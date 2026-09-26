const fs = require('fs');
const path = require('path');

const DATA_DIR = path.join(__dirname, 'data');
const FILE = path.join(DATA_DIR, 'matches.json');

function ensure() {
  if (!fs.existsSync(DATA_DIR)) fs.mkdirSync(DATA_DIR, { recursive: true });
  if (!fs.existsSync(FILE)) fs.writeFileSync(FILE, '[]');
}

function readMatches() {
  ensure();
  try { return JSON.parse(fs.readFileSync(FILE, 'utf8')); }
  catch { return []; }
}

function addMatch(match) {
  ensure();
  const matches = readMatches();
  matches.unshift(match);
  fs.writeFileSync(FILE, JSON.stringify(matches.slice(0, 200), null, 2));
}

module.exports = { readMatches, addMatch };