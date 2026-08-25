// Runtime configuration for the static PWA.  No secret belongs in this file.
// A host page may provide a public runtime override before loading the modules:
//   window.STARDEW_TODO_CONFIG = { apiBaseUrl, vapidPublicKey };

export const APP_VERSION = '1.0.1';

export const SHARE_META_KEY = 'shareCredentials';
export const SHARED_TASKS_CACHE_KEY = 'sharedTasks';
export const COMMENTS_CACHE_KEY = 'sharedComments';
export const PENDING_COMMENTS_KEY = 'pendingComments';
export const PUSH_SUBSCRIPTION_KEY = 'pushSubscription';

// Keep endpoints in one place so the Worker contract can change without
// scattering URLs throughout the UI.  The access token identifies the space;
// no space id is sent in a URL query parameter.
export const API_PATHS = Object.freeze({
  health: '/health',
  createSpace: '/v1/spaces',
  joinSpace: '/v1/spaces/{spaceId}/join',
  recoverSpace: '/v1/spaces/{spaceId}/join',
  currentDevice: '/v1/spaces/{spaceId}/devices/me',
  sharedTasks: '/v1/spaces/{spaceId}/tasks',
  sharedTask: '/v1/spaces/{spaceId}/tasks/{taskId}',
  comments: '/v1/spaces/{spaceId}/tasks/{taskId}/comments',
  pushSubscription: '/v1/spaces/{spaceId}/push-subscriptions',
  pushTest: '/v1/spaces/{spaceId}/push-test',
  pushConfig: '/v1/config',
});

const DEFAULT_CONFIG = Object.freeze({
  // Public Worker origin only; authentication stays in per-device local
  // credentials and VAPID private material remains a Worker secret.
  apiBaseUrl: 'https://stardew-todo-worker.stardew-todo.workers.dev',
  vapidPublicKey: '',
});

function runtimeConfig() {
  const value = globalThis.STARDEW_TODO_CONFIG;
  return value && typeof value === 'object' ? value : {};
}

export function getRuntimeConfig(overrides = {}) {
  const runtime = runtimeConfig();
  return Object.freeze({
    ...DEFAULT_CONFIG,
    ...runtime,
    ...overrides,
  });
}

export const CONFIG = getRuntimeConfig();
