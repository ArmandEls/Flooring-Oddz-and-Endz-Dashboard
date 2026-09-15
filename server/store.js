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

const STATUSES = ['todo', 'doing', 'done'];

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

function listTasks() {
  return readAll().tasks;
}

function addTask({ title, addedBy }) {
  return withLock(() => {
    const data = readAll();
    const now = new Date().toISOString();
    const task = {
      id: nanoid(10),
      title: String(title).trim(),
      status: 'todo',
      addedBy: addedBy ? String(addedBy).trim().slice(0, 60) : '',
      createdAt: now,
      updatedAt: now,
    };
    data.tasks.push(task);
    writeAll(data);
    return task;
  });
}

function updateTaskStatus(id, status) {
  if (!STATUSES.includes(status)) {
    const err = new Error('invalid_status');
    err.code = 'invalid_status';
    throw err;
  }
  return withLock(() => {
    const data = readAll();
    const task = data.tasks.find((t) => t.id === id);
    if (!task) return null;
    task.status = status;
    task.updatedAt = new Date().toISOString();
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

module.exports = { STATUSES, listTasks, addTask, updateTaskStatus, deleteTask };
