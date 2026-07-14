// ===== STATE =====
const DAYS = ['Monday', 'Tuesday', 'Wednesday', 'Thursday', 'Friday', 'Saturday', 'Sunday'];
const HOURS = Array.from({ length: 17 }, (_, i) => i + 6); // 6am - 10pm

let state = loadState();
let currentDay = null;
let draggedTask = null;
let dragSource = null; // { type: 'column'|'slot'|'unscheduled', dayIndex, hour }
let activeTimer = null; // { taskId, startTime, elapsed, interval, paused }
let editingTaskId = null;
let selectedPriority = 'medium';

// ===== PERSISTENCE =====
function loadState() {
  try {
    const saved = localStorage.getItem('focusflow_state');
    if (saved) return JSON.parse(saved);
  } catch (e) {}
  return {
    tasks: [],
    totalXP: 0,
    streak: 0,
    lastActiveDate: null,
    totalTimeWorked: 0, // seconds
  };
}

function saveState() {
  localStorage.setItem('focusflow_state', JSON.stringify(state));
}

function generateId() {
  return Math.random().toString(36).slice(2, 10) + Date.now().toString(36);
}

// ===== DATE HELPERS =====
function getWeekDates() {
  const now = new Date();
  const day = now.getDay(); // 0=Sun
  const monday = new Date(now);
  monday.setDate(now.getDate() - ((day + 6) % 7));
  return DAYS.map((_, i) => {
    const d = new Date(monday);
    d.setDate(monday.getDate() + i);
    return d;
  });
}

const weekDates = getWeekDates();

function getTodayIndex() {
  const today = new Date();
  const day = today.getDay();
  return (day + 6) % 7; // Mon=0
}

function formatDate(d) {
  return d.toLocaleDateString('en-US', { month: 'short', day: 'numeric' });
}

function formatTime(seconds) {
  const h = Math.floor(seconds / 3600);
  const m = Math.floor((seconds % 3600) / 60);
  if (h > 0) return `${h}h ${m}m`;
  return `${m}m`;
}

function formatEstimate(hours, minutes) {
  if (hours > 0 && minutes > 0) return `${hours}h ${minutes}m`;
  if (hours > 0) return `${hours}h`;
  if (minutes > 0) return `${minutes}m`;
  return '';
}

// Returns the week column index (0=Mon…6=Sun) for a YYYY-MM-DD string,
// or null if the date falls outside the current week.
function dueDateToWeekIndex(dateStr) {
  if (!dateStr) return null;
  const [y, m, d] = dateStr.split('-').map(Number);
  const due = new Date(y, m - 1, d);
  for (let i = 0; i < 7; i++) {
    const wd = weekDates[i];
    if (
      due.getFullYear() === wd.getFullYear() &&
      due.getMonth() === wd.getMonth() &&
      due.getDate() === wd.getDate()
    ) return i;
  }
  return null;
}

// Format a YYYY-MM-DD string for display, e.g. "Jun 3"
function formatDueDateStr(dateStr) {
  if (!dateStr) return '';
  const [y, m, d] = dateStr.split('-').map(Number);
  return new Date(y, m - 1, d).toLocaleDateString('en-US', { month: 'short', day: 'numeric' });
}

// Is the due date today or in the past (and task not complete)?
function isDueOverdue(dateStr) {
  if (!dateStr) return false;
  const [y, m, d] = dateStr.split('-').map(Number);
  const due = new Date(y, m - 1, d);
  const today = new Date();
  today.setHours(0, 0, 0, 0);
  return due < today;
}

function getTasksForDay(dayIndex) {
  return state.tasks.filter(t => t.dayIndex === dayIndex);
}

function getTask(id) {
  return state.tasks.find(t => t.id === id);
}

function updateTask(id, updates) {
  const idx = state.tasks.findIndex(t => t.id === id);
  if (idx !== -1) {
    state.tasks[idx] = { ...state.tasks[idx], ...updates };
    saveState();
  }
}

// ===== XP SYSTEM =====
const XP_VALUES = { complete: 20, start: 5, high: 10, medium: 5, low: 2 };

function awardXP(amount, label) {
  state.totalXP += amount;
  saveState();
  showXPToast(`+${amount} XP — ${label}! ⭐`);
  updateHeaderStats();
}

function showXPToast(msg) {
  const toast = document.getElementById('xp-toast');
  toast.textContent = msg;
  toast.classList.add('show');
  setTimeout(() => toast.classList.remove('show'), 2200);
}

// ===== CONFETTI =====
function launchConfetti() {
  const canvas = document.getElementById('confetti-canvas');
  const ctx = canvas.getContext('2d');
  canvas.width = window.innerWidth;
  canvas.height = window.innerHeight;

  const colors = ['#7c3aed', '#06b6d4', '#f59e0b', '#22c55e', '#ef4444', '#a78bfa', '#67e8f9'];
  const pieces = Array.from({ length: 80 }, () => ({
    x: Math.random() * canvas.width,
    y: -10,
    r: Math.random() * 6 + 3,
    color: colors[Math.floor(Math.random() * colors.length)],
    vx: (Math.random() - 0.5) * 4,
    vy: Math.random() * 4 + 2,
    rot: Math.random() * 360,
    rotV: (Math.random() - 0.5) * 8,
    shape: Math.random() > 0.5 ? 'rect' : 'circle',
  }));

  let frame = 0;
  function draw() {
    ctx.clearRect(0, 0, canvas.width, canvas.height);
    pieces.forEach(p => {
      ctx.save();
      ctx.translate(p.x, p.y);
      ctx.rotate((p.rot * Math.PI) / 180);
      ctx.fillStyle = p.color;
      if (p.shape === 'rect') {
        ctx.fillRect(-p.r, -p.r / 2, p.r * 2, p.r);
      } else {
        ctx.beginPath();
        ctx.arc(0, 0, p.r, 0, Math.PI * 2);
        ctx.fill();
      }
      ctx.restore();
      p.x += p.vx;
      p.y += p.vy;
      p.rot += p.rotV;
      p.vy += 0.08;
    });
    frame++;
    if (frame < 90) requestAnimationFrame(draw);
    else ctx.clearRect(0, 0, canvas.width, canvas.height);
  }
  draw();
}

// ===== RENDER WEEK VIEW =====
function renderWeekView() {
  const board = document.getElementById('board');
  board.innerHTML = '';
  const todayIdx = getTodayIndex();

  DAYS.forEach((day, i) => {
    const tasks = getTasksForDay(i);
    const done = tasks.filter(t => t.completed).length;
    const pct = tasks.length ? Math.round((done / tasks.length) * 100) : 0;

    const col = document.createElement('div');
    col.className = 'column' + (i === todayIdx ? ' today' : '');
    col.dataset.dayIndex = i;

    col.innerHTML = `
      <div class="column-header" data-day-index="${i}">
        <div class="column-day-name">
          ${day} ${i === todayIdx ? '🌟' : ''}
          <span class="day-arrow">→</span>
        </div>
        <div class="column-date">${formatDate(weekDates[i])}</div>
        <div class="column-meta">
          <div class="col-progress-bar">
            <div class="col-progress-fill" style="width:${pct}%"></div>
          </div>
          <span class="col-task-count">${done}/${tasks.length}</span>
        </div>
      </div>
      <div class="task-list" id="task-list-${i}" data-day-index="${i}"></div>
      <button class="col-add-btn" data-day-index="${i}">+ Add task</button>
    `;

    board.appendChild(col);

    // Render tasks assigned to this day
    const list = col.querySelector(`#task-list-${i}`);

    // Tasks due on this day but assigned to a different day
    const dueTasks = state.tasks.filter(t =>
      t.dayIndex !== i && dueDateToWeekIndex(t.dueDate) === i
    );

    const hasOwn = tasks.length > 0;
    const hasDue = dueTasks.length > 0;

    if (!hasOwn && !hasDue) {
      list.innerHTML = `<div class="empty-state"><div class="empty-icon">📭</div>No tasks yet</div>`;
    } else {
      tasks.forEach(task => list.appendChild(createTaskCard(task, 'column')));
      if (hasDue) {
        const divider = document.createElement('div');
        divider.className = 'due-divider';
        divider.textContent = '📅 Due today';
        list.appendChild(divider);
        dueTasks.forEach(task => list.appendChild(createDueCard(task)));
      }
    }

    // Column header click → day view
    col.querySelector('.column-header').addEventListener('click', () => openDayView(i));

    // Add task button
    col.querySelector('.col-add-btn').addEventListener('click', (e) => {
      e.stopPropagation();
      openModal(null, i);
    });

    // Drop zone
    setupDropZone(list, { type: 'column', dayIndex: i });
  });

  updateHeaderStats();
}

// ===== TASK CARD =====
function createTaskCard(task, context) {
  const card = document.createElement('div');
  card.className = 'task-card' + (task.completed ? ' completed' : '') + (activeTimer && activeTimer.taskId === task.id ? ' active-timer' : '');
  card.dataset.taskId = task.id;
  card.dataset.priority = task.priority;
  card.draggable = true;

  const est = formatEstimate(task.estHours || 0, task.estMinutes || 0);
  const dueBadge = task.dueDate
    ? `<span class="task-badge ${isDueOverdue(task.dueDate) && !task.completed ? 'badge-overdue' : 'badge-due'}">📅 ${formatDueDateStr(task.dueDate)}</span>`
    : '';

  card.innerHTML = `
    <div class="task-name">${escapeHtml(task.name)}</div>
    <div class="task-meta">
      <span class="task-badge badge-${task.priority}">${priorityLabel(task.priority)}</span>
      ${est ? `<span class="task-badge badge-time">⏱ ${est}</span>` : ''}
      ${task.timeSpent > 0 ? `<span class="task-badge badge-time">🕐 ${formatTime(task.timeSpent)}</span>` : ''}
      ${dueBadge}
    </div>
    <div class="task-actions">
      ${!task.completed ? `<button class="task-btn btn-start" data-id="${task.id}">${activeTimer && activeTimer.taskId === task.id ? '⏸ Pause' : '▶ Start'}</button>` : ''}
      <button class="task-btn btn-complete" data-id="${task.id}">${task.completed ? '↩ Undo' : '✓ Done'}</button>
      <button class="task-btn btn-edit" data-id="${task.id}">✏</button>
      <button class="task-btn btn-delete" data-id="${task.id}">🗑</button>
    </div>
  `;

  // Drag
  card.addEventListener('dragstart', (e) => {
    draggedTask = task.id;
    dragSource = context === 'column'
      ? { type: 'column', dayIndex: task.dayIndex }
      : context === 'slot'
      ? { type: 'slot', dayIndex: task.dayIndex, hour: task.scheduledHour }
      : { type: 'unscheduled', dayIndex: task.dayIndex };
    card.classList.add('dragging');
    e.dataTransfer.effectAllowed = 'move';
  });
  card.addEventListener('dragend', () => card.classList.remove('dragging'));

  // Buttons
  card.querySelector('.btn-complete')?.addEventListener('click', (e) => {
    e.stopPropagation();
    toggleComplete(task.id);
  });

  card.querySelector('.btn-start')?.addEventListener('click', (e) => {
    e.stopPropagation();
    handleStartTimer(task.id);
  });

  card.querySelector('.btn-edit')?.addEventListener('click', (e) => {
    e.stopPropagation();
    openModal(task.id);
  });

  card.querySelector('.btn-delete')?.addEventListener('click', (e) => {
    e.stopPropagation();
    deleteTask(task.id);
  });

  return card;
}

function priorityLabel(p) {
  return p === 'high' ? '🔴 High' : p === 'medium' ? '🟡 Med' : '🟢 Low';
}

// ===== DUE-DATE GHOST CARD =====
// Shows a task on its due day even though it's assigned to a different day.
function createDueCard(task) {
  const overdue = isDueOverdue(task.dueDate) && !task.completed;
  const card = document.createElement('div');
  card.className = 'task-card due-ghost' + (task.completed ? ' completed' : '') + (overdue ? ' overdue' : '');
  card.dataset.taskId = task.id;
  card.dataset.priority = task.priority;
  // Not draggable — it's a reference, not the real card
  card.draggable = false;

  const assignedDay = DAYS[task.dayIndex];
  const est = formatEstimate(task.estHours || 0, task.estMinutes || 0);

  card.innerHTML = `
    <div class="task-name">${escapeHtml(task.name)}</div>
    <div class="task-meta">
      <span class="task-badge badge-${task.priority}">${priorityLabel(task.priority)}</span>
      ${est ? `<span class="task-badge badge-time">⏱ ${est}</span>` : ''}
      <span class="task-badge badge-assigned">📌 ${assignedDay}</span>
    </div>
    <div class="due-ghost-note">${overdue ? '⚠️ Overdue' : '📅 Due today'} · click to edit</div>
  `;

  card.addEventListener('click', () => openModal(task.id));
  return card;
}

function escapeHtml(str) {
  return str.replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;');
}

// ===== COMPLETE TASK =====
function toggleComplete(taskId) {
  const task = getTask(taskId);
  if (!task) return;

  if (!task.completed) {
    // Stop timer if running
    if (activeTimer && activeTimer.taskId === taskId) stopTimer(false);

    updateTask(taskId, { completed: true });
    const bonus = XP_VALUES.complete + (task.priority === 'high' ? XP_VALUES.high : task.priority === 'medium' ? XP_VALUES.medium : XP_VALUES.low);
    awardXP(bonus, 'Task complete');
    launchConfetti();
  } else {
    updateTask(taskId, { completed: false });
  }

  rerender();
}

// ===== DELETE TASK =====
function deleteTask(taskId) {
  if (activeTimer && activeTimer.taskId === taskId) stopTimer(false);
  state.tasks = state.tasks.filter(t => t.id !== taskId);
  saveState();
  rerender();
}


function handleStartTimer(taskId) {
  if (activeTimer && activeTimer.taskId === taskId) {
    // Toggle pause
    if (activeTimer.paused) resumeTimer();
    else pauseTimer();
    return;
  }
  if (activeTimer) stopTimer(false);
  startTimer(taskId);
}

function startTimer(taskId) {
  const task = getTask(taskId);
  if (!task) return;

  awardXP(XP_VALUES.start, 'Task started');

  activeTimer = {
    taskId,
    startTime: Date.now(),
    paused: false,
  };

  showTimerWidget(task);
  rerender();
}

function tickTimer() {
  if (!activeTimer || activeTimer.paused) return;
  updateTimerDisplay();
}

function pauseTimer() {
  if (!activeTimer) return;
  const task = getTask(activeTimer.taskId);
  if (task && !activeTimer.paused) {
    const added = Math.floor((Date.now() - activeTimer.startTime) / 1000);
    updateTask(activeTimer.taskId, { timeSpent: (task.timeSpent || 0) + added });
    state.totalTimeWorked = (state.totalTimeWorked || 0) + added;
    saveState();
  }
  activeTimer.paused = true;
  document.getElementById('timer-pause').textContent = '▶';
  rerender();
}

function resumeTimer() {
  if (!activeTimer) return;
  activeTimer.paused = false;
  activeTimer.startTime = Date.now();
  document.getElementById('timer-pause').textContent = '⏸';
  rerender();
}

function stopTimer(complete = false) {
  if (!activeTimer) return;

  const task = getTask(activeTimer.taskId);
  if (task && !activeTimer.paused) {
    const added = Math.floor((Date.now() - activeTimer.startTime) / 1000);
    updateTask(activeTimer.taskId, { timeSpent: (task.timeSpent || 0) + added });
    state.totalTimeWorked = (state.totalTimeWorked || 0) + added;
    saveState();
  }

  activeTimer = null;
  document.getElementById('timer-widget').style.display = 'none';
  rerender();
}

function showTimerWidget(task) {
  const widget = document.getElementById('timer-widget');
  widget.style.display = 'block';
  document.getElementById('timer-task-name').textContent = task.name;
  document.getElementById('timer-pause').textContent = '⏸';
  updateTimerDisplay();
}

function updateTimerDisplay() {
  if (!activeTimer) return;
  const task = getTask(activeTimer.taskId);
  const base = task ? (task.timeSpent || 0) : 0;
  const current = activeTimer.paused ? base : base + Math.floor((Date.now() - activeTimer.startTime) / 1000);

  const m = Math.floor(current / 60);
  const s = current % 60;
  document.getElementById('timer-display').textContent =
    `${String(m).padStart(2, '0')}:${String(s).padStart(2, '0')}`;

  // Ring animation — based on estimated time
  const ring = document.getElementById('ring-fill');
  const circumference = 276.46;
  if (task && (task.estHours || task.estMinutes)) {
    const estSecs = (task.estHours || 0) * 3600 + (task.estMinutes || 0) * 60;
    const pct = Math.min(current / estSecs, 1);
    ring.style.strokeDashoffset = circumference * (1 - pct);
    ring.style.stroke = pct > 0.9 ? '#ef4444' : pct > 0.7 ? '#f59e0b' : '#06b6d4';
  } else {
    ring.style.strokeDashoffset = 0;
  }
}

// ===== HEADER STATS =====
function updateHeaderStats() {
  const all = state.tasks;
  const done = all.filter(t => t.completed).length;
  const pct = all.length ? Math.round((done / all.length) * 100) : 0;

  document.getElementById('total-xp').textContent = state.totalXP;
  document.getElementById('tasks-done').textContent = done;
  document.getElementById('tasks-total').textContent = all.length;
  document.getElementById('completion-pct').textContent = pct + '%';
  document.getElementById('time-worked').textContent = formatTime(state.totalTimeWorked || 0);
  document.getElementById('streak-count').textContent = state.streak || 0;

  const fill = document.getElementById('weekly-progress-fill');
  fill.style.width = pct + '%';
  document.getElementById('weekly-progress-label').textContent = pct + '% complete';
}

// ===== MODAL =====
function openModal(taskId, defaultDayIndex) {
  editingTaskId = taskId;
  const modal = document.getElementById('task-modal');
  const task = taskId ? getTask(taskId) : null;

  document.getElementById('modal-title').textContent = task ? 'Edit Task' : 'New Task';
  document.getElementById('task-name-input').value = task ? task.name : '';
  document.getElementById('task-notes').value = task ? (task.notes || '') : '';
  document.getElementById('task-hours').value = task ? (task.estHours || 0) : 0;
  document.getElementById('task-minutes').value = task ? (task.estMinutes || 30) : 30;
  document.getElementById('task-due-date').value = task ? (task.dueDate || '') : '';

  // Day select
  const sel = document.getElementById('task-day-select');
  sel.innerHTML = DAYS.map((d, i) => `<option value="${i}" ${(task ? task.dayIndex : defaultDayIndex) === i ? 'selected' : ''}>${d} — ${formatDate(weekDates[i])}</option>`).join('');

  // Priority
  selectedPriority = task ? task.priority : 'medium';
  document.querySelectorAll('.priority-btn').forEach(btn => {
    btn.classList.toggle('selected', btn.dataset.priority === selectedPriority);
  });

  modal.style.display = 'flex';
  setTimeout(() => document.getElementById('task-name-input').focus(), 50);
}

function closeModal() {
  document.getElementById('task-modal').style.display = 'none';
  editingTaskId = null;
}

function saveModal() {
  const name = document.getElementById('task-name-input').value.trim();
  if (!name) {
    document.getElementById('task-name-input').style.borderColor = '#ef4444';
    setTimeout(() => document.getElementById('task-name-input').style.borderColor = '', 1000);
    return;
  }

  const dayIndex = parseInt(document.getElementById('task-day-select').value);
  const estHours = parseInt(document.getElementById('task-hours').value) || 0;
  const estMinutes = parseInt(document.getElementById('task-minutes').value) || 0;
  const notes = document.getElementById('task-notes').value.trim();
  const dueDate = document.getElementById('task-due-date').value || null;

  if (editingTaskId) {
    updateTask(editingTaskId, { name, dayIndex, priority: selectedPriority, estHours, estMinutes, notes, dueDate });
  } else {
    const newTask = {
      id: generateId(),
      name,
      dayIndex,
      priority: selectedPriority,
      estHours,
      estMinutes,
      notes,
      dueDate,
      completed: false,
      timeSpent: 0,
      scheduledHour: null,
      createdAt: Date.now(),
    };
    state.tasks.push(newTask);
    saveState();
    showXPToast('Task added! 📝');
  }

  closeModal();
  rerender();
}

// ===== ADD FROM VOICE / PARSER =====
// draft: { name, dayIndex, dueDate|null, priority, estHours, estMinutes }
function addTaskFromDraft(draft) {
  const task = {
    id: generateId(),
    name: draft.name,
    dayIndex: Math.max(0, Math.min(6, draft.dayIndex ?? getTodayIndex())),
    priority: ['high', 'medium', 'low'].includes(draft.priority) ? draft.priority : 'medium',
    estHours: draft.estHours || 0,
    estMinutes: draft.estMinutes || 0,
    notes: '',
    dueDate: draft.dueDate || null,
    completed: false,
    timeSpent: 0,
    scheduledHour: null,
    createdAt: Date.now(),
  };
  state.tasks.push(task);
  saveState();
  return task;
}

// ===== DRAG & DROP =====
function setupDropZone(el, target) {
  el.addEventListener('dragover', (e) => {
    e.preventDefault();
    el.classList.add('drag-over');
    // Also add to parent column if applicable
    const col = el.closest('.column');
    if (col) col.classList.add('drag-over');
  });

  el.addEventListener('dragleave', (e) => {
    if (!el.contains(e.relatedTarget)) {
      el.classList.remove('drag-over');
      const col = el.closest('.column');
      if (col) col.classList.remove('drag-over');
    }
  });

  el.addEventListener('drop', (e) => {
    e.preventDefault();
    el.classList.remove('drag-over');
    const col = el.closest('.column');
    if (col) col.classList.remove('drag-over');

    if (!draggedTask) return;

    if (target.type === 'column') {
      updateTask(draggedTask, { dayIndex: target.dayIndex, scheduledHour: null });
    } else if (target.type === 'slot') {
      updateTask(draggedTask, { dayIndex: target.dayIndex, scheduledHour: target.hour });
    } else if (target.type === 'unscheduled') {
      updateTask(draggedTask, { scheduledHour: null });
    }

    draggedTask = null;
    dragSource = null;
    rerender();
  });
}

// ===== DAY VIEW =====
function openDayView(dayIndex) {
  currentDay = dayIndex;
  document.getElementById('app-week').classList.remove('active');
  document.getElementById('app-day').classList.add('active');
  document.getElementById('day-title').textContent = `${DAYS[dayIndex]} — ${formatDate(weekDates[dayIndex])}`;
  renderDayView(dayIndex);
}

function closeDayView() {
  document.getElementById('app-day').classList.remove('active');
  document.getElementById('app-week').classList.add('active');
  currentDay = null;
  renderWeekView();
}

function renderDayView(dayIndex) {
  const tasks = getTasksForDay(dayIndex);
  const done = tasks.filter(t => t.completed).length;
  const pct = tasks.length ? Math.round((done / tasks.length) * 100) : 0;

  document.getElementById('day-done').textContent = done;
  document.getElementById('day-total').textContent = tasks.length;
  document.getElementById('day-progress-fill').style.width = pct + '%';
  document.getElementById('day-progress-label').textContent = pct + '% complete';

  const dayXP = tasks.filter(t => t.completed).reduce((acc, t) => {
    return acc + XP_VALUES.complete + (t.priority === 'high' ? XP_VALUES.high : t.priority === 'medium' ? XP_VALUES.medium : XP_VALUES.low);
  }, 0);
  document.getElementById('day-xp').textContent = dayXP;

  const dayTime = tasks.reduce((acc, t) => acc + (t.timeSpent || 0), 0);
  document.getElementById('day-time').textContent = formatTime(dayTime);

  // Time slots
  const timeCol = document.getElementById('time-column');
  timeCol.innerHTML = '';

  HOURS.forEach(hour => {
    const slotTasks = tasks.filter(t => t.scheduledHour === hour);
    const label = hour < 12 ? `${hour}am` : hour === 12 ? '12pm' : `${hour - 12}pm`;

    const slot = document.createElement('div');
    slot.className = 'time-slot';
    slot.dataset.hour = hour;

    const content = document.createElement('div');
    content.className = 'slot-content';
    content.id = `slot-${hour}`;

    slotTasks.forEach(t => content.appendChild(createTaskCard(t, 'slot')));

    slot.innerHTML = `<div class="time-label">${label}</div>`;
    slot.appendChild(content);
    timeCol.appendChild(slot);

    setupDropZone(content, { type: 'slot', dayIndex, hour });
    setupDropZone(slot, { type: 'slot', dayIndex, hour });
  });

  // Unscheduled
  const unscheduled = tasks.filter(t => t.scheduledHour === null || t.scheduledHour === undefined);
  const unList = document.getElementById('unscheduled-list');
  unList.innerHTML = '';

  if (unscheduled.length === 0) {
    unList.innerHTML = `<div class="empty-state"><div class="empty-icon">🎉</div>All tasks scheduled!</div>`;
  } else {
    unscheduled.forEach(t => unList.appendChild(createTaskCard(t, 'unscheduled')));
  }

  setupDropZone(unList, { type: 'unscheduled', dayIndex });
}

// ===== RERENDER =====
function rerender() {
  if (currentDay !== null) {
    renderDayView(currentDay);
    updateHeaderStats();
  } else {
    renderWeekView();
  }
}

// ===== INIT =====
function init() {
  // Week label
  const now = new Date();
  document.getElementById('week-label').textContent =
    `Week of ${formatDate(weekDates[0])} – ${formatDate(weekDates[6])}`;

  // Render
  renderWeekView();

  // Quick add button
  document.getElementById('btn-open-quick-add').addEventListener('click', () => openModal(null, getTodayIndex()));

  // Back button
  document.getElementById('btn-back').addEventListener('click', closeDayView);

  // Modal events
  document.getElementById('modal-close').addEventListener('click', closeModal);
  document.getElementById('modal-cancel').addEventListener('click', closeModal);
  document.getElementById('modal-save').addEventListener('click', saveModal);

  document.getElementById('task-name-input').addEventListener('keydown', (e) => {
    if (e.key === 'Enter') saveModal();
    if (e.key === 'Escape') closeModal();
  });

  document.getElementById('task-modal').addEventListener('click', (e) => {
    if (e.target === document.getElementById('task-modal')) closeModal();
  });

  // Priority picker
  document.querySelectorAll('.priority-btn').forEach(btn => {
    btn.addEventListener('click', () => {
      selectedPriority = btn.dataset.priority;
      document.querySelectorAll('.priority-btn').forEach(b => b.classList.remove('selected'));
      btn.classList.add('selected');
    });
  });

  // Timer widget controls
  document.getElementById('timer-pause').addEventListener('click', () => {
    if (activeTimer?.paused) resumeTimer();
    else pauseTimer();
  });

  document.getElementById('timer-stop').addEventListener('click', () => {
    if (activeTimer) {
      const taskId = activeTimer.taskId;
      stopTimer(false);
      // Ask if complete
      const task = getTask(taskId);
      if (task && !task.completed) {
        setTimeout(() => {
          if (confirm(`Mark "${task.name}" as complete?`)) {
            toggleComplete(taskId);
          }
        }, 100);
      }
    }
  });

  // Streak logic
  checkStreak();

  // Timer tick interval for display
  setInterval(() => {
    if (activeTimer && !activeTimer.paused) updateTimerDisplay();
  }, 1000);
}

function checkStreak() {
  const today = new Date().toDateString();
  if (state.lastActiveDate !== today) {
    const yesterday = new Date();
    yesterday.setDate(yesterday.getDate() - 1);
    if (state.lastActiveDate === yesterday.toDateString()) {
      state.streak = (state.streak || 0) + 1;
    } else if (state.lastActiveDate !== today) {
      state.streak = 1;
    }
    state.lastActiveDate = today;
    saveState();
  }
}

// Seed some example tasks for first-time users
function seedExampleTasks() {
  if (state.tasks.length > 0) return;
  const examples = [
    { name: 'Morning workout', dayIndex: 0, priority: 'high', estHours: 1, estMinutes: 0 },
    { name: 'Review project proposal', dayIndex: 0, priority: 'high', estHours: 0, estMinutes: 45 },
    { name: 'Reply to emails', dayIndex: 1, priority: 'medium', estHours: 0, estMinutes: 30 },
    { name: 'Team standup', dayIndex: 1, priority: 'medium', estHours: 0, estMinutes: 15 },
    { name: 'Deep work session', dayIndex: 2, priority: 'high', estHours: 2, estMinutes: 0 },
    { name: 'Grocery shopping', dayIndex: 3, priority: 'low', estHours: 0, estMinutes: 45 },
    { name: 'Read for 30 mins', dayIndex: 4, priority: 'low', estHours: 0, estMinutes: 30 },
  ];
  examples.forEach(e => {
    state.tasks.push({
      id: generateId(),
      name: e.name,
      dayIndex: e.dayIndex,
      priority: e.priority,
      estHours: e.estHours,
      estMinutes: e.estMinutes,
      notes: '',
      completed: false,
      timeSpent: 0,
      scheduledHour: null,
      createdAt: Date.now(),
    });
  });
  saveState();
}

seedExampleTasks();
init();
