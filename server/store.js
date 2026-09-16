const fs = require('fs');
const path = require('path');
const { nanoid } = require('nanoid');

// Overridable so a deploy target with a persistent disk (e.g. Render) can
// point this at the disk's mount path instead of the app's own directory,
// which usually doesn't survive restarts/redeploys.
const DATA_DIR = process.env.DATA_DIR
  ? path.resolve(process.env.DATA_DIR)
  : path.join(__dirname, '..', 'data');
const DATA_FILE = path.join(DATA_DIR, 'tasks.json');

const STATUSES = ['todo', 'doing', 'blocked', 'done'];
const FREQUENCIES = ['none', 'daily', 'weekly', 'monthly'];

function ensureDataFile() {
  if (!fs.existsSync(DATA_DIR)) fs.mkdirSync(DATA_DIR, { recursive: true });
  if (!fs.existsSync(DATA_FILE)) {
    fs.writeFileSync(DATA_FILE, JSON.stringify({ tasks: [] }, null, 2));
  }
}

function readAll() {
  ensureDataFile();
  const raw = fs.readFileSync(DATA_FILE, 'utf8');
  try {
    const parsed = JSON.parse(raw);
    if (!Array.isArray(parsed.tasks)) return { tasks: [] };
    return parsed;
  } catch {
    return { tasks: [] };
  }
}

function writeAll(data) {
  const tmpFile = `${DATA_FILE}.${process.pid}.tmp`;
  fs.writeFileSync(tmpFile, JSON.stringify(data, null, 2));
  fs.renameSync(tmpFile, DATA_FILE);
}

// Serialize writes so concurrent requests can't interleave and corrupt the file.
let writeQueue = Promise.resolve();
function withLock(fn) {
  const result = writeQueue.then(fn, fn);
  writeQueue = result.catch(() => {});
  return result;
}

// --- Recurring task resets -------------------------------------------------
// A daily/weekly/monthly task that's marked Done moves itself back to To Do
// once the next period starts, so the board doesn't need anyone to
// manually "re-add" the same chore. Resets are computed lazily whenever
// tasks are read/listed, rather than needing a background cron.

function isoWeekKey(date) {
  const d = new Date(Date.UTC(date.getFullYear(), date.getMonth(), date.getDate()));
  const dayNum = d.getUTCDay() || 7;
  d.setUTCDate(d.getUTCDate() + 4 - dayNum);
  const yearStart = new Date(Date.UTC(d.getUTCFullYear(), 0, 1));
  const weekNo = Math.ceil(((d - yearStart) / 86400000 + 1) / 7);
  return `${d.getUTCFullYear()}-W${weekNo}`;
}

function periodKey(frequency, date) {
  if (frequency === 'daily') return date.toISOString().slice(0, 10);
  if (frequency === 'weekly') return isoWeekKey(date);
  if (frequency === 'monthly') return `${date.getFullYear()}-${date.getMonth()}`;
  return null;
}

// Mutates tasks in place; returns true if anything changed (so callers can
// decide whether a write is needed).
function applyRecurringResets(tasks) {
  const now = new Date();
  let changed = false;
  for (const task of tasks) {
    if (task.status !== 'done' || !task.frequency || task.frequency === 'none') continue;
    const completedAt = task.lastCompletedAt ? new Date(task.lastCompletedAt) : null;
    if (!completedAt) continue;
    if (periodKey(task.frequency, completedAt) !== periodKey(task.frequency, now)) {
      task.status = 'todo';
      task.lastCompletedAt = null;
      task.updatedAt = now.toISOString();
      changed = true;
    }
  }
  return changed;
}

function listTasks() {
  const data = readAll();
  if (applyRecurringResets(data.tasks)) writeAll(data);
  return data.tasks;
}

function addTask({ title, addedBy, frequency }) {
  return withLock(() => {
    const data = readAll();
    const now = new Date().toISOString();
    const task = {
      id: nanoid(10),
      title: String(title).trim(),
      status: 'todo',
      addedBy: addedBy ? String(addedBy).trim().slice(0, 60) : '',
      frequency: FREQUENCIES.includes(frequency) ? frequency : 'none',
      lastCompletedAt: null,
      blockedReason: null,
      createdAt: now,
      updatedAt: now,
    };
    data.tasks.push(task);
    writeAll(data);
    return task;
  });
}

function updateTaskStatus(id, status, reason) {
  if (!STATUSES.includes(status)) {
    const err = new Error('invalid_status');
    err.code = 'invalid_status';
    throw err;
  }
  if (status === 'blocked' && !(reason && String(reason).trim())) {
    const err = new Error('blocked_reason_required');
    err.code = 'blocked_reason_required';
    throw err;
  }
  return withLock(() => {
    const data = readAll();
    const task = data.tasks.find((t) => t.id === id);
    if (!task) return null;
    const now = new Date().toISOString();
    task.status = status;
    task.lastCompletedAt = status === 'done' ? now : null;
    task.blockedReason = status === 'blocked' ? String(reason).trim().slice(0, 300) : null;
    task.updatedAt = now;
    writeAll(data);
    return task;
  });
}

function deleteTask(id) {
  return withLock(() => {
    const data = readAll();
    const before = data.tasks.length;
    data.tasks = data.tasks.filter((t) => t.id !== id);
    writeAll(data);
    return data.tasks.length !== before;
  });
}

module.exports = {
  STATUSES,
  FREQUENCIES,
  listTasks,
  addTask,
  updateTaskStatus,
  deleteTask,
  DATA_DIR,
};
