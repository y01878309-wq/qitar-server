'use strict';
/* Online server for the train game. No dependencies: plain Node.js (version 18 or newer) with a small WebSocket implementation.
 *   node server/server.js            (PORT environment variable sets the port, default 8080)
 * Players join a room named after the line they drive. Every client sends its own train state about ten times a second
 * and this server relays the other players' states back to it. The server is only a relay: each client runs its own
 * physics and detects collisions with the trains it sees. */
const http = require('http'), crypto = require('crypto'), fs = require('fs'), path = require('path');
const PORT = +process.env.PORT || 8080, MAX_ROOM = 8, TICK_MS = 100, IDLE_MS = 20000;
const rooms = new Map();   // room name -> Map(id -> client)
let nextId = 1;

/* ---- Accounts and wallet -------------------------------------------------------------------------------------------
 * Every player gets a numeric ID (6 digits) and a secret token kept on their device. Coins and bought trains live here.
 * The owner tops players up from /admin with the ADMIN_KEY (environment variable). Data is kept in a JSON file (DATA_FILE).
 * NOTE: on hosts with a temporary disk (such as the free Render plan) the file is lost on every restart; point DATA_FILE
 * at a persistent disk or use a VPS. Prices and rewards come from catalog.json (made by tools/make-catalog.js). */
const DATA_FILE = process.env.DATA_FILE || path.join(__dirname, 'data.json'), ADMIN_KEY = process.env.ADMIN_KEY || '';
const START_COINS = process.env.START_COINS === undefined ? 50 : +process.env.START_COINS;
let catalog = { prices: {}, rewards: {} };
try { catalog = JSON.parse(fs.readFileSync(path.join(__dirname, 'catalog.json'), 'utf8')); } catch (e) { console.warn('catalog.json missing: all items are free and no rewards are paid'); }
let db = { players: {}, tx: [] };
try { db = JSON.parse(fs.readFileSync(DATA_FILE, 'utf8')); db.players = db.players || {}; db.tx = db.tx || []; } catch (e) { /* first run */ }
let saveTimer = null;
function save() {
  if (saveTimer) return;
  saveTimer = setTimeout(() => { saveTimer = null; const tmp = DATA_FILE + '.tmp'; try { fs.writeFileSync(tmp, JSON.stringify(db)); fs.renameSync(tmp, DATA_FILE); } catch (e) { console.error('could not save data:', e.message); } }, 400);
}
process.on('SIGTERM', () => { try { fs.writeFileSync(DATA_FILE, JSON.stringify(db)); } catch (e) { /* ignore */ } process.exit(0); });
const log = (id, kind, amount, note) => { db.tx.push({ t: Date.now(), id, kind, amount, note: String(note || '').slice(0, 60) }); if (db.tx.length > 2000) db.tx.splice(0, db.tx.length - 2000); };
const publicView = (p) => ({ id: p.id, name: p.name, coins: p.coins, owned: p.owned, xp: p.xp || 0, claimed: p.claimed || [] });
const today = () => new Date().toISOString().slice(0, 10);
function newId() { for (let i = 0; i < 1000; i++) { const id = String(100000 + crypto.randomInt(900000)); if (!db.players[id]) return id; } return String(Date.now()).slice(-8); }
const sha = (x) => crypto.createHash('sha256').update(String(x)).digest();
const same = (a, b) => crypto.timingSafeEqual(sha(a), sha(b));
const hits = new Map();   // ip -> timestamps, for rate limits
function limited(ip, kind, max, windowMs) {
  const k = kind + ip, now = Date.now(), list = (hits.get(k) || []).filter((t) => now - t < windowMs);
  list.push(now); hits.set(k, list); return list.length > max;
}
setInterval(() => { const now = Date.now(); for (const [k, v] of hits) if (!v.some((t) => now - t < 3600000)) hits.delete(k); }, 600000);

const CORS = { 'access-control-allow-origin': '*', 'access-control-allow-headers': 'content-type', 'access-control-allow-methods': 'GET,POST,OPTIONS' };
const send_ = (res, code, obj) => { res.writeHead(code, Object.assign({ 'content-type': 'application/json; charset=utf-8' }, CORS)); res.end(JSON.stringify(obj)); };
function body(req, cb) {
  let n = 0; const chunks = [];
  req.on('data', (c) => { n += c.length; if (n > 4096) { req.destroy(); return; } chunks.push(c); });
  req.on('end', () => { let o = {}; try { o = JSON.parse(Buffer.concat(chunks).toString('utf8') || '{}'); } catch (e) { o = null; } cb(o); });
}
const ipOf = (req) => String(req.headers['x-forwarded-for'] || req.socket.remoteAddress || '').split(',')[0].trim();
const cleanName = (s) => String(s == null ? '' : s).replace(/[\u0000-\u001f<>]/g, '').trim().slice(0, 16);
function authed(m) { const p = m && db.players[String(m.id)]; return p && typeof m.token === 'string' && same(p.token, m.token) ? p : null; }

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

const server = http.createServer((req, res) => {
  const url = (req.url || '/').split('?')[0], ip = ipOf(req);
  if (req.method === 'OPTIONS') { res.writeHead(204, CORS); res.end(); return; }
  if (req.method === 'GET') {
    if (url === '/admin') { res.writeHead(200, { 'content-type': 'text/html; charset=utf-8', 'cache-control': 'no-store' }); res.end(ADMIN_PAGE); return; }
    let n = 0; for (const r of rooms.values()) n += r.size;
    res.writeHead(200, Object.assign({ 'content-type': 'text/plain; charset=utf-8' }, CORS)); res.end(url === '/health' ? 'ok' : `Qitar server. Online players: ${n}\n`); return;
  }
  if (req.method !== 'POST') { send_(res, 405, { error: 'method' }); return; }
  body(req, (m) => {
    if (!m) return send_(res, 400, { error: 'bad json' });
    if (url === '/api/register') {
      if (limited(ip, 'reg', 15, 3600000)) return send_(res, 429, { error: 'too many accounts from this address, try later' });
      const name = cleanName(m.name) || 'سواق', id = newId(), token = crypto.randomBytes(18).toString('hex');
      const p = db.players[id] = { id, name, token, coins: START_COINS, owned: [], xp: 0, claimed: [], created: Date.now(), earnedDay: '', earnedSum: 0, lastEarn: 0 };
      log(id, 'register', START_COINS, 'start'); save(); return send_(res, 200, Object.assign({ token }, publicView(p)));
    }
    if (url === '/api/me') { const p = authed(m); return p ? send_(res, 200, publicView(p)) : send_(res, 401, { error: 'unknown account' }); }
    if (url === '/api/rename') { const p = authed(m); if (!p) return send_(res, 401, { error: 'unknown account' }); p.name = cleanName(m.name) || p.name; save(); return send_(res, 200, publicView(p)); }
    if (url === '/api/buy') {
      const p = authed(m); if (!p) return send_(res, 401, { error: 'unknown account' });
      const item = String(m.item || ''), price = catalog.prices[item];
      if (price === undefined) return send_(res, 400, { error: 'unknown item' });
      if (!price || p.owned.includes(item)) return send_(res, 200, publicView(p));
      if (p.coins < price) return send_(res, 402, Object.assign({ error: 'not enough coins', price }, publicView(p)));
      p.coins -= price; p.owned.push(item); log(p.id, 'buy', -price, item); save(); return send_(res, 200, publicView(p));
    }
    if (url === '/api/trip') {   // coins and experience for a finished trip (reported by the game, so capped)
      const p = authed(m); if (!p) return send_(res, 401, { error: 'unknown account' });
      const now = Date.now(), day = today(); if (p.earnedDay !== day) { p.earnedDay = day; p.earnedSum = 0; }
      const coins = Math.max(0, Math.min(400, Math.floor(+m.coins || 0))), xp = Math.max(0, Math.min(500, Math.floor(+m.xp || 0)));
      if (now - (p.lastEarn || 0) < 20000 || p.earnedSum + coins > 3000) return send_(res, 429, Object.assign({ error: 'trip rewards limited' }, publicView(p)));
      p.lastEarn = now; p.earnedSum += coins; p.coins += coins; p.xp = (p.xp || 0) + xp; log(p.id, 'trip', coins, 'xp ' + xp); save(); return send_(res, 200, publicView(p));
    }
    if (url === '/api/claim') {   // a finished mission (id@day) or achievement (id); each can be claimed once
      const p = authed(m); if (!p) return send_(res, 401, { error: 'unknown account' });
      const key = String(m.key || '').slice(0, 40), id = key.split('@')[0], reward = catalog.rewards[id];
      if (reward === undefined) return send_(res, 400, { error: 'unknown reward' });
      if (id.startsWith('d_')) { const d = key.split('@')[1], t = Date.now(); if (!/^\d{4}-\d\d-\d\d$/.test(d || '') || Math.abs(Date.parse(d) - t) > 2 * 86400000) return send_(res, 400, { error: 'bad day' }); }
      p.claimed = p.claimed || []; if (p.claimed.includes(key)) return send_(res, 200, publicView(p));
      p.claimed.push(key); if (p.claimed.length > 400) p.claimed.splice(0, p.claimed.length - 400); p.coins += reward; log(p.id, 'claim', reward, key); save(); return send_(res, 200, publicView(p));
    }
    if (url === '/admin/player' || url === '/admin/credit') {
      if (!ADMIN_KEY) return send_(res, 503, { error: 'ADMIN_KEY is not set on the server' });
      if (limited(ip, 'adm', 12, 600000)) return send_(res, 429, { error: 'too many attempts, wait 10 minutes' });
      if (typeof m.key !== 'string' || !same(m.key, ADMIN_KEY)) return send_(res, 403, { error: 'wrong admin key' });
      const p = db.players[String(m.id || '').trim()]; if (!p) return send_(res, 404, { error: 'no player with this ID' });
      if (url === '/admin/player') return send_(res, 200, publicView(p));
      const amount = Math.trunc(+m.amount); if (!Number.isFinite(amount) || amount === 0 || Math.abs(amount) > 100000) return send_(res, 400, { error: 'amount must be a whole number, not 0, at most 100000' });
      if (p.coins + amount < 0) return send_(res, 400, { error: 'balance would go below zero' });
      p.coins += amount; log(p.id, 'admin', amount, m.note); save(); console.log('admin credit', p.id, amount, String(m.note || '')); return send_(res, 200, publicView(p));
    }
    send_(res, 404, { error: 'not found' });
  });
});

server.on('upgrade', (req, socket) => {
  const key = req.headers['sec-websocket-key'];
  if (!key || String(req.headers.upgrade).toLowerCase() !== 'websocket') { socket.destroy(); return; }
  const accept = crypto.createHash('sha1').update(key + '258EAFA5-E914-47DA-95CA-C5AB0DC85B11').digest('base64');
  socket.write('HTTP/1.1 101 Switching Protocols\r\nUpgrade: websocket\r\nConnection: Upgrade\r\nSec-WebSocket-Accept: ' + accept + '\r\n\r\n');
  const c = { id: nextId++, socket, buf: Buffer.alloc(0), room: null, p: null, last: Date.now(), msgs: 0, frag: null, closed: false };
  socket.setNoDelay(true);
  socket.on('data', (d) => { c.buf = Buffer.concat([c.buf, d]); if (c.buf.length > 1 << 17) return drop(c); try { parse(c); } catch (e) { drop(c); } });
  socket.on('close', () => drop(c)); socket.on('error', () => drop(c));
});

function frame(op, payload) {
  const len = payload.length, head = len < 126 ? Buffer.from([0x80 | op, len]) : len < 65536 ? Buffer.from([0x80 | op, 126, len >> 8, len & 255]) : null;
  return head ? Buffer.concat([head, payload]) : null;
}
function send(c, obj) { if (c.closed || c.socket.destroyed) return; const f = frame(1, Buffer.from(JSON.stringify(obj))); if (f) c.socket.write(f); }

function parse(c) {
  for (;;) {
    const b = c.buf; if (b.length < 2) return;
    const fin = (b[0] & 0x80) !== 0, op = b[0] & 15, masked = (b[1] & 0x80) !== 0; let len = b[1] & 127, off = 2;
    if (len === 126) { if (b.length < 4) return; len = b.readUInt16BE(2); off = 4; }
    else if (len === 127) { if (b.length < 10) return; if (b.readUInt32BE(2) !== 0) return drop(c); len = b.readUInt32BE(6); off = 10; }
    if (len > 1 << 16) return drop(c);
    if (b.length < off + (masked ? 4 : 0) + len) return;
    let payload = b.subarray(off + (masked ? 4 : 0), off + (masked ? 4 : 0) + len);
    if (masked) { const m = b.subarray(off, off + 4), out = Buffer.alloc(len); for (let i = 0; i < len; i++) out[i] = payload[i] ^ m[i & 3]; payload = out; }
    c.buf = b.subarray(off + (masked ? 4 : 0) + len);
    if (op === 8) { try { c.socket.write(frame(8, Buffer.alloc(0))); } catch (e) { /* closing */ } return drop(c); }
    if (op === 9) { const f = frame(10, payload); if (f) c.socket.write(f); continue; }
    if (op === 10) { c.last = Date.now(); continue; }
    if (op === 1 || op === 0) {
      if (op === 1) c.frag = payload; else c.frag = Buffer.concat([c.frag || Buffer.alloc(0), payload]);
      if (fin) { const text = c.frag.toString('utf8'); c.frag = null; message(c, text); }
    }
  }
}

const num = (x, lo, hi, d) => (Number.isFinite(+x) ? Math.min(hi, Math.max(lo, +x)) : d);
const clean = (s, n) => String(s == null ? '' : s).replace(/[\u0000-\u001f<>]/g, '').slice(0, n);

function message(c, text) {
  c.last = Date.now(); if (++c.msgs > 400) return;   // at most about 400 messages per 5 s window, see sweep below
  let m; try { m = JSON.parse(text); } catch (e) { return; }
  if (m.t === 'join' && !c.room) {
    const room = clean(m.room || m.line, 40) || 'default', r = rooms.get(room) || new Map();
    if (r.size >= MAX_ROOM) { send(c, { t: 'full' }); return; }
    c.room = room; rooms.set(room, r); r.set(c.id, c);
    c.p = { id: c.id, name: clean(m.name, 16) || 'سواق', type: clean(m.type, 24), s: 0, v: 0, L: 200, derail: false, dt: 0, doors: 0 };
    send(c, { t: 'welcome', id: c.id, room, count: r.size });
  } else if (m.t === 'state' && c.p) {
    const p = c.p; p.s = num(m.s, -1e7, 1e7, p.s); p.v = num(m.v, 0, 100, 0); p.L = num(m.L, 20, 400, p.L); p.derail = !!m.derail; p.dt = num(m.dt, 0, 600, 0); p.doors = num(m.doors, 0, 1, 0);
  } else if (m.t === 'horn' && c.room) {
    for (const o of rooms.get(c.room).values()) if (o !== c) send(o, { t: 'horn', id: c.id });
  } else if (m.t === 'chat' && c.room) {
    const text = clean(m.text, 80); if (text) for (const o of rooms.get(c.room).values()) send(o, { t: 'chat', id: c.id, name: c.p.name, text });
  }
}

function drop(c) {
  if (c.closed) return; c.closed = true;
  try { c.socket.destroy(); } catch (e) { /* already gone */ }
  if (c.room) {
    const r = rooms.get(c.room); if (r) { r.delete(c.id); for (const o of r.values()) send(o, { t: 'leave', id: c.id }); if (!r.size) rooms.delete(c.room); }
  }
}

setInterval(() => {   // ten times a second: send everyone the other players of their room
  for (const r of rooms.values()) {
    if (r.size < 2) continue;
    const all = [...r.values()].map((c) => c.p);
    for (const c of r.values()) send(c, { t: 'players', list: all.filter((p) => p.id !== c.id) });
  }
}, TICK_MS);
setInterval(() => {   // drop silent clients, reset the flood counters
  const now = Date.now();
  for (const r of [...rooms.values()]) for (const c of [...r.values()]) { c.msgs = 0; if (now - c.last > IDLE_MS) drop(c); }
}, 5000);

server.listen(PORT, () => { console.log('Qitar server listening on port ' + PORT); if (!ADMIN_KEY) console.warn('ADMIN_KEY is not set: the /admin page is disabled'); });
