/**
 * Pure time/season helpers plus a tiny DOM class interface. The page can call
 * `createAtmosphereController().update()` whenever it renders; this module
 * does not install timers or alter the layout by itself.
 */

export const TIME_SEGMENTS = Object.freeze({
  dawn: Object.freeze({ key: 'dawn', label: '清晨' }),
  day: Object.freeze({ key: 'day', label: '白天' }),
  dusk: Object.freeze({ key: 'dusk', label: '傍晚' }),
  night: Object.freeze({ key: 'night', label: '夜晚' }),
});

export const SEASONS = Object.freeze({
  spring: Object.freeze({ key: 'spring', label: '春' }),
  summer: Object.freeze({ key: 'summer', label: '夏' }),
  autumn: Object.freeze({ key: 'autumn', label: '秋' }),
  winter: Object.freeze({ key: 'winter', label: '冬' }),
});

const TIME_KEYS = Object.keys(TIME_SEGMENTS);
const SEASON_KEYS = Object.keys(SEASONS);

function dateFrom(value) {
  if (value instanceof Date) return Number.isNaN(value.getTime()) ? new Date() : value;
  const date = new Date(value ?? Date.now());
  return Number.isNaN(date.getTime()) ? new Date() : date;
}
/**
 * Return one of 清晨/白天/傍晚/夜晚. Boundaries are intentionally broad and
 * calm: dawn 05:00–07:59, day 08:00–16:59, dusk 17:00–19:59, night 20:00–04:59.
 */
export function getTimeSegment(value = new Date()) {
  const hour = dateFrom(value).getHours();
  if (hour >= 5 && hour < 8) return { ...TIME_SEGMENTS.dawn };
  if (hour >= 8 && hour < 17) return { ...TIME_SEGMENTS.day };
  if (hour >= 17 && hour < 20) return { ...TIME_SEGMENTS.dusk };
  return { ...TIME_SEGMENTS.night };
}

/** Accept a 1–12 month number or any Date-like value. */
export function getSeason(value = new Date()) {
  let month;
  if (value instanceof Date || typeof value === 'string') {
    month = dateFrom(value).getMonth() + 1;
  } else {
    month = Number(value);
  }
  if (month >= 3 && month <= 5) return { ...SEASONS.spring };
  if (month >= 6 && month <= 8) return { ...SEASONS.summer };
  if (month >= 9 && month <= 11) return { ...SEASONS.autumn };
  return { ...SEASONS.winter };
}

export function getAtmosphere(value = new Date()) {
  const date = dateFrom(value);
  const time = getTimeSegment(date);
  const season = getSeason(date);
  return {
    time,
    season,
    timeKey: time.key,
    seasonKey: season.key,
    timeLabel: time.label,
    seasonLabel: season.label,
    classNames: [`time-${time.key}`, `season-${season.key}`],
  };
}

function removeAtmosphereClasses(target) {
  target.classList.remove(
    ...TIME_KEYS.map(key => `time-${key}`),
    ...SEASON_KEYS.map(key => `season-${key}`),
  );
}

/** Apply only the stable CSS/data contract; callers own all visual styles. */
export function applyAtmosphereClass(target, atmosphere) {
  if (!target?.classList) return null;
  const value = atmosphere?.timeKey && atmosphere?.seasonKey
    ? atmosphere
    : getAtmosphere(atmosphere);
  const timeKey = TIME_KEYS.includes(value.timeKey) ? value.timeKey : 'day';
  const seasonKey = SEASON_KEYS.includes(value.seasonKey) ? value.seasonKey : 'spring';
  removeAtmosphereClasses(target);
  target.classList.add(`time-${timeKey}`, `season-${seasonKey}`);
  if (target.dataset) {
    target.dataset.timeOfDay = timeKey;
    target.dataset.season = seasonKey;
  }
  return { timeKey, seasonKey };
}

export function createAtmosphereController(options = {}) {
  const target = options.target || null;
  const nowFactory = options.nowFactory || (() => new Date());
  let current = null;
  return Object.freeze({
    update(value = nowFactory()) {
      current = getAtmosphere(value);
      if (target) applyAtmosphereClass(target, current);
      return current;
    },
    getCurrent: () => current,
    apply: value => applyAtmosphereClass(target, value || current || getAtmosphere(nowFactory())),
  });
}
