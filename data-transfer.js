import { classifyTask, TASK_DATE_BUCKETS } from './date-utils.js';
import { normalizeTask, TASK_STATUSES, REMINDER_MODES, REMOTE_REMINDER_MODES } from './task-model.js';
import { DEFAULT_SETTINGS, SETTING_KEYS, normalizeSettings, validateSettings } from './settings-store.js';

export const BACKUP_TYPE = 'stardew-todo-backup';
export const BACKUP_SCHEMA_VERSION = 1;
export const MAX_IMPORT_BYTES = 1024 * 1024;

const TOP_LEVEL_KEYS = new Set(['type', 'schemaVersion', 'appVersion', 'exportedAt', 'tasks', 'sharedTasks', 'comments', 'settings']);
const TASK_KEYS = new Set([
  'id', 'title', 'description', 'emoji', 'dueDate', 'status', 'createdAt', 'updatedAt',
  'completedAt', 'deletedAt', 'reminderMode', 'reminderAt', 'overdueAt', 'reminderSentAt',
  'overdueReminderSentAt', 'ownerRole', 'sourceRevision', 'pendingShareSync', 'lastSharedAt',
  'createdByDevice', 'createdByRole',
]);
const SHARED_TASK_KEYS = new Set([
  'taskId', 'spaceId', 'title', 'description', 'emoji', 'dueDate', 'status', 'createdAt', 'updatedAt',
  'ownerRole', 'revision', 'reminderMode', 'reminderAt', 'overdueAt', 'reminderSentAt', 'overdueReminderSentAt', 'sourceRevision',
]);
const COMMENT_KEYS = new Set(['commentId', 'taskId', 'spaceId', 'authorRole', 'authorLabel', 'content', 'createdAt']);

export class ImportValidationError extends Error {
  constructor(message, details = []) {
    super(message);
    this.name = 'ImportValidationError';
    this.details = details;
  }
}

export async function readImportSource(source) {
  if (typeof source === 'string') return source;
  if (source && typeof source.text === 'function') return source.text();
  if (source && typeof source === 'object') return source;
  throw new ImportValidationError('导入内容不可读取');
}

/** Build a stable, credential-free JSON backup from a store snapshot. */
export function buildExportPayload(snapshot = {}, options = {}) {
  const includeShared = options.includeShared !== false;
  const includeSettings = options.includeSettings !== false;
  return {
    type: BACKUP_TYPE,
    schemaVersion: BACKUP_SCHEMA_VERSION,
    appVersion: String(options.appVersion ?? '1.0'),
    exportedAt: String(options.exportedAt ?? new Date().toISOString()),
    tasks: Array.isArray(snapshot.tasks) ? snapshot.tasks.map(task => normalizeTask(task)) : [],
    sharedTasks: includeShared && Array.isArray(snapshot.sharedTasks) ? snapshot.sharedTasks.map(task => ({ ...task })) : [],
    comments: includeShared && Array.isArray(snapshot.comments) ? snapshot.comments.map(comment => ({
      commentId: String(comment.commentId || ''),
      taskId: String(comment.taskId || ''),
      spaceId: String(comment.spaceId || ''),
      authorRole: String(comment.authorRole || 'me'),
      authorLabel: String(comment.authorLabel || comment.authorName || ''),
      content: String(comment.content || ''),
      createdAt: String(comment.createdAt || ''),
    })) : [],
    settings: includeSettings ? normalizeSettings(snapshot.settings || {}) : { ...DEFAULT_SETTINGS },
  };
}

export function exportSnapshot(snapshot, options = {}) {
  const payload = buildExportPayload(snapshot, options);
  return options.pretty === false ? JSON.stringify(payload) : JSON.stringify(payload, null, 2);
}

export async function exportData(store, options = {}) {
  if (!store || typeof store.getSnapshot !== 'function') throw new Error('数据存储不可用');
  return exportSnapshot(await store.getSnapshot(), options);
}

/** Parse and strictly validate a V1 backup before it can touch a store. */
export function parseImport(source) {
  let json;
  try {
    json = typeof source === 'string' ? source : JSON.stringify(source);
  } catch {
    throw new ImportValidationError('导入内容不可序列化');
  }
  const bytes = byteLength(json);
  if (bytes > MAX_IMPORT_BYTES) {
    throw new ImportValidationError(`导入文件不能超过 ${MAX_IMPORT_BYTES / 1024} KB`);
  }
  let payload;
  try {
    payload = typeof source === 'string' ? JSON.parse(source) : source;
  } catch {
    throw new ImportValidationError('导入文件不是有效 JSON');
  }
  const validation = validateImportPayload(payload);
  if (!validation.ok) throw new ImportValidationError('导入文件格式不正确', validation.errors);
  return clone(payload);
}

export function validateImportPayload(payload) {
  const errors = [];
  if (!isPlainObject(payload)) return { ok: false, errors: ['顶层必须是对象'] };
  for (const key of Object.keys(payload)) if (!TOP_LEVEL_KEYS.has(key)) errors.push(`不支持的字段：${key}`);
  if (payload.type !== BACKUP_TYPE) errors.push('type 不正确');
  if (payload.schemaVersion !== BACKUP_SCHEMA_VERSION) errors.push('schemaVersion 不支持');
  if (typeof payload.exportedAt !== 'string' || Number.isNaN(Date.parse(payload.exportedAt))) errors.push('exportedAt 不正确');
  if (!Array.isArray(payload.tasks)) errors.push('tasks 必须是数组');
  if (!Array.isArray(payload.sharedTasks)) errors.push('sharedTasks 必须是数组');
  if (!Array.isArray(payload.comments)) errors.push('comments 必须是数组');
  if (!isPlainObject(payload.settings)) errors.push('settings 必须是对象');
  if (Array.isArray(payload.tasks)) payload.tasks.forEach((task, index) => validateTaskRecord(task, `tasks[${index}]`, errors));
  if (Array.isArray(payload.sharedTasks)) payload.sharedTasks.forEach((task, index) => validateSharedTaskRecord(task, `sharedTasks[${index}]`, errors));
  if (Array.isArray(payload.comments)) payload.comments.forEach((comment, index) => validateCommentRecord(comment, `comments[${index}]`, errors));
  if (isPlainObject(payload.settings)) {
    for (const key of Object.keys(payload.settings)) {
      if (!SETTING_KEYS.includes(key)) errors.push(`settings 包含不支持的字段：${key}`);
    }
    const settingValidation = validateSettings(payload.settings);
    if (!settingValidation.ok) errors.push(...Object.values(settingValidation.errors));
  }
  return { ok: errors.length === 0, errors };
}

function validateTaskRecord(task, path, errors) {
  if (!isPlainObject(task)) {
    errors.push(`${path} 必须是对象`);
    return;
  }
  validateKeys(task, TASK_KEYS, path, errors);
  requireString(task, 'id', path, errors);
  requireString(task, 'title', path, errors);
  requireStatus(task.status, `${path}.status`, errors);
  requireTimestamp(task, 'createdAt', path, errors);
  requireTimestamp(task, 'updatedAt', path, errors);
  if (task.description !== undefined && typeof task.description !== 'string') errors.push(`${path}.description 类型不正确`);
  if (task.emoji !== undefined && typeof task.emoji !== 'string') errors.push(`${path}.emoji 类型不正确`);
  if (task.dueDate !== undefined && task.dueDate !== '' && (typeof task.dueDate !== 'string' || !/^\d{4}-\d{2}-\d{2}$/.test(task.dueDate))) errors.push(`${path}.dueDate 不正确`);
  if (task.reminderMode !== undefined && ![...REMINDER_MODES, 'off'].includes(task.reminderMode)) errors.push(`${path}.reminderMode 不正确`);
  if (task.sourceRevision !== undefined && (!Number.isSafeInteger(task.sourceRevision) || task.sourceRevision < 0)) errors.push(`${path}.sourceRevision 不正确`);
  if (task.pendingShareSync !== undefined && typeof task.pendingShareSync !== 'boolean') errors.push(`${path}.pendingShareSync 类型不正确`);
}

function validateSharedTaskRecord(task, path, errors) {
  if (!isPlainObject(task)) {
    errors.push(`${path} 必须是对象`);
    return;
  }
  validateKeys(task, SHARED_TASK_KEYS, path, errors);
  requireString(task, 'taskId', path, errors);
  requireString(task, 'spaceId', path, errors);
  requireString(task, 'title', path, errors);
  requireStatus(task.status, `${path}.status`, errors);
  requireTimestamp(task, 'createdAt', path, errors);
  requireTimestamp(task, 'updatedAt', path, errors);
  if (task.reminderMode !== undefined && !REMOTE_REMINDER_MODES.includes(task.reminderMode) && !REMINDER_MODES.includes(task.reminderMode)) errors.push(`${path}.reminderMode 不正确`);
}

function validateCommentRecord(comment, path, errors) {
  if (!isPlainObject(comment)) {
    errors.push(`${path} 必须是对象`);
    return;
  }
  validateKeys(comment, COMMENT_KEYS, path, errors);
  for (const key of ['commentId', 'taskId', 'spaceId', 'authorRole', 'content']) requireString(comment, key, path, errors);
  requireTimestamp(comment, 'createdAt', path, errors);
  if ([...(comment.content || '')].length > 500) errors.push(`${path}.content 过长`);
}

export function summarizeImport(input, referenceDate = new Date()) {
  const payload = input?.type === BACKUP_TYPE ? input : buildExportPayload(input);
  const counts = { open: 0, completed: 0, deleted: 0 };
  const buckets = {
    [TASK_DATE_BUCKETS.OVERDUE]: 0,
    [TASK_DATE_BUCKETS.TODAY]: 0,
    [TASK_DATE_BUCKETS.FUTURE]: 0,
    [TASK_DATE_BUCKETS.ANYTIME]: 0,
  };
  for (const task of payload.tasks) {
    if (Object.prototype.hasOwnProperty.call(counts, task.status)) counts[task.status] += 1;
    if (task.status === 'open') buckets[classifyTask(task, referenceDate)] += 1;
  }
  return {
    bytes: byteLength(JSON.stringify(payload)),
    taskCount: payload.tasks.length,
    openCount: counts.open,
    completedCount: counts.completed,
    deletedCount: counts.deleted,
    overdueCount: buckets.overdue,
    todayCount: buckets.today,
    futureCount: buckets.future,
    anytimeCount: buckets.anytime,
    sharedTaskCount: payload.sharedTasks.length,
    commentCount: payload.comments.length,
    settingsCount: Object.keys(payload.settings || {}).length,
  };
}

export function mergeImport(existing = {}, incoming = {}) {
  const base = normalizeSnapshot(existing);
  const next = normalizeSnapshot(incoming);
  return {
    ...base,
    tasks: mergeRecords(base.tasks, next.tasks, 'id', compareTaskFreshness),
    sharedTasks: mergeRecords(base.sharedTasks, next.sharedTasks, 'taskId', compareRecordFreshness),
    comments: mergeRecords(base.comments, next.comments, 'commentId', () => 1),
    settings: normalizeSettings({ ...base.settings, ...next.settings }),
  };
}

export function replaceImport(_existing = {}, incoming = {}) {
  const next = normalizeSnapshot(incoming);
  return {
    ...next,
    tasks: next.tasks.map(task => normalizeTask(task)),
    settings: normalizeSettings(next.settings),
  };
}

export async function importData(store, source, options = {}) {
  const raw = await readImportSource(source);
  const incoming = parseImport(raw);
  if (!store || typeof store.getSnapshot !== 'function') throw new Error('数据存储不可用');
  const existing = await store.getSnapshot();
  const mode = options.mode === 'replace' ? 'replace' : 'merge';
  const snapshot = mode === 'replace' ? replaceImport(existing, incoming) : mergeImport(existing, incoming);
  if (mode === 'replace') {
    await Promise.all([
      store.clearTasks(), store.clearSharedTasks(), store.clearComments(), store.clearSettings(),
    ]);
  }
  await store.putMany(snapshot.tasks);
  if (snapshot.sharedTasks.length) await store.putSharedTasks(snapshot.sharedTasks);
  if (snapshot.comments.length) for (const comment of snapshot.comments) await store.putComment(comment);
  await store.setSettings(snapshot.settings);
  return { mode, snapshot, summary: summarizeImport(snapshot) };
}

export const importIntoStore = importData;

export async function saveLocalBackup(store, options = {}) {
  const data = await exportData(store, options);
  const backup = {
    id: String(options.id ?? `backup-${Date.now()}`),
    createdAt: new Date().toISOString(),
    bytes: byteLength(data),
    data,
  };
  if (typeof store?.saveBackup !== 'function') throw new Error('备份存储不可用');
  await store.saveBackup(backup);
  return backup;
}

export async function restoreLocalBackup(store, backup, options = {}) {
  if (!backup?.data) throw new ImportValidationError('本地备份内容为空');
  return importData(store, backup.data, options);
}

function normalizeSnapshot(snapshot = {}) {
  return {
    tasks: Array.isArray(snapshot.tasks) ? snapshot.tasks.map(task => normalizeTask(task)) : [],
    sharedTasks: Array.isArray(snapshot.sharedTasks) ? snapshot.sharedTasks.map(task => ({ ...task })) : [],
    comments: Array.isArray(snapshot.comments) ? snapshot.comments.map(comment => ({ ...comment })) : [],
    settings: normalizeSettings(snapshot.settings || {}),
  };
}

function mergeRecords(existing, incoming, key, compare) {
  const result = new Map(existing.map(record => [record?.[key], clone(record)]));
  for (const record of incoming) {
    const id = record?.[key];
    if (!id) continue;
    const previous = result.get(id);
    if (!previous || compare(previous, record) <= 0) result.set(id, clone(record));
  }
  return [...result.values()];
}

function compareTaskFreshness(left, right) {
  return compareRecordFreshness(left, right);
}

function compareRecordFreshness(left, right) {
  const leftTime = Date.parse(String(left?.updatedAt ?? left?.createdAt ?? ''));
  const rightTime = Date.parse(String(right?.updatedAt ?? right?.createdAt ?? ''));
  if (!Number.isNaN(leftTime) && !Number.isNaN(rightTime) && leftTime !== rightTime) return leftTime - rightTime;
  return String(left?.updatedAt ?? left?.createdAt ?? '').localeCompare(String(right?.updatedAt ?? right?.createdAt ?? ''));
}

function validateKeys(record, allowed, path, errors) {
  for (const key of Object.keys(record)) if (!allowed.has(key)) errors.push(`${path} 包含不支持的字段：${key}`);
}

function requireString(record, key, path, errors) {
  if (typeof record[key] !== 'string' || !record[key].trim()) errors.push(`${path}.${key} 必填`);
}

function requireStatus(status, path, errors) {
  if (!TASK_STATUSES.includes(status)) errors.push(`${path} 不正确`);
}

function requireTimestamp(record, key, path, errors) {
  if (typeof record[key] !== 'string' || Number.isNaN(Date.parse(record[key]))) errors.push(`${path}.${key} 不正确`);
}

function isPlainObject(value) {
  return Boolean(value) && typeof value === 'object' && !Array.isArray(value);
}

function byteLength(value) {
  if (globalThis.TextEncoder) return new globalThis.TextEncoder().encode(String(value)).length;
  return unescape(encodeURIComponent(String(value))).length;
}

function clone(value) {
  if (value === undefined) return undefined;
  if (globalThis.structuredClone) return globalThis.structuredClone(value);
  return JSON.parse(JSON.stringify(value));
}
