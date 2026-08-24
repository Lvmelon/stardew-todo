import {
  COMMENTS_CACHE_KEY,
  PENDING_COMMENTS_KEY,
  SHARED_TASKS_CACHE_KEY,
} from './config.js';
import {
  NotPairedError,
  ShareClientError,
  createShareClient,
  sourceRevisionFor,
} from './share-client.js';

const MAX_COMMENT_LENGTH = 500;

/**
 * Share only the fields the other person needs to see the task and the Worker
 * needs to schedule its reminder.  Local display/settings data never crosses
 * this boundary.
 */
export function toSharedTask(task, credentials = {}) {
  if (!task || !task.id) throw new ShareClientError('任务缺少 id', { code: 'task-id-missing' });
  return {
    taskId: String(task.id),
    spaceId: String(credentials.spaceId || task.spaceId || ''),
    title: String(task.title || '').trim(),
    description: String(task.description || '').trim(),
    emoji: String(task.emoji || '📌').trim() || '📌',
    dueDate: String(task.dueDate || '').trim() || null,
    status: String(task.status || 'open'),
    createdAt: task.createdAt || null,
    updatedAt: task.updatedAt || task.createdAt || null,
    ownerRole: String(credentials.role || 'owner'),
    revision: revisionNumber(task),
    reminderMode: normalizeReminderMode(task.reminderMode, task.reminderAt),
    reminderAt: task.reminderAt || null,
    overdueAt: task.overdueAt || null,
    reminderSentAt: task.reminderSentAt || null,
    overdueReminderSentAt: task.overdueReminderSentAt || null,
    sourceRevision: sourceRevisionFor(task),
  };
}

/**
 * Local-first sharing helper.  It deliberately has no distributed queue: a
 * task only gets a boolean pendingShareSync marker and is retried at explicit
 * lifecycle points (startup, online, or a user-triggered refresh).
 */
export function createShareSync(options = {}) {
  const store = options.store || null;
  const client = options.shareClient || createShareClient(options);
  const now = options.now || (() => new Date().toISOString());
  const lifecycleTarget = options.lifecycleTarget || globalThis;
  let bound = false;

  async function credentials() {
    return client.getCredentials();
  }

  async function syncTask(task, requestOptions = {}) {
    const currentCredentials = await credentials();
    if (!currentCredentials?.spaceId || !currentCredentials.accessToken) {
      return { ok: false, skipped: true, reason: 'not-paired', task };
    }
    // The second device is intentionally read/comment-only in V1.0.
    const mirror = toSharedTask(task, currentCredentials);
    try {
      const response = await client.putTaskMirror(mirror, requestOptions);
      const updated = await markTaskPending(task, false);
      return { ok: true, response, mirror, task: updated };
    } catch (error) {
      const pending = await markTaskPending(task, true);
      return { ok: false, pendingShareSync: true, error, mirror, task: pending };
    }
  }

  async function syncExistingTasks(tasks = [], requestOptions = {}) {
    const results = [];
    for (const task of tasks) results.push(await syncTask(task, requestOptions));
    return results;
  }

  async function retryPendingShareSync(requestOptions = {}) {
    const tasks = await getTasks();
    const pending = tasks.filter(task => task?.pendingShareSync === true);
    const results = [];
    for (const task of pending) results.push(await syncTask(task, requestOptions));
    return results;
  }

  async function fetchSharedTasks(requestOptions = {}) {
    const payload = await client.getSharedTasks(requestOptions);
    const tasks = extractCollection(payload, ['tasks', 'sharedTasks', 'items']);
    await replaceSharedTasks(tasks);
    return clone(tasks);
  }

  async function getCachedSharedTasks() {
    const cached = await readCollection('sharedTasks', SHARED_TASKS_CACHE_KEY, store);
    return clone(Array.isArray(cached) ? cached : []);
  }

  async function fetchComments(taskId, requestOptions = {}) {
    const id = requireTaskId(taskId);
    const payload = await client.getComments(id, requestOptions);
    const comments = extractCollection(payload, ['comments', 'items']);
    await writeComments(id, comments);
    return clone(comments);
  }

  async function getCachedComments(taskId) {
    const id = requireTaskId(taskId);
    if (typeof store?.getComments === 'function') {
      const comments = await store.getComments({ taskId: id });
      return clone(Array.isArray(comments) ? comments : []);
    }
    const all = await readCollection('comments', COMMENTS_CACHE_KEY, store);
    return clone(Array.isArray(all?.[id]) ? all[id] : []);
  }

  async function addComment(taskId, content, input = {}) {
    const id = requireTaskId(taskId);
    const text = String(content ?? '').trim();
    if (!text) throw new ShareClientError('留言内容不能为空', { code: 'comment-empty' });
    if ([...text].length > MAX_COMMENT_LENGTH) {
      throw new ShareClientError(`留言最多 ${MAX_COMMENT_LENGTH} 个字`, { code: 'comment-too-long' });
    }
    const currentCredentials = await credentials();
    if (!currentCredentials?.spaceId || !currentCredentials.accessToken) throw new NotPairedError();
    const comment = {
      commentId: input.commentId || makeCommentId(),
      taskId: id,
      spaceId: currentCredentials.spaceId,
      authorRole: String(input.authorRole || currentCredentials.role || 'guest'),
      authorName: String(input.authorName || currentCredentials.displayName || '').trim() || undefined,
      content: text,
      createdAt: input.createdAt || now(),
    };
    try {
      const response = await client.postComment(comment, input);
      const saved = normalizeComment(response, comment);
      await appendCachedComment(id, saved);
      return { ok: true, comment: clone(saved), response };
    } catch (error) {
      await savePendingComment(comment);
      return { ok: false, pending: true, comment: clone(comment), error };
    }
  }

  async function retryPendingComments(requestOptions = {}) {
    const pending = await readPendingComments();
    const results = [];
    for (const comment of pending) {
      try {
        const response = await client.postComment(comment, requestOptions);
        const saved = normalizeComment(response, comment);
        await appendCachedComment(comment.taskId, saved);
        await removePendingComment(comment.commentId);
        results.push({ ok: true, comment: clone(saved), response });
      } catch (error) {
        results.push({ ok: false, pending: true, comment: clone(comment), error });
      }
    }
    return results;
  }

  async function retryPending(requestOptions = {}) {
    const [tasks, comments] = await Promise.all([
      retryPendingShareSync(requestOptions),
      retryPendingComments(requestOptions),
    ]);
    return { tasks, comments };
  }

  function bindLifecycle() {
    if (bound || !lifecycleTarget?.addEventListener) return () => {};
    bound = true;
    const retry = () => { void retryPending(); };
    lifecycleTarget.addEventListener('online', retry);
    lifecycleTarget.addEventListener('visibilitychange', retry);
    return () => {
      if (!bound) return;
      lifecycleTarget.removeEventListener?.('online', retry);
      lifecycleTarget.removeEventListener?.('visibilitychange', retry);
      bound = false;
    };
  }

  async function markTaskPending(task, pending) {
    const updated = { ...task, pendingShareSync: Boolean(pending) };
    if (store?.put) {
      try { await store.put(updated); } catch { /* local operation already succeeded */ }
    }
    return updated;
  }

  async function getTasks() {
    if (typeof options.getTasks === 'function') return (await options.getTasks()) || [];
    if (store?.getAll) return (await store.getAll()) || [];
    return [];
  }

  return Object.freeze({
    client,
    syncTask,
    syncExistingTasks,
    retryPendingShareSync,
    retryPendingComments,
    retryPending,
    fetchSharedTasks,
    getCachedSharedTasks,
    fetchComments,
    getCachedComments,
    addComment,
    bindLifecycle,
    toSharedTask,
  });

  async function readPendingComments() {
    const value = await readCollection('pendingComments', PENDING_COMMENTS_KEY, store);
    return Array.isArray(value) ? value.map(clone) : [];
  }

  async function savePendingComment(comment) {
    const pending = await readPendingComments();
    const index = pending.findIndex(item => item.commentId === comment.commentId);
    if (index >= 0) pending[index] = comment; else pending.push(comment);
    await writeCollection('pendingComments', PENDING_COMMENTS_KEY, pending, store);
  }

  async function removePendingComment(commentId) {
    const pending = await readPendingComments();
    await writeCollection(
      'pendingComments',
      PENDING_COMMENTS_KEY,
      pending.filter(item => item.commentId !== commentId),
      store,
    );
  }

  async function replaceSharedTasks(tasks) {
    if (typeof store?.replaceSharedTasks === 'function') return store.replaceSharedTasks(clone(tasks));
    if (typeof store?.putSharedTasks === 'function') return store.putSharedTasks(clone(tasks));
    await writeCollection('sharedTasks', SHARED_TASKS_CACHE_KEY, tasks, store);
  }

  async function writeComments(taskId, comments) {
    if (typeof store?.replaceComments === 'function') return store.replaceComments(taskId, clone(comments));
    const all = await readCollection('comments', COMMENTS_CACHE_KEY, store);
    const next = all && typeof all === 'object' && !Array.isArray(all) ? all : {};
    next[taskId] = clone(comments);
    await writeCollection('comments', COMMENTS_CACHE_KEY, next, store);
  }

  async function appendCachedComment(taskId, comment) {
    const existing = await getCachedComments(taskId);
    if (!existing.some(item => item.commentId === comment.commentId)) {
      existing.push(comment);
      await writeComments(taskId, existing);
    }
  }
}

export function extractCollection(payload, keys = []) {
  if (Array.isArray(payload)) return payload;
  for (const key of keys) if (Array.isArray(payload?.[key])) return payload[key];
  return [];
}

function requireTaskId(taskId) {
  const id = String(taskId || '').trim();
  if (!id) throw new ShareClientError('任务缺少 id', { code: 'task-id-missing' });
  return id;
}

function normalizeComment(payload, fallback) {
  const data = payload?.comment && typeof payload.comment === 'object' ? payload.comment : payload;
  if (!data || typeof data !== 'object' || Array.isArray(data)) return { ...fallback };
  return {
    ...fallback,
    ...data,
    commentId: String(data.commentId || data.id || fallback.commentId),
    taskId: String(data.taskId || fallback.taskId),
    spaceId: String(data.spaceId || fallback.spaceId),
    authorRole: String(data.authorRole || fallback.authorRole),
    content: String(data.content || fallback.content),
    createdAt: data.createdAt || fallback.createdAt,
  };
}

function makeCommentId() {
  if (globalThis.crypto?.randomUUID) return globalThis.crypto.randomUUID();
  return `comment-${Date.now()}-${Math.random().toString(36).slice(2, 10)}`;
}

function revisionNumber(task) {
  const value = Number(task?.sourceRevision ?? task?.revision);
  return Number.isSafeInteger(value) && value >= 0 ? value : 0;
}

function normalizeReminderMode(mode, reminderAt) {
  const value = String(mode || '').trim();
  if (value === 'none' || value === 'off' || !value) return reminderAt ? 'custom' : 'none';
  return ['default', 'custom'].includes(value) ? value : 'none';
}

function clone(value) {
  if (value === undefined || value === null) return value;
  if (typeof structuredClone === 'function') return structuredClone(value);
  return JSON.parse(JSON.stringify(value));
}

async function readCollection(kind, key, store = null) {
  // This overload is used internally after the closure is created; it is kept
  // outside the closure for easy testing and to avoid mutating returned data.
  if (!store) return undefined;
  if (kind === 'sharedTasks' && typeof store.getSharedTasks === 'function') return store.getSharedTasks();
  if (kind === 'comments' && typeof store.getComments === 'function') return store.getComments();
  if (kind === 'pendingComments' && typeof store.getPendingComments === 'function') return store.getPendingComments();
  if (typeof store.getMeta === 'function') return store.getMeta(key);
  if (typeof store.getMetadata === 'function') return store.getMetadata(key);
  if (store.meta?.get) return store.meta.get(key);
  return undefined;
}

async function writeCollection(kind, key, value, store = null) {
  if (!store) return value;
  if (kind === 'sharedTasks' && typeof store.replaceSharedTasks === 'function') return store.replaceSharedTasks(value);
  if (kind === 'comments' && typeof store.replaceComments === 'function') return store.replaceComments(value);
  if (kind === 'pendingComments' && typeof store.putPendingComments === 'function') return store.putPendingComments(value);
  if (typeof store.putMeta === 'function') return store.putMeta(key, value);
  if (typeof store.setMeta === 'function') return store.setMeta(key, value);
  if (typeof store.putMetadata === 'function') return store.putMetadata(key, value);
  if (store.meta?.set) return store.meta.set(key, value);
  return value;
}
