// api/history.js — intentionally disabled.
// Match history is private: each browser keeps its own list in localStorage,
// so nothing is served from the shared database.
'use strict';

module.exports = async function handler(req, res) {
  res.status(200).json([]);
};
