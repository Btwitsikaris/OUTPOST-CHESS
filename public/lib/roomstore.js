// lib/roomStore.js
// All shared room/game state lives in Redis (not in-process memory), because a
// Vercel Function instance holding one player's WebSocket is not guaranteed to be
// the same instance holding the other player's. Cross-instance delivery of moves
// happens via Redis Pub/Sub (see channelFor + api/ws.js).
'use strict';
const crypto = require('crypto');
const { getCommandClient } = require('./redis.js');

const ROOM_TTL_SECONDS = 2 * 60 * 60; // rooms auto-expire 2h after last activity
const LOBBY_SET = 'lobby:open';
const HISTORY_KEY = 'history';
const HISTORY_MAX = 200;

function roomKey(code) { return `room:${code}`; }
function channelFor(code) { return `room:${code}:events`; }
function genToken() { return crypto.randomBytes(12).toString('hex'); }

function genCode() {
  const chars = 'ABCDEFGHJKLMNPQRSTUVWXYZ23456789';
  let code = '';
  for (let i = 0; i < 5; i++) code += chars[Math.floor(Math.random() * chars.length)];
  return code;
}

async function createRoom(hostName, initialState) {
  const redis = getCommandClient();
  let code;
  do { code = genCode(); } while (await redis.exists(roomKey(code)));
  const token = genToken();
  const room = {
    code,
    hostName, hostToken: token, hostDisconnectedAt: null,
    guestName: null, guestToken: null, guestDisconnectedAt: null,
    state: initialState,
    createdAt: Date.now(), lastActivity: Date.now(), recorded: false
  };
  await redis.set(roomKey(code), JSON.stringify(room), 'EX', ROOM_TTL_SECONDS);
  await redis.sadd(LOBBY_SET, code);
  return { code, token, room };
}

async function getRoom(code) {
  const redis = getCommandClient();
  const raw = await redis.get(roomKey(code));
  return raw ? JSON.parse(raw) : null;
}

async function saveRoom(room) {
  const redis = getCommandClient();
  room.lastActivity = Date.now();
  await redis.set(roomKey(room.code), JSON.stringify(room), 'EX', ROOM_TTL_SECONDS);
}

async function joinRoom(code, guestName) {
  const redis = getCommandClient();
  const room = await getRoom(code);
  if (!room) return { error: 'No room with that code.' };
  if (room.guestToken) return { error: 'That room already has two players.' };
  const token = genToken();
  room.guestName = guestName;
  room.guestToken = token;
  room.guestDisconnectedAt = null;
  await saveRoom(room);
  await redis.srem(LOBBY_SET, code);
  return { token, room };
}

async function listOpenRooms() {
  const redis = getCommandClient();
  const codes = await redis.smembers(LOBBY_SET);
  const results = [];
  for (const code of codes) {
    const room = await getRoom(code);
    if (!room || room.guestToken) { await redis.srem(LOBBY_SET, code); continue; } // self-heal stale entries
    results.push({ code, hostName: room.hostName, createdAt: room.createdAt });
  }
  return results;
}

async function recordMatch(entry) {
  const redis = getCommandClient();
  await redis.lpush(HISTORY_KEY, JSON.stringify(entry));
  await redis.ltrim(HISTORY_KEY, 0, HISTORY_MAX - 1);
}

async function readHistory(limit) {
  const redis = getCommandClient();
  const raw = await redis.lrange(HISTORY_KEY, 0, (limit || 20) - 1);
  return raw.map(r => JSON.parse(r));
}

module.exports = {
  createRoom, getRoom, saveRoom, joinRoom, listOpenRooms,
  recordMatch, readHistory, channelFor, genToken
};