import { describe, expect, it } from 'vitest';
import {
  classifyDueDate,
  classifyTask,
  getDueDatePresentation,
  sortTasksForDisplay,
  sortTasksForToday,
  TASK_DATE_BUCKETS,
} from '../../date-utils.js';

const TODAY = new Date(2026, 7, 25, 12, 0, 0);

function task(id, dueDate, createdAt, status = 'open', startDate = '') {
  return { id, startDate, dueDate, createdAt, updatedAt: createdAt, status };
}

describe('date classification and stable task ordering', () => {
  it('classifies overdue, today, future and anytime values by local calendar date', () => {
    expect(classifyDueDate('2026-08-24', TODAY)).toBe(TASK_DATE_BUCKETS.OVERDUE);
    expect(classifyDueDate('2026-08-25', TODAY)).toBe(TASK_DATE_BUCKETS.TODAY);
    expect(classifyDueDate('2026-08-26', TODAY)).toBe(TASK_DATE_BUCKETS.FUTURE);
    expect(classifyDueDate('', TODAY)).toBe(TASK_DATE_BUCKETS.ANYTIME);
    expect(classifyDueDate('not-a-date', TODAY)).toBe(TASK_DATE_BUCKETS.ANYTIME);
  });

  it('uses start date for visibility while due date only describes urgency', () => {
    const activeWithFutureDeadline = task('active', '2026-08-30', '2026-08-25T00:00:00.000Z', 'open', '2026-08-25');
    const notStarted = task('not-started', '2026-08-30', '2026-08-25T00:00:00.000Z', 'open', '2026-08-26');
    expect(classifyTask(activeWithFutureDeadline, TODAY)).toBe(TASK_DATE_BUCKETS.ANYTIME);
    expect(classifyTask(notStarted, TODAY)).toBe(TASK_DATE_BUCKETS.FUTURE);
    expect(getDueDatePresentation(activeWithFutureDeadline, TODAY)).toMatchObject({ label: '8月30日', tone: 'future' });
  });

  it('orders active home tasks by urgency and leaves tasks with a future start out', () => {
    const tasks = [
      task('any-late', '', '2026-08-25T03:00:00.000Z'),
      task('today-2', '2026-08-25', '2026-08-25T02:00:00.000Z'),
      task('active-future-due', '2026-08-26', '2026-08-25T02:30:00.000Z', 'open', '2026-08-25'),
      task('future-start', '2026-08-28', '2026-08-25T01:00:00.000Z', 'open', '2026-08-26'),
      task('overdue-late', '2026-08-24', '2026-08-25T00:00:00.000Z'),
      task('overdue-early', '2026-08-20', '2026-08-25T04:00:00.000Z'),
      task('today-1', '2026-08-25', '2026-08-25T01:00:00.000Z'),
    ];
    expect(sortTasksForToday(tasks, TODAY).map(item => item.id)).toEqual([
      'overdue-early', 'overdue-late', 'today-1', 'today-2', 'active-future-due', 'any-late',
    ]);
    expect(sortTasksForDisplay(tasks, TODAY).map(item => item.id)).toEqual([
      'overdue-early', 'overdue-late', 'today-1', 'today-2', 'active-future-due', 'any-late', 'future-start',
    ]);
  });

  it('keeps completed and deleted records out of open views', () => {
    const tasks = [task('done', '2026-08-25', '2026-08-25T00:00:00.000Z', 'completed'), task('open', '', '2026-08-25T01:00:00.000Z')];
    expect(sortTasksForToday(tasks, TODAY).map(item => item.id)).toEqual(['open']);
  });

  it('provides quiet overdue and tomorrow labels', () => {
    expect(getDueDatePresentation(task('x', '2026-08-24', '2026-08-25T00:00:00.000Z'), TODAY)).toMatchObject({ label: '已逾期', tone: 'overdue', isOverdue: true });
    expect(getDueDatePresentation(task('x', '2026-08-26', '2026-08-25T00:00:00.000Z'), TODAY)).toMatchObject({ label: '明日', tone: 'future', isOverdue: false });
  });
});
