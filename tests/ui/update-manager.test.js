import { describe, expect, it, vi } from 'vitest';
import { createUpdateManager } from '../../update-manager.js';

function eventTarget() {
  const listeners = new Map();
  return {
    addEventListener(type, listener) { listeners.set(type, listener); },
    removeEventListener(type) { listeners.delete(type); },
    dispatch(type) { listeners.get(type)?.(); },
  };
}

describe('PWA update manager', () => {
  it('notices a worker installed after registration emits updatefound', async () => {
    const worker = { ...eventTarget(), state: 'installing', postMessage: vi.fn() };
    const registrationTarget = eventTarget();
    const registration = {
      ...registrationTarget,
      waiting: null,
      installing: null,
      async update() {},
    };
    const serviceWorker = {
      ...eventTarget(),
      controller: {},
      ready: Promise.resolve(registration),
    };
    const onUpdateAvailable = vi.fn();
    const manager = createUpdateManager({ serviceWorkerContainer: serviceWorker, registration, onUpdateAvailable });

    await manager.start(registration);
    registration.installing = worker;
    registration.dispatch('updatefound');
    worker.state = 'installed';
    worker.dispatch('statechange');

    expect(onUpdateAvailable).toHaveBeenCalledTimes(1);
    expect(manager.getState()).toMatchObject({ state: 'waiting', hasWaitingWorker: true });
  });
});
