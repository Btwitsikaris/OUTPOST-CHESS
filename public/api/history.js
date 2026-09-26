// api/history.js — GET /api/history : recent completed matches
'use strict';
const { readHistory } = require('../lib/roomStore.js');

module.exports = async function handler(req, res) {
  res.setHeader('Access-Control-Allow-Origin', '*');
  try {
    const matches = await readHistory(20);
    res.status(200).json(matches);
  } catch (err) {
    console.error('api/history error:', err);
    res.status(500).json({ error: 'Could not load match history.' });
  }
};