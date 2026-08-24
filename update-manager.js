/**
 * Controls the Service Worker update prompt without silently reloading the
 * user's page.  The UI decides when to call accept(); dismiss() leaves the
 * waiting worker alone so the current task view remains stable.
 */
export function createUpdateManager(options = {}) {
  const serviceWorker = options.serviceWorkerContainer || globalThis.navigator?.serviceWorker;
  const onUpdateAvailable = typeof options.onUpdateAvailable === 'function' ? options.onUpdateAvailable : () => {};
  const reload = options.reload || (() => globalThis.location?.reload?.());
  const reloadOnApply = options.reloadOnApply === true;
  let registration = options.registration || null;
  let waitingWorker = null;
  let state = serviceWorker ? 'idle' : 'unsupported';
  let dismissed = false;
  let applying = false;
  let started = false;
  let removeControllerListener = null;
  let removeUpdateListener = null;

  function notify(worker) {
    waitingWorker = worker;
    dismissed = false;
    state = 'waiting';
    onUpdateAvailable({ worker, state, accept, dismiss, manager: api });
  }

  function inspect(currentRegistration) {
    registration = currentRegistration;
    if (registration?.waiting) notify(registration.waiting);
    const installing = registration?.installing;
    if (installing) watchInstalling(installing);
  }

  function watchInstalling(installing) {
    const stateChange = () => {
      if (installing.state === 'installed' && serviceWorker?.controller) notify(installing);
    };
    installing.addEventListener?.('statechange', stateChange);
    removeUpdateListener = () => installing.removeEventListener?.('statechange', stateChange);
  }

  async function start(explicitRegistration = registration) {
    if (!serviceWorker) return api;
    if (started) return api;
    started = true;
    if (explicitRegistration) inspect(explicitRegistration);
    else if (serviceWorker.ready) inspect(await serviceWorker.ready);
    const controllerChange = () => {
      if (!applying) return;
      applying = false;
      state = 'updated';
      waitingWorker = null;
      if (reloadOnApply) reload();
    };
    serviceWorker.addEventListener?.('controllerchange', controllerChange);
    removeControllerListener = () => serviceWorker.removeEventListener?.('controllerchange', controllerChange);
    return api;
  }

  async function checkForUpdate() {
    if (!registration?.update) return false;
    await registration.update();
    inspect(registration);
    return Boolean(registration.waiting);
  }

  function accept() {
    if (!waitingWorker) return false;
    applying = true;
    state = 'applying';
    waitingWorker.postMessage?.({ type: 'SKIP_WAITING' });
    return true;
  }

  function dismiss() {
    dismissed = true;
    state = 'dismissed';
    return state;
  }

  function getState() {
    return { state, dismissed, hasWaitingWorker: Boolean(waitingWorker), registration };
  }

  function stop() {
    removeControllerListener?.();
    removeUpdateListener?.();
    removeControllerListener = null;
    removeUpdateListener = null;
    started = false;
  }

  const api = Object.freeze({ start, checkForUpdate, accept, dismiss, getState, stop });
  return api;
}
