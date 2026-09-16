const fs = require('fs');
const path = require('path');
const { DATA_DIR } = require('./store');

// Where the last known-good stock-losses payload is persisted, whether it
// came from a direct Cin7 fetch on this instance or from the relay push
// (see README: "Cin7 blocked from Render" workaround). Surviving restarts
// matters because the relay only pushes every so often.
const CACHE_FILE = path.join(DATA_DIR, 'losses-cache.json');

function read() {
  try {
    const raw = fs.readFileSync(CACHE_FILE, 'utf8');
    return JSON.parse(raw);
  } catch {
    return null;
  }
}

function write(data) {
  if (!fs.existsSync(DATA_DIR)) fs.mkdirSync(DATA_DIR, { recursive: true });
  const tmpFile = `${CACHE_FILE}.${process.pid}.tmp`;
  fs.writeFileSync(tmpFile, JSON.stringify(data, null, 2));
  fs.renameSync(tmpFile, CACHE_FILE);
}

module.exports = { read, write };
