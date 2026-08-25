import {
  classifyTask,
  formatDateOnly,
  isValidDateOnly,
  sortTasksForDisplay,
  sortTasksForToday,
  TASK_DATE_BUCKETS,
} from './date-utils.js';

export const TASK_STATUSES = Object.freeze(['open', 'completed', 'deleted']);
export const REMINDER_MODES = Object.freeze(['none', 'default', 'custom']);
export const REMOTE_REMINDER_MODES = Object.freeze(['off', 'default', 'custom']);

const MAX_TITLE_LENGTH = 40;
const MAX_DESCRIPTION_LENGTH = 120;
const ISO_TIMESTAMP_PATTERN = /^\d{4}-\d{2}-\d{2}T/;

export function validateTaskInput(input = {}) {
  const title = String(input.title ?? '').trim();
  if (!title) return { ok: false, message: '任务名称不能为空' };
  if ([...title].length > MAX_TITLE_LENGTH) return { ok: false, message: '任务名称最多 40 个字' };

  const dueDate = String(input.dueDate ?? '').trim();
  const startDate = String(input.startDate ?? '').trim();
  if (startDate && !isValidDateOnly(startDate)) {
    return { ok: false, message: '开始日期格式不正确' };
  }
  if (dueDate && !isValidDateOnly(dueDate)) {
    return { ok: false, message: '截止日期格式不正确' };
  }
  if (startDate && dueDate && dueDate < startDate) {
    return { ok: false, message: '截止日期不能早于开始日期' };
  }
  const description = String(input.description ?? '').trim();
  if ([...description].length > MAX_DESCRIPTION_LENGTH) {
    return { ok: false, message: '任务描述最多 120 个字' };
  }
  const reminderMode = input.reminderMode === null || input.reminderMode === undefined || input.reminderMode === ''
    ? 'none'
    : String(input.reminderMode);
  if (!REMINDER_MODES.includes(reminderMode)) {
    return { ok: false, message: '提醒方式不正确' };
  }
  if (reminderMode === 'default' && !dueDate) {
    return { ok: false, message: '默认提醒需要先设置截止日期' };
  }
  if (reminderMode === 'custom' && (input.reminderAt === null || input.reminderAt === undefined || input.reminderAt === '')) {
    return { ok: false, message: '自定义提醒需要设置提醒时间' };
  }
  if (input.reminderAt !== null && input.reminderAt !== undefined && input.reminderAt !== '' && !isTimestampLike(input.reminderAt)) {
    return { ok: false, message: '提醒时间格式不正确' };
  }
  if (input.overdueAt !== null && input.overdueAt !== undefined && input.overdueAt !== '' && !isTimestampLike(input.overdueAt)) {
    return { ok: false, message: '逾期提醒时间格式不正确' };
  }
  return { ok: true, message: '' };
}

export function createTask(input = {}, idFactory = defaultId, nowFactory = defaultNow) {
  const validation = validateTaskInput(input);
  if (!validation.ok) throw new Error(validation.message);
  const now = normalizeTimestamp(nowFactory()) || defaultNow();
  const reminderMode = normalizeReminderMode(input.reminderMode, input.reminderAt);
  return normalizeTask({
    ...input,
    id: input.id ?? idFactory(),
    title: String(input.title).trim(),
    description: String(input.description ?? '').trim(),
    emoji: String(input.emoji ?? '').trim() || '📌',
    startDate: String(input.startDate ?? '').trim(),
    dueDate: String(input.dueDate ?? '').trim(),
    status: 'open',
    createdAt: now,
    updatedAt: now,
    reminderMode,
    reminderAt: normalizeNullable(input.reminderAt),
    overdueAt: normalizeNullable(input.overdueAt),
    reminderSentAt: normalizeNullable(input.reminderSentAt),
    overdueReminderSentAt: normalizeNullable(input.overdueReminderSentAt),
    ownerRole: normalizeOwnerRole(input.ownerRole),
    sourceRevision: 1,
    pendingShareSync: input.pendingShareSync ?? true,
  }, () => now);
}

export function normalizeTask(input = {}, nowFactory = defaultNow) {
  const source = input && typeof input === 'object' ? input : {};
  const now = normalizeTimestamp(typeof nowFactory === 'function' ? nowFactory() : nowFactory) || defaultNow();
  const createdAt = normalizeTimestamp(source.createdAt) || now;
  const updatedAt = normalizeTimestamp(source.updatedAt) || createdAt;
  const startDate = source.startDate === null || source.startDate === undefined ? '' : String(source.startDate).trim();
  const dueDate = source.dueDate === null || source.dueDate === undefined ? '' : String(source.dueDate).trim();
  const reminderAt = normalizeNullable(source.reminderAt);
  const reminderMode = normalizeReminderMode(source.reminderMode, reminderAt);
  const status = TASK_STATUSES.includes(source.status) ? source.status : 'open';
  const sourceRevision = normalizeRevision(source.sourceRevision);
  const task = {
    ...source,
    id: String(source.id ?? '').trim() || defaultId(),
    title: String(source.title ?? '').trim(),
    description: String(source.description ?? '').trim(),
    emoji: String(source.emoji ?? '').trim() || '📌',
    startDate,
    dueDate,
    status,
    createdAt,
    updatedAt,
    reminderMode,
    reminderAt,
    overdueAt: normalizeNullable(source.overdueAt),
    reminderSentAt: normalizeNullable(source.reminderSentAt),
    overdueReminderSentAt: normalizeNullable(source.overdueReminderSentAt),
    ownerRole: normalizeOwnerRole(source.ownerRole),
    sourceRevision,
    pendingShareSync: Boolean(source.pendingShareSync),
  };
  if (source.completedAt !== null && source.completedAt !== undefined) task.completedAt = normalizeTimestamp(source.completedAt) || source.completedAt;
  if (source.deletedAt !== null && source.deletedAt !== undefined) task.deletedAt = normalizeTimestamp(source.deletedAt) || source.deletedAt;
  return task;
}

export function updateTask(task, input = {}, nowFactory = defaultNow) {
  const validation = validateTaskInput(input);
  if (!validation.ok) throw new Error(validation.message);
  const now = normalizeTimestamp(nowFactory()) || defaultNow();
  const nextReminderMode = normalizeReminderMode(input.reminderMode, input.reminderAt);
  const reminderChanged = normalizeReminderMode(task?.reminderMode, task?.reminderAt) !== nextReminderMode
    || normalizeNullable(task?.reminderAt) !== normalizeNullable(input.reminderAt);
  const dueDateChanged = String(task?.dueDate ?? '') !== String(input.dueDate ?? '').trim();
  const nextOverdueAt = input.overdueAt === undefined
    ? (dueDateChanged ? null : task?.overdueAt)
    : normalizeNullable(input.overdueAt);
  const overdueTimeChanged = normalizeNullable(task?.overdueAt) !== normalizeNullable(nextOverdueAt);
  return normalizeTask({
    ...task,
    title: String(input.title).trim(),
    description: String(input.description ?? '').trim(),
    emoji: String(input.emoji ?? '').trim() || '📌',
    startDate: String(input.startDate ?? '').trim(),
    dueDate: String(input.dueDate ?? '').trim(),
    updatedAt: now,
    reminderMode: nextReminderMode,
    reminderAt: normalizeNullable(input.reminderAt),
    overdueAt: nextOverdueAt,
    reminderSentAt: reminderChanged ? null : task?.reminderSentAt,
    overdueReminderSentAt: reminderChanged || dueDateChanged || overdueTimeChanged ? null : task?.overdueReminderSentAt,
    sourceRevision: nextRevision(task),
    pendingShareSync: true,
  }, () => now);
}

export function completeTask(task, nowFactory = defaultNow) {
  const now = normalizeTimestamp(nowFactory()) || defaultNow();
  return normalizeTask({
    ...task,
    status: 'completed',
    completedAt: now,
    updatedAt: now,
    sourceRevision: nextRevision(task),
    pendingShareSync: true,
  }, () => now);
}

export function deleteTask(task, nowFactory = defaultNow) {
  const now = normalizeTimestamp(nowFactory()) || defaultNow();
  return normalizeTask({
    ...task,
    status: 'deleted',
    deletedAt: now,
    updatedAt: now,
    sourceRevision: nextRevision(task),
    pendingShareSync: true,
  }, () => now);
}

export function reopenTask(task, nowFactory = defaultNow) {
  const now = normalizeTimestamp(nowFactory()) || defaultNow();
  return normalizeTask({
    ...task,
    status: 'open',
    completedAt: null,
    deletedAt: null,
    updatedAt: now,
    sourceRevision: nextRevision(task),
    pendingShareSync: true,
  }, () => now);
}

export function markTaskShareSynced(task, syncedAt = defaultNow) {
  const now = normalizeTimestamp(typeof syncedAt === 'function' ? syncedAt() : syncedAt) || defaultNow();
  return normalizeTask({ ...task, pendingShareSync: false, lastSharedAt: now }, () => now);
}

export function markReminderSent(task, sentAt = defaultNow) {
  const now = normalizeTimestamp(typeof sentAt === 'function' ? sentAt() : sentAt) || defaultNow();
  return normalizeTask({ ...task, reminderSentAt: now }, () => now);
}

export function markOverdueReminderSent(task, sentAt = defaultNow) {
  const now = normalizeTimestamp(typeof sentAt === 'function' ? sentAt() : sentAt) || defaultNow();
  return normalizeTask({ ...task, overdueReminderSentAt: now }, () => now);
}

export function getTaskCategory(task, referenceDate = new Date()) {
  return classifyTask(task, referenceDate);
}

export function visibleTasks(tasks = [], limit = 5, referenceDate = new Date()) {
  const homeTasks = sortTasksForToday(tasks, referenceDate);
  return Number.isFinite(limit) ? homeTasks.slice(0, Math.max(0, limit)) : homeTasks;
}

export function allOpenTasks(tasks = [], referenceDate = new Date()) {
  return sortTasksForDisplay(tasks, referenceDate);
}

export function groupOpenTasks(tasks = [], referenceDate = new Date()) {
  const groups = {
    [TASK_DATE_BUCKETS.OVERDUE]: [],
    [TASK_DATE_BUCKETS.TODAY]: [],
    [TASK_DATE_BUCKETS.FUTURE]: [],
    [TASK_DATE_BUCKETS.ANYTIME]: [],
  };
  for (const task of tasks) {
    if (task?.status !== 'open') continue;
    groups[classifyTask(task, referenceDate)].push(task);
  }
  for (const key of Object.keys(groups)) groups[key] = sortTasksForDisplay(groups[key], referenceDate);
  return groups;
}

/** Pick only the fields needed for the Cloudflare shared task mirror. */
export function toSharedTask(task, spaceId) {
  const normalized = normalizeTask(task);
  return {
    taskId: normalized.id,
    spaceId: String(spaceId ?? '').trim(),
    title: normalized.title,
    description: normalized.description,
    emoji: normalized.emoji,
    startDate: normalized.startDate || null,
    dueDate: normalized.dueDate || null,
    status: normalized.status,
    createdAt: normalized.createdAt,
    updatedAt: normalized.updatedAt,
    ownerRole: normalized.ownerRole,
    reminderMode: normalized.reminderMode,
    reminderAt: normalized.reminderAt,
    overdueAt: normalized.overdueAt,
    reminderSentAt: normalized.reminderSentAt,
    overdueReminderSentAt: normalized.overdueReminderSentAt,
    sourceRevision: normalized.sourceRevision,
  };
}

export function isOpenTask(task) {
  return task?.status === 'open';
}

function normalizeReminderMode(mode, reminderAt) {
  const value = String(mode ?? '').trim();
  if (REMINDER_MODES.includes(value)) return value;
  return reminderAt ? 'custom' : 'none';
}

function normalizeNullable(value) {
  if (value === null || value === undefined || value === '') return null;
  return String(value);
}

function normalizeOwnerRole(value) {
  const role = String(value ?? '').trim();
  return role || 'me';
}

function normalizeRevision(value) {
  const number = Number(value);
  return Number.isSafeInteger(number) && number >= 0 ? number : 0;
}

function nextRevision(task) {
  return normalizeRevision(task?.sourceRevision) + 1;
}

function normalizeTimestamp(value) {
  if (value instanceof Date && !Number.isNaN(value.getTime())) return value.toISOString();
  const text = String(value ?? '').trim();
  return text && (ISO_TIMESTAMP_PATTERN.test(text) || !Number.isNaN(Date.parse(text))) ? text : '';
}

function isTimestampLike(value) {
  const text = String(value ?? '').trim();
  return Boolean(text && !Number.isNaN(Date.parse(text)));
}

function defaultId() {
  if (globalThis.crypto?.randomUUID) return globalThis.crypto.randomUUID();
  return `task-${Date.now()}-${Math.random().toString(36).slice(2, 10)}`;
}

function defaultNow() {
  return new Date().toISOString();
}

export { formatDateOnly };
