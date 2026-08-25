import { readFileSync } from 'node:fs';
import { beforeAll, beforeEach, describe, expect, it, vi } from 'vitest';

globalThis.__STARDEW_TODO_DISABLE_AUTO_INIT__ = true;

let createApplication;
const indexHtml = readFileSync('index.html', 'utf8');

class AppStore {
  constructor(tasks = []) {
    this.tasks = tasks.map(task => ({ ...task }));
    this.meta = new Map([['defaultSeeded', true]]);
    this.settings = {};
  }

  async getAll() { return structuredClone(this.tasks); }
  async putMany(tasks) { this.tasks = structuredClone(tasks); return structuredClone(tasks); }
  async put(task) {
    const index = this.tasks.findIndex(item => item.id === task.id);
    if (index < 0) this.tasks.push(structuredClone(task)); else this.tasks[index] = structuredClone(task);
    return structuredClone(task);
  }
  async clearTasks() { this.tasks = []; }
  async getMeta(key) { return this.meta.get(key); }
  async setMeta(key, value) { this.meta.set(key, structuredClone(value)); }
  async putMeta(key, value) { return this.setMeta(key, value); }
  async deleteMeta(key) { this.meta.delete(key); }
  async getSettings() { return structuredClone(this.settings); }
  async setSettings(value) { this.settings = structuredClone(value); }
  async getSharedTasks() { return []; }
  async getComments() { return []; }
  async getBackups() { return []; }
  async putComment() {}
}

function tick() {
  return new Promise(resolve => setTimeout(resolve, 0));
}

describe('V1 application sharing consent', () => {
  beforeAll(async () => {
    ({ createApplication } = await import('../../app.js'));
  });

  beforeEach(() => {
    document.open();
    document.write(indexHtml);
    document.close();
  });

  it('does not upload existing local tasks until the user confirms', async () => {
    const store = new AppStore([{
      id: 'seed-1', title: '旧任务', description: '', emoji: '📌', dueDate: '', status: 'open',
      createdAt: '2026-08-25T00:00:00.000Z', updatedAt: '2026-08-25T00:00:00.000Z',
      sourceRevision: 1, pendingShareSync: true,
    }]);
    let credentials = null;
    const shareClient = {
      async getCredentials() { return credentials; },
      async createSpace() {
        credentials = {
          spaceId: 'space-1', deviceId: 'device-1', role: 'owner', accessToken: 'access-1',
          pairSecret: 'pair-secret', recoveryCode: 'recovery-secret', pairLink: 'https://example.test/#pair=descriptor',
          recoveryDescriptor: 'recovery-descriptor',
        };
        return credentials;
      },
      buildPairLink: () => 'https://example.test/#pair=descriptor',
      buildRecoveryCode: () => 'recovery-descriptor',
    };
    const syncExistingTasks = vi.fn(async tasks => tasks.map(task => ({ ok: true, task: { ...task, pendingShareSync: false } })));
    const shareSync = {
      bindLifecycle() {},
      async retryPending() { return { tasks: [], comments: [] }; },
      syncExistingTasks,
      async getCachedSharedTasks() { return []; },
    };
    const app = createApplication({
      documentImpl: document,
      navigatorImpl: {},
      store,
      shareClient,
      shareSync,
      notificationClient: { permission: () => 'default', support: () => ({ supported: false }) },
      weatherService: { getCached: () => null },
      audioManager: { setEnabled() {}, setVolume() {} },
    });
    await app.initialize();

    document.querySelector('#create-space').click();
    await tick();
    await tick();

    expect(syncExistingTasks).not.toHaveBeenCalled();
    expect(document.querySelector('#confirm-modal').getAttribute('aria-hidden')).toBe('false');
    expect(document.querySelector('#confirm-message').textContent).toContain('已有任务');
    expect(document.querySelector('#space-secret-output').textContent).toContain('recovery-descriptor');
    expect(store.tasks[0]).toMatchObject({ id: 'legacy-device-1-seed-1', pendingShareSync: false });

    document.querySelector('#confirm-action').click();
    await tick();
    expect(syncExistingTasks).toHaveBeenCalledTimes(1);
  });

  it('shows creation progress immediately and prevents duplicate space requests', async () => {
    const store = new AppStore();
    let credentials = null;
    let resolveCreate;
    const createSpace = vi.fn(() => new Promise(resolve => { resolveCreate = resolve; }));
    const shareClient = {
      async getCredentials() { return credentials; },
      createSpace,
      buildPairLink: () => 'https://example.test/#pair=descriptor',
      buildRecoveryCode: () => 'recovery-descriptor',
    };
    const app = createApplication({
      documentImpl: document,
      navigatorImpl: {},
      store,
      shareClient,
      shareSync: { bindLifecycle() {}, async retryPending() { return { tasks: [], comments: [] }; } },
      notificationClient: { permission: () => 'default', support: () => ({ supported: false }) },
      weatherService: { getCached: () => null },
      audioManager: { setEnabled() {}, setVolume() {} },
    });
    await app.initialize();

    const button = document.querySelector('#create-space');
    button.click();
    button.click();
    await tick();

    expect(createSpace).toHaveBeenCalledTimes(1);
    expect(button.disabled).toBe(true);
    expect(button.textContent).toBe('正在创建…');
    expect(document.querySelector('#space-status').textContent).toContain('正在创建');

    credentials = {
      spaceId: 'space-1', deviceId: 'device-1', role: 'owner', accessToken: 'access-1',
      pairSecret: 'pair-secret', recoveryCode: 'recovery-secret',
      pairLink: 'https://example.test/#pair=descriptor', recoveryDescriptor: 'recovery-descriptor',
    };
    resolveCreate(credentials);
    await tick();
    await tick();

    expect(button.disabled).toBe(false);
    expect(button.textContent).toBe('创建我们的空间');
    expect(document.querySelector('#space-status').textContent).toContain('已连接');
  });

  it('keeps a route to future and completed tasks when the home board has no current task', async () => {
    const store = new AppStore([
      {
        id: 'future-1', title: '未来任务', startDate: '2099-08-27', dueDate: '2099-08-30', status: 'open',
        createdAt: '2026-08-25T00:00:00.000Z', updatedAt: '2026-08-25T00:00:00.000Z',
      },
      {
        id: 'done-1', title: '完成任务', dueDate: '', status: 'completed',
        createdAt: '2026-08-24T00:00:00.000Z', updatedAt: '2026-08-25T00:00:00.000Z',
      },
    ]);
    const shareClient = { async getCredentials() { return null; } };
    const shareSync = {
      bindLifecycle() {},
      async retryPending() { return { tasks: [], comments: [] }; },
      async getCachedSharedTasks() { return []; },
    };
    const app = createApplication({
      documentImpl: document,
      navigatorImpl: {},
      store,
      shareClient,
      shareSync,
      notificationClient: { permission: () => 'default', support: () => ({ supported: false }) },
      weatherService: { getCached: () => null },
      audioManager: { setEnabled() {}, setVolume() {} },
    });
    await app.initialize();

    const empty = document.querySelector('#empty-state');
    const route = document.querySelector('#overflow-count');
    expect(empty.hidden).toBe(false);
    expect(empty.textContent).toContain('未来');
    expect(route.hidden).toBe(false);
    expect(route.dataset.filter).toBe('future');
  });

  it('saves a selected preset or a custom task icon together with the start date', async () => {
    const store = new AppStore();
    const app = createApplication({
      documentImpl: document,
      navigatorImpl: {},
      store,
      shareClient: { async getCredentials() { return null; } },
      shareSync: { bindLifecycle() {}, async retryPending() { return { tasks: [], comments: [] }; }, async syncTask(task) { return { task }; } },
      notificationClient: { permission: () => 'default', support: () => ({ supported: false }) },
      weatherService: { getCached: () => null },
      audioManager: { setEnabled() {}, setVolume() {} },
    });
    await app.initialize();

    document.querySelector('#new-task-button').click();
    [...document.querySelectorAll('[data-task-emoji]')].find(button => button.textContent === '📦').click();
    document.querySelector('#task-title-input').value = '取快递';
    document.querySelector('#task-start-date-input').value = '2026-08-25';
    document.querySelector('#task-date-input').value = '2026-08-27';
    document.querySelector('#task-form').requestSubmit();
    await tick();
    expect(store.tasks[0]).toMatchObject({ title: '取快递', emoji: '📦', startDate: '2026-08-25', dueDate: '2026-08-27' });

    document.querySelector('#new-task-button').click();
    document.querySelector('#task-title-input').value = '带伞';
    document.querySelector('#task-emoji-input').value = '☂️';
    document.querySelector('#task-start-date-input').value = '2026-08-25';
    document.querySelector('#task-form').requestSubmit();
    await tick();
    expect(store.tasks[1]).toMatchObject({ title: '带伞', emoji: '☂️', startDate: '2026-08-25' });
  });

  it('applies and persists the gentle scene motion preference', async () => {
    const store = new AppStore();
    store.settings = { ambientMotion: false };
    const app = createApplication({
      documentImpl: document,
      navigatorImpl: {},
      store,
      shareClient: { async getCredentials() { return null; } },
      shareSync: { bindLifecycle() {}, async retryPending() { return { tasks: [], comments: [] }; }, async getCachedSharedTasks() { return []; } },
      notificationClient: { permission: () => 'default', support: () => ({ supported: false }) },
      weatherService: { getCached: () => null },
      audioManager: { setEnabled() {}, setVolume() {} },
    });
    await app.initialize();

    expect(document.body.classList.contains('ambient-motion-off')).toBe(true);
    const input = document.querySelector('#ambient-motion-enabled');
    expect(input.checked).toBe(false);
    input.checked = true;
    input.dispatchEvent(new window.Event('change', { bubbles: true }));
    await tick();
    expect(store.settings.ambientMotion).toBe(true);
    expect(document.body.classList.contains('ambient-motion-off')).toBe(false);
  });

  it('explains when the system reduces motion', async () => {
    const store = new AppStore();
    const app = createApplication({
      documentImpl: document,
      navigatorImpl: {},
      store,
      matchMediaImpl: () => ({ matches: true }),
      shareClient: { async getCredentials() { return null; } },
      shareSync: { bindLifecycle() {}, async retryPending() { return { tasks: [], comments: [] }; }, async getCachedSharedTasks() { return []; } },
      notificationClient: { permission: () => 'default', support: () => ({ supported: false }) },
      weatherService: { getCached: () => null },
      audioManager: { setEnabled() {}, setVolume() {} },
    });
    await app.initialize();

    expect(document.querySelector('#ambient-motion-status').textContent).toContain('减少动态效果');
  });

  it('starts BGM inside the enabling gesture before asynchronous settings persistence', async () => {
    const store = new AppStore();
    let finishSave;
    store.setSettings = value => new Promise(resolve => {
      finishSave = () => { store.settings = structuredClone(value); resolve(); };
    });
    const audioManager = {
      setEnabled: vi.fn(),
      setVolume: vi.fn(),
      startFromGesture: vi.fn(async () => ({ ok: true })),
      stop: vi.fn(async () => ({ ok: true })),
    };
    const app = createApplication({
      documentImpl: document,
      navigatorImpl: {},
      store,
      shareClient: { async getCredentials() { return null; } },
      shareSync: { bindLifecycle() {}, async retryPending() { return { tasks: [], comments: [] }; }, async getCachedSharedTasks() { return []; } },
      notificationClient: { permission: () => 'default', support: () => ({ supported: false }) },
      weatherService: { getCached: () => null },
      audioManager,
    });
    await app.initialize();

    const input = document.querySelector('#bgm-enabled');
    input.checked = true;
    input.dispatchEvent(new window.Event('change', { bubbles: true }));

    expect(audioManager.setEnabled).toHaveBeenCalledWith(true);
    expect(audioManager.startFromGesture).toHaveBeenCalledTimes(1);
    await tick();
    finishSave?.();
    await tick();
    expect(store.settings.bgmEnabled).toBe(true);
  });

  it('resumes an enabled local BGM preference on the next page gesture', async () => {
    const store = new AppStore();
    store.settings = { bgmEnabled: true, volume: 0.4 };
    const audioManager = {
      setEnabled: vi.fn(),
      setVolume: vi.fn(),
      startFromGesture: vi.fn(async () => ({ ok: true })),
      stop: vi.fn(async () => ({ ok: true })),
      isRunning: vi.fn(() => false),
    };
    const app = createApplication({
      documentImpl: document,
      navigatorImpl: {},
      store,
      shareClient: { async getCredentials() { return null; } },
      shareSync: { bindLifecycle() {}, async retryPending() { return { tasks: [], comments: [] }; }, async getCachedSharedTasks() { return []; } },
      notificationClient: { permission: () => 'default', support: () => ({ supported: false }) },
      weatherService: { getCached: () => null },
      audioManager,
    });
    await app.initialize();

    document.querySelector('#settings-button').click();
    await tick();

    expect(audioManager.startFromGesture).toHaveBeenCalledTimes(1);
    expect(document.querySelector('#bgm-status').textContent).toContain('正在播放');
  });

  it('opens the owned task when a notification click message reaches the page', async () => {
    const store = new AppStore([{
      id: 'task-from-push', title: '取快递', description: '下班路上', dueDate: '2026-08-25', status: 'open',
      createdAt: '2026-08-25T00:00:00.000Z', updatedAt: '2026-08-25T00:00:00.000Z',
    }]);
    const listeners = new Map();
    const registration = { waiting: null, installing: null, async update() {} };
    const serviceWorker = {
      controller: {},
      ready: Promise.resolve(registration),
      async register() { return registration; },
      addEventListener(type, handler) { listeners.set(type, handler); },
      removeEventListener() {},
    };
    const app = createApplication({
      documentImpl: document,
      navigatorImpl: { serviceWorker },
      store,
      shareClient: { async getCredentials() { return null; } },
      shareSync: { bindLifecycle() {}, async retryPending() { return { tasks: [], comments: [] }; } },
      notificationClient: { permission: () => 'granted', support: () => ({ supported: true }) },
      weatherService: { getCached: () => null },
      audioManager: { setEnabled() {}, setVolume() {} },
    });
    await app.initialize();
    listeners.get('message')?.({ data: { type: 'OPEN_TASK', taskId: 'task-from-push' } });
    await tick();

    expect(document.querySelector('#detail-modal').getAttribute('aria-hidden')).toBe('false');
    expect(document.querySelector('#detail-title').textContent).toContain('取快递');
  });
});
