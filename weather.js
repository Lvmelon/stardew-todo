/**
 * Small, opt-in weather client for Open-Meteo.
 *
 * The module deliberately does not request a location or make a network
 * request on import. A caller has to invoke one of the service methods from
 * an explicit weather action in the UI.
 */

export const WEATHER_CACHE_KEY = 'stardew-todo-weather-v1';
export const OPEN_METEO_WEATHER_URL = 'https://api.open-meteo.com/v1/forecast';
export const OPEN_METEO_GEOCODING_URL = 'https://geocoding-api.open-meteo.com/v1/search';

const WEATHER_CLASS_KEYS = ['clear', 'cloudy', 'rain', 'snow'];

export const WEATHER_CONDITIONS = Object.freeze({
  clear: Object.freeze({ key: 'clear', label: '晴', emoji: '☀️' }),
  cloudy: Object.freeze({ key: 'cloudy', label: '多云', emoji: '☁️' }),
  rain: Object.freeze({ key: 'rain', label: '下雨', emoji: '🌧️' }),
  snow: Object.freeze({ key: 'snow', label: '下雪', emoji: '❄️' }),
});

function finiteNumber(value) {
  const number = Number(value);
  return Number.isFinite(number) ? number : null;
}
function cloneCondition(condition) {
  return { ...condition };
}

/**
 * Collapse Open-Meteo WMO weather codes into the four visual states the app
 * needs. The raw code is still kept on the normalized weather object.
 */
export function weatherCodeToCondition(code) {
  const numeric = Number(code);
  if (numeric === 0) return cloneCondition(WEATHER_CONDITIONS.clear);
  if (numeric >= 1 && numeric <= 48) return cloneCondition(WEATHER_CONDITIONS.cloudy);
  if ((numeric >= 51 && numeric <= 67) || (numeric >= 80 && numeric <= 99)) {
    // 71–77 and 85–86 are snow codes and are checked below.
    if ((numeric >= 71 && numeric <= 77) || (numeric >= 85 && numeric <= 86)) {
      return cloneCondition(WEATHER_CONDITIONS.snow);
    }
    return cloneCondition(WEATHER_CONDITIONS.rain);
  }
  if (numeric >= 71 && numeric <= 77) return cloneCondition(WEATHER_CONDITIONS.snow);
  return cloneCondition(WEATHER_CONDITIONS.clear);
}

export function weatherClassName(weatherOrCode) {
  const condition = typeof weatherOrCode === 'object' && weatherOrCode
    ? weatherOrCode.condition || weatherOrCode
    : weatherCodeToCondition(weatherOrCode);
  const key = WEATHER_CLASS_KEYS.includes(condition?.key) ? condition.key : 'clear';
  return `weather-${key}`;
}

/**
 * Add a stable class/data interface for CSS without requiring this module to
 * know anything about the page layout.
 */
export function applyWeatherClass(target, weatherOrCode) {
  if (!target?.classList) return null;
  const condition = typeof weatherOrCode === 'object' && weatherOrCode?.condition
    ? weatherOrCode.condition
    : weatherCodeToCondition(typeof weatherOrCode === 'object' ? weatherOrCode?.weatherCode : weatherOrCode);
  const key = WEATHER_CLASS_KEYS.includes(condition?.key) ? condition.key : 'clear';
  target.classList.remove(...WEATHER_CLASS_KEYS.map(item => `weather-${item}`));
  target.classList.add(`weather-${key}`);
  if (target.dataset) target.dataset.weather = key;
  return key;
}

export function normalizeCoordinates(value = {}) {
  const latitude = finiteNumber(value.latitude ?? value.lat);
  const longitude = finiteNumber(value.longitude ?? value.lon ?? value.lng);
  if (latitude === null || longitude === null || latitude < -90 || latitude > 90 || longitude < -180 || longitude > 180) {
    return null;
  }
  return { latitude, longitude };
}

export function normalizeWeatherPayload(payload, metadata = {}, nowFactory = () => new Date()) {
  const current = payload?.current || payload?.current_weather;
  if (!current || current.weather_code === undefined) {
    throw new Error('Open-Meteo 返回的天气数据不完整');
  }
  const weatherCode = Number(current.weather_code);
  const condition = weatherCodeToCondition(weatherCode);
  const coordinates = normalizeCoordinates({
    latitude: payload.latitude ?? metadata.latitude,
    longitude: payload.longitude ?? metadata.longitude,
  });
  return {
    latitude: coordinates?.latitude ?? null,
    longitude: coordinates?.longitude ?? null,
    locationName: String(metadata.locationName ?? payload.locationName ?? '').trim(),
    timezone: String(payload.timezone ?? metadata.timezone ?? '').trim(),
    temperature: finiteNumber(current.temperature_2m ?? current.temperature),
    apparentTemperature: finiteNumber(current.apparent_temperature),
    humidity: finiteNumber(current.relative_humidity_2m ?? current.relativehumidity_2m),
    windSpeed: finiteNumber(current.wind_speed_10m ?? current.windspeed),
    isDay: current.is_day === undefined ? null : Boolean(Number(current.is_day)),
    weatherCode: Number.isFinite(weatherCode) ? weatherCode : 0,
    condition,
    fetchedAt: nowFactory().toISOString(),
    source: 'network',
  };
}

function getDefaultStorage() {
  try {
    return globalThis.localStorage || null;
  } catch {
    return null;
  }
}

function safeRead(storage, key) {
  try {
    const value = storage?.getItem?.(key);
    return value ? JSON.parse(value) : null;
  } catch {
    return null;
  }
}

function safeWrite(storage, key, value) {
  try {
    storage?.setItem?.(key, JSON.stringify(value));
  } catch {
    // Weather is an enhancement; a full or unavailable localStorage must not
    // make the task list unusable.
  }
}

function safeRemove(storage, key) {
  try {
    storage?.removeItem?.(key);
  } catch {
    // Ignore storage cleanup failures.
  }
}

function fallbackWeather(nowFactory, cached, metadata = {}) {
  if (cached && typeof cached === 'object' && cached.condition) {
    return {
      ...cached,
      locationName: String(metadata.locationName ?? cached.locationName ?? '').trim(),
      source: 'cache',
    };
  }
  return {
    latitude: finiteNumber(metadata.latitude),
    longitude: finiteNumber(metadata.longitude),
    locationName: String(metadata.locationName ?? '').trim(),
    timezone: '',
    temperature: null,
    apparentTemperature: null,
    humidity: null,
    windSpeed: null,
    isDay: null,
    weatherCode: 0,
    condition: cloneCondition(WEATHER_CONDITIONS.clear),
    fetchedAt: nowFactory().toISOString(),
    source: 'fallback',
  };
}

function coordinatesFromPosition(position) {
  const coords = normalizeCoordinates(position?.coords || position);
  if (!coords) throw new Error('定位结果无效');
  return coords;
}

function getPosition(geolocation) {
  return new Promise((resolve, reject) => {
    if (!geolocation?.getCurrentPosition) {
      reject(new Error('当前设备不支持定位'));
      return;
    }
    geolocation.getCurrentPosition(
      position => {
        try {
          resolve(coordinatesFromPosition(position));
        } catch (error) {
          reject(error);
        }
      },
      error => reject(error || new Error('定位失败')),
      { enableHighAccuracy: false, maximumAge: 15 * 60 * 1000, timeout: 12 * 1000 },
    );
  });
}

function weatherRequestUrl(coordinates) {
  const url = new URL(OPEN_METEO_WEATHER_URL);
  url.searchParams.set('latitude', String(coordinates.latitude));
  url.searchParams.set('longitude', String(coordinates.longitude));
  url.searchParams.set('current', 'temperature_2m,relative_humidity_2m,apparent_temperature,weather_code,wind_speed_10m,is_day');
  url.searchParams.set('timezone', 'auto');
  return url.toString();
}

function geocodingRequestUrl(query, language = 'zh') {
  const url = new URL(OPEN_METEO_GEOCODING_URL);
  url.searchParams.set('name', query);
  url.searchParams.set('count', '5');
  url.searchParams.set('language', language);
  url.searchParams.set('format', 'json');
  return url.toString();
}

/**
 * Create an opt-in weather service. All side effects are injected or happen
 * only after a method is called, making this module usable in tests and in a
 * local-first/offline PWA.
 */
export function createWeatherService(options = {}) {
  const fetchImpl = options.fetchImpl || globalThis.fetch?.bind(globalThis);
  const geolocation = options.geolocation ?? globalThis.navigator?.geolocation ?? null;
  const storage = options.storage ?? getDefaultStorage();
  const nowFactory = options.nowFactory || (() => new Date());
  const cacheKey = options.cacheKey || WEATHER_CACHE_KEY;
  const cachedWeather = () => safeRead(storage, cacheKey);
  const fallback = metadata => fallbackWeather(nowFactory, cachedWeather(), metadata);

  async function fetchJson(url) {
    if (typeof fetchImpl !== 'function') throw new Error('当前环境不支持网络请求');
    const response = await fetchImpl(url, { headers: { Accept: 'application/json' } });
    if (!response?.ok) throw new Error(`天气请求失败（${response?.status ?? 'network'}）`);
    return response.json();
  }

  async function getByCoordinates(value, metadata = {}) {
    const coordinates = normalizeCoordinates(value);
    if (!coordinates) return fallback(metadata);
    try {
      const payload = await fetchJson(weatherRequestUrl(coordinates));
      const weather = normalizeWeatherPayload(payload, { ...metadata, ...coordinates }, nowFactory);
      safeWrite(storage, cacheKey, weather);
      return weather;
    } catch {
      return fallback({ ...metadata, ...coordinates });
    }
  }

  async function searchLocations(query, language = 'zh') {
    const name = String(query ?? '').trim();
    if (!name) return [];
    try {
      const payload = await fetchJson(geocodingRequestUrl(name, language));
      return (Array.isArray(payload?.results) ? payload.results : [])
        .map(item => ({
          id: item.id ?? null,
          name: String(item.name ?? '').trim(),
          latitude: finiteNumber(item.latitude),
          longitude: finiteNumber(item.longitude),
          timezone: String(item.timezone ?? '').trim(),
          country: String(item.country ?? '').trim(),
          admin1: String(item.admin1 ?? '').trim(),
        }))
        .filter(item => item.name && item.latitude !== null && item.longitude !== null);
    } catch {
      return [];
    }
  }

  async function getByCity(query, language = 'zh') {
    const [place] = await searchLocations(query, language);
    return place
      ? getByCoordinates(place, { locationName: place.name, timezone: place.timezone })
      : fallback({ locationName: String(query ?? '').trim() });
  }

  async function getWeather(request = {}) {
    const directCoordinates = request.coordinates || request;
    const coordinates = normalizeCoordinates(directCoordinates);
    if (coordinates) return getByCoordinates(coordinates, request);
    if (request.city || request.query) return getByCity(request.city || request.query, request.language);
    // Geolocation is intentionally opt-in. A normal call with no options is
    // a safe cached/clear result and never triggers a permission prompt.
    if (request.useCurrentLocation === true) {
      try {
        const current = await getPosition(geolocation);
        return getByCoordinates(current, request);
      } catch {
        return fallback();
      }
    }
    return fallback();
  }

  return Object.freeze({
    getWeather,
    requestWeather: getWeather,
    getCurrentWeather: getWeather,
    getByCoordinates,
    getByCity,
    searchLocations,
    getCurrentLocation: () => getPosition(geolocation),
    getCached: () => cachedWeather(),
    clearCache: () => safeRemove(storage, cacheKey),
    applyWeatherClass,
  });
}
