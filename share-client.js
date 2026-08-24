import {
  API_PATHS,
  CONFIG,
  PUSH_SUBSCRIPTION_KEY,
  SHARE_META_KEY,
  getRuntimeConfig,
} from './config.js';

const META_FALLBACK_KEY = 'stardew_todo_share_meta_v1';

export class ShareClientError extends Error {
  constructor(message, options = {}) {
    super(message);
    this.name = 'ShareClientError';
    this.code = options.code || 'share-client-error';
    this.status = options.status;
    this.details = options.details;
  }
}

export class ShareHttpError extends ShareClientError {
  constructor(status, message, details) {
    super(message || `共享服务暂时不可用（${status}）`, {
      code: 'http-error',
      status,
      details,
    });
    this.name = 'ShareHttpError';
  }
}

export class NotPairedError extends ShareClientError {
  constructor() {
    super('尚未加入我们的空间', { code: 'not-paired' });
    this.name = 'NotPairedError';
  }
}

/**
 * Create the very small HTTP client used by share-sync and notifications.
 *
 * The injected store is expected to expose getMeta(key)/putMeta(key, value).
 * The helpers also understand getMetadata/setMetadata and a plain localStorage
 * fallback, which keeps this module usable while storage.js is migrating.
 */
export function createShareClient(options = {}) {
  const store = options.store || null;
  const fetchImpl = options.fetchImpl || globalThis.fetch?.bind(globalThis);
  const cryptoImpl = options.cryptoImpl || globalThis.crypto;
  const locationImpl = options.locationImpl || globalThis.location;
  const historyImpl = options.historyImpl || globalThis.history;
  const config = getRuntimeConfig(options.config || CONFIG);
  const memoryMeta = new Map();

  if (typeof fetchImpl !== 'function') {
    throw new ShareClientError('当前环境没有可用的网络请求能力', { code: 'fetch-unavailable' });
  }

  async function getMeta(key, fallback = undefined) {
    const value = await readStoreMeta(store, key);
    if (value !== undefined) return value;
    if (memoryMeta.has(key)) return memoryMeta.get(key);
    const localValue = readLocalMeta(key);
    return localValue === undefined ? fallback : localValue;
  }

  async function putMeta(key, value) {
    let written = false;
    if (store && typeof store.putMeta === 'function') {
      await store.putMeta(key, value);
      written = true;
    } else if (store && typeof store.setMeta === 'function') {
      await store.setMeta(key, value);
      written = true;
    } else if (store && typeof store.putMetadata === 'function') {
      await store.putMetadata(key, value);
      written = true;
    } else if (store?.meta && typeof store.meta.set === 'function') {
      await store.meta.set(key, value);
      written = true;
    }
    memoryMeta.set(key, value);
    if (!written) writeLocalMeta(key, value);
    return value;
  }

  async function removeMeta(key) {
    if (store && typeof store.deleteMeta === 'function') await store.deleteMeta(key);
    else if (store && typeof store.removeMeta === 'function') await store.removeMeta(key);
    else if (store?.meta && typeof store.meta.delete === 'function') await store.meta.delete(key);
    memoryMeta.delete(key);
    removeLocalMeta(key);
  }

  async function getCredentials() {
    return getMeta(SHARE_META_KEY, null);
  }

  async function saveCredentials(value) {
    const credentials = normalizeCredentials(value);
    if (!credentials.spaceId || !credentials.accessToken) {
      throw new ShareClientError('共享服务返回的空间凭证不完整', { code: 'invalid-credentials' });
    }
    await putMeta(SHARE_META_KEY, credentials);
    return clone(credentials);
  }

  async function clearCredentials() {
    await removeMeta(SHARE_META_KEY);
    await removeMeta('pendingPairSecret');
    await removeMeta('pendingPairSpaceId');
  }

  async function request(path, requestOptions = {}) {
    const {
      method = 'GET',
      body,
      auth = true,
      headers = {},
      signal,
    } = requestOptions;
    const credentials = auth ? await getCredentials() : null;
    if (auth && !credentials?.accessToken) throw new NotPairedError();
    const url = makeUrl(path, config.apiBaseUrl, locationImpl);
    const requestHeaders = { Accept: 'application/json', ...headers };
    if (body !== undefined) requestHeaders['Content-Type'] = 'application/json';
    if (auth) requestHeaders.Authorization = `Bearer ${credentials.accessToken}`;
    const response = await fetchImpl(url, {
      method,
      headers: requestHeaders,
      body: body === undefined ? undefined : JSON.stringify(body),
      signal,
    });
    const payload = await readResponse(response);
    if (!response.ok) {
      throw new ShareHttpError(response.status, safeErrorMessage(payload, response.status), payload);
    }
    return payload;
  }

  async function createSpace(input = {}) {
    // The Worker creates and hashes the one-time pairing token.  Keeping token
    // generation server-side avoids accidentally storing a client-generated
    // token that the server did not accept.
    const payload = await request(API_PATHS.createSpace, {
      method: 'POST',
      auth: false,
      body: {
        displayName: String(input.displayName || '').trim() || undefined,
      },
    });
    const created = payload?.data && typeof payload.data === 'object' ? payload.data : payload;
    const returnedPairSecret = created?.pairSecret || created?.pairingToken || created?.pairing_token;
    if (!returnedPairSecret) throw new ShareClientError('共享服务没有返回配对链接', { code: 'pairing-token-missing' });
    const credentials = await saveCredentials({ ...payload, pairSecret: returnedPairSecret });
    await removeMeta('pendingPairSecret');
    await removeMeta('pendingPairSpaceId');
    return {
      ...credentials,
      pairLink: buildPairLink(credentials.pairSecret, locationImpl, credentials.spaceId),
      recoveryDescriptor: buildRecoveryCode(credentials.recoveryCode, credentials.spaceId),
    };
  }

  async function joinSpace(input = {}) {
    const pairSecret = String(input.pairSecret || await getMeta('pendingPairSecret', '') || '').trim();
    if (!pairSecret) throw new ShareClientError('配对链接已失效，请重新获取', { code: 'pair-secret-missing' });
    const spaceId = String(input.spaceId || await getMeta('pendingPairSpaceId', '') || '').trim();
    if (!spaceId) throw new ShareClientError('配对链接缺少空间信息，请重新获取', { code: 'space-id-missing' });
    await putMeta('pendingPairSecret', pairSecret);
    await putMeta('pendingPairSpaceId', spaceId);
    const payload = await request(resolveSpacePath(API_PATHS.joinSpace, spaceId), {
      method: 'POST',
      auth: false,
      body: {
        pairingToken: pairSecret,
        displayName: String(input.displayName || '').trim() || undefined,
      },
    });
    const credentials = await saveCredentials({ ...payload, pairSecret });
    await removeMeta('pendingPairSecret');
    await removeMeta('pendingPairSpaceId');
    if (input.clearLocation !== false) clearPairFragment(locationImpl, historyImpl);
    return credentials;
  }

  async function joinFromPairLink(input = {}) {
    const fragmentValue = input.pairSecret || readPairFragment(locationImpl);
    const descriptor = decodePairDescriptor(fragmentValue);
    const pairSecret = descriptor.pairSecret;
    const spaceId = input.spaceId || descriptor.spaceId;
    if (!pairSecret) throw new ShareClientError('没有找到配对链接', { code: 'pair-fragment-missing' });
    // Persist before the request so a temporary network failure does not lose
    // the pairing token after the address bar is cleaned.
    await putMeta('pendingPairSecret', pairSecret);
    if (spaceId) await putMeta('pendingPairSpaceId', spaceId);
    clearPairFragment(locationImpl, historyImpl);
    return joinSpace({ ...input, pairSecret, spaceId, clearLocation: false });
  }

  async function recoverSpace(input = {}) {
    const descriptor = decodePairDescriptor(input.recoveryCode);
    const recoveryCode = descriptor.pairSecret;
    if (!recoveryCode) throw new ShareClientError('请输入恢复码', { code: 'recovery-code-missing' });
    const previous = await getCredentials();
    const spaceId = String(input.spaceId || descriptor.spaceId || previous?.spaceId || '').trim();
    if (!spaceId) throw new ShareClientError('恢复码缺少空间信息', { code: 'space-id-missing' });
    const payload = await request(resolveSpacePath(API_PATHS.recoverSpace, spaceId), {
      method: 'POST',
      auth: false,
      body: { recoveryCode, displayName: input.displayName },
    });
    return saveCredentials({
      ...previous,
      ...payload,
      spaceId,
      pairSecret: payload.pairSecret || payload.pairingToken || previous?.pairSecret,
      recoveryCode,
    });
  }

  async function disconnect(options = {}) {
    if (options.revoke !== false) {
      const current = await getCredentials();
      if (!current?.spaceId) {
        await clearCredentials();
        return;
      }
      try { await request(resolveSpacePath(API_PATHS.currentDevice, current.spaceId), { method: 'DELETE' }); } catch (error) {
        if (options.ignoreNetworkErrors !== true) throw error;
      }
    }
    await clearCredentials();
  }

  async function putTaskMirror(taskMirror, requestOptions = {}) {
    const taskId = String(taskMirror?.taskId || taskMirror?.id || '').trim();
    if (!taskId) throw new ShareClientError('共享任务缺少 taskId', { code: 'task-id-missing' });
    const body = {
      ...taskMirror,
      taskId,
      sourceRevision: sourceRevisionFor(taskMirror),
      revision: revisionFor(taskMirror),
    };
    const current = await getCredentials();
    if (!current?.spaceId) throw new NotPairedError();
    return request(resolveSpacePath(API_PATHS.sharedTask || `${API_PATHS.sharedTasks}/{taskId}`, current.spaceId, taskId), {
      method: 'PUT',
      body,
      signal: requestOptions.signal,
    });
  }

  async function getSharedTasks(requestOptions = {}) {
    const current = await getCredentials();
    if (!current?.spaceId) throw new NotPairedError();
    return request(resolveSpacePath(API_PATHS.sharedTasks, current.spaceId), { signal: requestOptions.signal });
  }

  async function getComments(taskId, requestOptions = {}) {
    const current = await getCredentials();
    if (!current?.spaceId) throw new NotPairedError();
    return request(resolveSpacePath(API_PATHS.comments, current.spaceId, taskId), { signal: requestOptions.signal });
  }

  async function postComment(comment, requestOptions = {}) {
    const taskId = String(comment?.taskId || '').trim();
    if (!taskId) throw new ShareClientError('留言缺少 taskId', { code: 'comment-task-id-missing' });
    const body = { ...comment, taskId, commentId: String(comment.commentId || comment.id || '').trim() || makeId(cryptoImpl) };
    const current = await getCredentials();
    if (!current?.spaceId) throw new NotPairedError();
    return request(resolveSpacePath(API_PATHS.comments, current.spaceId, taskId), {
      method: 'POST',
      body,
      signal: requestOptions.signal,
    });
  }

  async function registerPushSubscription(subscription, requestOptions = {}) {
    const normalized = serializeSubscription(subscription);
    if (!normalized?.endpoint) throw new ShareClientError('推送订阅信息不完整', { code: 'subscription-invalid' });
    const current = await getCredentials();
    if (!current?.spaceId) throw new NotPairedError();
    const payload = await request(resolveSpacePath(API_PATHS.pushSubscription, current.spaceId), {
      method: 'POST',
      body: normalized,
      signal: requestOptions.signal,
    });
    await putMeta(PUSH_SUBSCRIPTION_KEY, normalized);
    return payload;
  }

  async function removePushSubscription(endpoint, requestOptions = {}) {
    const body = endpoint ? { endpoint } : undefined;
    const current = await getCredentials();
    if (!current?.spaceId) throw new NotPairedError();
    const payload = await request(resolveSpacePath(API_PATHS.pushSubscription, current.spaceId), {
      method: 'DELETE',
      body,
      signal: requestOptions.signal,
    });
    await removeMeta(PUSH_SUBSCRIPTION_KEY);
    return payload;
  }

  async function testNotification(requestOptions = {}) {
    const current = await getCredentials();
    if (!current?.spaceId) throw new NotPairedError();
    return request(resolveSpacePath(API_PATHS.pushTest, current.spaceId), { method: 'POST', body: {}, signal: requestOptions.signal });
  }

  async function getPushConfig(requestOptions = {}) {
    return request(API_PATHS.pushConfig, { auth: false, signal: requestOptions.signal });
  }

  async function health(requestOptions = {}) {
    return request(API_PATHS.health, { auth: false, signal: requestOptions.signal });
  }

  return Object.freeze({
    getCredentials,
    saveCredentials,
    clearCredentials,
    createSpace,
    joinSpace,
    joinFromPairLink,
    recoverSpace,
    disconnect,
    request,
    putTaskMirror,
    getSharedTasks,
    getComments,
    postComment,
    registerPushSubscription,
    removePushSubscription,
    testNotification,
    getPushConfig,
    health,
    getMeta,
    putMeta,
    removeMeta,
    buildPairLink: (secret, spaceId) => buildPairLink(secret, locationImpl, spaceId),
    buildRecoveryCode,
  });
}

export function generatePairSecret(cryptoImpl = globalThis.crypto) {
  const bytes = new Uint8Array(32);
  if (!cryptoImpl?.getRandomValues) {
    throw new ShareClientError('当前环境缺少安全随机数能力', { code: 'secure-random-unavailable' });
  }
  cryptoImpl.getRandomValues(bytes);
  return bytesToBase64Url(bytes);
}

export function buildPairLink(pairSecret, locationImpl = globalThis.location, spaceId = '') {
  const secret = String(pairSecret || '').trim();
  if (!secret) throw new ShareClientError('无法生成空的配对链接', { code: 'pair-secret-missing' });
  const base = locationImpl?.href || locationImpl?.origin || 'http://localhost/';
  const url = new URL(base, 'http://localhost/');
  const descriptor = spaceId ? encodePairDescriptor(spaceId, secret) : secret;
  url.hash = `pair=${encodeURIComponent(descriptor)}`;
  return `${url.origin === 'http://localhost' && !locationImpl?.origin ? '' : url.origin}${url.pathname}${url.search}${url.hash}`;
}

/** Encode the space id with the high-entropy recovery secret for a new device. */
export function buildRecoveryCode(recoveryCode, spaceId) {
  const secret = String(recoveryCode || '').trim();
  const id = String(spaceId || '').trim();
  if (!secret || !id) throw new ShareClientError('恢复码信息不完整', { code: 'recovery-code-invalid' });
  return encodePairDescriptor(id, secret);
}

export function readPairFragment(locationImpl = globalThis.location) {
  const hash = String(locationImpl?.hash || '').replace(/^#/, '');
  if (!hash) return '';
  const value = new URLSearchParams(hash).get('pair');
  return String(value || '').trim();
}

export function clearPairFragment(locationImpl = globalThis.location, historyImpl = globalThis.history) {
  if (!locationImpl) return;
  const current = locationImpl.href || `${locationImpl.pathname || ''}${locationImpl.search || ''}${locationImpl.hash || ''}`;
  try {
    const url = new URL(current, 'http://localhost/');
    url.hash = '';
    if (historyImpl?.replaceState) {
      const target = `${url.pathname}${url.search}` || '/';
      historyImpl.replaceState(historyImpl.state ?? null, '', target);
    } else if ('hash' in locationImpl) {
      locationImpl.hash = '';
    }
  } catch {
    if ('hash' in locationImpl) locationImpl.hash = '';
  }
}

export function sourceRevisionFor(task) {
  const value = task?.sourceRevision ?? task?.version ?? task?.updatedAt ?? task?.createdAt ?? task?.id;
  if (typeof value === 'number' && Number.isSafeInteger(value) && value >= 0) return value;
  return String(value ?? '0');
}

export function revisionFor(task) {
  const value = task?.revision ?? task?.sourceRevision;
  const number = Number(value);
  if (Number.isSafeInteger(number) && number >= 0) return number;
  return 0;
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

function normalizeCredentials(payload = {}) {
  const nested = payload.data && typeof payload.data === 'object' ? payload.data : null;
  const data = nested ? { ...nested, ...payload } : payload;
  const space = data.space && typeof data.space === 'object' ? data.space : {};
  const device = data.device && typeof data.device === 'object' ? data.device : {};
  const token = data.tokens && typeof data.tokens === 'object' ? data.tokens : data;
  return {
    spaceId: String(data.spaceId || space.id || space.spaceId || '').trim(),
    deviceId: String(data.deviceId || device.id || device.deviceId || '').trim(),
    role: String(data.role || device.role || 'guest').trim(),
    displayName: String(data.displayName || device.displayName || '').trim(),
    accessToken: String(data.accessToken || data.access_token || token.accessToken || token.access_token || '').trim(),
    refreshToken: String(data.refreshToken || data.refresh_token || token.refreshToken || token.refresh_token || '').trim(),
    expiresAt: data.expiresAt || data.expires_at || token.expiresAt || token.expires_at || null,
    pairSecret: String(data.pairSecret || data.pair_secret || data.pairingToken || data.pairing_token || '').trim() || undefined,
    recoveryCode: String(data.recoveryCode || data.recovery_code || '').trim() || undefined,
  };
}

function makeUrl(path, baseUrl, locationImpl) {
  const rawBase = String(baseUrl || '').trim();
  if (/^https?:\/\//i.test(rawBase)) return new URL(path, `${rawBase.replace(/\/$/, '')}/`).toString();
  if (rawBase) {
    const origin = locationImpl?.origin || 'http://localhost';
    return new URL(path, new URL(rawBase, origin)).toString();
  }
  throw new ShareClientError('尚未配置共享服务地址', { code: 'api-base-missing' });
}

function resolveSpacePath(template, spaceId, taskId = '') {
  return template
    .replace('{spaceId}', encodeURIComponent(String(spaceId || '').trim()))
    .replace('{taskId}', encodeURIComponent(String(taskId || '').trim()));
}

function encodePairDescriptor(spaceId, pairSecret) {
  const value = JSON.stringify({ spaceId: String(spaceId), pairSecret: String(pairSecret) });
  let binary = '';
  for (let index = 0; index < value.length; index += 1) binary += String.fromCharCode(value.charCodeAt(index));
  if (typeof btoa === 'function') return btoa(binary).replace(/\+/g, '-').replace(/\//g, '_').replace(/=+$/g, '');
  return Buffer.from(value, 'utf8').toString('base64url');
}

function decodePairDescriptor(value) {
  const raw = String(value || '').trim();
  if (!raw) return { pairSecret: '', spaceId: '' };
  // A raw token remains accepted for callers that already know spaceId.
  for (const candidate of [raw, raw.replace(/-/g, '+').replace(/_/g, '/')]) {
    try {
      const padded = candidate.padEnd(Math.ceil(candidate.length / 4) * 4, '=');
      const text = typeof atob === 'function'
        ? atob(padded)
        : Buffer.from(padded, 'base64').toString('utf8');
      const parsed = JSON.parse(text);
      if (parsed?.pairSecret) return { pairSecret: String(parsed.pairSecret), spaceId: String(parsed.spaceId || '') };
    } catch { /* not a structured pairing fragment */ }
  }
  const separator = raw.indexOf('.');
  if (separator > 0) return { spaceId: raw.slice(0, separator), pairSecret: raw.slice(separator + 1) };
  return { pairSecret: raw, spaceId: '' };
}

async function readResponse(response) {
  if (!response || typeof response.text !== 'function') return null;
  const raw = await response.text();
  if (!raw) return null;
  try { return JSON.parse(raw); } catch { return { message: raw }; }
}

function safeErrorMessage(payload, status) {
  if (payload && typeof payload === 'object') {
    const message = payload.error || payload.message;
    if (typeof message === 'string' && message.length <= 240) return message;
  }
  return `共享服务暂时不可用（${status}）`;
}

function bytesToBase64Url(bytes) {
  let binary = '';
  for (const byte of bytes) binary += String.fromCharCode(byte);
  if (typeof btoa === 'function') return btoa(binary).replace(/\+/g, '-').replace(/\//g, '_').replace(/=+$/g, '');
  return Buffer.from(bytes).toString('base64url');
}

function makeId(cryptoImpl = globalThis.crypto) {
  if (cryptoImpl?.randomUUID) return cryptoImpl.randomUUID();
  return `comment-${Date.now()}-${Math.random().toString(36).slice(2, 10)}`;
}

function clone(value) {
  if (value === undefined || value === null) return value;
  if (typeof structuredClone === 'function') return structuredClone(value);
  return JSON.parse(JSON.stringify(value));
}

async function readStoreMeta(store, key) {
  if (!store) return undefined;
  if (typeof store.getMeta === 'function') {
    const value = await store.getMeta(key);
    return value && typeof value === 'object' && key in value ? value[key] : value;
  }
  if (typeof store.getMetadata === 'function') {
    const value = await store.getMetadata(key);
    return value && typeof value === 'object' && key in value ? value[key] : value;
  }
  if (store.meta && typeof store.meta.get === 'function') return store.meta.get(key);
  return undefined;
}

function readLocalMeta(key) {
  try {
    if (typeof localStorage === 'undefined') return undefined;
    const raw = localStorage.getItem(META_FALLBACK_KEY);
    const data = raw ? JSON.parse(raw) : {};
    return Object.prototype.hasOwnProperty.call(data, key) ? data[key] : undefined;
  } catch { return undefined; }
}

function writeLocalMeta(key, value) {
  try {
    if (typeof localStorage === 'undefined') return;
    const raw = localStorage.getItem(META_FALLBACK_KEY);
    const data = raw ? JSON.parse(raw) : {};
    data[key] = value;
    localStorage.setItem(META_FALLBACK_KEY, JSON.stringify(data));
  } catch { /* local persistence is best effort */ }
}

function removeLocalMeta(key) {
  try {
    if (typeof localStorage === 'undefined') return;
    const raw = localStorage.getItem(META_FALLBACK_KEY);
    const data = raw ? JSON.parse(raw) : {};
    delete data[key];
    localStorage.setItem(META_FALLBACK_KEY, JSON.stringify(data));
  } catch { /* local persistence is best effort */ }
}
