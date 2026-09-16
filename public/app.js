const STATUSES = ['todo', 'doing', 'blocked', 'done'];
const POLL_MS = 5000;

const boardEl = document.getElementById('board');
const addForm = document.getElementById('add-task-form');
const titleInput = document.getElementById('task-title');
const assigneeInput = document.getElementById('task-assignee');
const frequencyInput = document.getElementById('task-frequency');
const locationInput = document.getElementById('task-location');
const lossesBody = document.getElementById('losses-body');
const refreshLossesBtn = document.getElementById('refresh-losses');

let tasks = [];
let draggedId = null;

function fmtMoney(n) {
  return new Intl.NumberFormat('en-AU', { style: 'currency', currency: 'AUD' }).format(n);
}

function fmtRelativeTime(iso) {
  const diffMs = Date.now() - new Date(iso).getTime();
  const mins = Math.round(diffMs / 60000);
  if (mins < 1) return 'just now';
  if (mins < 60) return `${mins}m ago`;
  const hours = Math.round(mins / 60);
  if (hours < 24) return `${hours}h ago`;
  const days = Math.round(hours / 24);
  return `${days}d ago`;
}

function escapeHtml(str) {
  return String(str)
    .replace(/&/g, '&amp;')
    .replace(/</g, '&lt;')
    .replace(/>/g, '&gt;')
    .replace(/"/g, '&quot;');
}

// ---- Tasks / board ----

async function loadTasks() {
  const res = await fetch('/api/tasks');
  const data = await res.json();
  tasks = data.tasks || [];
  renderBoard();
}

function renderBoard() {
  const isEditing = document.activeElement === titleInput || document.activeElement === assigneeInput;

  for (const status of STATUSES) {
    const list = boardEl.querySelector(`.card-list[data-status="${status}"]`);
    const items = tasks.filter((t) => t.status === status);
    document.getElementById(`count-${status}`).textContent = items.length;

    if (items.length === 0) {
      list.innerHTML = '<div class="empty-column">Nothing here</div>';
      continue;
    }

    list.innerHTML = items
      .slice()
      .sort((a, b) => new Date(b.updatedAt) - new Date(a.updatedAt))
      .map((t) => renderCard(t))
      .join('');
  }

  // Re-attach listeners since innerHTML was replaced.
  boardEl.querySelectorAll('.card').forEach((card) => {
    card.addEventListener('dragstart', onDragStart);
    card.addEventListener('dragend', onDragEnd);
  });
  boardEl.querySelectorAll('[data-action]').forEach((btn) => {
    btn.addEventListener('click', onCardAction);
  });

  if (isEditing) document.activeElement?.focus?.();
}

const FREQUENCY_LABELS = { daily: 'Daily', weekly: 'Weekly', monthly: 'Monthly' };

function renderCard(task) {
  const meta = task.addedBy
    ? `${escapeHtml(task.addedBy)} · ${fmtRelativeTime(task.updatedAt)}`
    : fmtRelativeTime(task.updatedAt);

  const frequencyBadge = FREQUENCY_LABELS[task.frequency]
    ? `<span class="badge badge-${task.frequency}">↻ ${FREQUENCY_LABELS[task.frequency]}</span>`
    : '';

  const locationBadge = task.location
    ? `<span class="badge badge-location">📍 ${escapeHtml(task.location)}</span>`
    : '';

  const actions = [];
  if (task.status === 'todo') {
    actions.push(`<button class="btn btn-small" data-action="status" data-status="doing" data-id="${task.id}">Start</button>`);
    actions.push(`<button class="btn btn-small" data-action="block" data-id="${task.id}">Block</button>`);
  }
  if (task.status === 'doing') {
    actions.push(`<button class="btn btn-small" data-action="status" data-status="todo" data-id="${task.id}">Back to To Do</button>`);
    actions.push(`<button class="btn btn-small" data-action="status" data-status="done" data-id="${task.id}">Done</button>`);
    actions.push(`<button class="btn btn-small" data-action="block" data-id="${task.id}">Block</button>`);
  }
  if (task.status === 'blocked') {
    actions.push(`<button class="btn btn-small" data-action="status" data-status="doing" data-id="${task.id}">Unblock</button>`);
  }
  if (task.status === 'done') {
    actions.push(`<button class="btn btn-small" data-action="status" data-status="doing" data-id="${task.id}">Reopen</button>`);
  }
  actions.push(`<button class="btn btn-small" data-action="delete" data-id="${task.id}">Delete</button>`);

  const blockedNote = task.status === 'blocked' && task.blockedReason
    ? `<div class="blocked-reason">🚫 ${escapeHtml(task.blockedReason)}</div>`
    : '';

  return `
    <div class="card" draggable="true" data-id="${task.id}">
      <div class="card-title">${escapeHtml(task.title)} ${locationBadge} ${frequencyBadge}</div>
      <div class="card-meta">${meta}</div>
      ${blockedNote}
      <div class="card-actions">${actions.join('')}</div>
    </div>
  `;
}

async function onCardAction(e) {
  const id = e.currentTarget.dataset.id;
  const action = e.currentTarget.dataset.action;
  if (action === 'status') {
    await updateStatus(id, e.currentTarget.dataset.status);
  } else if (action === 'block') {
    const reason = prompt('Why is this item blocked?');
    if (reason && reason.trim()) await updateStatus(id, 'blocked', reason.trim());
  } else if (action === 'delete') {
    if (confirm('Delete this item?')) await deleteTask(id);
  }
}

async function updateStatus(id, status, reason) {
  const res = await fetch(`/api/tasks/${id}`, {
    method: 'PATCH',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({ status, reason }),
  });
  if (res.ok) await loadTasks();
  else if (res.status === 400) {
    const data = await res.json().catch(() => ({}));
    alert(data.error || 'Could not update item.');
  }
}

async function deleteTask(id) {
  const res = await fetch(`/api/tasks/${id}`, { method: 'DELETE' });
  if (res.ok || res.status === 404) await loadTasks();
}

addForm.addEventListener('submit', async (e) => {
  e.preventDefault();
  const title = titleInput.value.trim();
  if (!title) return;
  const res = await fetch('/api/tasks', {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({
      title,
      addedBy: assigneeInput.value.trim(),
      frequency: frequencyInput.value,
      location: locationInput.value,
    }),
  });
  if (res.ok) {
    titleInput.value = '';
    assigneeInput.value = '';
    frequencyInput.value = 'none';
    locationInput.value = '';
    await loadTasks();
    titleInput.focus();
  }
});

// Drag and drop between columns.

function onDragStart(e) {
  draggedId = e.currentTarget.dataset.id;
  e.currentTarget.classList.add('dragging');
  e.dataTransfer.effectAllowed = 'move';
}

function onDragEnd(e) {
  e.currentTarget.classList.remove('dragging');
  draggedId = null;
}

boardEl.querySelectorAll('.card-list').forEach((list) => {
  list.addEventListener('dragover', (e) => {
    e.preventDefault();
    list.classList.add('drag-over');
  });
  list.addEventListener('dragleave', () => list.classList.remove('drag-over'));
  list.addEventListener('drop', async (e) => {
    e.preventDefault();
    list.classList.remove('drag-over');
    if (!draggedId) return;
    const status = list.dataset.status;
    if (status === 'blocked') {
      const reason = prompt('Why is this item blocked?');
      if (reason && reason.trim()) await updateStatus(draggedId, 'blocked', reason.trim());
    } else {
      await updateStatus(draggedId, status);
    }
  });
});

// ---- Stock take losses ----

let lossesInFlight = false;

async function loadLosses(force) {
  if (lossesInFlight) return;
  lossesInFlight = true;
  if (force) {
    lossesBody.innerHTML = '<p class="muted">Refreshing… a cold Cin7 scan can take a minute or two.</p>';
  }
  try {
    const res = await fetch(force ? '/api/stock-losses/refresh' : '/api/stock-losses', {
      method: force ? 'POST' : 'GET',
    });
    const data = await res.json();
    renderLosses(data);
  } catch {
    lossesBody.innerHTML = '<div class="notice error">Could not load stock take losses.</div>';
  } finally {
    lossesInFlight = false;
  }
}

function renderLosses(data) {
  refreshLossesBtn.textContent = data.relayed ? 'Check for update' : 'Refresh';

  if (!data.configured) {
    lossesBody.innerHTML = `
      <div class="notice">
        Not connected to Cin7 Core yet. Add <code>CIN7_ACCOUNT_ID</code> and
        <code>CIN7_APPLICATION_KEY</code> to the server's <code>.env</code> file to enable this panel.
      </div>`;
    return;
  }

  if (data.error) {
    lossesBody.innerHTML = `<div class="notice error">${escapeHtml(data.error)}</div>`;
    return;
  }

  const rows = (data.entries || [])
    .map(
      (e) => `
      <tr>
        <td>${new Date(e.date).toLocaleDateString('en-AU')}</td>
        <td>${escapeHtml(e.stocktakeNumber)}</td>
        <td>${escapeHtml((e.locations || []).join(', '))}</td>
        <td>${escapeHtml(e.reference || e.comment || '')}</td>
        <td class="amount">${fmtMoney(e.lossAmount)}</td>
      </tr>`
    )
    .join('');

  const table = data.entries && data.entries.length
    ? `
      <table class="losses-table">
        <thead>
          <tr><th>Date</th><th>Stock take</th><th>State</th><th>Reference</th><th class="amount">Loss</th></tr>
        </thead>
        <tbody>${rows}</tbody>
      </table>`
    : '<p class="muted">No stock take losses in this period.</p>';

  // Gross loss per state — same basis as the "Loss" column in the table
  // below, so the two reconcile: summing this list equals summing the table.
  const maxLocationAmount = Math.max(1, ...(data.locationTotals || []).map((c) => c.amount));
  const categoryRows = (data.locationTotals || [])
    .map((c) => {
      return `
      <div class="category-row">
        <span class="category-name">${escapeHtml(c.state)}</span>
        <span class="category-bar-track">
          <span class="category-bar" style="width:${Math.max(4, (c.amount / maxLocationAmount) * 100)}%"></span>
        </span>
        <span class="category-amount">${fmtMoney(c.amount)}</span>
      </div>`;
    })
    .join('');

  const categoryBlock = data.locationTotals && data.locationTotals.length
    ? `
      <div class="category-breakdown">
        <h3>By state</h3>
        ${categoryRows}
      </div>`
    : '';

  const updated = data.generatedAt ? `Updated ${fmtRelativeTime(data.generatedAt)}` : '';
  const relayedNote = data.relayed ? ' · via local relay' : '';

  const worstSkuRows = (data.worstSkusThisWeek || [])
    .map(
      (s) => `
      <div class="sku-row">
        <span class="sku-name" title="${escapeHtml(s.sku)}">${escapeHtml(s.productName)}</span>
        <span class="sku-amount">${fmtMoney(s.amount)}</span>
      </div>`
    )
    .join('');

  const worstSkuBlock = data.worstSkusThisWeek && data.worstSkusThisWeek.length
    ? `
      <div class="worst-skus">
        <h3>Worst SKUs this week</h3>
        ${worstSkuRows}
      </div>`
    : '';

  lossesBody.innerHTML = `
    <div class="losses-summary">
      <span class="losses-total">${fmtMoney(data.totalLoss || 0)}</span>
      <span class="muted">lost in the last ${data.days} days · ${updated}${relayedNote}</span>
    </div>
    ${data.truncated ? '<p class="muted">Showing the most recent adjustments only.</p>' : ''}
    ${worstSkuBlock}
    ${categoryBlock}
    ${table}
  `;
}

refreshLossesBtn.addEventListener('click', () => loadLosses(true));

// ---- Boot ----

loadTasks();
loadLosses(false);
setInterval(loadTasks, POLL_MS);
setInterval(() => loadLosses(false), 5 * 60 * 1000);
