import { CONFIG, PUSH_SUBSCRIPTION_KEY } from './config.js';

export class NotificationClientError extends Error {
  constructor(message, code = 'notification-error') {
    super(message);
    this.name = 'NotificationClientError';
    this.code = code;
  }
}

/**
 * Web Push is intentionally opt-in.  Constructing this client never asks for
 * notification permission; the UI must call requestPermission/enable from a
 * user gesture.
 */
export function createNotificationClient(options = {}) {
  const notificationApi = options.NotificationApi || globalThis.Notification;
  const navigatorImpl = options.navigatorImpl || globalThis.navigator;
  const serviceWorker = options.serviceWorkerContainer || navigatorImpl?.serviceWorker;
  const shareClient = options.shareClient;
  const store = options.store;
  const config = { ...CONFIG, ...(options.config || {}) };
  const locationImpl = options.locationImpl || globalThis.location;

  function permission() {
    if (!notificationApi) return 'unsupported';
    return notificationApi.permission || 'default';
  }

  function support() {
    if (!notificationApi || !serviceWorker) return { supported: false, reason: 'unsupported' };
    if (!globalThis.PushManager && !options.pushManager) return { supported: false, reason: 'push-unsupported' };
    if (isIos(navigatorImpl) && !isIosStandalone(navigatorImpl, locationImpl)) {
      return { supported: false, reason: 'ios-standalone-required' };
    }
    return { supported: true, reason: '' };
  }

  async function requestPermission() {
    if (!notificationApi?.requestPermission) {
      throw new NotificationClientError('当前设备不支持通知', 'unsupported');
    }
    // This function is explicit by design.  Call it only from a click/tap.
    return notificationApi.requestPermission();
  }

  async function enable(input = {}) {
    const state = support();
    if (!state.supported) return { enabled: false, reason: state.reason };
    const currentPermission = permission();
    const granted = currentPermission === 'granted'
      ? currentPermission
      : await requestPermission();
    if (granted !== 'granted') return { enabled: false, reason: 'permission-denied', permission: granted };
    if (!shareClient?.registerPushSubscription) {
      throw new NotificationClientError('共享服务尚未连接', 'share-client-missing');
    }
    const registration = await getRegistration(input.registration);
    const pushManager = registration?.pushManager;
    if (!pushManager?.subscribe) throw new NotificationClientError('当前设备不支持 Push', 'push-unsupported');
    let subscription = await pushManager.getSubscription?.();
    if (!subscription) {
      let applicationServerKey = input.applicationServerKey || config.vapidPublicKey;
      if (!applicationServerKey && shareClient?.getPushConfig) {
        const pushConfig = await shareClient.getPushConfig();
        applicationServerKey = pushConfig?.vapidPublicKey || pushConfig?.publicKey || pushConfig?.vapid_public_key;
      }
      if (!applicationServerKey) throw new NotificationClientError('尚未配置推送服务', 'vapid-key-missing');
      subscription = await pushManager.subscribe({
        userVisibleOnly: true,
        applicationServerKey: normalizeApplicationServerKey(applicationServerKey),
      });
    }
    const serialized = serializeSubscription(subscription);
    await shareClient.registerPushSubscription(serialized);
    await saveMeta(PUSH_SUBSCRIPTION_KEY, serialized, store);
    return { enabled: true, permission: granted, subscription: serialized };
  }

  async function disable(input = {}) {
    const registration = await getRegistration(input.registration);
    const subscription = await registration?.pushManager?.getSubscription?.();
    if (subscription) {
      const endpoint = subscription.endpoint;
      await subscription.unsubscribe?.();
      if (shareClient?.removePushSubscription) {
        try { await shareClient.removePushSubscription(endpoint); } catch (error) {
          if (input.ignoreNetworkErrors !== true) throw error;
        }
      }
    }
    await removeMeta(PUSH_SUBSCRIPTION_KEY, store);
    return { enabled: false };
  }

  async function testNotification(input = {}) {
    if (permission() !== 'granted') {
      throw new NotificationClientError('请先开启通知', 'permission-not-granted');
    }
    if (!shareClient?.testNotification) {
      throw new NotificationClientError('共享服务尚未连接', 'share-client-missing');
    }
    try {
      return await shareClient.testNotification(input);
    } catch (error) {
      if (input.localFallback === false) throw error;
      // A local notification still gives the user useful feedback when the
      // Worker is offline. It is not presented as proof that server-side Push
      // delivery is configured.
      await showLocalTestNotification(input);
      return { ok: true, local: true, remoteError: error?.code || 'remote-test-failed' };
    }
  }

  async function showLocalTestNotification(input = {}) {
    if (permission() !== 'granted') {
      throw new NotificationClientError('请先开启通知', 'permission-not-granted');
    }
    const registration = await getRegistration(input.registration);
    if (registration?.showNotification) {
      return registration.showNotification(input.title || '今日任务', {
        body: input.body || '通知已经准备好了。',
        tag: input.tag || 'stardew-todo-test',
      });
    }
    if (typeof notificationApi === 'function') {
      return new notificationApi(input.title || '今日任务', { body: input.body || '通知已经准备好了。' });
    }
    throw new NotificationClientError('当前设备无法显示测试通知', 'show-unsupported');
  }

  async function getRegistration(explicit) {
    if (explicit) return explicit;
    if (serviceWorker?.ready) return serviceWorker.ready;
    return null;
  }

  return Object.freeze({
    permission,
    support,
    requestPermission,
    enable,
    disable,
    testNotification,
    showLocalTestNotification,
    isIosStandalone: () => isIosStandalone(navigatorImpl, locationImpl),
    getRegistration,
  });
}

export function isIosStandalone(navigatorImpl = globalThis.navigator, locationImpl = globalThis.location) {
  if (!isIos(navigatorImpl)) return false;
  if (navigatorImpl?.standalone === true) return true;
  const displayMode = locationImpl?.matchMedia
    ? locationImpl.matchMedia('(display-mode: standalone)').matches
    : globalThis.matchMedia?.('(display-mode: standalone)').matches;
  return Boolean(displayMode);
}

export function serializeSubscription(subscription) {
  if (!subscription) return null;
  const json = typeof subscription.toJSON === 'function' ? subscription.toJSON() : subscription;
  const endpoint = String(json.endpoint || subscription.endpoint || '').trim();
  if (!endpoint) return null;
  const keys = json.keys || {};
  return {
    endpoint,
    expirationTime: json.expirationTime ?? subscription.expirationTime ?? null,
    keys: {
      p256dh: String(keys.p256dh || '').trim(),
      auth: String(keys.auth || '').trim(),
    },
  };
}

export function normalizeApplicationServerKey(value) {
  if (value instanceof Uint8Array) return value;
  if (value instanceof ArrayBuffer) return new Uint8Array(value);
  if (ArrayBuffer.isView(value)) return new Uint8Array(value.buffer, value.byteOffset, value.byteLength);
  const text = String(value || '').replace(/-/g, '+').replace(/_/g, '/');
  if (!text) return value;
  const padded = text.padEnd(Math.ceil(text.length / 4) * 4, '=');
  if (typeof atob === 'function') {
    const binary = atob(padded);
    return Uint8Array.from(binary, character => character.charCodeAt(0));
  }
  return Uint8Array.from(Buffer.from(text, 'base64'));
}

function isIos(navigatorImpl = globalThis.navigator) {
  const ua = String(navigatorImpl?.userAgent || '');
  const iPadDesktop = navigatorImpl?.platform === 'MacIntel' && Number(navigatorImpl?.maxTouchPoints || 0) > 1;
  return /iPad|iPhone|iPod/i.test(ua) || iPadDesktop;
}

async function saveMeta(key, value, store) {
  if (store?.putMeta) return store.putMeta(key, value);
  if (store?.setMeta) return store.setMeta(key, value);
  if (store?.putMetadata) return store.putMetadata(key, value);
  if (store?.meta?.set) return store.meta.set(key, value);
  return value;
}

async function removeMeta(key, store) {
  if (store?.deleteMeta) return store.deleteMeta(key);
  if (store?.removeMeta) return store.removeMeta(key);
  if (store?.meta?.delete) return store.meta.delete(key);
  return undefined;
}
