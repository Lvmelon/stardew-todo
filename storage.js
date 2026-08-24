import { normalizeTask } from './task-model.js';

export const DB_NAME = 'stardew-todo-pwa';
export const DB_VERSION = 2;
export const LEGACY_TASKS_KEY = 'stardew_todo_tasks_v05';

export const STORE_NAMES = Object.freeze({
  tasks: 'tasks',
  meta: 'meta',
  sharedTasks: 'sharedTasks',
  comments: 'comments',
  backups: 'backups',
  settings: 'settings',
});

const LEGACY_MIGRATION_KEY = 'legacyLocalStorageMigrationV1';
const LOCAL_KEYS = Object.freeze({
  tasks: LEGACY_TASKS_KEY,
  meta: 'stardew_todo_meta_v1',
  sharedTasks: 'stardew_todo_shared_tasks_v1',
  comments: 'stardew_todo_comments_v1',
  backups: 'stardew_todo_backups_v1',
  settings: 'stardew_todo_settings_v1',
});

const API_METHODS = [
  'getAll', 'getTask', 'put', 'putMany', 'clearTasks',
  'getSharedTasks', 'getSharedTask', 'putSharedTask', 'putSharedTasks', 'removeSharedTask', 'clearSharedTasks',
  'getComments', 'getComment', 'putComment', 'addComment', 'clearComments',
  'getMeta', 'setMeta', 'getSetting', 'setSetting', 'getSettings', 'setSettings', 'clearSettings',
  'getBackups', 'getBackup', 'putBackup', 'saveBackup', 'removeBackup', 'deleteBackup', 'clearBackups',
  'getSnapshot', 'clearAll',
];

export function createTaskStore() {
  const memory = createMemoryStore();
  const local = createResilientStore(createLocalStorageStore(), memory);
  if (typeof indexedDB === 'undefined') return local;
  return createResilientStore(createIndexedDbStore(), local);
}

/**
 * Wrap a storage implementation and move permanently to its fallback after a
 * browser storage error (private browsing and quota errors are common cases).
 */
export function createResilientStore(primary, fallback) {
  let active = primary;
  async function call(method, ...args) {
    try {
      if (typeof active?.[method] !== 'function') throw new Error(`Storage method unavailable: ${method}`);
      return await active[method](...args);
    } catch (error) {
      if (active === fallback) throw error;
      active = fallback;
      if (typeof active?.[method] !== 'function') throw error;
      return active[method](...args);
    }
  }
  const api = Object.fromEntries(API_METHODS.map(method => [method, (...args) => call(method, ...args)]));
  // Compatibility aliases used by the sharing client. They still resolve
  // through the same resilient path and never create a second data store.
  api.putMeta = (...args) => api.setMeta(...args);
  api.deleteMeta = async key => api.setMeta(key, undefined);
  api.getMetadata = (...args) => api.getMeta(...args);
  api.putMetadata = (...args) => api.setMeta(...args);
  api.setMetadata = (...args) => api.setMeta(...args);
  api.getPendingComments = () => api.getMeta('pendingComments');
  api.putPendingComments = value => api.setMeta('pendingComments', value);
  api.replaceSharedTasks = async tasks => {
    await api.clearSharedTasks();
    return tasks?.length ? api.putSharedTasks(tasks) : [];
  };
  api.replaceComments = async (taskId, comments) => {
    const current = await api.getComments();
    const preserved = current.filter(comment => comment?.taskId !== taskId);
    await api.clearComments();
    for (const comment of [...preserved, ...(Array.isArray(comments) ? comments : [])]) await api.putComment(comment);
    return comments;
  };
  return api;
}

function createIndexedDbStore() {
  let dbPromise;
  let readyPromise;

  function openDb() {
    if (dbPromise) return dbPromise;
    dbPromise = new Promise((resolve, reject) => {
      const request = indexedDB.open(DB_NAME, DB_VERSION);
      request.onupgradeneeded = () => {
        const db = request.result;
        const transaction = request.transaction;
        ensureObjectStores(db, transaction);
        migrateTaskRecords(transaction, db);
      };
      request.onsuccess = () => resolve(request.result);
      request.onerror = () => reject(request.error || new Error('IndexedDB 打开失败'));
      request.onblocked = () => reject(new Error('IndexedDB 被其他页面占用'));
    });
    return dbPromise;
  }

  function ready() {
    if (!readyPromise) readyPromise = openDb().then(async db => {
      await migrateLegacyLocalStorage(db);
      return db;
    });
    return readyPromise;
  }

  async function getAll() {
    return getAllRecords(STORE_NAMES.tasks);
  }

  async function getTask(id) {
    return getRecord(STORE_NAMES.tasks, id);
  }

  async function put(task) {
    const normalized = normalizeTask(task);
    await writeTransaction([STORE_NAMES.tasks], stores => stores.tasks.put(normalized));
    return normalized;
  }

  async function putMany(tasks) {
    const normalized = tasks.map(task => normalizeTask(task));
    await writeTransaction([STORE_NAMES.tasks], stores => normalized.forEach(task => stores.tasks.put(task)));
    return normalized;
  }

  async function getSharedTasks() {
    return getAllRecords(STORE_NAMES.sharedTasks);
  }

  async function getSharedTask(taskId) {
    return getRecord(STORE_NAMES.sharedTasks, taskId);
  }

  async function putSharedTask(task) {
    const value = normalizeSharedTask(task);
    await writeTransaction([STORE_NAMES.sharedTasks], stores => stores.sharedTasks.put(value));
    return value;
  }

  async function putSharedTasks(tasks) {
    const values = tasks.map(normalizeSharedTask);
    await writeTransaction([STORE_NAMES.sharedTasks], stores => values.forEach(task => stores.sharedTasks.put(task)));
    return values;
  }

  async function getComments(filter = {}) {
    const taskId = typeof filter === 'string' ? filter : filter?.taskId;
    const spaceId = typeof filter === 'object' ? filter?.spaceId : undefined;
    const db = await ready();
    return requestTransaction(db, [STORE_NAMES.comments], 'readonly', stores => {
      if (taskId && stores.comments.indexNames.contains('byTaskId')) {
        return stores.comments.index('byTaskId').getAll(taskId);
      }
      if (spaceId && stores.comments.indexNames.contains('bySpaceId')) {
        return stores.comments.index('bySpaceId').getAll(spaceId);
      }
      return stores.comments.getAll();
    });
  }

  async function putComment(comment) {
    const value = normalizeComment(comment);
    await writeTransaction([STORE_NAMES.comments], stores => stores.comments.put(value));
    return value;
  }

  async function addComment(comment) {
    return putComment({ ...comment, commentId: comment?.commentId || createId('comment') });
  }

  async function getMeta(key) {
    if (key === null || key === undefined) {
      const records = await getAllRecords(STORE_NAMES.meta);
      return Object.fromEntries(records.map(record => [record.key, record.value]));
    }
    const record = await getRecord(STORE_NAMES.meta, key);
    return record?.value;
  }

  async function setMeta(key, value) {
    const entries = typeof key === 'object' && key !== null ? Object.entries(key) : [[key, value]];
    await writeTransaction([STORE_NAMES.meta], stores => entries.forEach(([name, entry]) => stores.meta.put({ key: name, value: entry })));
    return typeof key === 'object' && key !== null ? key : value;
  }

  async function getSetting(key, fallbackValue) {
    const record = await getRecord(STORE_NAMES.settings, key);
    return record ? record.value : fallbackValue;
  }

  async function setSetting(key, value) {
    await writeTransaction([STORE_NAMES.settings], stores => stores.settings.put({ key, value }));
    return value;
  }

  async function getSettings() {
    const records = await getAllRecords(STORE_NAMES.settings);
    return Object.fromEntries(records.map(record => [record.key, record.value]));
  }

  async function setSettings(values = {}) {
    const entries = Object.entries(values);
    await writeTransaction([STORE_NAMES.settings], stores => entries.forEach(([key, value]) => stores.settings.put({ key, value })));
    return values;
  }

  async function getBackups() {
    return getAllRecords(STORE_NAMES.backups);
  }

  async function getBackup(id) {
    return getRecord(STORE_NAMES.backups, id);
  }

  async function putBackup(backup) {
    const value = normalizeBackup(backup);
    await writeTransaction([STORE_NAMES.backups], stores => stores.backups.put(value));
    return value;
  }

  async function removeSharedTask(taskId) {
    await deleteRecord(STORE_NAMES.sharedTasks, taskId);
  }

  async function removeBackup(id) {
    await deleteRecord(STORE_NAMES.backups, id);
  }

  async function clearTasks() { await clearStore(STORE_NAMES.tasks); }
  async function clearSharedTasks() { await clearStore(STORE_NAMES.sharedTasks); }
  async function clearComments() { await clearStore(STORE_NAMES.comments); }
  async function clearSettings() { await clearStore(STORE_NAMES.settings); }
  async function clearBackups() { await clearStore(STORE_NAMES.backups); }

  async function getSnapshot() {
    const [tasks, sharedTasks, comments, settings] = await Promise.all([
      getAll(), getSharedTasks(), getComments(), getSettings(),
    ]);
    return { tasks, sharedTasks, comments, settings };
  }

  async function clearAll() {
    await Promise.all([clearTasks(), clearSharedTasks(), clearComments(), clearBackups(), clearSettings()]);
  }

  return {
    getAll, getTask, put, putMany, clearTasks,
    getSharedTasks, getSharedTask, putSharedTask, putSharedTasks, removeSharedTask, clearSharedTasks,
    getComments, getComment: commentId => getRecord(STORE_NAMES.comments, commentId), putComment, addComment, clearComments,
    getMeta, setMeta, getSetting, setSetting, getSettings, setSettings, clearSettings,
    getBackups, getBackup, putBackup, saveBackup: putBackup, removeBackup, deleteBackup: removeBackup, clearBackups,
    getSnapshot, clearAll,
  };

  async function getAllRecords(storeName) {
    const db = await ready();
    return requestTransaction(db, [storeName], 'readonly', stores => stores[storeName].getAll());
  }

  async function getRecord(storeName, key) {
    const db = await ready();
    return requestTransaction(db, [storeName], 'readonly', stores => stores[storeName].get(key));
  }

  async function writeTransaction(storeNames, action) {
    const db = await ready();
    return transaction(db, storeNames, 'readwrite', action);
  }

  async function deleteRecord(storeName, key) {
    return writeTransaction([storeName], stores => stores[storeName].delete(key));
  }

  async function clearStore(storeName) {
    return writeTransaction([storeName], stores => stores[storeName].clear());
  }
}

function ensureObjectStores(db, transactionValue) {
  if (!db.objectStoreNames.contains(STORE_NAMES.tasks)) {
    db.createObjectStore(STORE_NAMES.tasks, { keyPath: 'id' });
  }
  if (!db.objectStoreNames.contains(STORE_NAMES.meta)) {
    db.createObjectStore(STORE_NAMES.meta, { keyPath: 'key' });
  }
  if (!db.objectStoreNames.contains(STORE_NAMES.sharedTasks)) {
    db.createObjectStore(STORE_NAMES.sharedTasks, { keyPath: 'taskId' });
  }
  if (!db.objectStoreNames.contains(STORE_NAMES.comments)) {
    const store = db.createObjectStore(STORE_NAMES.comments, { keyPath: 'commentId' });
    store.createIndex('byTaskId', 'taskId', { unique: false });
    store.createIndex('bySpaceId', 'spaceId', { unique: false });
    store.createIndex('byCreatedAt', 'createdAt', { unique: false });
  } else {
    const store = transactionValue?.objectStore(STORE_NAMES.comments);
    if (store) ensureCommentIndexes(store);
  }
  if (!db.objectStoreNames.contains(STORE_NAMES.backups)) {
    db.createObjectStore(STORE_NAMES.backups, { keyPath: 'id' });
  }
  if (!db.objectStoreNames.contains(STORE_NAMES.settings)) {
    db.createObjectStore(STORE_NAMES.settings, { keyPath: 'key' });
  }
}

function ensureCommentIndexes(store) {
  if (!store.indexNames.contains('byTaskId')) store.createIndex('byTaskId', 'taskId', { unique: false });
  if (!store.indexNames.contains('bySpaceId')) store.createIndex('bySpaceId', 'spaceId', { unique: false });
  if (!store.indexNames.contains('byCreatedAt')) store.createIndex('byCreatedAt', 'createdAt', { unique: false });
}

function migrateTaskRecords(transactionValue, db) {
  if (!transactionValue || !db.objectStoreNames.contains(STORE_NAMES.tasks)) return;
  const store = transactionValue.objectStore(STORE_NAMES.tasks);
  const cursorRequest = store.openCursor();
  cursorRequest.onsuccess = () => {
    const cursor = cursorRequest.result;
    if (!cursor) return;
    cursor.update(normalizeTask(cursor.value, () => cursor.value?.updatedAt || new Date().toISOString()));
    cursor.continue();
  };
}

async function migrateLegacyLocalStorage(db) {
  const legacyTasks = readLegacyTasks();
  return new Promise((resolve, reject) => {
    let tasks;
    let marker;
    let reads = 0;
    let failed = false;
    const transactionValue = db.transaction([STORE_NAMES.tasks, STORE_NAMES.meta], 'readwrite');
    const tasksRequest = transactionValue.objectStore(STORE_NAMES.tasks).getAll();
    const markerRequest = transactionValue.objectStore(STORE_NAMES.meta).get(LEGACY_MIGRATION_KEY);
    const fail = error => {
      if (failed) return;
      failed = true;
      reject(error);
    };
    const maybeMigrate = () => {
      reads += 1;
      if (reads < 2 || failed) return;
      if (!marker && (!tasks || tasks.length === 0)) {
        const normalized = legacyTasks.map(task => normalizeTask(task));
        for (const task of normalized) transactionValue.objectStore(STORE_NAMES.tasks).put(task);
      }
      transactionValue.objectStore(STORE_NAMES.meta).put({
        key: LEGACY_MIGRATION_KEY,
        value: { migrated: true, imported: Boolean(!marker && (!tasks || tasks.length === 0) && legacyTasks.length), migratedAt: new Date().toISOString() },
      });
    };
    tasksRequest.onsuccess = () => { tasks = tasksRequest.result || []; maybeMigrate(); };
    markerRequest.onsuccess = () => { marker = markerRequest.result; maybeMigrate(); };
    tasksRequest.onerror = () => fail(tasksRequest.error);
    markerRequest.onerror = () => fail(markerRequest.error);
    transactionValue.oncomplete = () => resolve();
    transactionValue.onerror = () => fail(transactionValue.error || new Error('IndexedDB 迁移失败'));
    transactionValue.onabort = () => fail(transactionValue.error || new Error('IndexedDB 迁移已中止'));
  });
}

function readLegacyTasks() {
  try {
    if (typeof localStorage === 'undefined') return [];
    const raw = localStorage.getItem(LEGACY_TASKS_KEY);
    const parsed = raw ? JSON.parse(raw) : [];
    return Array.isArray(parsed) ? parsed : [];
  } catch {
    return [];
  }
}

function requestTransaction(db, storeNames, mode, action) {
  return new Promise((resolve, reject) => {
    let value;
    let request;
    const tx = db.transaction(storeNames, mode);
    const stores = Object.fromEntries(storeNames.map(name => [name, tx.objectStore(name)]));
    try {
      request = action(stores, tx);
    } catch (error) {
      reject(error);
      return;
    }
    if (request && typeof request.onsuccess !== 'undefined') {
      request.onsuccess = () => { value = request.result; };
      request.onerror = () => reject(request.error);
    } else value = request;
    tx.oncomplete = () => resolve(value);
    tx.onerror = () => reject(tx.error || new Error('IndexedDB 事务失败'));
    tx.onabort = () => reject(tx.error || new Error('IndexedDB 事务已中止'));
  });
}

function transaction(db, storeNames, mode, action) {
  return new Promise((resolve, reject) => {
    let value;
    const tx = db.transaction(storeNames, mode);
    const stores = Object.fromEntries(storeNames.map(name => [name, tx.objectStore(name)]));
    try {
      value = action(stores, tx);
    } catch (error) {
      reject(error);
      return;
    }
    tx.oncomplete = () => resolve(value);
    tx.onerror = () => reject(tx.error || new Error('IndexedDB 事务失败'));
    tx.onabort = () => reject(tx.error || new Error('IndexedDB 事务已中止'));
  });
}

function createMemoryStore() {
  const collections = {
    tasks: new Map(),
    sharedTasks: new Map(),
    comments: new Map(),
    meta: new Map(),
    settings: new Map(),
    backups: new Map(),
  };
  const cloneValue = value => {
    if (value === undefined) return undefined;
    if (globalThis.structuredClone) return globalThis.structuredClone(value);
    return JSON.parse(JSON.stringify(value));
  };
  const keys = {
    tasks: 'id', sharedTasks: 'taskId', comments: 'commentId', meta: 'key', settings: 'key', backups: 'id',
  };
  function putCollection(name, value) {
    const key = value?.[keys[name]];
    if (key === null || key === undefined) throw new Error(`Missing ${keys[name]}`);
    collections[name].set(key, cloneValue(value));
    return cloneValue(value);
  }
  function getCollection(name) {
    return [...collections[name].values()].map(cloneValue);
  }
  function clearCollection(name) { collections[name].clear(); }
  return {
    async getAll() { return getCollection('tasks'); },
    async getTask(id) { return cloneValue(collections.tasks.get(id)); },
    async put(task) { return putCollection('tasks', normalizeTask(task)); },
    async putMany(tasks) { return tasks.map(task => putCollection('tasks', normalizeTask(task))); },
    async clearTasks() { clearCollection('tasks'); },
    async getSharedTasks() { return getCollection('sharedTasks'); },
    async getSharedTask(taskId) { return cloneValue(collections.sharedTasks.get(taskId)); },
    async putSharedTask(task) { return putCollection('sharedTasks', normalizeSharedTask(task)); },
    async putSharedTasks(tasks) { return tasks.map(task => putCollection('sharedTasks', normalizeSharedTask(task))); },
    async removeSharedTask(taskId) { collections.sharedTasks.delete(taskId); },
    async clearSharedTasks() { clearCollection('sharedTasks'); },
    async getComments(filter = {}) {
      const taskId = typeof filter === 'string' ? filter : filter?.taskId;
      const spaceId = typeof filter === 'object' ? filter?.spaceId : undefined;
      return getCollection('comments').filter(comment => (!taskId || comment.taskId === taskId) && (!spaceId || comment.spaceId === spaceId));
    },
    async getComment(commentId) { return cloneValue(collections.comments.get(commentId)); },
    async putComment(comment) { return putCollection('comments', normalizeComment(comment)); },
    async addComment(comment) { return putCollection('comments', normalizeComment({ ...comment, commentId: comment?.commentId || createId('comment') })); },
    async clearComments() { clearCollection('comments'); },
    async getMeta(key) { return key === null || key === undefined ? Object.fromEntries([...collections.meta].map(([k, v]) => [k, cloneValue(v)])) : cloneValue(collections.meta.get(key)); },
    async setMeta(key, value) {
      const entries = typeof key === 'object' && key !== null ? Object.entries(key) : [[key, value]];
      entries.forEach(([name, entry]) => collections.meta.set(name, cloneValue(entry)));
      return typeof key === 'object' && key !== null ? key : value;
    },
    async getSetting(key, fallbackValue) { return collections.settings.has(key) ? cloneValue(collections.settings.get(key)) : fallbackValue; },
    async setSetting(key, value) { collections.settings.set(key, cloneValue(value)); return value; },
    async getSettings() { return Object.fromEntries([...collections.settings].map(([key, value]) => [key, cloneValue(value)])); },
    async setSettings(values = {}) { Object.entries(values).forEach(([key, value]) => collections.settings.set(key, cloneValue(value))); return values; },
    async clearSettings() { clearCollection('settings'); },
    async getBackups() { return getCollection('backups'); },
    async getBackup(id) { return cloneValue(collections.backups.get(id)); },
    async putBackup(backup) { return putCollection('backups', normalizeBackup(backup)); },
    async saveBackup(backup) { return putCollection('backups', normalizeBackup(backup)); },
    async removeBackup(id) { collections.backups.delete(id); },
    async deleteBackup(id) { collections.backups.delete(id); },
    async clearBackups() { clearCollection('backups'); },
    async getSnapshot() {
      return {
        tasks: getCollection('tasks'),
        sharedTasks: getCollection('sharedTasks'),
        comments: getCollection('comments'),
        settings: Object.fromEntries([...collections.settings].map(([key, value]) => [key, cloneValue(value)])),
      };
    },
    async clearAll() { Object.keys(collections).forEach(clearCollection); },
  };
}

function createLocalStorageStore() {
  function readCollection(name) {
    if (typeof localStorage === 'undefined') throw new Error('localStorage unavailable');
    const raw = localStorage.getItem(LOCAL_KEYS[name]);
    if (!raw) return name === 'settings' || name === 'meta' ? {} : [];
    const value = JSON.parse(raw);
    return value;
  }
  function writeCollection(name, value) {
    if (typeof localStorage === 'undefined') throw new Error('localStorage unavailable');
    localStorage.setItem(LOCAL_KEYS[name], JSON.stringify(value));
  }
  function records(name) {
    const value = readCollection(name);
    return Array.isArray(value) ? value : [];
  }
  function putRecord(name, keyName, record) {
    const values = records(name);
    const index = values.findIndex(item => item?.[keyName] === record?.[keyName]);
    if (index >= 0) values[index] = record; else values.push(record);
    writeCollection(name, values);
    return record;
  }
  function deleteRecord(name, keyName, key) {
    writeCollection(name, records(name).filter(item => item?.[keyName] !== key));
  }
  return {
    async getAll() { return records('tasks').map(task => normalizeTask(task)); },
    async getTask(id) { return records('tasks').find(task => task?.id === id); },
    async put(task) { return putRecord('tasks', 'id', normalizeTask(task)); },
    async putMany(tasks) { tasks.forEach(task => putRecord('tasks', 'id', normalizeTask(task))); return tasks; },
    async clearTasks() { writeCollection('tasks', []); },
    async getSharedTasks() { return records('sharedTasks'); },
    async getSharedTask(taskId) { return records('sharedTasks').find(task => task?.taskId === taskId); },
    async putSharedTask(task) { return putRecord('sharedTasks', 'taskId', normalizeSharedTask(task)); },
    async putSharedTasks(tasks) { tasks.forEach(task => putRecord('sharedTasks', 'taskId', normalizeSharedTask(task))); return tasks; },
    async removeSharedTask(taskId) { deleteRecord('sharedTasks', 'taskId', taskId); },
    async clearSharedTasks() { writeCollection('sharedTasks', []); },
    async getComments(filter = {}) {
      const taskId = typeof filter === 'string' ? filter : filter?.taskId;
      const spaceId = typeof filter === 'object' ? filter?.spaceId : undefined;
      return records('comments').filter(comment => (!taskId || comment.taskId === taskId) && (!spaceId || comment.spaceId === spaceId));
    },
    async getComment(commentId) { return records('comments').find(comment => comment?.commentId === commentId); },
    async putComment(comment) { return putRecord('comments', 'commentId', normalizeComment(comment)); },
    async addComment(comment) { return putRecord('comments', 'commentId', normalizeComment({ ...comment, commentId: comment?.commentId || createId('comment') })); },
    async clearComments() { writeCollection('comments', []); },
    async getMeta(key) { const value = readCollection('meta'); return key === null || key === undefined ? value : value?.[key]; },
    async setMeta(key, value) { const current = readCollection('meta'); const next = typeof key === 'object' && key !== null ? { ...current, ...key } : { ...current, [key]: value }; writeCollection('meta', next); return value; },
    async getSetting(key, fallbackValue) { const value = readCollection('settings'); return Object.prototype.hasOwnProperty.call(value, key) ? value[key] : fallbackValue; },
    async setSetting(key, value) { const current = readCollection('settings'); writeCollection('settings', { ...current, [key]: value }); return value; },
    async getSettings() { return readCollection('settings'); },
    async setSettings(values = {}) { writeCollection('settings', { ...readCollection('settings'), ...values }); return values; },
    async clearSettings() { writeCollection('settings', {}); },
    async getBackups() { return records('backups'); },
    async getBackup(id) { return records('backups').find(backup => backup?.id === id); },
    async putBackup(backup) { return putRecord('backups', 'id', normalizeBackup(backup)); },
    async saveBackup(backup) { return putRecord('backups', 'id', normalizeBackup(backup)); },
    async removeBackup(id) { deleteRecord('backups', 'id', id); },
    async deleteBackup(id) { deleteRecord('backups', 'id', id); },
    async clearBackups() { writeCollection('backups', []); },
    async getSnapshot() { return { tasks: records('tasks').map(task => normalizeTask(task)), sharedTasks: records('sharedTasks'), comments: records('comments'), settings: readCollection('settings') }; },
    async clearAll() { writeCollection('tasks', []); writeCollection('sharedTasks', []); writeCollection('comments', []); writeCollection('backups', []); writeCollection('settings', {}); },
  };
}

function normalizeSharedTask(task = {}) {
  const taskId = String(task.taskId ?? task.id ?? '').trim() || createId('shared-task');
  return {
    ...task,
    taskId,
    spaceId: String(task.spaceId ?? '').trim(),
    title: String(task.title ?? '').trim(),
    description: String(task.description ?? '').trim(),
    emoji: String(task.emoji ?? '').trim() || '📌',
    dueDate: task.dueDate === null || task.dueDate === undefined ? '' : String(task.dueDate),
    status: ['open', 'completed', 'deleted'].includes(task.status) ? task.status : 'open',
    ownerRole: String(task.ownerRole ?? 'me').trim() || 'me',
    reminderMode: task.reminderMode === 'off' ? 'none' : String(task.reminderMode ?? '').trim() || 'none',
    sourceRevision: Number.isSafeInteger(Number(task.sourceRevision)) ? Number(task.sourceRevision) : 0,
  };
}

function normalizeComment(comment = {}) {
  return {
    ...comment,
    commentId: String(comment.commentId ?? '').trim() || createId('comment'),
    taskId: String(comment.taskId ?? '').trim(),
    spaceId: String(comment.spaceId ?? '').trim(),
    authorRole: String(comment.authorRole ?? 'me').trim() || 'me',
    content: String(comment.content ?? '').trim(),
    createdAt: normalizeRecordTimestamp(comment.createdAt),
  };
}

function normalizeBackup(backup = {}) {
  return {
    ...backup,
    id: String(backup.id ?? '').trim() || createId('backup'),
    createdAt: normalizeRecordTimestamp(backup.createdAt),
  };
}

function normalizeRecordTimestamp(value) {
  if (value instanceof Date && !Number.isNaN(value.getTime())) return value.toISOString();
  const text = String(value ?? '').trim();
  return text || new Date().toISOString();
}

function createId(prefix) {
  if (globalThis.crypto?.randomUUID) return `${prefix}-${globalThis.crypto.randomUUID()}`;
  return `${prefix}-${Date.now()}-${Math.random().toString(36).slice(2, 10)}`;
}
