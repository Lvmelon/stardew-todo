import assert from 'node:assert/strict';
import { readFile } from 'node:fs/promises';
import { dirname, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import test from 'node:test';

const root = resolve(dirname(fileURLToPath(import.meta.url)), '../..');

async function loadModule(name) {
  const source = await readFile(resolve(root, name), 'utf8');
  const encoded = Buffer.from(source).toString('base64');
  return import(`data:text/javascript;base64,${encoded}`);
}

class FakeClassList {
  constructor() { this.values = new Set(); }
  add(...names) { names.forEach(name => this.values.add(name)); }
  remove(...names) { names.forEach(name => this.values.delete(name)); }
  contains(name) { return this.values.has(name); }
}

function fakeTarget() {
  return { classList: new FakeClassList(), dataset: {} };
}

function fakeStorage() {
  const values = new Map();
  return {
    getItem: key => values.get(key) ?? null,
    setItem: (key, value) => values.set(key, String(value)),
    removeItem: key => values.delete(key),
  };
}

test('weather maps WMO codes and never requests location by default', async () => {
  const weather = await loadModule('weather.js');
  assert.equal(weather.weatherCodeToCondition(0).key, 'clear');
  assert.equal(weather.weatherCodeToCondition(3).key, 'cloudy');
  assert.equal(weather.weatherCodeToCondition(61).key, 'rain');
  assert.equal(weather.weatherCodeToCondition(71).key, 'snow');

  let geolocationCalls = 0;
  const storage = fakeStorage();
  const service = weather.createWeatherService({
    storage,
    geolocation: {
      getCurrentPosition(success) {
        geolocationCalls += 1;
        success({ coords: { latitude: 31.2, longitude: 121.5 } });
      },
    },
    fetchImpl: async () => ({
      ok: true,
      json: async () => ({
        latitude: 31.2,
        longitude: 121.5,
        timezone: 'Asia/Shanghai',
        current: { temperature_2m: 24, weather_code: 2, is_day: 1 },
      }),
    }),
    nowFactory: () => new Date('2026-08-25T00:00:00.000Z'),
  });

  const safeDefault = await service.getWeather();
  assert.equal(geolocationCalls, 0);
  assert.equal(safeDefault.source, 'fallback');
  assert.equal(safeDefault.condition.key, 'clear');

  const located = await service.getWeather({ useCurrentLocation: true });
  assert.equal(geolocationCalls, 1);
  assert.equal(located.source, 'network');
  assert.equal(located.condition.key, 'cloudy');
  assert.equal(located.temperature, 24);
});
test('weather uses cached data before a calm clear fallback when offline', async () => {
  const weather = await loadModule('weather.js');
  const storage = fakeStorage();
  const online = weather.createWeatherService({
    storage,
    fetchImpl: async () => ({ ok: true, json: async () => ({ current_weather: { temperature: 8, weather_code: 61 } }) }),
    nowFactory: () => new Date('2026-08-25T00:00:00.000Z'),
  });
  await online.getByCoordinates({ latitude: 1, longitude: 2 });
  const offline = weather.createWeatherService({ storage, fetchImpl: async () => { throw new Error('offline'); } });
  const cached = await offline.getByCoordinates({ latitude: 1, longitude: 2 });
  assert.equal(cached.source, 'cache');
  assert.equal(cached.condition.key, 'rain');
});

test('atmosphere exposes pure time/season values and replaces CSS classes', async () => {
  const atmosphere = await loadModule('atmosphere.js');
  assert.equal(atmosphere.getTimeSegment(new Date(2026, 7, 25, 6)).key, 'dawn');
  assert.equal(atmosphere.getTimeSegment(new Date(2026, 7, 25, 12)).key, 'day');
  assert.equal(atmosphere.getTimeSegment(new Date(2026, 7, 25, 18)).key, 'dusk');
  assert.equal(atmosphere.getTimeSegment(new Date(2026, 7, 25, 23)).key, 'night');
  assert.equal(atmosphere.getSeason(3).key, 'spring');
  assert.equal(atmosphere.getSeason(7).key, 'summer');
  assert.equal(atmosphere.getSeason(10).key, 'autumn');
  assert.equal(atmosphere.getSeason(12).key, 'winter');

  const target = fakeTarget();
  atmosphere.applyAtmosphereClass(target, atmosphere.getAtmosphere(new Date(2026, 7, 25, 18)));
  assert.equal(target.classList.contains('time-dusk'), true);
  assert.equal(target.classList.contains('season-summer'), true);
  atmosphere.applyAtmosphereClass(target, atmosphere.getAtmosphere(new Date(2026, 0, 25, 23)));
  assert.equal(target.classList.contains('time-night'), true);
  assert.equal(target.classList.contains('season-winter'), true);
  assert.equal(target.classList.contains('time-dusk'), false);
});

test('audio manager is off until enabled and explicitly started from a gesture', async () => {
  const audio = await loadModule('audio-manager.js');
  const storage = fakeStorage();
  let contextCreations = 0;
  const parameter = () => ({
    value: 0,
    setValueAtTime(value) { this.value = value; },
    linearRampToValueAtTime(value) { this.value = value; },
    exponentialRampToValueAtTime(value) { this.value = value; },
  });
  const context = {
    currentTime: 0,
    destination: {},
    createGain() { return { gain: parameter(), connect() {}, disconnect() {} }; },
    createOscillator() {
      return { frequency: parameter(), connect() {}, disconnect() {}, start() {}, stop() {}, type: '' };
    },
    resume() {},
    suspend() {},
    close() {},
  };
  const manager = audio.createAudioManager({
    storage,
    audioContextFactory: () => { contextCreations += 1; return context; },
  });
  assert.equal(manager.getSettings().enabled, false);
  assert.equal(contextCreations, 0);
  assert.equal((await manager.start()).reason, 'user-gesture-required');
  assert.equal(contextCreations, 0);
  manager.setEnabled(true);
  assert.equal((await manager.startFromGesture()).ok, true);
  assert.equal(manager.isRunning(), true);
  manager.setVolume(0.6);
  assert.equal(manager.getSettings().volume, 0.6);
  await manager.stop();
  assert.equal(manager.isRunning(), false);
});

test('plant growth stays within stages 0–4 and exposes a DOM class', async () => {
  const plant = await loadModule('plant-growth.js');
  assert.equal(plant.getPlantStage(0), 0);
  assert.equal(plant.getPlantStage(1), 1);
  assert.equal(plant.getPlantStage(2), 1);
  assert.equal(plant.getPlantStage(3), 2);
  assert.equal(plant.getPlantStage(10), 4);
  assert.equal(plant.getPlantStage(999), 4);
  const target = fakeTarget();
  const growth = plant.applyPlantGrowth(target, [
    { status: 'completed' },
    { status: 'open' },
    { status: 'completed' },
    { status: 'completed' },
  ]);
  assert.equal(growth.stage, 2);
  assert.equal(target.classList.contains('plant-stage-2'), true);
  assert.equal(target.dataset.completedCount, '3');
});
