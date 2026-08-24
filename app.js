import {
  allOpenTasks,
  completeTask,
  createTask,
  deleteTask,
  getTaskCategory,
  reopenTask,
  updateTask,
  validateTaskInput,
  visibleTasks,
} from './task-model.js';
import { createTaskStore } from './storage.js';
import {
  formatDateOnly,
  getDueDatePresentation,
  TASK_DATE_BUCKETS,
  toDateKey,
} from './date-utils.js';
import { loadSettings, saveSettings } from './settings-store.js';
import {
  exportData,
  importData,
  parseImport,
  saveLocalBackup,
  restoreLocalBackup,
  summarizeImport,
} from './data-transfer.js';
import { createShareClient, readPairFragment, clearPairFragment } from './share-client.js';
import { createShareSync } from './share-sync.js';
import { createNotificationClient } from './notification-client.js';
import { createUpdateManager } from './update-manager.js';
import { createWeatherService, applyWeatherClass } from './weather.js';
import { applyAtmosphereClass, getAtmosphere } from './atmosphere.js';
import { createAudioManager } from './audio-manager.js';
import { applyPlantGrowth } from './plant-growth.js';
import { APP_VERSION, CONFIG } from './config.js';

const HOME_LIMIT = 5;
const DEFAULT_TASK_TITLES = [
  ['记得取快递', '路过驿站的时候别忘啦。', '📦'],
  ['清洗常用的杯子', '把每天用的杯子洗干净。', '🥤'],
  ['提醒你该喝水了', '忙起来也要记得喝水。', '💧'],
];

function clone(value) {
  if (value === undefined || value === null) return value;
  if (typeof globalThis.structuredClone === 'function') return globalThis.structuredClone(value);
  return JSON.parse(JSON.stringify(value));
}

function safeId(value) {
  return String(value ?? '').trim();
}

function nowIso() {
  return new Date().toISOString();
}

function formatDateTime(value) {
  const date = new Date(value);
  if (Number.isNaN(date.getTime())) return String(value ?? '');
  return `${date.getMonth() + 1}月${date.getDate()}日 ${String(date.getHours()).padStart(2, '0')}:${String(date.getMinutes()).padStart(2, '0')}`;
}

function toLocalDateTimeInput(value) {
  if (!value) return '';
  const date = new Date(value);
  if (Number.isNaN(date.getTime())) return '';
  const pad = number => String(number).padStart(2, '0');
  return `${date.getFullYear()}-${pad(date.getMonth() + 1)}-${pad(date.getDate())}T${pad(date.getHours())}:${pad(date.getMinutes())}`;
}

/** Convert a date-only key and a local wall-clock time into an absolute ISO instant. */
export function localDateTimeToIso(dateKey, timeValue) {
  const date = String(dateKey ?? '').trim();
  const time = String(timeValue ?? '').trim();
  if (!/^\d{4}-\d{2}-\d{2}$/.test(date) || !/^\d{2}:\d{2}$/.test(time)) return '';
  const value = new Date(`${date}T${time}:00`);
  return Number.isNaN(value.getTime()) ? '' : value.toISOString();
}

/** Default overdue reminder is 09:00 local time on the day after the due date. */
export function overdueAtForDueDate(dueDate) {
  const date = String(dueDate ?? '').trim();
  if (!/^\d{4}-\d{2}-\d{2}$/.test(date)) return null;
  const value = new Date(`${date}T00:00:00`);
  if (Number.isNaN(value.getTime())) return null;
  value.setDate(value.getDate() + 1);
  value.setHours(9, 0, 0, 0);
  return value.toISOString();
}

export function reminderScheduleFromInput(input, settings) {
  const mode = String(input?.reminderMode || 'none');
  if (mode === 'none') return { reminderAt: null, overdueAt: null };
  const dueDate = String(input?.dueDate || '').trim();
  if (mode === 'default') {
    if (!dueDate) throw new Error('使用默认提醒前，请先选择截止日期');
    if (settings?.defaultReminderEnabled !== true) throw new Error('请先在设置中开启默认提醒');
    const reminderAt = localDateTimeToIso(dueDate, settings.defaultReminderTime || '20:00');
    if (!reminderAt) throw new Error('默认提醒时间不正确');
    return { reminderAt, overdueAt: overdueAtForDueDate(dueDate) };
  }
  const reminderInput = String(input?.reminderAt || '').trim();
  const reminderAt = reminderInput ? new Date(reminderInput) : null;
  if (!reminderAt || Number.isNaN(reminderAt.getTime())) throw new Error('请选择自定义提醒时间');
  return { reminderAt: reminderAt.toISOString(), overdueAt: overdueAtForDueDate(dueDate) };
}

function createSeedTasks() {
  const now = Date.now();
  const dueDate = toDateKey(new Date(now));
  return DEFAULT_TASK_TITLES.map(([title, description, emoji], index) => {
    const timestamp = new Date(now - (DEFAULT_TASK_TITLES.length - index) * 1000).toISOString();
    return {
      id: `seed-${index + 1}`,
      title,
      description,
      emoji,
      dueDate: index === 0 ? dueDate : '',
      status: 'open',
      createdAt: timestamp,
      updatedAt: timestamp,
      ownerRole: 'me',
      reminderMode: 'none',
      reminderAt: null,
      overdueAt: null,
      reminderSentAt: null,
      overdueReminderSentAt: null,
      sourceRevision: 1,
      pendingShareSync: true,
    };
  });
}

function roleForCredentials(credentials) {
  const role = String(credentials?.role || '').trim().toLowerCase();
  return role === 'partner' || role === 'guest' ? 'partner' : 'owner';
}

function roleLabel(role) {
  if (role === 'partner' || role === 'guest') return 'TA';
  if (role === 'owner' || role === 'me') return '我';
  return role || '小伙伴';
}

function setHidden(element, hidden) {
  if (element) element.hidden = Boolean(hidden);
}

function createTextElement(tagName, className, text) {
  const element = document.createElement(tagName);
  if (className) element.className = className;
  if (text !== undefined) element.textContent = text;
  return element;
}

function isHttpLocation(locationImpl = globalThis.location) {
  return String(locationImpl?.protocol || '').startsWith('http');
}

/**
 * The application controller keeps the local task collection authoritative.
 * Sharing is deliberately called after the local write and its errors are
 * rendered as a gentle pending state instead of blocking the Todo flow.
 */
export function createApplication(options = {}) {
  const documentImpl = options.documentImpl || globalThis.document;
  if (!documentImpl) return Object.freeze({ initialize: async () => undefined });
  const navigatorImpl = options.navigatorImpl || globalThis.navigator || {};
  const store = options.store || createTaskStore();

  const $ = id => documentImpl.getElementById(id);
  const body = documentImpl.body;
  const taskList = $('task-list');
  const allTaskList = $('all-task-list');
  const sharedTaskList = $('shared-task-list');
  const emptyState = $('empty-state');
  const overflowCount = $('overflow-count');
  const toast = $('toast');
  const detailModal = $('detail-modal');
  const editorModal = $('editor-modal');
  const deleteModal = $('delete-modal');
  const allModal = $('all-modal');
  const sharedModal = $('shared-modal');
  const settingsModal = $('settings-modal');
  const importModal = $('import-modal');
  const confirmModal = $('confirm-modal');
  const detailTitle = $('detail-title');
  const detailDesc = $('detail-desc');
  const detailDate = $('detail-date');
  const detailReminder = $('detail-reminder');
  const detailStatus = $('detail-status');
  const commentsPanel = $('comments-panel');
  const commentList = $('comment-list');
  const commentInput = $('comment-input');
  const commentForm = $('comment-form');
  const ownerTaskActions = $('owner-task-actions');
  const sharedTaskActions = $('shared-task-actions');
  const titleInput = $('task-title-input');
  const descInput = $('task-desc-input');
  const emojiInput = $('task-emoji-input');
  const dateInput = $('task-date-input');
  const reminderModeInput = $('task-reminder-mode');
  const reminderAtInput = $('task-reminder-at');
  const customReminderField = $('custom-reminder-field');
  const formError = $('form-error');
  const allFilter = { value: 'active' };
  const sharedFilter = { value: 'active' };

  let tasks = [];
  let sharedTasks = [];
  let selectedId = null;
  let selectedSource = 'local';
  let editingId = null;
  let settings = {};
  let pendingImport = null;
  let confirmAction = null;
  let latestPairLink = '';
  let latestRecoveryCode = '';
  let spaceConnected = false;
  let initialized = false;
  let updateManager = null;

  let shareClient = options.shareClient || null;
  let shareSync = options.shareSync || null;
  let notificationClient = options.notificationClient || null;
  const weatherService = options.weatherService || createWeatherService({
    storage: options.weatherStorage || undefined,
    fetchImpl: options.fetchImpl,
    geolocation: navigatorImpl.geolocation,
  });
  const audioManager = options.audioManager || createAudioManager({ storage: options.audioStorage });

  function setModal(modal, open) {
    if (!modal) return;
    modal.setAttribute('aria-hidden', open ? 'false' : 'true');
  }

  function on(id, eventName, handler) {
    const element = $(id);
    if (element) element.addEventListener(eventName, handler);
    return element;
  }

  function showToast(message, duration = 1800) {
    if (!toast) return;
    toast.textContent = String(message || '');
    toast.classList.add('show');
    if (showToast.timer) clearTimeout(showToast.timer);
    showToast.timer = setTimeout(() => toast.classList.remove('show'), duration);
  }

  function setStatus(element, message) {
    if (element) element.textContent = String(message || '');
  }

  async function getCredentials() {
    try {
      return shareClient?.getCredentials ? await shareClient.getCredentials() : null;
    } catch {
      return null;
    }
  }

  function currentTask(id, source = selectedSource) {
    const list = source === 'shared' ? sharedTasks : tasks;
    return list.find(task => safeId(task?.id || task?.taskId) === safeId(id)) || null;
  }

  function dueLabel(task, referenceDate = new Date()) {
    return getDueDatePresentation(task, referenceDate);
  }

  function renderTaskButton(task, source = 'local') {
    const id = safeId(task?.id || task?.taskId);
    const button = createTextElement('button', 'all-task-item');
    button.type = 'button';
    button.dataset.id = id;
    button.dataset.source = source;
    const heading = createTextElement('span', 'item-heading');
    const emoji = createTextElement('span', 'item-emoji', task.emoji || '📌');
    const title = createTextElement('span', 'item-title', task.title || '未命名任务');
    const status = createTextElement('span', 'status-label');
    const presentation = dueLabel(task);
    status.textContent = task.status === 'completed' ? '已完成' : presentation.label;
    heading.append(emoji, title, status);
    button.appendChild(heading);
    const meta = createTextElement('small', '', task.status === 'completed'
      ? `完成于 ${formatDateTime(task.completedAt || task.updatedAt)}`
      : task.dueDate ? `截止：${formatDateOnly(task.dueDate)}` : '无截止日期 · 随时');
    button.appendChild(meta);
    button.addEventListener('click', () => {
      setModal(source === 'shared' ? sharedModal : allModal, false);
      openDetail(id, source);
    });
    return button;
  }

  function renderHomeTasks() {
    if (!taskList) return;
    const shown = visibleTasks(tasks, HOME_LIMIT, new Date());
    const open = allOpenTasks(tasks, new Date());
    taskList.replaceChildren();
    for (const task of shown) {
      const row = documentImpl.createElement('button');
      const presentation = dueLabel(task);
      row.type = 'button';
      row.className = `task-row due-${presentation.bucket}`;
      row.dataset.taskRow = '';
      row.dataset.id = safeId(task.id);
      row.setAttribute('aria-label', `查看任务：${task.title}，${presentation.label}`);
      const mark = createTextElement('span', 'task-mark');
      mark.setAttribute('aria-hidden', 'true');
      const emoji = createTextElement('span', 'task-emoji', task.emoji || '📌');
      const title = createTextElement('span', 'task-title', task.title || '未命名任务');
      const dueTag = createTextElement('small', 'task-due-tag', presentation.bucket === TASK_DATE_BUCKETS.OVERDUE
        ? '逾期' : presentation.bucket === TASK_DATE_BUCKETS.TODAY ? '今日' : '随时');
      row.append(mark, emoji, title, dueTag);
      row.addEventListener('click', () => openDetail(task.id, 'local'));
      taskList.appendChild(row);
    }
    const currentOpen = open.filter(task => getTaskCategory(task) !== TASK_DATE_BUCKETS.FUTURE);
    const hasHomeTasks = shown.length > 0;
    if (emptyState) {
      emptyState.hidden = hasHomeTasks;
      emptyState.style.display = hasHomeTasks ? 'none' : 'flex';
      emptyState.textContent = tasks.some(task => task.status === 'open' && getTaskCategory(task) === TASK_DATE_BUCKETS.FUTURE)
        ? '今天暂时没有委托，未来的委托在全部任务里哦 🌱'
        : '今天暂时没有委托哦 🌱';
    }
    const extra = Math.max(0, currentOpen.length - shown.length);
    const futureCount = open.filter(task => getTaskCategory(task) === TASK_DATE_BUCKETS.FUTURE).length;
    const completedCount = tasks.filter(task => task.status === 'completed').length;
    if (overflowCount) {
      overflowCount.hidden = extra === 0 && futureCount === 0 && completedCount === 0;
      overflowCount.dataset.filter = extra > 0 ? 'active' : futureCount > 0 ? 'future' : 'completed';
      overflowCount.textContent = extra > 0
        ? `还有 ${extra} 项，在全部任务里查看 ›`
        : futureCount > 0 ? `未来还有 ${futureCount} 项委托 ›` : `查看已完成委托 ›`;
    }
    renderAllTasks();
    updatePlant();
    updateShareIndicator();
  }

  function filteredLocalTasks() {
    const today = new Date();
    if (allFilter.value === 'completed') return tasks.filter(task => task.status === 'completed');
    if (allFilter.value === 'future') return allOpenTasks(tasks, today).filter(task => getTaskCategory(task, today) === TASK_DATE_BUCKETS.FUTURE);
    return allOpenTasks(tasks, today).filter(task => getTaskCategory(task, today) !== TASK_DATE_BUCKETS.FUTURE);
  }

  function renderAllTasks() {
    if (!allTaskList) return;
    allTaskList.replaceChildren();
    for (const task of filteredLocalTasks()) allTaskList.appendChild(renderTaskButton(task, 'local'));
    const empty = createTextElement('div', 'list-empty', '这里还没有符合条件的委托。');
    empty.hidden = allTaskList.children.length !== 0;
    allTaskList.appendChild(empty);
    documentImpl.querySelectorAll('[data-all-filter]').forEach(button => {
      const active = button.dataset.allFilter === allFilter.value;
      button.classList.toggle('active', active);
      button.setAttribute('aria-selected', active ? 'true' : 'false');
    });
  }

  function filteredSharedTasks() {
    const today = new Date();
    if (sharedFilter.value === 'completed') return sharedTasks.filter(task => task.status === 'completed');
    if (sharedFilter.value === 'future') return sharedTasks.filter(task => task.status === 'open' && getTaskCategory(task, today) === TASK_DATE_BUCKETS.FUTURE);
    return sharedTasks.filter(task => task.status === 'open' && getTaskCategory(task, today) !== TASK_DATE_BUCKETS.FUTURE);
  }

  function renderSharedTasks() {
    if (!sharedTaskList) return;
    sharedTaskList.replaceChildren();
    const list = filteredSharedTasks();
    for (const task of list) sharedTaskList.appendChild(renderTaskButton(task, 'shared'));
    setHidden($('shared-empty'), list.length !== 0);
    documentImpl.querySelectorAll('[data-shared-filter]').forEach(button => {
      const active = button.dataset.sharedFilter === sharedFilter.value;
      button.classList.toggle('active', active);
      button.setAttribute('aria-selected', active ? 'true' : 'false');
    });
  }

  function renderComments(comments = []) {
    if (!commentList) return;
    commentList.replaceChildren();
    const values = Array.isArray(comments) ? [...comments].sort((left, right) => String(left.createdAt || '').localeCompare(String(right.createdAt || ''))) : [];
    for (const comment of values) {
      const note = createTextElement('article', 'comment-note');
      const author = createTextElement('strong', '', comment.authorLabel || comment.authorName || roleLabel(comment.authorRole));
      const time = createTextElement('time', '', formatDateTime(comment.createdAt));
      time.dateTime = comment.createdAt || '';
      const head = createTextElement('div', 'comment-meta');
      head.append(author, time);
      const content = createTextElement('p', '', comment.content || '');
      note.append(head, content);
      commentList.appendChild(note);
    }
    if (!values.length) commentList.appendChild(createTextElement('p', 'list-empty', '还没有小纸条。'));
  }

  async function loadCommentsForSelected() {
    if (!selectedId || !shareSync) return;
    const id = selectedId;
    const source = selectedSource;
    try {
      const cached = await shareSync.getCachedComments(id);
      if (selectedId === id && selectedSource === source) renderComments(cached);
    } catch {
      renderComments([]);
    }
    const credentials = await getCredentials();
    if (!credentials?.accessToken || selectedId !== id || selectedSource !== source) return;
    try {
      const remote = await shareSync.fetchComments(id);
      if (selectedId === id && selectedSource === source) renderComments(remote);
    } catch {
      // A cached comment list is still useful when the Worker is offline.
    }
  }

  function updateCommentControls(credentials) {
    const enabled = Boolean(credentials?.accessToken);
    if (commentInput) commentInput.disabled = !enabled;
    const submit = commentForm?.querySelector('button[type="submit"]');
    if (submit) submit.disabled = !enabled;
    if (!enabled && $('comment-error')) $('comment-error').textContent = '加入我们的空间后，就可以贴小纸条了。';
  }

  async function openDetail(id, source = 'local') {
    const task = currentTask(id, source);
    if (!task || task.status === 'deleted') return;
    selectedId = safeId(id);
    selectedSource = source;
    const presentation = dueLabel(task);
    setStatus(detailTitle, `${task.emoji || '📌'} ${task.title || '未命名任务'}`);
    setStatus(detailDesc, task.description || '这条任务没有额外备注。');
    if (detailDate) {
      detailDate.hidden = false;
      const formattedDueDate = task.dueDate ? formatDateOnly(task.dueDate) : '';
      const gentleLabel = presentation.label && presentation.label !== formattedDueDate ? ` · ${presentation.label}` : '';
      detailDate.textContent = task.dueDate ? `截止日期：${formattedDueDate}${gentleLabel}` : '无截止日期 · 随时';
      detailDate.className = `detail-date due-${presentation.tone}`;
    }
    if (detailReminder) {
      detailReminder.hidden = !task.reminderAt;
      detailReminder.textContent = task.reminderAt ? `提醒：${formatDateTime(task.reminderAt)}` : '';
    }
    if (detailStatus) {
      const message = task.status === 'completed' ? '已完成，历史留言会保留。' : presentation.isOverdue ? '已经逾期了，慢慢完成就好。' : '';
      detailStatus.hidden = !message;
      detailStatus.textContent = message;
    }
    setHidden(ownerTaskActions, source !== 'local');
    setHidden(sharedTaskActions, source === 'local');
    if (source === 'local') {
      const completeButton = $('complete-task');
      if (completeButton) completeButton.textContent = task.status === 'completed' ? '重新打开' : '完成任务';
      setHidden($('delete-task'), task.status === 'completed');
    }
    setHidden(commentsPanel, false);
    if ($('comment-error')) $('comment-error').textContent = '';
    renderComments([]);
    updateCommentControls(await getCredentials());
    setModal(detailModal, true);
    void loadCommentsForSelected();
  }

  function openEditor(id = null) {
    editingId = id ? safeId(id) : null;
    const task = editingId ? currentTask(editingId, 'local') : null;
    setStatus($('editor-heading'), task ? '编辑任务' : '新任务');
    setStatus($('save-task'), task ? '保存修改' : '贴到公告板');
    if (titleInput) titleInput.value = task?.title || '';
    if (descInput) descInput.value = task?.description || '';
    if (emojiInput) emojiInput.value = task?.emoji || '📌';
    if (dateInput) dateInput.value = task?.dueDate || '';
    if (reminderModeInput) reminderModeInput.value = task?.reminderMode || 'none';
    if (reminderAtInput) reminderAtInput.value = toLocalDateTimeInput(task?.reminderAt);
    if (formError) formError.textContent = '';
    toggleCustomReminderField();
    setModal(detailModal, false);
    setModal(editorModal, true);
    titleInput?.focus?.();
  }

  function toggleCustomReminderField() {
    const custom = reminderModeInput?.value === 'custom';
    setHidden(customReminderField, !custom);
    const help = $('reminder-help');
    if (!help) return;
    if (reminderModeInput?.value === 'default') {
      help.textContent = '默认提醒使用设置中的时间；连接空间并开启通知后，逾期时会再温和提醒一次。';
    } else if (custom) {
      help.textContent = '自定义提醒只在你选择的时间发送；后台提醒需要连接空间并开启通知。';
    } else {
      help.textContent = '不提醒时只保留截止日期提示，不会申请系统通知。';
    }
  }

  function buildEditorInput() {
    const raw = {
      title: titleInput?.value || '',
      description: descInput?.value || '',
      emoji: emojiInput?.value || '',
      dueDate: dateInput?.value || '',
      reminderMode: reminderModeInput?.value || 'none',
    };
    if (raw.reminderMode === 'custom') raw.reminderAt = reminderAtInput?.value || '';
    const schedule = reminderScheduleFromInput(raw, settings);
    return { ...raw, ...schedule };
  }

  async function saveLocalTask(nextTask, successMessage) {
    const index = tasks.findIndex(task => task.id === nextTask.id);
    if (index >= 0) tasks[index] = nextTask;
    else tasks.push(nextTask);
    // The IndexedDB/localStorage write is deliberately awaited before any
    // network request. This is the local-first boundary.
    await store.put(nextTask);
    renderHomeTasks();
    showToast(successMessage);
    void syncOneTask(nextTask);
  }

  async function syncOneTask(task) {
    if (!shareSync) return;
    try {
      const result = await shareSync.syncTask(task);
      if (result?.task) {
        const index = tasks.findIndex(item => item.id === task.id);
        if (index >= 0) tasks[index] = result.task;
      }
      if (result?.ok) await store.setMeta('lastShareSyncAt', nowIso()).catch(() => {});
    } catch {
      // share-sync records pendingShareSync; local Todo remains usable.
    }
    renderHomeTasks();
    await refreshSpaceStatus();
  }

  async function saveTaskFromForm(event) {
    event.preventDefault();
    let input;
    try {
      input = buildEditorInput();
    } catch (error) {
      if (formError) formError.textContent = error.message || '提醒设置不正确';
      return;
    }
    const validation = validateTaskInput(input);
    if (!validation.ok) {
      if (formError) formError.textContent = validation.message;
      titleInput?.focus?.();
      return;
    }
    try {
      const existing = editingId ? currentTask(editingId, 'local') : null;
      const credentials = await getCredentials();
      if (!existing) {
        const ownerRole = credentials ? roleForCredentials(credentials) : 'me';
        const task = createTask({ ...input, ownerRole });
        editingId = null;
        setModal(editorModal, false);
        await saveLocalTask(task, '新任务已经贴好');
        return;
      }
      let updated = updateTask(existing, input);
      updated = { ...updated, overdueAt: input.reminderMode === 'none' ? null : overdueAtForDueDate(input.dueDate) };
      editingId = null;
      setModal(editorModal, false);
      await saveLocalTask(updated, '任务已经更新');
    } catch (error) {
      if (formError) formError.textContent = error?.message || '保存失败，请稍后再试';
    }
  }

  function sparklesFor(row) {
    if (!row || settings.completionAnimation !== true) return;
    const rect = row.getBoundingClientRect();
    for (let index = 0; index < 10; index += 1) {
      const spark = documentImpl.createElement('i');
      spark.className = 'spark';
      spark.style.left = `${rect.left + rect.width * (0.18 + Math.random() * 0.64)}px`;
      spark.style.top = `${rect.top + rect.height * (0.2 + Math.random() * 0.6)}px`;
      spark.style.setProperty('--dx', `${(Math.random() - 0.5) * 90}px`);
      spark.style.setProperty('--dy', `${-20 - Math.random() * 70}px`);
      documentImpl.body?.appendChild(spark);
      setTimeout(() => spark.remove(), 680);
    }
  }

  async function completeSelected() {
    if (!selectedId || selectedSource !== 'local') return;
    const task = currentTask(selectedId, 'local');
    if (!task) return;
    const row = [...(taskList?.children || [])].find(element => element.dataset.id === selectedId);
    sparklesFor(row);
    const updated = task.status === 'completed' ? reopenTask(task) : completeTask(task);
    setModal(detailModal, false);
    await saveLocalTask(updated, task.status === 'completed' ? '任务回到公告板了' : '任务完成 ✦');
    selectedId = null;
  }

  function askDelete() {
    if (!selectedId || selectedSource !== 'local') return;
    setModal(detailModal, false);
    setModal(deleteModal, true);
  }

  async function confirmDelete() {
    if (!selectedId || selectedSource !== 'local') return;
    const task = currentTask(selectedId, 'local');
    if (!task) return;
    const updated = deleteTask(task);
    setModal(deleteModal, false);
    await saveLocalTask(updated, '已从公告板移除');
    selectedId = null;
  }

  function updateShareIndicator() {
    const indicator = $('share-sync-indicator');
    if (!indicator) return;
    const pending = spaceConnected ? tasks.filter(task => task.pendingShareSync === true).length : 0;
    if (!pending) {
      indicator.hidden = true;
      indicator.textContent = '';
      return;
    }
    indicator.hidden = false;
    indicator.textContent = `还有 ${pending} 项委托待分享`;
  }

  async function refreshSpaceStatus() {
    const credentials = await getCredentials();
    const status = $('space-status');
    const last = $('last-share-sync');
    if (!credentials?.spaceId) {
      spaceConnected = false;
      setStatus(status, '尚未连接');
      setHidden($('copy-pair-link'), true);
      setHidden($('show-recovery-code'), true);
    } else {
      spaceConnected = true;
      const name = settings.displayName || credentials.displayName || roleLabel(credentials.role);
      setStatus(status, `${name} · 已连接`);
      setHidden($('copy-pair-link'), !latestPairLink);
      setHidden($('show-recovery-code'), !credentials.recoveryCode && !latestRecoveryCode);
    }
    const lastValue = await store.getMeta('lastShareSyncAt').catch(() => null);
    setStatus(last, lastValue ? formatDateTime(lastValue) : '暂无');
    updateShareIndicator();
    updateCommentControls(credentials);
  }

  async function prepareExistingTasksForSpace(credentials) {
    const role = roleForCredentials(credentials);
    const migrationKey = `legacySeedTaskIdsPrepared:${credentials.spaceId}`;
    const legacySeedIdsPrepared = await store.getMeta(migrationKey).catch(() => false);
    tasks = tasks.map(task => {
      const ownerRole = role === 'partner' ? 'partner' : 'owner';
      const isLegacySeed = !legacySeedIdsPrepared && /^seed-[1-3]$/.test(String(task.id || ''));
      const id = isLegacySeed ? `legacy-${credentials.deviceId}-${task.id}` : task.id;
      return { ...task, id, ownerRole, pendingShareSync: false };
    });
    if (!legacySeedIdsPrepared && tasks.some(task => String(task.id || '').startsWith(`legacy-${credentials.deviceId}-seed-`))) {
      await store.clearTasks();
    }
    await store.putMany(tasks);
    if (!legacySeedIdsPrepared) await store.setMeta(migrationKey, true);
    renderHomeTasks();
  }

  function recoveryDescriptorFor(credentials) {
    if (!credentials?.recoveryCode || !credentials?.spaceId || !shareClient?.buildRecoveryCode) return '';
    return shareClient.buildRecoveryCode(credentials.recoveryCode, credentials.spaceId);
  }

  function offerExistingTaskShare(successMessage = '') {
    if (!tasks.length) {
      if (successMessage) showToast(successMessage);
      return;
    }
    askConfirm('要将这台设备已有任务分享到我们的空间吗？只会上传任务、留言和提醒所需的必要字段。', async () => {
      setModal(confirmModal, false);
      await syncAllLocalTasks();
    });
    if (successMessage) showToast(successMessage);
  }

  async function syncAllLocalTasks() {
    if (!shareSync) {
      showToast('共享服务尚未配置');
      return;
    }
    const credentials = await getCredentials();
    if (!credentials?.accessToken) {
      showToast('先连接我们的空间，再分享委托');
      return;
    }
    setStatus($('space-status'), '正在分享委托…');
    try {
      const results = await shareSync.syncExistingTasks(tasks);
      for (const result of results) {
        if (!result?.task) continue;
        const index = tasks.findIndex(task => task.id === result.task.id);
        if (index >= 0) tasks[index] = result.task;
      }
      await store.putMany(tasks);
      if (results.some(result => result?.ok)) await store.setMeta('lastShareSyncAt', nowIso());
      renderHomeTasks();
      showToast(results.some(result => result?.pendingShareSync) ? '部分委托会在联网后继续分享' : '委托已经分享');
    } catch (error) {
      showToast(error?.message || '分享暂时不可用');
    }
    await refreshSpaceStatus();
  }

  async function refreshSharedTasks(showMessage = false) {
    const credentials = await getCredentials();
    if (!credentials?.accessToken || !shareSync) {
      sharedTasks = await store.getSharedTasks().catch(() => []);
      renderSharedTasks();
      if (showMessage) showToast('先在设置中加入我们的空间');
      return;
    }
    sharedTasks = await shareSync.getCachedSharedTasks().catch(() => []);
    renderSharedTasks();
    try {
      sharedTasks = await shareSync.fetchSharedTasks();
      renderSharedTasks();
      if (showMessage) showToast('委托已经刷新');
    } catch (error) {
      if (showMessage) showToast(error?.message || '暂时无法刷新，先看看已缓存的委托吧');
    }
  }

  async function openSharedModal() {
    setModal(sharedModal, true);
    await refreshSharedTasks(false);
  }

  function showPairSecrets(pairLink, recoveryCode) {
    latestPairLink = String(pairLink || '');
    latestRecoveryCode = String(recoveryCode || '');
    const output = $('space-secret-output');
    if (!output) return;
    output.replaceChildren();
    if (latestPairLink) {
      output.appendChild(createTextElement('strong', '', '配对链接'));
      output.appendChild(createTextElement('span', '', latestPairLink));
    }
    if (latestRecoveryCode) {
      output.appendChild(createTextElement('strong', '', '恢复码'));
      output.appendChild(createTextElement('span', '', latestRecoveryCode));
    }
    output.hidden = !(latestPairLink || latestRecoveryCode);
  }

  async function createSpace() {
    if (!shareClient) {
      showToast('共享服务尚未配置');
      return;
    }
    try {
      const credentials = await shareClient.createSpace({ displayName: settings.displayName });
      await prepareExistingTasksForSpace(credentials);
      latestPairLink = credentials.pairLink || shareClient.buildPairLink(credentials.pairSecret, credentials.spaceId);
      latestRecoveryCode = credentials.recoveryDescriptor || recoveryDescriptorFor(credentials);
      showPairSecrets(latestPairLink, latestRecoveryCode);
      await refreshSpaceStatus();
      offerExistingTaskShare('我们的空间已经创建好了');
    } catch (error) {
      showToast(error?.message || '创建空间失败');
    }
  }

  function pairFragmentFromText(text) {
    const raw = String(text || '').trim();
    if (!raw) return '';
    try {
      const parsed = new URL(raw, globalThis.location?.href || 'http://localhost/');
      return readPairFragment({ hash: parsed.hash });
    } catch {
      return raw.startsWith('#') ? readPairFragment({ hash: raw }) : '';
    }
  }

  async function joinSpace() {
    if (!shareClient) {
      showToast('共享服务尚未配置');
      return;
    }
    const input = $('pair-token-input')?.value?.trim() || '';
    const descriptor = pairFragmentFromText(input);
    try {
      const credentials = descriptor
        ? await shareClient.joinFromPairLink({ pairSecret: descriptor, displayName: settings.displayName, clearLocation: false })
        : await shareClient.joinSpace({ pairSecret: input, displayName: settings.displayName });
      await prepareExistingTasksForSpace(credentials);
      await refreshSpaceStatus();
      offerExistingTaskShare('已经加入我们的空间');
    } catch (error) {
      showToast(error?.message || '加入空间失败');
    }
  }

  async function recoverSpace() {
    if (!shareClient) {
      showToast('共享服务尚未配置');
      return;
    }
    const recoveryCode = $('pair-token-input')?.value?.trim() || '';
    if (!recoveryCode) {
      showToast('请先粘贴恢复码');
      return;
    }
    try {
      const credentials = await shareClient.recoverSpace({ recoveryCode, displayName: settings.displayName });
      await prepareExistingTasksForSpace(credentials);
      await refreshSpaceStatus();
      offerExistingTaskShare('本设备已经恢复连接');
    } catch (error) {
      showToast(error?.message || '恢复空间失败；恢复码需要对应空间信息');
    }
  }

  async function disconnectDevice() {
    if (!shareClient) return;
    try {
      await shareClient.disconnect({ ignoreNetworkErrors: true });
      latestPairLink = '';
      latestRecoveryCode = '';
      showPairSecrets('', '');
      showToast('本设备已断开，任务仍保留在本机');
      await refreshSpaceStatus();
    } catch (error) {
      showToast(error?.message || '断开失败');
    }
  }

  async function copyPairLink() {
    if (!latestPairLink) {
      const credentials = await getCredentials();
      latestPairLink = credentials?.pairLink || (credentials?.pairSecret && shareClient?.buildPairLink(credentials.pairSecret, credentials.spaceId)) || '';
    }
    if (!latestPairLink) {
      showToast('请先创建我们的空间');
      return;
    }
    try {
      await navigatorImpl.clipboard?.writeText?.(latestPairLink);
      showToast('配对链接已复制');
    } catch {
      showPairSecrets(latestPairLink, latestRecoveryCode);
      showToast('请从下方复制配对链接');
    }
  }

  async function showRecoveryCode() {
    if (!latestRecoveryCode) {
      const credentials = await getCredentials();
      latestRecoveryCode = recoveryDescriptorFor(credentials);
    }
    if (!latestRecoveryCode) {
      showToast('当前没有可显示的恢复码');
      return;
    }
    showPairSecrets(latestPairLink, latestRecoveryCode);
  }

  function updateNotificationStatus() {
    const status = $('notification-status');
    if (!notificationClient) {
      setStatus(status, '未配置');
      return;
    }
    const permission = notificationClient.permission();
    const support = notificationClient.support();
    const text = permission === 'granted' ? '已授权' : permission === 'denied' ? '已拒绝' : support.supported ? '尚未开启' : '当前设备不可用';
    setStatus(status, text);
  }

  async function enableNotifications() {
    if (!notificationClient) {
      showToast('通知服务尚未准备好');
      return;
    }
    try {
      // This is called only from the explicit button click; construction and
      // app startup never call requestPermission().
      const result = await notificationClient.enable();
      if (!result.enabled) {
        showToast(result.reason === 'ios-standalone-required' ? 'iPhone 请先把应用添加到主屏幕' : '当前设备暂时无法开启通知');
        return;
      }
      settings = await saveSettings(store, { notificationsEnabled: true });
      updateSettingsUI();
      showToast('通知已经开启');
    } catch (error) {
      showToast(error?.message || '通知授权没有完成');
    }
    updateNotificationStatus();
  }

  async function testNotification() {
    if (!notificationClient) return;
    try {
      if (notificationClient.permission() !== 'granted') await enableNotifications();
      if (notificationClient.permission() !== 'granted') return;
      const credentials = await getCredentials();
      if (credentials?.accessToken) await notificationClient.testNotification();
      else await notificationClient.showLocalTestNotification({ title: '今日任务', body: '通知已经准备好了。' });
      showToast('测试通知已经发出');
    } catch (error) {
      showToast(error?.message || '测试通知暂时失败');
    }
  }

  async function persistSetting(changes) {
    try {
      settings = await saveSettings(store, changes);
      updateSettingsUI();
      applyExperience();
    } catch (error) {
      showToast(error?.message || '设置没有保存');
    }
  }

  function updateSettingsUI() {
    const values = {
      'default-reminder-enabled': settings.defaultReminderEnabled,
      'default-reminder-time': settings.defaultReminderTime,
      'weather-enabled': settings.weatherEnabled,
      'time-mood-enabled': settings.timeAtmosphere,
      'season-mood-enabled': settings.seasonalAtmosphere,
      'weather-effects-enabled': settings.weatherEffects,
      'completion-animation-enabled': settings.completionAnimation,
      'plant-growth-enabled': settings.plantGrowth,
      'bgm-enabled': settings.bgmEnabled,
      'bgm-volume': settings.volume,
      'role-label-input': settings.displayName,
    };
    for (const [id, value] of Object.entries(values)) {
      const element = $(id);
      if (!element) continue;
      if (element.type === 'checkbox') element.checked = Boolean(value);
      else element.value = value ?? '';
    }
    updateNotificationStatus();
    void refreshSpaceStatus();
  }

  async function applyWeather(weather) {
    const value = settings.weatherEnabled && settings.weatherEffects ? weather : null;
    applyWeatherClass(body, value || 0);
    const status = $('weather-status');
    if (!settings.weatherEnabled) {
      setStatus(status, '天气关闭时保持默认晴天。');
      return;
    }
    const condition = value?.condition;
    setStatus(status, condition ? `${condition.emoji} ${condition.label}${value.locationName ? ` · ${value.locationName}` : ''}${value.temperature !== null && value.temperature !== undefined ? ` · ${value.temperature}℃` : ''}` : '天气尚未刷新。');
  }

  function applyExperience() {
    const atmosphere = getAtmosphere(new Date());
    applyAtmosphereClass(body, {
      ...atmosphere,
      timeKey: settings.timeAtmosphere ? atmosphere.timeKey : 'day',
      seasonKey: settings.seasonalAtmosphere ? atmosphere.seasonKey : 'summer',
    });
    const plant = $('plant-progress');
    if (plant) {
      if (settings.plantGrowth) {
        const growth = applyPlantGrowth(plant, tasks);
        plant.setAttribute('aria-label', growth.label);
        plant.title = `${growth.label} · 完成小事，植物会慢慢长大`;
      } else {
        applyPlantGrowth(plant, 0);
        plant.setAttribute('aria-label', '小芽刚刚冒出');
      }
    }
    void applyWeather(weatherService.getCached?.() || null);
  }

  function updatePlant() {
    if (!settings.plantGrowth) return;
    const plant = $('plant-progress');
    if (!plant) return;
    const growth = applyPlantGrowth(plant, tasks);
    plant.setAttribute('aria-label', growth.label);
    plant.title = `${growth.label} · 完成小事，植物会慢慢长大`;
  }

  async function weatherFromCoordinates(coordinates, metadata = {}) {
    const weather = await weatherService.getWeather({ coordinates, ...metadata });
    await store.setMeta('weatherCoordinates', { ...coordinates, locationName: metadata.locationName || weather.locationName || '' }).catch(() => {});
    if (metadata.locationName) settings = await saveSettings(store, { weatherLocation: metadata.locationName });
    await applyWeather(weather);
    showToast(weather.source === 'network' ? `${weather.condition?.emoji || '☀️'} 天气已更新` : '网络暂时不可用，先保持当前天气');
  }

  async function updateWeatherInputs() {
    const saved = await store.getMeta('weatherCoordinates').catch(() => null);
    if ($('weather-city')) $('weather-city').value = saved?.locationName || settings.weatherLocation || '';
    if ($('weather-latitude')) $('weather-latitude').value = Number.isFinite(Number(saved?.latitude)) ? saved.latitude : '';
    if ($('weather-longitude')) $('weather-longitude').value = Number.isFinite(Number(saved?.longitude)) ? saved.longitude : '';
  }

  async function useCurrentLocation() {
    try {
      const weather = await weatherService.getWeather({ useCurrentLocation: true });
      if (weather.latitude === null || weather.longitude === null) throw new Error('没有取得当前位置');
      await store.setMeta('weatherCoordinates', { latitude: weather.latitude, longitude: weather.longitude, locationName: weather.locationName || '' });
      await applyWeather(weather);
      showToast('已经使用当前位置的天气');
    } catch (error) {
      showToast(error?.message || '定位失败');
    }
  }

  async function refreshWeather() {
    const saved = await store.getMeta('weatherCoordinates').catch(() => null);
    const latitude = Number($('weather-latitude')?.value || saved?.latitude);
    const longitude = Number($('weather-longitude')?.value || saved?.longitude);
    if (Number.isFinite(latitude) && Number.isFinite(longitude)) {
      await weatherFromCoordinates({ latitude, longitude }, { locationName: $('weather-city')?.value || saved?.locationName || '' });
      return;
    }
    const city = $('weather-city')?.value?.trim() || '';
    if (city) {
      const weather = await weatherService.getByCity(city);
      if (weather.latitude !== null && weather.longitude !== null) {
        await store.setMeta('weatherCoordinates', { latitude: weather.latitude, longitude: weather.longitude, locationName: weather.locationName || city });
      }
      await applyWeather(weather);
      showToast(`${weather.condition?.emoji || '☀️'} 天气已更新`);
      return;
    }
    showToast('请填写城市，或使用当前位置');
  }

  async function searchWeather() {
    const city = $('weather-city')?.value?.trim() || '';
    if (!city) {
      showToast('请先填写城市');
      return;
    }
    const [place] = await weatherService.searchLocations(city);
    if (!place) {
      showToast('没有找到这个位置');
      return;
    }
    if ($('weather-latitude')) $('weather-latitude').value = place.latitude;
    if ($('weather-longitude')) $('weather-longitude').value = place.longitude;
    await weatherFromCoordinates(place, { locationName: place.name, timezone: place.timezone });
  }

  function downloadJson(data, filename) {
    const BlobImpl = globalThis.Blob;
    const URLImpl = globalThis.URL;
    if (!BlobImpl || !URLImpl?.createObjectURL) {
      showToast('当前设备不支持下载，请复制备份内容');
      return;
    }
    const blob = new BlobImpl([data], { type: 'application/json;charset=utf-8' });
    const href = URLImpl.createObjectURL(blob);
    const anchor = documentImpl.createElement('a');
    anchor.href = href;
    anchor.download = filename;
    anchor.hidden = true;
    documentImpl.body?.appendChild(anchor);
    anchor.click();
    anchor.remove();
    setTimeout(() => URLImpl.revokeObjectURL(href), 0);
  }

  async function exportLocalData() {
    try {
      const data = await exportData(store, { appVersion: APP_VERSION });
      downloadJson(data, `stardew-todo-backup-${toDateKey(new Date())}.json`);
      showToast('数据已经导出');
    } catch (error) {
      showToast(error?.message || '导出失败');
    }
  }

  function renderBackupOptions(backups = []) {
    const select = $('backup-select');
    if (!select) return;
    select.replaceChildren();
    if (!backups.length) {
      const option = createTextElement('option', '', '暂无备份');
      option.value = '';
      select.appendChild(option);
      select.value = '';
      return;
    }
    const placeholder = createTextElement('option', '', '选择一个备份');
    placeholder.value = '';
    select.appendChild(placeholder);
    for (const backup of backups.sort((left, right) => String(right.createdAt || '').localeCompare(String(left.createdAt || '')))) {
      const option = createTextElement('option', '', `${formatDateTime(backup.createdAt)} · ${backup.bytes || 0} bytes`);
      option.value = backup.id;
      select.appendChild(option);
    }
  }

  async function refreshBackups() {
    renderBackupOptions(await store.getBackups().catch(() => []));
  }

  async function createBackup() {
    try {
      await saveLocalBackup(store, { appVersion: APP_VERSION });
      await refreshBackups();
      showToast('本地备份已经保存');
    } catch (error) {
      showToast(error?.message || '备份失败');
    }
  }

  async function reloadFromStore() {
    tasks = await store.getAll();
    sharedTasks = await store.getSharedTasks().catch(() => []);
    settings = await loadSettings(store);
    updateSettingsUI();
    renderHomeTasks();
    renderSharedTasks();
    applyExperience();
    await refreshBackups();
  }

  async function importLocalData(mode) {
    if (!pendingImport) return;
    try {
      await importData(store, pendingImport, { mode });
      pendingImport = null;
      setModal(importModal, false);
      await reloadFromStore();
      const credentials = await getCredentials();
      if (credentials?.accessToken) {
        await prepareExistingTasksForSpace(credentials);
        offerExistingTaskShare('导入已完成，任务仍以本设备为主');
        return;
      }
      showToast(mode === 'replace' ? '本设备数据已经替换' : '数据已经合并');
    } catch (error) {
      setStatus($('import-error'), error?.message || '导入失败');
    }
  }

  async function readImportFile(event) {
    const file = event.target.files?.[0];
    if (!file) return;
    try {
      const text = await file.text();
      pendingImport = parseImport(text);
      const summary = summarizeImport(pendingImport);
      setStatus($('import-summary'), `将导入 ${summary.taskCount} 项任务、${summary.commentCount} 条留言。当前设备已有内容时，可以选择合并。`);
      setStatus($('import-error'), '');
      setModal(importModal, true);
    } catch (error) {
      setStatus($('import-error'), error?.message || '导入文件不正确');
      setModal(importModal, true);
    } finally {
      event.target.value = '';
    }
  }

  function askConfirm(message, action) {
    setStatus($('confirm-message'), message);
    confirmAction = action;
    setModal(confirmModal, true);
  }

  async function clearDeviceData() {
    askConfirm('只清除本设备任务、缓存和本地设置，保留情侣空间与服务器镜像，可以吗？', async () => {
      await Promise.all([
        store.clearTasks(),
        store.clearSharedTasks(),
        store.clearComments(),
        store.clearBackups(),
        store.clearSettings(),
      ]);
      await store.setMeta('defaultSeeded', true);
      tasks = [];
      sharedTasks = [];
      settings = await loadSettings(store);
      setModal(confirmModal, false);
      await reloadFromStore();
      showToast('本设备数据已经清除');
    });
  }

  function setupUpdateManager(registration) {
    if (!navigatorImpl.serviceWorker) return;
    updateManager = createUpdateManager({
      serviceWorkerContainer: navigatorImpl.serviceWorker,
      registration,
      reloadOnApply: true,
      onUpdateAvailable: () => setHidden($('update-banner'), false),
    });
    void updateManager.start(registration);
  }

  async function registerServiceWorker() {
    if (!navigatorImpl.serviceWorker || !isHttpLocation(globalThis.location)) return;
    try {
      const registration = await navigatorImpl.serviceWorker.register('./sw.js');
      setupUpdateManager(registration);
    } catch {
      // Offline/local file mode can still use the task app without a SW.
    }
  }

  async function handlePairFragment() {
    if (!shareClient || !readPairFragment(globalThis.location)) return;
    const credentials = await getCredentials();
    if (credentials?.accessToken) {
      clearPairFragment(globalThis.location, globalThis.history);
      return;
    }
    try {
      const joined = await shareClient.joinFromPairLink({ displayName: settings.displayName });
      await prepareExistingTasksForSpace(joined);
      await refreshSpaceStatus();
      offerExistingTaskShare('已经加入我们的空间');
    } catch (error) {
      // joinFromPairLink clears the fragment immediately after storing the
      // pending secret; errors stay local and never print the secret.
      showToast(error?.message || '配对链接暂时无法使用');
    }
  }

  async function openTaskFromNotification(taskId) {
    const id = safeId(taskId);
    if (!id) return;
    const localTask = currentTask(id, 'local');
    if (localTask && localTask.status !== 'deleted') {
      await openDetail(id, 'local');
      return;
    }
    await refreshSharedTasks(false);
    const sharedTask = currentTask(id, 'shared');
    if (sharedTask && sharedTask.status !== 'deleted') await openDetail(id, 'shared');
  }

  async function handleLaunchFragment() {
    if (readPairFragment(globalThis.location)) {
      await handlePairFragment();
      return;
    }
    const hash = String(globalThis.location?.hash || '').replace(/^#/, '');
    const taskId = new URLSearchParams(hash).get('task');
    if (!taskId) return;
    clearPairFragment(globalThis.location, globalThis.history);
    await openTaskFromNotification(taskId);
  }

  function updateCalendar() {
    const now = new Date();
    setStatus($('current-date'), `${now.getMonth() + 1}月${now.getDate()}日`);
    setStatus($('current-weekday'), `周${'日一二三四五六'[now.getDay()]}`);
    const hour = now.getHours();
    const greeting = hour < 6 ? '夜深了，别忘了早点休息哦！' : hour < 11 ? '早安，开始今天的任务吧！' : hour < 14 ? '中午好，看看还有什么任务吧！' : hour < 18 ? '下午好，慢慢完成今天的小事吧！' : '晚上好，看看今天还剩什么吧！';
    setStatus($('greeting-text'), greeting);
  }

  function bindEvents() {
    on('new-task-button', 'click', () => openEditor());
    on('settings-button', 'click', () => { updateSettingsUI(); void updateWeatherInputs(); setModal(settingsModal, true); });
    on('shared-button', 'click', () => { void openSharedModal(); });
    on('task-form', 'submit', event => { void saveTaskFromForm(event); });
    on('task-reminder-mode', 'change', toggleCustomReminderField);
    on('complete-task', 'click', () => { void completeSelected(); });
    on('edit-task', 'click', () => selectedId && openEditor(selectedId));
    on('delete-task', 'click', askDelete);
    on('confirm-delete', 'click', () => { void confirmDelete(); });
    on('confirm-action', 'click', () => { const action = confirmAction; confirmAction = null; void action?.(); });
    overflowCount?.addEventListener('click', () => { allFilter.value = overflowCount.dataset.filter || 'active'; renderAllTasks(); setModal(allModal, true); });
    documentImpl.querySelectorAll('[data-close]').forEach(button => button.addEventListener('click', () => {
      setModal($(button.dataset.close), false);
      if (button.dataset.close === 'editor-modal') editingId = null;
      if (button.dataset.close === 'confirm-modal') confirmAction = null;
    }));
    documentImpl.querySelectorAll('.modal').forEach(modal => modal.addEventListener('click', event => {
      if (event.target === modal) setModal(modal, false);
    }));
    documentImpl.addEventListener('visibilitychange', () => {
      if (documentImpl.visibilityState !== 'hidden') applyExperience();
    });
    navigatorImpl.serviceWorker?.addEventListener?.('message', event => {
      const message = event.data || {};
      if (message.type === 'OPEN_TASK') void openTaskFromNotification(message.taskId);
      if (message.type === 'PUSH_SUBSCRIPTION_CHANGED' && notificationClient?.permission?.() === 'granted') {
        void notificationClient.enable().catch(() => undefined);
      }
    });
    documentImpl.querySelectorAll('[data-all-filter]').forEach(button => button.addEventListener('click', () => {
      allFilter.value = button.dataset.allFilter || 'active';
      renderAllTasks();
    }));
    documentImpl.querySelectorAll('[data-shared-filter]').forEach(button => button.addEventListener('click', () => {
      sharedFilter.value = button.dataset.sharedFilter || 'active';
      renderSharedTasks();
    }));
    on('refresh-shared', 'click', () => { void refreshSharedTasks(true); });
    on('open-share-settings', 'click', () => { setModal(sharedModal, false); setModal(settingsModal, true); documentImpl.querySelector('[data-settings-section="sync"]')?.setAttribute('open', ''); });
    on('create-space', 'click', () => { void createSpace(); });
    on('copy-pair-link', 'click', () => { void copyPairLink(); });
    on('show-recovery-code', 'click', () => { void showRecoveryCode(); });
    on('join-space', 'click', () => { void joinSpace(); });
    on('recover-space', 'click', () => { void recoverSpace(); });
    on('sync-shared-now', 'click', () => { void syncAllLocalTasks(); });
    on('disconnect-device', 'click', () => { void disconnectDevice(); });
    on('enable-notifications', 'click', () => { void enableNotifications(); });
    on('test-notification', 'click', () => { void testNotification(); });
    on('weather-auto-location', 'click', () => { void useCurrentLocation(); });
    on('weather-refresh', 'click', () => { void refreshWeather(); });
    on('weather-search', 'click', () => { void searchWeather(); });
    on('export-data', 'click', () => { void exportLocalData(); });
    on('import-data-file', 'change', event => { void readImportFile(event); });
    on('import-merge', 'click', () => { void importLocalData('merge'); });
    on('import-replace', 'click', () => { void importLocalData('replace'); });
    on('create-backup', 'click', () => { void createBackup(); });
    on('restore-backup', 'click', async () => {
      const id = $('backup-select')?.value;
      if (!id) { showToast('请先选择一个备份'); return; }
      const backup = await store.getBackup(id);
      try {
        await restoreLocalBackup(store, backup, { mode: 'merge' });
        await reloadFromStore();
        const credentials = await getCredentials();
        if (credentials?.accessToken) {
          await prepareExistingTasksForSpace(credentials);
          offerExistingTaskShare('本地备份已经恢复');
        } else showToast('本地备份已经恢复');
      } catch (error) { showToast(error?.message || '恢复备份失败'); }
    });
    on('clear-device-data', 'click', () => { void clearDeviceData(); });
    on('check-update', 'click', async () => {
      const found = await updateManager?.checkForUpdate?.();
      showToast(found ? '发现新版本，请点击公告' : '当前已经是最新版本');
    });
    on('apply-update', 'click', () => updateManager?.accept?.());
    on('dismiss-update', 'click', () => { updateManager?.dismiss?.(); setHidden($('update-banner'), true); });
    on('comment-form', 'submit', event => { void submitComment(event); });
    on('default-reminder-enabled', 'change', event => { void persistSetting({ defaultReminderEnabled: event.target.checked }); });
    on('default-reminder-time', 'change', event => { void persistSetting({ defaultReminderTime: event.target.value }); });
    on('weather-enabled', 'change', event => { void persistSetting({ weatherEnabled: event.target.checked }); });
    on('time-mood-enabled', 'change', event => { void persistSetting({ timeAtmosphere: event.target.checked }); });
    on('season-mood-enabled', 'change', event => { void persistSetting({ seasonalAtmosphere: event.target.checked }); });
    on('weather-effects-enabled', 'change', event => { void persistSetting({ weatherEffects: event.target.checked }); });
    on('completion-animation-enabled', 'change', event => { void persistSetting({ completionAnimation: event.target.checked }); });
    on('plant-growth-enabled', 'change', async event => {
      await persistSetting({ plantGrowth: event.target.checked });
      applyExperience();
    });
    on('role-label-input', 'change', event => { void persistSetting({ displayName: event.target.value }); });
    on('bgm-enabled', 'change', async event => {
      await persistSetting({ bgmEnabled: event.target.checked });
      audioManager.setEnabled(event.target.checked);
      if (event.target.checked) {
        const result = await audioManager.startFromGesture();
        if (!result.ok) showToast('当前设备暂时无法播放声音');
      } else await audioManager.stop();
    });
    on('bgm-volume', 'input', event => {
      audioManager.setVolume(event.target.value);
      void persistSetting({ volume: Number(event.target.value) });
    });
  }

  async function buildClients() {
    if (!shareClient) {
      try {
        shareClient = createShareClient({ store, config: CONFIG, locationImpl: globalThis.location, historyImpl: globalThis.history });
      } catch {
        shareClient = null;
      }
    }
    if (!shareSync && shareClient) {
      try {
        shareSync = createShareSync({ store, shareClient, getTasks: () => tasks, lifecycleTarget: options.lifecycleTarget || globalThis });
      } catch {
        shareSync = null;
      }
    }
    if (!notificationClient && shareClient) {
      notificationClient = createNotificationClient({ store, shareClient, navigatorImpl, serviceWorkerContainer: navigatorImpl.serviceWorker, config: CONFIG, locationImpl: globalThis.location });
    }
  }

  async function seedIfNeeded() {
    const existing = await store.getAll();
    const seeded = await store.getMeta('defaultSeeded');
    if (!existing.length && !seeded) {
      tasks = createSeedTasks();
      await store.putMany(tasks);
      await store.setMeta('defaultSeeded', true);
      return;
    }
    tasks = existing;
    if (!seeded) await store.setMeta('defaultSeeded', true);
  }

  async function retryPendingShare() {
    if (!shareSync) return;
    try {
      const result = await shareSync.retryPending();
      for (const item of [...(result?.tasks || []), ...(result?.comments || [])]) {
        if (item?.task?.id) {
          const index = tasks.findIndex(task => task.id === item.task.id);
          if (index >= 0) tasks[index] = item.task;
        }
      }
      renderHomeTasks();
      await refreshSpaceStatus();
    } catch {
      // Retry points are best effort by design.
    }
  }

  async function initialize() {
    if (initialized) return api;
    initialized = true;
    await buildClients();
    settings = await loadSettings(store);
    await seedIfNeeded();
    sharedTasks = await store.getSharedTasks().catch(() => []);
    updateCalendar();
    bindEvents();
    updateSettingsUI();
    renderHomeTasks();
    renderSharedTasks();
    applyExperience();
    await updateWeatherInputs();
    await refreshBackups();
    shareSync?.bindLifecycle?.();
    void retryPendingShare();
    void handleLaunchFragment();
    await registerServiceWorker();
    return api;
  }

  async function submitComment(event) {
    event.preventDefault();
    if (!selectedId || !shareSync) return;
    const text = commentInput?.value?.trim() || '';
    if (!text) {
      if ($('comment-error')) $('comment-error').textContent = '先写下一句小纸条吧。';
      return;
    }
    const credentials = await getCredentials();
    if (!credentials?.accessToken) {
      if ($('comment-error')) $('comment-error').textContent = '加入我们的空间后，就可以贴小纸条了。';
      return;
    }
    if ($('comment-error')) $('comment-error').textContent = '';
    try {
      const result = await shareSync.addComment(selectedId, text, {
        authorRole: credentials.role,
        authorName: settings.displayName || credentials.displayName,
      });
      if (result?.comment) await store.putComment(result.comment);
      if (commentInput) commentInput.value = '';
      renderComments(await shareSync.getCachedComments(selectedId));
      showToast(result?.pending ? '小纸条已留下，联网后会送达' : '小纸条已经贴好');
    } catch (error) {
      if ($('comment-error')) $('comment-error').textContent = error?.message || '留言没有贴上，请稍后再试';
    }
  }

  const api = Object.freeze({
    initialize,
    renderHomeTasks,
    renderAllTasks,
    renderSharedTasks,
    openDetail,
    openEditor,
    saveTaskFromForm,
    syncAllLocalTasks,
    refreshSharedTasks,
    getState: () => ({ tasks: clone(tasks), sharedTasks: clone(sharedTasks), settings: clone(settings) }),
  });
  return api;
}

if (typeof document !== 'undefined' && globalThis.__STARDEW_TODO_DISABLE_AUTO_INIT__ !== true) {
  const app = createApplication();
  globalThis.stardewTodoApp = app;
  void app.initialize().catch(() => {
    const toast = document.getElementById('toast');
    if (toast) toast.textContent = '任务数据加载失败';
  });
}
