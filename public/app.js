const STATUSES = ['todo', 'doing', 'blocked', 'done'];
const POLL_MS = 5000;

const boardEl = document.getElementById('board');
const addForm = document.getElementById('add-task-form');
const titleInput = document.getElementById('task-title');
const authorInput = document.getElementById('task-author');
const frequencyInput = document.getElementById('task-frequency');
const lossesBody = document.getElementById('losses-body');
const refreshLossesBtn = document.getElementById('refresh-losses');

let tasks = [];
let draggedId = null;

function fmtMoney(n) {
  return new Intl.NumberFormat(undefined, { style: 'currency', currency: 'USD' }).format(n);
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
  const isEditing = document.activeElement === titleInput || document.activeElement === authorInput;

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
      <div class="card-title">${escapeHtml(task.title)} ${frequencyBadge}</div>
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
    body: JSON.stringify({ title, addedBy: authorInput.value.trim(), frequency: frequencyInput.value }),
  });
  if (res.ok) {
    titleInput.value = '';
    frequencyInput.value = 'none';
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
        <td>${new Date(e.date).toLocaleDateString()}</td>
        <td>${escapeHtml(e.stocktakeNumber)}</td>
        <td>${escapeHtml((e.categories || []).join(', '))}</td>
        <td>${escapeHtml(e.reference || e.comment || '')}</td>
        <td class="amount">${fmtMoney(e.lossAmount)}</td>
      </tr>`
    )
    .join('');

  const table = data.entries && data.entries.length
    ? `
      <table class="losses-table">
        <thead>
          <tr><th>Date</th><th>Stock take</th><th>Category</th><th>Reference</th><th class="amount">Loss</th></tr>
        </thead>
        <tbody>${rows}</tbody>
      </table>`
    : '<p class="muted">No stock take losses in this period.</p>';

  const maxCategoryAmount = Math.max(1, ...(data.categoryTotals || []).map((c) => c.amount));
  const categoryRows = (data.categoryTotals || [])
    .map(
      (c) => `
      <div class="category-row">
        <span class="category-name">${escapeHtml(c.category)}</span>
        <span class="category-bar-track">
          <span class="category-bar" style="width:${Math.max(4, (c.amount / maxCategoryAmount) * 100)}%"></span>
        </span>
        <span class="category-amount">${fmtMoney(c.amount)}</span>
      </div>`
    )
    .join('');

  const categoryBlock = data.categoryTotals && data.categoryTotals.length
    ? `<div class="category-breakdown">${categoryRows}</div>`
    : '';

  const updated = data.generatedAt ? `Updated ${fmtRelativeTime(data.generatedAt)}` : '';
  const relayedNote = data.relayed ? ' · via local relay' : '';

  const totalGain = data.totalGain || 0;
  const netAmount = data.netAmount ?? -(data.totalLoss || 0);
  const netClass = netAmount < 0 ? 'net-negative' : 'net-positive';
  const netLabel = netAmount < 0 ? 'net loss' : 'net gain';

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
    <div class="losses-net">
      <span class="muted">Gained back ${fmtMoney(totalGain)} over the same period</span>
      <span class="net-badge ${netClass}">${fmtMoney(Math.abs(netAmount))} ${netLabel}</span>
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
