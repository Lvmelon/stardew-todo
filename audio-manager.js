/**
 * Procedural, deliberately small background music manager.
 *
 * No audio file or game melody is bundled. Notes are synthesized with Web
 * Audio only after `start({ userGesture: true })` is called by a visible user
 * action. The manager keeps the context alive for the page lifetime while it
 * is enabled and running.
 */

export const AUDIO_SETTINGS_KEY = 'stardew-todo-audio-settings-v1';
export const DEFAULT_AUDIO_SETTINGS = Object.freeze({ enabled: false, volume: 0.28 });

// A short original pentatonic phrase. Frequencies and rhythm are intentionally
// kept here as data so a test can inject a different phrase without audio I/O.
export const DEFAULT_MELODY = Object.freeze([
  Object.freeze({ frequency: 261.63, beats: 1 }),
  Object.freeze({ frequency: 329.63, beats: 1 }),
  Object.freeze({ frequency: 392.00, beats: 1 }),
  Object.freeze({ frequency: 329.63, beats: 1 }),
  Object.freeze({ frequency: 293.66, beats: 1 }),
  Object.freeze({ frequency: 392.00, beats: 1 }),
  Object.freeze({ frequency: 440.00, beats: 2 }),
  Object.freeze({ frequency: 392.00, beats: 2 }),
]);

function clampVolume(value) {
  const number = Number(value);
  if (!Number.isFinite(number)) return DEFAULT_AUDIO_SETTINGS.volume;
  return Math.min(1, Math.max(0, number));
}

function normalizeSettings(value = {}) {
  return {
    enabled: value.enabled === true,
    volume: clampVolume(value.volume),
  };
}

function getDefaultStorage() {
  try {
    return globalThis.localStorage || null;
  } catch {
    return null;
  }
}

function readSettings(storage, key) {
  try {
    const raw = storage?.getItem?.(key);
    return normalizeSettings(raw ? JSON.parse(raw) : DEFAULT_AUDIO_SETTINGS);
  } catch {
    return normalizeSettings(DEFAULT_AUDIO_SETTINGS);
  }
}

function writeSettings(storage, key, settings) {
  try {
    storage?.setItem?.(key, JSON.stringify(settings));
  } catch {
    // Audio preferences are optional and should never block the todo app.
  }
}

function defaultAudioContextFactory() {
  const AudioContextConstructor = globalThis.AudioContext || globalThis.webkitAudioContext;
  return AudioContextConstructor ? new AudioContextConstructor() : null;
}

function setParam(param, method, value, when) {
  if (!param) return;
  if (typeof param[method] === 'function') {
    param[method](value, when);
  } else {
    param.value = value;
  }
}

function makeNoteDuration(note, beatSeconds) {
  const beats = Number(note?.beats);
  return (Number.isFinite(beats) && beats > 0 ? beats : 1) * beatSeconds;
}

/** Create an isolated manager; no AudioContext is constructed at factory time. */
export function createAudioManager(options = {}) {
  const storage = options.storage ?? getDefaultStorage();
  const settingsKey = options.settingsKey || AUDIO_SETTINGS_KEY;
  const melody = Array.isArray(options.melody) && options.melody.length ? options.melody : DEFAULT_MELODY;
  const beatSeconds = Number.isFinite(Number(options.beatSeconds)) && Number(options.beatSeconds) > 0
    ? Number(options.beatSeconds)
    : 0.48;
  const contextFactory = options.audioContextFactory || defaultAudioContextFactory;
  let settings = readSettings(storage, settingsKey);
  let context = null;
  let masterGain = null;
  let running = false;
  let noteIndex = 0;
  let generation = 0;
  const activeOscillators = new Set();

  function persist() {
    writeSettings(storage, settingsKey, settings);
  }

  function updateMasterGain() {
    if (!masterGain?.gain) return;
    const when = Number(context?.currentTime) || 0;
    setParam(masterGain.gain, 'setValueAtTime', settings.volume, when);
  }

  function createContext() {
    try {
      return contextFactory();
    } catch {
      return null;
    }
  }

  function setupGraph() {
    if (!context?.createGain || !context?.destination) return false;
    masterGain = context.createGain();
    if (!masterGain) return false;
    masterGain.connect?.(context.destination);
    updateMasterGain();
    return true;
  }

  function finishOscillator(oscillator) {
    activeOscillators.delete(oscillator);
    try { oscillator.disconnect?.(); } catch { /* already disconnected */ }
  }

  function scheduleNext(myGeneration) {
    if (!running || myGeneration !== generation || !context) return;
    const note = melody[noteIndex % melody.length] || melody[0];
    noteIndex = (noteIndex + 1) % melody.length;
    const when = Number(context.currentTime) || 0;
    const duration = makeNoteDuration(note, beatSeconds);
    let oscillator;
    try {
      oscillator = context.createOscillator();
      const noteGain = context.createGain();
      oscillator.type = options.waveform || 'triangle';
      setParam(oscillator.frequency, 'setValueAtTime', Number(note.frequency) || 261.63, when);
      setParam(noteGain.gain, 'setValueAtTime', 0.0001, when);
      setParam(noteGain.gain, 'linearRampToValueAtTime', Math.min(0.12, settings.volume * 0.42), when + 0.035);
      setParam(noteGain.gain, 'exponentialRampToValueAtTime', 0.0001, when + Math.max(0.08, duration - 0.03));
      oscillator.connect(noteGain);
      noteGain.connect(masterGain);
      activeOscillators.add(oscillator);
      oscillator.onended = () => {
        finishOscillator(oscillator);
        try { noteGain.disconnect?.(); } catch { /* already disconnected */ }
        scheduleNext(myGeneration);
      };
      oscillator.start(when);
      oscillator.stop(when + duration);
    } catch {
      if (oscillator) finishOscillator(oscillator);
    }
  }

  function stopOscillators() {
    for (const oscillator of activeOscillators) {
      try { oscillator.onended = null; oscillator.stop?.(); } catch { /* already stopped */ }
      finishOscillator(oscillator);
    }
    activeOscillators.clear();
  }

  /**
   * Start only from a user gesture. The caller should invoke this directly in
   * a click/tap handler; browsers cannot reliably expose gesture provenance to
   * a library, so the explicit option makes that contract visible and testable.
   */
  function start(startOptions = {}) {
    if (startOptions.userGesture !== true) {
      return Promise.resolve({ ok: false, reason: 'user-gesture-required' });
    }
    if (!settings.enabled) return Promise.resolve({ ok: false, reason: 'disabled' });
    if (running) return Promise.resolve({ ok: true, alreadyRunning: true });
    if (!context) context = createContext();
    if (!context || (!masterGain && !setupGraph())) {
      context = null;
      masterGain = null;
      return Promise.resolve({ ok: false, reason: 'unsupported' });
    }
    updateMasterGain();
    running = true;
    generation += 1;
    noteIndex = 0;
    const myGeneration = generation;
    const resumeResult = typeof context.resume === 'function' ? context.resume() : undefined;
    return Promise.resolve(resumeResult)
      .then(() => {
        if (running && myGeneration === generation) scheduleNext(myGeneration);
        return { ok: true, alreadyRunning: false };
      })
      .catch(() => {
        running = false;
        stopOscillators();
        return { ok: false, reason: 'resume-failed' };
      });
  }

  function stop() {
    if (!context && !running) return Promise.resolve({ ok: true, alreadyStopped: true });
    running = false;
    generation += 1;
    stopOscillators();
    const suspendResult = context && typeof context.suspend === 'function' ? context.suspend() : undefined;
    return Promise.resolve(suspendResult).then(() => ({ ok: true }));
  }

  function setEnabled(enabled) {
    settings = { ...settings, enabled: enabled === true };
    persist();
    if (!settings.enabled) void stop();
    return { ...settings };
  }

  function setVolume(volume) {
    settings = { ...settings, volume: clampVolume(volume) };
    persist();
    updateMasterGain();
    return { ...settings };
  }

  function loadSettings() {
    settings = readSettings(storage, settingsKey);
    updateMasterGain();
    if (!settings.enabled) void stop();
    return { ...settings };
  }

  function destroy() {
    running = false;
    generation += 1;
    stopOscillators();
    const closeResult = context && typeof context.close === 'function' ? context.close() : undefined;
    context = null;
    masterGain = null;
    return Promise.resolve(closeResult).then(() => ({ ok: true }));
  }

  return Object.freeze({
    start,
    startFromGesture: () => start({ userGesture: true }),
    stop,
    destroy,
    setEnabled,
    setVolume,
    loadSettings,
    getSettings: () => ({ ...settings }),
    isEnabled: () => settings.enabled,
    isRunning: () => running,
    isSupported: () => typeof options.audioContextFactory === 'function'
      || typeof globalThis.AudioContext === 'function'
      || typeof globalThis.webkitAudioContext === 'function',
  });
}
