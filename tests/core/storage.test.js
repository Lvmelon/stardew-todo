import 'fake-indexeddb/auto';
import { beforeAll, beforeEach, describe, expect, it } from 'vitest';
import { createTaskStore, DB_NAME, LEGACY_TASKS_KEY, STORE_NAMES } from '../../storage.js';

function deleteDatabase() {
  return new Promise((resolve, reject) => {
    const request = indexedDB.deleteDatabase(DB_NAME);
    request.onsuccess = () => resolve();
    request.onerror = () => reject(request.error);
    request.onblocked = () => resolve();
  });
}

describe('IndexedDB v2 task store and migration', () => {
  beforeAll(async () => {
    localStorage.clear();
    await deleteDatabase();
  });

  beforeEach(() => {
    localStorage.clear();
  });

  it('creates all V2 stores and migrates legacy localStorage only into an empty IDB', async () => {
    localStorage.setItem(LEGACY_TASKS_KEY, JSON.stringify([{ id: 'legacy', title: '旧任务', status: 'open', dueDate: '' }]));
    const store = createTaskStore();
    const migrated = await store.getAll();
    expect(migrated).toHaveLength(1);
    expect(migrated[0]).toMatchObject({ id: 'legacy', reminderMode: 'none', pendingShareSync: false });
    const db = await new Promise((resolve, reject) => {
      const request = indexedDB.open(DB_NAME);
      request.onsuccess = () => resolve(request.result);
      request.onerror = () => reject(request.error);
    });
    expect([...db.objectStoreNames]).toEqual(expect.arrayContaining(Object.values(STORE_NAMES)));
    db.close();
  });

  it('does not overwrite existing IDB tasks with later legacy localStorage data', async () => {
    const store = createTaskStore();
    await store.put({ id: 'idb', title: '云前本机', status: 'open', dueDate: '' });
    localStorage.setItem(LEGACY_TASKS_KEY, JSON.stringify([{ id: 'legacy', title: '不应覆盖', status: 'open', dueDate: '' }]));
    const nextStore = createTaskStore();
    const tasks = await nextStore.getAll();
    expect(tasks.map(task => task.id)).toEqual(expect.arrayContaining(['legacy', 'idb']));
  });

  it('keeps shared task, comments, settings and backup APIs local', async () => {
    const store = createTaskStore();
    await store.putSharedTask({ taskId: 'task-1', spaceId: 'space-1', title: '共享', status: 'open' });
    await store.addComment({ commentId: 'comment-1', taskId: 'task-1', spaceId: 'space-1', authorRole: 'me', content: '收到', createdAt: '2026-08-25T00:00:00.000Z' });
    await store.setSetting('bgmEnabled', true);
    await store.saveBackup({ id: 'backup-1', data: '{}', createdAt: '2026-08-25T00:00:00.000Z' });
    expect((await store.getSharedTasks())[0].taskId).toBe('task-1');
    expect((await store.getComments('task-1'))[0].content).toBe('收到');
    expect(await store.getSetting('bgmEnabled')).toBe(true);
    expect((await store.getBackups())[0].id).toBe('backup-1');
  });
});
