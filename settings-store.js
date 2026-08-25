export const DEFAULT_SETTINGS = Object.freeze({
  notificationsEnabled: false,
  defaultReminderEnabled: false,
  defaultReminderTime: '20:00',
  weatherEnabled: false,
  weatherAutoLocation: true,
  weatherLocation: '',
  timeAtmosphere: true,
  seasonalAtmosphere: true,
  weatherEffects: true,
  ambientMotion: true,
  completionAnimation: true,
  plantGrowth: true,
  bgmEnabled: false,
  volume: 0.35,
  displayName: '我',
});

export const SETTING_KEYS = Object.freeze(Object.keys(DEFAULT_SETTINGS));
const TIME_PATTERN = /^(?:[01]\d|2[0-3]):[0-5]\d$/;

export function validateSettings(input = {}) {
  const source = input && typeof input === 'object' ? input : {};
  const errors = {};
  if (source.defaultReminderTime !== undefined && !TIME_PATTERN.test(String(source.defaultReminderTime))) {
    errors.defaultReminderTime = '默认提醒时间格式应为 HH:MM';
  }
  if (source.volume !== undefined && (!Number.isFinite(Number(source.volume)) || Number(source.volume) < 0 || Number(source.volume) > 1)) {
    errors.volume = '音量应在 0 到 1 之间';
  }
  if (source.displayName !== undefined && [...String(source.displayName)].length > 20) {
    errors.displayName = '称呼最多 20 个字';
  }
  if (source.weatherLocation !== undefined && [...String(source.weatherLocation)].length > 80) {
    errors.weatherLocation = '位置名称最多 80 个字';
  }
  return { ok: Object.keys(errors).length === 0, errors };
}

/** Normalize local-only UI settings without ever adding cloud credentials. */
export function normalizeSettings(input = {}) {
  const source = input && typeof input === 'object' ? input : {};
  const result = { ...DEFAULT_SETTINGS };
  for (const key of SETTING_KEYS) {
    if (source[key] === undefined) continue;
    result[key] = normalizeSettingValue(key, source[key]);
  }
  return result;
}

export function mergeSettings(current = {}, changes = {}) {
  return normalizeSettings({ ...normalizeSettings(current), ...changes });
}

export async function loadSettings(store) {
  const saved = typeof store?.getSettings === 'function' ? await store.getSettings() : {};
  return normalizeSettings(saved);
}

export async function saveSettings(store, changes = {}) {
  const validation = validateSettings(changes);
  if (!validation.ok) {
    const error = new Error(Object.values(validation.errors)[0]);
    error.details = validation.errors;
    throw error;
  }
  const next = mergeSettings(await loadSettings(store), changes);
  if (typeof store?.setSettings !== 'function') throw new Error('设置存储不可用');
  await store.setSettings(next);
  return next;
}

export function normalizeSettingValue(key, value) {
  switch (key) {
    case 'notificationsEnabled':
    case 'defaultReminderEnabled':
    case 'weatherEnabled':
    case 'weatherAutoLocation':
    case 'timeAtmosphere':
    case 'seasonalAtmosphere':
    case 'weatherEffects':
    case 'ambientMotion':
    case 'completionAnimation':
    case 'plantGrowth':
    case 'bgmEnabled':
      return Boolean(value);
    case 'defaultReminderTime':
      return TIME_PATTERN.test(String(value)) ? String(value) : DEFAULT_SETTINGS.defaultReminderTime;
    case 'volume': {
      const numeric = Number(value);
      if (!Number.isFinite(numeric)) return DEFAULT_SETTINGS.volume;
      return Math.min(1, Math.max(0, numeric));
    }
    case 'displayName':
      return String(value ?? '').trim().slice(0, 20) || DEFAULT_SETTINGS.displayName;
    case 'weatherLocation':
      return String(value ?? '').trim().slice(0, 80);
    default:
      return value;
  }
}

export function isSettingKey(key) {
  return SETTING_KEYS.includes(key);
}
