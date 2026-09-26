// api/rooms.js — GET /api/rooms : list open rooms for the lobby
'use strict';
const { listOpenRooms } = require('../lib/roomStore.js');

module.exports = async function handler(req, res) {
  res.setHeader('Access-Control-Allow-Origin', '*');
  try {
    const rooms = await listOpenRooms();
    res.status(200).json(rooms);
  } catch (err) {
    console.error('api/rooms error:', err);
    res.status(500).json({ error: 'Could not load open rooms.' });
  }
};
