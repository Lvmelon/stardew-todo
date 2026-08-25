const DATE_ONLY_PATTERN = /^(\d{4})-(\d{2})-(\d{2})$/;

export const TASK_DATE_BUCKETS = Object.freeze({
  OVERDUE: 'overdue',
  TODAY: 'today',
  FUTURE: 'future',
  ANYTIME: 'anytime',
});

const BUCKET_ORDER = Object.freeze({
  [TASK_DATE_BUCKETS.OVERDUE]: 0,
  [TASK_DATE_BUCKETS.TODAY]: 1,
  [TASK_DATE_BUCKETS.ANYTIME]: 2,
  [TASK_DATE_BUCKETS.FUTURE]: 3,
});

/**
 * Parse a YYYY-MM-DD value without allowing JavaScript's date parser to roll
 * invalid dates into the following month.
 */
export function parseDateOnly(value) {
  const match = DATE_ONLY_PATTERN.exec(String(value ?? ''));
  if (!match) return null;
  const year = Number(match[1]);
  const month = Number(match[2]);
  const day = Number(match[3]);
  const date = new Date(year, month - 1, day);
  if (
    date.getFullYear() !== year
    || date.getMonth() !== month - 1
    || date.getDate() !== day
  ) return null;
  return date;
}

export function isValidDateOnly(value) {
  return Boolean(parseDateOnly(value));
}

/** Return the local calendar date as a stable YYYY-MM-DD key. */
export function toDateKey(value = new Date()) {
  if (typeof value === 'string' && isValidDateOnly(value)) return value;
  const date = value instanceof Date ? new Date(value.getTime()) : new Date(value);
  if (Number.isNaN(date.getTime())) return '';
  return [date.getFullYear(), date.getMonth() + 1, date.getDate()]
    .map((part, index) => index === 0 ? String(part).padStart(4, '0') : String(part).padStart(2, '0'))
    .join('-');
}

export function compareDateKeys(left, right) {
  const a = String(left ?? '');
  const b = String(right ?? '');
  if (a === b) return 0;
  if (!a) return 1;
  if (!b) return -1;
  return a < b ? -1 : 1;
}

export function daysBetweenDateKeys(from, to) {
  const start = parseDateOnly(from);
  const end = parseDateOnly(to);
  if (!start || !end) return null;
  const startUtc = Date.UTC(start.getFullYear(), start.getMonth(), start.getDate());
  const endUtc = Date.UTC(end.getFullYear(), end.getMonth(), end.getDate());
  return Math.round((endUtc - startUtc) / 86400000);
}

export function classifyDueDate(dueDate, referenceDate = new Date()) {
  const dueKey = String(dueDate ?? '').trim();
  if (!isValidDateOnly(dueKey)) return TASK_DATE_BUCKETS.ANYTIME;
  const todayKey = toDateKey(referenceDate);
  if (!todayKey) return TASK_DATE_BUCKETS.ANYTIME;
  if (dueKey < todayKey) return TASK_DATE_BUCKETS.OVERDUE;
  if (dueKey === todayKey) return TASK_DATE_BUCKETS.TODAY;
  return TASK_DATE_BUCKETS.FUTURE;
}

export function classifyTask(task, referenceDate = new Date()) {
  const startKey = String(task?.startDate ?? '').trim();
  const todayKey = toDateKey(referenceDate);
  if (isValidDateOnly(startKey) && todayKey && startKey > todayKey) {
    return TASK_DATE_BUCKETS.FUTURE;
  }
  const dueBucket = classifyDueDate(task?.dueDate, referenceDate);
  return dueBucket === TASK_DATE_BUCKETS.FUTURE ? TASK_DATE_BUCKETS.ANYTIME : dueBucket;
}

function timestampForSort(value) {
  const text = String(value ?? '');
  const parsed = Date.parse(text);
  return Number.isNaN(parsed) ? null : parsed;
}

function compareCreation(left, right) {
  const leftTime = timestampForSort(left.createdAt);
  const rightTime = timestampForSort(right.createdAt);
  if (leftTime !== null && rightTime !== null && leftTime !== rightTime) {
    return leftTime - rightTime;
  }
  const textResult = String(left.createdAt ?? '').localeCompare(String(right.createdAt ?? ''));
  if (textResult !== 0) return textResult;
  return 0;
}

/**
 * Sort open tasks for the home board. The original array index is used as the
 * final tie-breaker so the result stays stable even for legacy records with
 * identical or missing timestamps.
 */
export function sortTasksForToday(tasks = [], referenceDate = new Date()) {
  return tasks
    .map((task, index) => ({ task, index, bucket: classifyTask(task, referenceDate) }))
    .filter(item => item.task?.status === 'open' && item.bucket !== TASK_DATE_BUCKETS.FUTURE)
    .sort((left, right) => {
      const bucketResult = BUCKET_ORDER[left.bucket] - BUCKET_ORDER[right.bucket];
      if (bucketResult !== 0) return bucketResult;
      const dateResult = left.bucket === TASK_DATE_BUCKETS.OVERDUE
        ? compareDateKeys(left.task.dueDate, right.task.dueDate)
        : left.bucket === TASK_DATE_BUCKETS.FUTURE
          ? compareDateKeys(left.task.startDate, right.task.startDate)
        : 0;
      if (dateResult !== 0) return dateResult;
      const creationResult = compareCreation(left.task, right.task);
      return creationResult !== 0 ? creationResult : left.index - right.index;
    })
    .map(item => item.task);
}

/** Sort all open tasks, retaining future work for the “全部任务” view. */
export function sortTasksForDisplay(tasks = [], referenceDate = new Date()) {
  return tasks
    .map((task, index) => ({ task, index, bucket: classifyTask(task, referenceDate) }))
    .filter(item => item.task?.status === 'open')
    .sort((left, right) => {
      const bucketResult = BUCKET_ORDER[left.bucket] - BUCKET_ORDER[right.bucket];
      if (bucketResult !== 0) return bucketResult;
      const dateResult = left.bucket === TASK_DATE_BUCKETS.OVERDUE
        ? compareDateKeys(left.task.dueDate, right.task.dueDate)
        : left.bucket === TASK_DATE_BUCKETS.FUTURE
          ? compareDateKeys(left.task.startDate, right.task.startDate)
        : 0;
      if (dateResult !== 0) return dateResult;
      const creationResult = compareCreation(left.task, right.task);
      return creationResult !== 0 ? creationResult : left.index - right.index;
    })
    .map(item => item.task);
}

export function formatDateOnly(value, options = {}) {
  const date = parseDateOnly(value);
  if (!date) return String(value ?? '');
  const month = date.getMonth() + 1;
  const day = date.getDate();
  if (options.withYear) return `${date.getFullYear()}年${month}月${day}日`;
  return `${month}月${day}日`;
}

export function getDueDatePresentation(task, referenceDate = new Date()) {
  const bucket = classifyDueDate(task?.dueDate, referenceDate);
  if (bucket === TASK_DATE_BUCKETS.ANYTIME) {
    return { bucket, label: '随时', tone: 'quiet', isOverdue: false };
  }
  if (bucket === TASK_DATE_BUCKETS.TODAY) {
    return { bucket, label: '今天', tone: 'today', isOverdue: false };
  }
  if (bucket === TASK_DATE_BUCKETS.OVERDUE) {
    const days = daysBetweenDateKeys(task?.dueDate, toDateKey(referenceDate));
    const label = days && days > 1 ? `逾期 ${days} 天` : '已逾期';
    return { bucket, label, tone: 'overdue', isOverdue: true };
  }
  const days = daysBetweenDateKeys(toDateKey(referenceDate), task?.dueDate);
  const label = days === 1 ? '明日' : formatDateOnly(task?.dueDate);
  return { bucket, label, tone: 'future', isOverdue: false };
}

export const dateBucketOrder = BUCKET_ORDER;
