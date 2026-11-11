import { createClient } from '@supabase/supabase-js';
import catalog from './catalog.json';

const MAX_ROOM = 8;
const TICK_MS = 100;

const CORS = {
  'Access-Control-Allow-Origin': '*',
  'Access-Control-Allow-Headers': 'content-type',
  'Access-Control-Allow-Methods': 'GET,POST,OPTIONS'
};

const jsonRes = (code, obj) => new Response(JSON.stringify(obj), {
  status: code,
  headers: { 'Content-Type': 'application/json; charset=utf-8', ...CORS }
});

const num = (x, lo, hi, d) => (Number.isFinite(+x) ? Math.min(hi, Math.max(lo, +x)) : d);
const clean = (s, n) => String(s == null ? '' : s).replace(/[\u0000-\u001f<>]/g, '').trim().slice(0, n);
const today = () => new Date().toISOString().slice(0, 10);

function newId() {
  return String(100000 + Math.floor(Math.random() * 900000));
}

function newToken() {
  const arr = new Uint8Array(18);
  crypto.getRandomValues(arr);
  return Array.from(arr, b => b.toString(16).padStart(2, '0')).join('');
}

const publicView = (p) => ({
  id: p.id,
  name: p.name,
  coins: p.coins,
  owned: p.owned || [],
  xp: p.xp || 0,
  claimed: p.claimed || []
});

const ADMIN_PAGE = `<!doctype html><html lang="ar" dir="rtl"><meta charset="utf-8"><meta name="viewport" content="width=device-width,initial-scale=1"><title>شحن اللاعبين</title>
<style>body{font:17px system-ui,Tahoma;background:#15110c;color:#f1e7d0;max-width:520px;margin:0 auto;padding:16px}h1{font-size:22px;color:#f2a93b}label{display:block;margin:14px 0 4px;color:#b9a98a}
input{width:100%;box-sizing:border-box;padding:12px;background:#1d1812;color:#f1e7d0;border:1px solid #4a3d2c;border-radius:8px;font-size:18px}button{margin-top:12px;padding:12px 16px;font-size:17px;border:0;border-radius:8px;background:#f2a93b;color:#1b140a;font-weight:700}
.box{margin-top:16px;padding:12px;background:#1d1812;border:1px solid #4a3d2c;border-radius:8px}.ok{color:#9fe3a8}.bad{color:#ff9b8a}</style>
<h1>شحن اللاعبين</h1><label>مفتاح الأدمن</label><input id=k type=password autocomplete=off>
<label>ID اللاعب</label><input id=i inputmode=numeric maxlength=10><button onclick=look()>اعرض اللاعب</button><div id=p class=box hidden></div>
<label>العملات (سالب للخصم)</label><input id=a inputmode=numeric value=200><label>ملاحظة (اختياري، مثلاً رقم التحويل)</label><input id=n maxlength=60>
<button onclick=credit()>اشحن</button><div id=m class=box hidden></div>
<script>
const $=id=>document.getElementById(id);
async function call(path,data){const r=await fetch(path,{method:'POST',headers:{'content-type':'application/json'},body:JSON.stringify(Object.assign({key:$('k').value},data))});return {s:r.status,j:await r.json().catch(()=>({}))}}
function msg(t,ok){const m=$('m');m.hidden=false;m.className='box '+(ok?'ok':'bad');m.textContent=t}
async function look(){const r=await call('/admin/player',{id:$('i').value});const p=$('p');p.hidden=false;if(r.s==200){p.textContent='الاسم: '+r.j.name+' — الرصيد: '+r.j.coins+' — القطارات: '+(r.j.owned.length?r.j.owned.join(', '):'لا يوجد');p.className='box ok'}else{p.textContent=r.j.error||'خطأ';p.className='box bad'}}
async function credit(){const r=await call('/admin/credit',{id:$('i').value,amount:+$('a').value,note:$('n').value});if(r.s==200){msg('تم. رصيد '+r.j.name+' الآن: '+r.j.coins,true);look()}else msg(r.j.error||'خطأ',false)}
</script></html>`;

export default class QitarServer {
  constructor(room) {
    this.room = room;
    this.players = new Map();
    this.nextNumId = 1;
    this.tickInterval = null;
  }

  getSupabase() {
    const url = this.room.env.SUPABASE_URL;
    const key = this.room.env.SUPABASE_KEY;
    if (!url || !key) return null;
    return createClient(url, key);
  }

  onConnect(conn) {
    if (this.players.size >= MAX_ROOM) {
      conn.send(JSON.stringify({ t: 'full' }));
      conn.close();
      return;
    }

    const numId = this.nextNumId++;
    this.players.set(conn.id, {
      connId: conn.id,
      id: numId,
      name: 'سواق',
      type: '',
      s: 0, v: 0, L: 200,
      derail: false, dt: 0, doors: 0,
      joined: false
    });

    if (!this.tickInterval) {
      this.tickInterval = setInterval(() => this.broadcastTick(), TICK_MS);
    }
  }

  onMessage(message, sender) {
    let m;
    try { m = JSON.parse(message); } catch { return; }
    const p = this.players.get(sender.id);
    if (!p) return;

    if (m.t === 'join' && !p.joined) {
      p.joined = true;
      p.name = clean(m.name, 16) || 'سواق';
      p.type = clean(m.type, 24);
      sender.send(JSON.stringify({
        t: 'welcome',
        id: p.id,
        room: this.room.id,
        count: this.players.size
      }));
    } else if (m.t === 'state' && p.joined) {
      p.s = num(m.s, -1e7, 1e7, p.s);
      p.v = num(m.v, 0, 100, 0);
      p.L = num(m.L, 20, 400, p.L);
      p.derail = !!m.derail;
      p.dt = num(m.dt, 0, 600, 0);
      p.doors = num(m.doors, 0, 1, 0);
    } else if (m.t === 'horn' && p.joined) {
      this.room.broadcast(JSON.stringify({ t: 'horn', id: p.id }), [sender.id]);
    } else if (m.t === 'chat' && p.joined) {
      const text = clean(m.text, 80);
      if (text) {
        this.room.broadcast(JSON.stringify({ t: 'chat', id: p.id, name: p.name, text }), [sender.id]);
      }
    }
  }

  onClose(conn) {
    const p = this.players.get(conn.id);
    if (p) {
      this.players.delete(conn.id);
      if (p.joined) {
        this.room.broadcast(JSON.stringify({ t: 'leave', id: p.id }));
      }
    }
    if (this.players.size === 0 && this.tickInterval) {
      clearInterval(this.tickInterval);
      this.tickInterval = null;
    }
  }

  broadcastTick() {
    if (this.players.size < 2) return;
    const active = [...this.players.values()].filter(p => p.joined);
    if (active.length < 2) return;

    for (const conn of this.room.getConnections()) {
      const me = this.players.get(conn.id);
      if (!me || !me.joined) continue;
      const others = active
        .filter(o => o.id !== me.id)
        .map(({ connId, joined, ...rest }) => rest);
      conn.send(JSON.stringify({ t: 'players', list: others }));
    }
  }

  async onRequest(req) {
    const url = new URL(req.url);
    const path = url.pathname.replace(/^\/parties\/[^/]+\/[^/]+/, '') || '/';

    if (req.method === 'OPTIONS') return new Response(null, { status: 204, headers: CORS });

    if (req.method === 'GET') {
      if (path.endsWith('/admin')) {
        return new Response(ADMIN_PAGE, {
          status: 200,
          headers: { 'Content-Type': 'text/html; charset=utf-8', 'Cache-Control': 'no-store' }
        });
      }
      if (path.endsWith('/health')) return new Response('ok', { status: 200, headers: CORS });
      return new Response(`Qitar PartyKit Server. Active in room: ${this.players.size}\n`, { status: 200, headers: CORS });
    }

    if (req.method !== 'POST') return jsonRes(405, { error: 'method' });

    const supabase = this.getSupabase();
    if (!supabase) return jsonRes(500, { error: 'Supabase not configured' });

    let m;
    try { m = await req.json(); } catch { return jsonRes(400, { error: 'bad json' }); }

    const startCoins = Number(this.room.env.START_COINS ?? 50);
    const adminKey = this.room.env.ADMIN_KEY || '';

    const getAuthed = async () => {
      if (!m?.id || typeof m?.token !== 'string') return null;
      const { data } = await supabase.from('players').select('*').eq('id', String(m.id)).single();
      return (data && data.token === m.token) ? data : null;
    };

    const logTx = async (playerId, kind, amount, note) => {
      await supabase.from('transactions').insert({
        t: Date.now(), player_id: playerId, kind, amount, note: String(note || '').slice(0, 60)
      });
    };

    if (path.endsWith('/api/register')) {
      const name = clean(m.name, 16) || 'سواق';
      const id = newId();
      const token = newToken();
      const newPlayer = {
        id, name, token, coins: startCoins, owned: [], xp: 0, claimed: [],
        created: Date.now(), earned_day: '', earned_sum: 0, last_earn: 0
      };
      const { error } = await supabase.from('players').insert(newPlayer);
      if (error) return jsonRes(500, { error: 'db error' });
      await logTx(id, 'register', startCoins, 'start');
      return jsonRes(200, { token, ...publicView(newPlayer) });
    }

    if (path.endsWith('/api/me')) {
      const p = await getAuthed();
      return p ? jsonRes(200, publicView(p)) : jsonRes(401, { error: 'unknown account' });
    }

    if (path.endsWith('/api/rename')) {
      const p = await getAuthed();
      if (!p) return jsonRes(401, { error: 'unknown account' });
      const newName = clean(m.name, 16) || p.name;
      await supabase.from('players').update({ name: newName }).eq('id', p.id);
      p.name = newName;
      return jsonRes(200, publicView(p));
    }

    if (path.endsWith('/api/buy')) {
      const p = await getAuthed();
      if (!p) return jsonRes(401, { error: 'unknown account' });
      const item = String(m.item || '');
      const price = catalog.prices[item];
      if (price === undefined) return jsonRes(400, { error: 'unknown item' });
      if (!price || p.owned.includes(item)) return jsonRes(200, publicView(p));
      if (p.coins < price) return jsonRes(402, { error: 'not enough coins', price, ...publicView(p) });

      const updatedOwned = [...p.owned, item];
      const updatedCoins = p.coins - price;
      await supabase.from('players').update({ coins: updatedCoins, owned: updatedOwned }).eq('id', p.id);
      await logTx(p.id, 'buy', -price, item);
      p.coins = updatedCoins; p.owned = updatedOwned;
      return jsonRes(200, publicView(p));
    }

    if (path.endsWith('/api/trip')) {
      const p = await getAuthed();
      if (!p) return jsonRes(401, { error: 'unknown account' });
      const now = Date.now(), day = today();
      let earnedSum = p.earned_day === day ? (p.earned_sum || 0) : 0;

