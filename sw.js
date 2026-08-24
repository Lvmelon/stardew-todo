const CACHE = 'stardew-todo-v1.0.0';
const APP_SHELL = [
  './',
  './index.html',
  './styles.css',
  './app.js',
  './config.js',
  './task-model.js',
  './date-utils.js',
  './storage.js',
  './settings-store.js',
  './data-transfer.js',
  './share-client.js',
  './share-sync.js',
  './notification-client.js',
  './update-manager.js',
  './weather.js',
  './atmosphere.js',
  './audio-manager.js',
  './plant-growth.js',
  './manifest.webmanifest',
  './assets/scene.webp',
  './assets/parchment-tile.png',
  './icons/apple-touch-icon.png',
  './icons/icon-192.png',
  './icons/icon-512.png',
];

self.addEventListener('install', event => {
  event.waitUntil(caches.open(CACHE).then(cache => cache.addAll(APP_SHELL)));
});

self.addEventListener('activate', event => {
  event.waitUntil((async () => {
    const keys = await caches.keys();
    await Promise.all(keys.filter(key => key !== CACHE).map(key => caches.delete(key)));
    await self.clients.claim();
  })());
});

self.addEventListener('message', event => {
  const message = event.data || {};
  if (message.type === 'SKIP_WAITING') {
    self.skipWaiting();
  }
  if (message.type === 'GET_VERSION') {
    event.source?.postMessage({ type: 'APP_VERSION', version: '1.0.0', cache: CACHE });
  }
  if (message.type === 'TEST_NOTIFICATION') {
    event.waitUntil(self.registration.showNotification('今日任务', {
      body: '通知已经准备好啦。',
      icon: './icons/icon-192.png',
      badge: './icons/icon-192.png',
      tag: 'stardew-todo-test',
      data: { url: './' },
    }));
  }
});

async function networkFirstNavigation(request) {
  const cache = await caches.open(CACHE);
  try {
    const response = await fetch(request);
    if (response.ok) await cache.put(request, response.clone());
    return response;
  } catch {
    return (await cache.match(request)) || cache.match('./index.html');
  }
}

async function cacheFirstWithRefresh(request, event) {
  const cache = await caches.open(CACHE);
  const cached = await cache.match(request);
  const refresh = fetch(request).then(async response => {
    if (response.ok) await cache.put(request, response.clone());
    return response;
  });
  if (cached) {
    event.waitUntil(refresh.catch(() => undefined));
    return cached;
  }
  return refresh;
}

self.addEventListener('fetch', event => {
  const { request } = event;
  if (request.method !== 'GET') return;
  const url = new URL(request.url);
  if (url.origin !== self.location.origin) return;

  if (request.mode === 'navigate') {
    event.respondWith(networkFirstNavigation(request));
    return;
  }
  event.respondWith(cacheFirstWithRefresh(request, event));
});

function readPushPayload(event) {
  if (!event.data) return {};
  try {
    return event.data.json();
  } catch {
    return { body: event.data.text() };
  }
}

self.addEventListener('push', event => {
  const payload = readPushPayload(event);
  const title = String(payload.title || '今日任务');
  const taskId = String(payload.taskId || '');
  const deliveryId = String(payload.deliveryId || '');
  const tag = String(payload.tag || deliveryId || `task-${taskId || 'reminder'}`);
  event.waitUntil(self.registration.showNotification(title, {
    body: String(payload.body || '有一条委托想提醒你。'),
    icon: './icons/icon-192.png',
    badge: './icons/icon-192.png',
    tag,
    renotify: false,
    data: {
      taskId,
      deliveryId,
      url: String(payload.url || './'),
    },
  }));
});

self.addEventListener('notificationclick', event => {
  event.notification.close();
  const taskId = String(event.notification.data?.taskId || '');
  event.waitUntil((async () => {
    const windows = await self.clients.matchAll({ type: 'window', includeUncontrolled: true });
    const existing = windows.find(client => client.url.startsWith(self.registration.scope));
    if (existing) {
      await existing.focus();
      if (taskId) existing.postMessage({ type: 'OPEN_TASK', taskId });
      return;
    }
    const suffix = taskId ? `#task=${encodeURIComponent(taskId)}` : '';
    await self.clients.openWindow(`./${suffix}`);
  })());
});

self.addEventListener('pushsubscriptionchange', event => {
  event.waitUntil((async () => {
    let subscription = event.newSubscription || null;
    const applicationServerKey = event.oldSubscription?.options?.applicationServerKey;
    if (!subscription && applicationServerKey) {
      try {
        subscription = await self.registration.pushManager.subscribe({ userVisibleOnly: true, applicationServerKey });
      } catch {
        subscription = null;
      }
    }
    const clients = await self.clients.matchAll({ type: 'window', includeUncontrolled: true });
    for (const client of clients) {
      client.postMessage({ type: 'PUSH_SUBSCRIPTION_CHANGED', subscription: subscription?.toJSON() || null });
    }
  })());
});
