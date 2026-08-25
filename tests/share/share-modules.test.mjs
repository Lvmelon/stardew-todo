import assert from 'node:assert/strict';
import { createShareClient, readPairFragment, clearPairFragment, buildPairLink, buildRecoveryCode, generatePairSecret } from '../../share-client.js';
import { createShareSync } from '../../share-sync.js';
import { createNotificationClient, isIosStandalone } from '../../notification-client.js';
import { createUpdateManager } from '../../update-manager.js';

class FakeStore {
  constructor(tasks = []) {
    this.tasks = tasks.map(item => ({ ...item }));
    this.meta = new Map();
  }
  async getMeta(key) { return this.meta.get(key); }
  async putMeta(key, value) { this.meta.set(key, structuredClone(value)); }
  async deleteMeta(key) { this.meta.delete(key); }
  async getAll() { return this.tasks.map(item => ({ ...item })); }
  async put(task) {
    const index = this.tasks.findIndex(item => item.id === task.id);
    if (index < 0) this.tasks.push({ ...task }); else this.tasks[index] = { ...task };
  }
}

function response(status, body) {
  return {
    status,
    ok: status >= 200 && status < 300,
    async text() { return body === undefined ? '' : JSON.stringify(body); },
  };
}

async function testPairingAndAuth() {
  const calls = [];
  const store = new FakeStore();
  const location = {
    origin: 'https://example.test',
    href: 'https://example.test/stardew-todo/?from=share',
    hash: '',
  };
  let historyTarget = '';
  const client = createShareClient({
    store,
    locationImpl: location,
    historyImpl: { replaceState(_state, _title, target) { historyTarget = target; } },
    config: { apiBaseUrl: 'https://worker.example.test' },
    fetchImpl: async (url, init) => {
      calls.push({ url, init });
      if (url.endsWith('/v1/spaces/space-1/join')) return response(200, {
        space: { id: 'space-1' }, device: { id: 'device-1', role: 'guest' }, accessToken: 'access-1',
      });
      return response(200, {});
    },
  });
  const pairUrl = buildPairLink('secret-for-test', location, 'space-1');
  location.hash = new URL(pairUrl).hash;
  assert.notEqual(readPairFragment(location), '');
  await client.joinFromPairLink({ displayName: '她' });
  assert.equal(historyTarget, '/stardew-todo/?from=share');
  assert.equal((await client.getCredentials()).accessToken, 'access-1');
  assert.equal(calls[0].init.headers.Authorization, undefined);
  assert.equal(calls[0].url.includes('secret-for-test'), false);

  await client.putTaskMirror({ taskId: 'task-1', title: '取快递', updatedAt: '2026-08-25T00:00:00.000Z' });
  assert.equal(calls[1].init.headers.Authorization, 'Bearer access-1');
  assert.equal(JSON.parse(calls[1].init.body).sourceRevision, '2026-08-25T00:00:00.000Z');
  clearPairFragment(location, { replaceState() {} });
}

async function testPendingTaskShareAndCommentRetry() {
  const task = { id: 'task-1', title: '取快递', startDate: '2026-08-25', dueDate: '2026-08-27', status: 'open', createdAt: '2026-08-25T00:00:00.000Z', updatedAt: '2026-08-25T00:00:00.000Z' };
  const store = new FakeStore([task]);
  let taskAttempts = 0;
  let commentAttempts = 0;
  const shareClient = {
    async getCredentials() { return { spaceId: 'space-1', accessToken: 'access-1', role: 'owner' }; },
    async putTaskMirror() { taskAttempts += 1; if (taskAttempts === 1) throw new Error('offline'); return { ok: true }; },
    async postComment(comment) { commentAttempts += 1; if (commentAttempts === 1) throw new Error('offline'); return { comment }; },
  };
  const sync = createShareSync({ store, shareClient });
  const partnerMirror = sync.toSharedTask(task, { spaceId: 'space-1', role: 'partner' });
  assert.equal(partnerMirror.ownerRole, 'partner');
  assert.equal(partnerMirror.startDate, '2026-08-25');
  assert.equal(partnerMirror.reminderMode, 'none');
  const first = await sync.syncTask(task);
  assert.equal(first.pendingShareSync, true);
  assert.equal((await store.getAll())[0].pendingShareSync, true);
  const retry = await sync.retryPendingShareSync();
  assert.equal(retry[0].ok, true);
  assert.equal((await store.getAll())[0].pendingShareSync, false);

  const added = await sync.addComment('task-1', '收到～');
  assert.equal(added.pending, true);
  const retried = await sync.retryPendingComments();
  assert.equal(retried[0].ok, true);
  assert.equal((await store.getMeta('pendingComments')).length, 0);
}

async function testSecureRandomRequirement() {
  assert.throws(() => generatePairSecret({}), error => error.code === 'secure-random-unavailable');
}

async function testRecoveryCodeCarriesSpaceId() {
  let received;
  const client = createShareClient({
    store: new FakeStore(),
    config: { apiBaseUrl: 'https://worker.example.test' },
    fetchImpl: async (url, init) => {
      received = { url, body: JSON.parse(init.body) };
      return response(200, { spaceId: 'space-1', deviceId: 'device-2', role: 'owner', accessToken: 'access-2' });
    },
  });
  await client.recoverSpace({ recoveryCode: buildRecoveryCode('recovery-secret', 'space-1') });
  assert.equal(received.url.endsWith('/v1/spaces/space-1/join'), true);
  assert.equal(received.body.recoveryCode, 'recovery-secret');
}

async function testMissingApiBaseNeverFallsBackToPageOrigin() {
  let called = false;
  const client = createShareClient({
    store: new FakeStore(),
    locationImpl: { origin: 'https://lvmelon.github.io', href: 'https://lvmelon.github.io/stardew-todo/' },
    config: { apiBaseUrl: '' },
    fetchImpl: async () => {
      called = true;
      return response(200, {});
    },
  });
  await assert.rejects(
    client.health(),
    error => error.code === 'api-base-missing',
  );
  assert.equal(called, false);
}

async function testNotificationsDoNotPromptOnConstruction() {
  let permissionCalls = 0;
  let registered = 0;
  const notificationApi = {
    permission: 'default',
    async requestPermission() { permissionCalls += 1; this.permission = 'granted'; return 'granted'; },
  };
  const subscription = {
    endpoint: 'https://push.example/subscription',
    toJSON() { return { endpoint: this.endpoint, keys: { p256dh: 'public', auth: 'secret' } }; },
  };
  const registration = { pushManager: {
    async getSubscription() { return null; },
    async subscribe() { return subscription; },
  } };
  const client = createNotificationClient({
    NotificationApi: notificationApi,
    navigatorImpl: { userAgent: 'Mozilla/5.0', serviceWorker: { ready: Promise.resolve(registration) } },
    serviceWorkerContainer: { ready: Promise.resolve(registration) },
    pushManager: {},
    config: { vapidPublicKey: 'AQID' },
    shareClient: { async registerPushSubscription() { registered += 1; } },
  });
  assert.equal(permissionCalls, 0);
  await client.enable();
  assert.equal(permissionCalls, 1);
  assert.equal(registered, 1);
  assert.equal(isIosStandalone({ userAgent: 'iPhone' }, { matchMedia: () => ({ matches: true }) }), true);
}

async function testNotificationLocalFallback() {
  let localShown = 0;
  const registration = {
    async showNotification() { localShown += 1; },
    pushManager: { async getSubscription() { return null; } },
  };
  const client = createNotificationClient({
    NotificationApi: { permission: 'granted' },
    navigatorImpl: { userAgent: 'Mozilla/5.0', serviceWorker: { ready: Promise.resolve(registration) } },
    serviceWorkerContainer: { ready: Promise.resolve(registration) },
    pushManager: {},
    shareClient: { async testNotification() { throw new Error('offline'); } },
  });
  const result = await client.testNotification();
  assert.equal(result.local, true);
  assert.equal(localShown, 1);
}

async function testWaitingWorkerControl() {
  const messages = [];
  const waiting = { postMessage(message) { messages.push(message); } };
  const registration = { waiting, async update() {} };
  const serviceWorker = {
    controller: {},
    ready: Promise.resolve(registration),
    addEventListener() {},
    removeEventListener() {},
  };
  const manager = createUpdateManager({ serviceWorkerContainer: serviceWorker });
  await manager.start();
  assert.equal(manager.getState().state, 'waiting');
  assert.equal(manager.accept(), true);
  assert.deepEqual(messages, [{ type: 'SKIP_WAITING' }]);
}

await testPairingAndAuth();
await testPendingTaskShareAndCommentRetry();
await testSecureRandomRequirement();
await testRecoveryCodeCarriesSpaceId();
await testMissingApiBaseNeverFallsBackToPageOrigin();
await testNotificationsDoNotPromptOnConstruction();
await testNotificationLocalFallback();
await testWaitingWorkerControl();
console.log('share modules: ok');
