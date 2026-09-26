// api/ws.js
// Vercel Function serving WebSocket connections at /api/ws.
// Room/game state lives in Redis (lib/roomStore.js), not in memory, because this
// function's instances don't share memory. Cross-instance delivery works via a
// Redis Pub/Sub channel per room: whichever instance holds a player's socket
// subscribes to that room's channel, and any instance can publish to it.
'use strict';
const express = require('express');
const { createServer } = require('http');
const { WebSocketServer, WebSocket } = require('ws');
const Chess = require('../lib/chessEngine.js');
const { getRoom, saveRoom, createRoom, joinRoom, recordMatch, channelFor } = require('../lib/roomStore.js');
const { getCommandClient, getSubscriberClient } = require('../lib/redis.js');

const app = express();
const server = createServer(app);
const wss = new WebSocketServer({ server });

// Reused across warm invocations of this instance.
const subscriber = getSubscriberClient();
const localSockets = new Map();      // roomCode -> Set<ws> (sockets connected to THIS instance)
const subscribedChannels = new Set(); // channels this instance is already subscribed to

subscriber.on('message', (channel, message) => {
  const code = channel.split(':')[1];
  const sockets = localSockets.get(code);
  if (!sockets) return;
  for (const ws of sockets) {
    if (ws.readyState === WebSocket.OPEN) ws.send(message);
  }
});

async function ensureSubscribed(code) {
  const channel = channelFor(code);
  if (subscribedChannels.has(channel)) return;
  subscribedChannels.add(channel);
  await subscriber.subscribe(channel);
}

function registerLocalSocket(code, ws) {
  if (!localSockets.has(code)) localSockets.set(code, new Set());
  localSockets.get(code).add(ws);
}
function unregisterLocalSocket(code, ws) {
  const set = localSockets.get(code);
  if (!set) return;
  set.delete(ws);
  if (!set.size) localSockets.delete(code);
}

function send(ws, obj) {
  if (ws && ws.readyState === WebSocket.OPEN) ws.send(JSON.stringify(obj));
}
async function publish(code, obj) {
  await getCommandClient().publish(channelFor(code), JSON.stringify(obj));
}
function sanitizeName(raw, fallback) {
  const s = String(raw == null ? '' : raw).replace(/[<>]/g, '').trim().slice(0, 24);
  return s || fallback;
}
async function recordIfOver(room) {
  if (room.state && room.state.gameOver && !room.recorded) {
    room.recorded = true;
    await recordMatch({
      code: room.code,
      white: room.hostName,
      black: room.guestName || '—',
      result: room.state.result || 'Game over',
      moves: (room.state.history || []).length,
      date: new Date().toISOString()
    });
  }
}

wss.on('connection', (ws) => {
  ws.roomCode = null;
  ws.color = null;

  ws.on('message', async (raw) => {
    let msg;
    try { msg = JSON.parse(raw); } catch { return; }

    try {
      if (msg.type === 'create') {
        const hostName = sanitizeName(msg.name, 'White player');
        const { code, token } = await createRoom(hostName, Chess.initialState());
        ws.roomCode = code; ws.color = 'w';
        await ensureSubscribed(code);
        registerLocalSocket(code, ws);
        send(ws, { type: 'created', code, color: 'w', token });
        return;
      }

      if (msg.type === 'join') {
        const guestName = sanitizeName(msg.name, 'Black player');
        const result = await joinRoom(msg.code, guestName);
        if (result.error) { send(ws, { type: 'error', message: result.error }); return; }
        ws.roomCode = msg.code; ws.color = 'b';
        await ensureSubscribed(msg.code);
        registerLocalSocket(msg.code, ws);
        send(ws, {
          type: 'joined', code: msg.code, color: 'b', token: result.token,
          state: result.room.state, hostName: result.room.hostName, guestName
        });
        await publish(msg.code, { type: 'opponent-joined', guestName });
        return;
      }

      if (msg.type === 'reconnect') {
        const room = await getRoom(msg.code);
        if (!room) { send(ws, { type: 'error', message: 'That room no longer exists.' }); return; }
        const slot = room.hostToken === msg.token ? 'host' : room.guestToken === msg.token ? 'guest' : null;
        if (!slot) { send(ws, { type: 'error', message: 'Could not resume that session.' }); return; }
        if (slot === 'host') room.hostDisconnectedAt = null; else room.guestDisconnectedAt = null;
        await saveRoom(room);
        ws.roomCode = msg.code; ws.color = slot === 'host' ? 'w' : 'b';
        await ensureSubscribed(msg.code);
        registerLocalSocket(msg.code, ws);
        send(ws, {
          type: 'resumed', code: msg.code, color: ws.color, state: room.state,
          hostName: room.hostName, guestName: room.guestName || ''
        });
        await publish(msg.code, { type: 'opponent-reconnected' });
        return;
      }

      if (msg.type === 'move') {
        const room = await getRoom(ws.roomCode);
        if (!room || !room.state) return;
        if (room.state.gameOver) { send(ws, { type: 'error', message: 'The game is already over.' }); return; }
        if (ws.color !== room.state.turn) { send(ws, { type: 'error', message: 'Not your move.' }); return; }

        const result = Chess.applyMove(room.state, msg.from, msg.to, msg.promotion);
        if (!result.ok) { send(ws, { type: 'error', message: result.error || 'Illegal move.' }); return; }

        room.state = result.state;
        await recordIfOver(room);
        await saveRoom(room);
        await publish(ws.roomCode, { type: 'state', state: room.state });
        return;
      }

      if (msg.type === 'resign') {
        const room = await getRoom(ws.roomCode);
        if (!room || !room.state || room.state.gameOver) return;
        room.state.gameOver = true;
        room.state.result = (ws.color === 'w' ? 'Black' : 'White') + ' wins — resignation';
        await recordIfOver(room);
        await saveRoom(room);
        await publish(ws.roomCode, { type: 'state', state: room.state });
        return;
      }
    } catch (err) {
      console.error('ws message error:', err);
      send(ws, { type: 'error', message: 'Server error — please try again.' });
    }
  });

  ws.on('close', async () => {
    if (!ws.roomCode) return;
    unregisterLocalSocket(ws.roomCode, ws);
    try {
      const room = await getRoom(ws.roomCode);
      if (!room) return;
      if (ws.color === 'w') room.hostDisconnectedAt = Date.now();
      else room.guestDisconnectedAt = Date.now();
      await saveRoom(room);
      await publish(ws.roomCode, { type: 'opponent-disconnected' });
    } catch (err) {
      console.error('ws close handler error:', err);
    }
  });
});

module.exports = server;