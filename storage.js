const DB_NAME = 'stardew-todo-pwa';
const STORE_NAME = 'tasks';
const DB_VERSION = 1;
const FALLBACK_KEY = 'stardew_todo_tasks_v05';

export function createTaskStore() {
  const memory = createMemoryStore();
  const local = createResilientStore(createLocalStorageStore(), memory);
  const hasIndexedDB = typeof indexedDB !== 'undefined';
  return hasIndexedDB ? createResilientStore(createIndexedDbStore(), local) : local;
}

export function createResilientStore(primary, fallback) {
  let active = primary;
  async function call(method, ...args) {
    try {
      return await active[method](...args);
    } catch (error) {
      if (active === fallback) throw error;
      active = fallback;
      return active[method](...args);
    }
  }
  return {
    getAll: () => call('getAll'),
    put: task => call('put', task),
    putMany: tasks => call('putMany', tasks),
  };
}

function createIndexedDbStore() {
  let dbPromise;
  function openDb() {
    if (dbPromise) return dbPromise;
    dbPromise = new Promise((resolve, reject) => {
      const request = indexedDB.open(DB_NAME, DB_VERSION);
      request.onupgradeneeded = () => {
        const db = request.result;
        if (!db.objectStoreNames.contains(STORE_NAME)) {
          db.createObjectStore(STORE_NAME, { keyPath: 'id' });
        }
      };
      request.onsuccess = () => resolve(request.result);
      request.onerror = () => reject(request.error);
    });
    return dbPromise;
  }

  async function transact(mode, executor) {
    const db = await openDb();
    return new Promise((resolve, reject) => {
      const tx = db.transaction(STORE_NAME, mode);
      const store = tx.objectStore(STORE_NAME);
      let value;
      try { value = executor(store); } catch (error) { reject(error); return; }
      tx.oncomplete = () => resolve(value);
      tx.onerror = () => reject(tx.error);
      tx.onabort = () => reject(tx.error || new Error('IndexedDB transaction aborted'));
    });
  }

  return {
    async getAll() {
      const db = await openDb();
      return new Promise((resolve, reject) => {
        const tx = db.transaction(STORE_NAME, 'readonly');
        const request = tx.objectStore(STORE_NAME).getAll();
        request.onsuccess = () => resolve(request.result || []);
        request.onerror = () => reject(request.error);
      });
    },
    async put(task) {
      await transact('readwrite', store => store.put(task));
      return task;
    },
    async putMany(tasks) {
      await transact('readwrite', store => tasks.forEach(task => store.put(task)));
      return tasks;
    },
  };
}

function createMemoryStore() {
  let tasks = [];
  return {
    async getAll() { return tasks.map(task => ({ ...task })); },
    async put(task) {
      const index = tasks.findIndex(item => item.id === task.id);
      if (index >= 0) tasks[index] = { ...task }; else tasks.push({ ...task });
      return task;
    },
    async putMany(items) { tasks = items.map(task => ({ ...task })); return items; },
  };
}

function createLocalStorageStore() {
  function read() {
    try {
      const raw = localStorage.getItem(FALLBACK_KEY);
      const parsed = raw ? JSON.parse(raw) : [];
      return Array.isArray(parsed) ? parsed : [];
    } catch { return []; }
  }
  function write(tasks) {
    localStorage.setItem(FALLBACK_KEY, JSON.stringify(tasks));
  }
  return {
    async getAll() { return read(); },
    async put(task) {
      const tasks = read();
      const index = tasks.findIndex(item => item.id === task.id);
      if (index >= 0) tasks[index] = task; else tasks.push(task);
      write(tasks);
      return task;
    },
    async putMany(newTasks) {
      const tasks = read();
      for (const task of newTasks) {
        const index = tasks.findIndex(item => item.id === task.id);
        if (index >= 0) tasks[index] = task; else tasks.push(task);
      }
      write(tasks);
      return newTasks;
    },
  };
}
