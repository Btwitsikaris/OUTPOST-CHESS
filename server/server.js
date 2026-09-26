const path = require('path');
const http = require('http');
const crypto = require('crypto');
const express = require('express');
const WebSocket = require('ws');
const db = require('./db');
const Chess = require('./chessEngine');

const PORT = process.env.PORT || 3000;
const RECONNECT_GRACE_MS = 30 * 1000;   // time a disconnected player has to rejoin before the room closes
const ROOM_TTL_MS = 2 * 60 * 60 * 1000; // rooms with no activity this long are swept up

// roomCode -> {
//   host: { ws, name, token, disconnectedAt } | null,
//   guest: { ws, name, token, disconnectedAt } | null,
//   state: ChessEngine state,
//   hostName, createdAt, lastActivity, recorded
// }
const rooms = new Map();

function genCode() {
  const chars = 'ABCDEFGHJKLMNPQRSTUVWXYZ23456789';
  let code = '';
  for (let i = 0; i < 5; i++) code += chars[Math.floor(Math.random() * chars.length)];
  return rooms.has(code) ? genCode() : code;
}
function genToken() { return crypto.randomBytes(12).toString('hex'); }
function send(ws, obj) { if (ws && ws.readyState === WebSocket.OPEN) ws.send(JSON.stringify(obj)); }
function sanitizeName(raw, fallback) {
  const s = String(raw == null ? '' : raw).replace(/[<>]/g, '').trim().slice(0, 24);
  return s || fallback;
}

// --- housekeeping: sweep dead rooms so `rooms` doesn't grow forever ---
setInterval(() => {
  const now = Date.now();
  for (const [code, room] of rooms.entries()) {
    const bothGone = !room.host && !room.guest;
    const stale = now - room.lastActivity > ROOM_TTL_MS;
    if (bothGone || stale) rooms.delete(code);
  }
}, 60 * 1000);

const app = express();

// Minimal CORS so the client also works if served from a different origin/port.
app.use((req, res, next) => {
  res.header('Access-Control-Allow-Origin', '*');
  res.header('Access-Control-Allow-Methods', 'GET,POST,OPTIONS');
  res.header('Access-Control-Allow-Headers', 'Content-Type');
  if (req.method === 'OPTIONS') return res.sendStatus(204);
  next();
});

app.use(express.static(path.join(__dirname, '..', 'public')));

app.get('/', (req, res) => res.redirect('/landingpage.html'));

app.get('/api/rooms', (req, res) => {
  const open = [...rooms.entries()]
    .filter(([, r]) => !r.guest)
    .map(([code, r]) => ({ code, hostName: r.hostName, createdAt: r.createdAt }));
  res.json(open);
});

app.get('/api/history', (req, res) => {
  res.json(db.readMatches().slice(0, 20));
});

const server = http.createServer(app);
const wss = new WebSocket.Server({ server });

function recordIfOver(room) {
  if (room.state && room.state.gameOver && !room.recorded) {
    room.recorded = true;
    db.addMatch({
      code: room._code,
      white: room.hostName,
      black: room.guest ? room.guest.name : '—',
      result: room.state.result || 'Game over',
      moves: (room.state.history || []).length,
      date: new Date().toISOString()
    });
  }
}

wss.on('connection', (ws) => {
  ws.roomCode = null;
  ws.color = null;
  ws.token = null;

  ws.on('message', (raw) => {
    let msg;
    try { msg = JSON.parse(raw); } catch { return; }

    if (msg.type === 'create') {
      const code = genCode();
      const hostName = sanitizeName(msg.name, 'White player');
      const token = genToken();
      const room = {
        host: { ws, name: hostName, token, disconnectedAt: null },
        guest: null,
        state: Chess.initialState(),
        hostName,
        createdAt: Date.now(),
        lastActivity: Date.now(),
        recorded: false,
        _code: code
      };
      rooms.set(code, room);
      ws.roomCode = code; ws.color = 'w'; ws.token = token;
      send(ws, { type: 'created', code, color: 'w', token });
      return;
    }

    if (msg.type === 'join') {
      const room = rooms.get(msg.code);
      if (!room) { send(ws, { type: 'error', message: 'No room with that code.' }); return; }
      if (room.guest && room.guest.ws && room.guest.ws.readyState === WebSocket.OPEN) {
        send(ws, { type: 'error', message: 'That room already has two players.' });
        return;
      }
      const guestName = sanitizeName(msg.name, 'Black player');
      const token = genToken();
      room.guest = { ws, name: guestName, token, disconnectedAt: null };
      room.lastActivity = Date.now();
      ws.roomCode = msg.code; ws.color = 'b'; ws.token = token;
      send(ws, {
        type: 'joined', code: msg.code, color: 'b', token,
        state: room.state, hostName: room.hostName, guestName
      });
      send(room.host.ws, { type: 'opponent-joined', guestName });
      return;
    }

    if (msg.type === 'reconnect') {
      const room = rooms.get(msg.code);
      if (!room) { send(ws, { type: 'error', message: 'That room no longer exists.' }); return; }
      const slot = (room.host && room.host.token === msg.token) ? 'host'
        : (room.guest && room.guest.token === msg.token) ? 'guest' : null;
      if (!slot) { send(ws, { type: 'error', message: 'Could not resume that session.' }); return; }
      room[slot].ws = ws;
      room[slot].disconnectedAt = null;
      ws.roomCode = msg.code; ws.color = slot === 'host' ? 'w' : 'b'; ws.token = msg.token;
      room.lastActivity = Date.now();
      send(ws, {
        type: 'resumed', code: msg.code, color: ws.color, state: room.state,
        hostName: room.hostName, guestName: room.guest ? room.guest.name : ''
      });
      const other = ws.color === 'w' ? room.guest : room.host;
      send(other && other.ws, { type: 'opponent-reconnected' });
      return;
    }

    if (msg.type === 'move') {
      const room = rooms.get(ws.roomCode);
      if (!room || !room.state) return;
      if (room.state.gameOver) { send(ws, { type: 'error', message: 'The game is already over.' }); return; }
      if (ws.color !== room.state.turn) { send(ws, { type: 'error', message: 'Not your move.' }); return; }

      const result = Chess.applyMove(room.state, msg.from, msg.to, msg.promotion);
      if (!result.ok) { send(ws, { type: 'error', message: result.error || 'Illegal move.' }); return; }

      room.state = result.state;
      room.lastActivity = Date.now();
      const payload = { type: 'state', state: room.state };
      send(room.host && room.host.ws, payload);
      send(room.guest && room.guest.ws, payload);
      recordIfOver(room);
      return;
    }

    if (msg.type === 'resign') {
      const room = rooms.get(ws.roomCode);
      if (!room || !room.state || room.state.gameOver) return;
      room.state.gameOver = true;
      room.state.result = (ws.color === 'w' ? 'Black' : 'White') + ' wins — resignation';
      room.lastActivity = Date.now();
      const payload = { type: 'state', state: room.state };
      send(room.host && room.host.ws, payload);
      send(room.guest && room.guest.ws, payload);
      recordIfOver(room);
      return;
    }
  });

  ws.on('close', () => {
    const room = rooms.get(ws.roomCode);
    if (!room) return;
    const slot = ws.color === 'w' ? room.host : room.guest;
    if (!slot || slot.ws !== ws) return; // an old/replaced socket closing shouldn't affect a reconnected one
    slot.disconnectedAt = Date.now();
    const other = ws.color === 'w' ? room.guest : room.host;
    send(other && other.ws, { type: 'opponent-disconnected', graceMs: RECONNECT_GRACE_MS });

    setTimeout(() => {
      const stillGone = slot.disconnectedAt && (!slot.ws || slot.ws.readyState !== WebSocket.OPEN);
      if (!stillGone) return; // they reconnected in time
      if (ws.color === 'w') room.host = null; else room.guest = null;
      send(other && other.ws, { type: 'opponent-left' });
      if (!room.host && !room.guest) rooms.delete(ws.roomCode);
    }, RECONNECT_GRACE_MS);
  });
});

server.listen(PORT, () => {
  console.log(`Outpost Chess server running at http://localhost:${PORT}`);
});