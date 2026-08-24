export function validateTaskInput(input = {}) {
  const title = String(input.title ?? '').trim();
  if (!title) return { ok: false, message: '任务名称不能为空' };
  if ([...title].length > 40) return { ok: false, message: '任务名称最多 40 个字' };
  return { ok: true, message: '' };
}

export function createTask(input, idFactory = defaultId, nowFactory = defaultNow) {
  const validation = validateTaskInput(input);
  if (!validation.ok) throw new Error(validation.message);
  const now = nowFactory();
  return {
    id: idFactory(),
    title: String(input.title).trim(),
    description: String(input.description ?? '').trim(),
    emoji: String(input.emoji ?? '').trim() || '📌',
    dueDate: String(input.dueDate ?? '').trim(),
    status: 'open',
    createdAt: now,
    updatedAt: now,
  };
}

export function updateTask(task, input, nowFactory = defaultNow) {
  const validation = validateTaskInput(input);
  if (!validation.ok) throw new Error(validation.message);
  return {
    ...task,
    title: String(input.title).trim(),
    description: String(input.description ?? '').trim(),
    emoji: String(input.emoji ?? '').trim() || '📌',
    dueDate: String(input.dueDate ?? '').trim(),
    updatedAt: nowFactory(),
  };
}

export function completeTask(task, nowFactory = defaultNow) {
  const now = nowFactory();
  return { ...task, status: 'completed', completedAt: now, updatedAt: now };
}

export function deleteTask(task, nowFactory = defaultNow) {
  const now = nowFactory();
  return { ...task, status: 'deleted', deletedAt: now, updatedAt: now };
}

export function visibleTasks(tasks, limit = 5) {
  return tasks
    .filter(task => task.status === 'open')
    .sort((a, b) => String(b.updatedAt ?? '').localeCompare(String(a.updatedAt ?? '')))
    .slice(0, limit);
}

function defaultId() {
  if (globalThis.crypto?.randomUUID) return crypto.randomUUID();
  return `task-${Date.now()}-${Math.random().toString(36).slice(2, 8)}`;
}

function defaultNow() {
  return new Date().toISOString();
}
