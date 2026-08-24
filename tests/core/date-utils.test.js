import { describe, expect, it } from 'vitest';
import {
  classifyDueDate,
  getDueDatePresentation,
  sortTasksForDisplay,
  sortTasksForToday,
  TASK_DATE_BUCKETS,
} from '../../date-utils.js';

const TODAY = new Date(2026, 7, 25, 12, 0, 0);

function task(id, dueDate, createdAt, status = 'open') {
  return { id, dueDate, createdAt, updatedAt: createdAt, status };
}

describe('date classification and stable task ordering', () => {
  it('classifies overdue, today, future and anytime values by local calendar date', () => {
    expect(classifyDueDate('2026-08-24', TODAY)).toBe(TASK_DATE_BUCKETS.OVERDUE);
    expect(classifyDueDate('2026-08-25', TODAY)).toBe(TASK_DATE_BUCKETS.TODAY);
    expect(classifyDueDate('2026-08-26', TODAY)).toBe(TASK_DATE_BUCKETS.FUTURE);
    expect(classifyDueDate('', TODAY)).toBe(TASK_DATE_BUCKETS.ANYTIME);
    expect(classifyDueDate('not-a-date', TODAY)).toBe(TASK_DATE_BUCKETS.ANYTIME);
  });

  it('orders home tasks as overdue, today, then anytime and leaves future out', () => {
    const tasks = [
      task('any-late', '', '2026-08-25T03:00:00.000Z'),
      task('today-2', '2026-08-25', '2026-08-25T02:00:00.000Z'),
      task('future', '2026-08-26', '2026-08-25T01:00:00.000Z'),
      task('overdue-late', '2026-08-24', '2026-08-25T00:00:00.000Z'),
      task('overdue-early', '2026-08-20', '2026-08-25T04:00:00.000Z'),
      task('today-1', '2026-08-25', '2026-08-25T01:00:00.000Z'),
    ];
    expect(sortTasksForToday(tasks, TODAY).map(item => item.id)).toEqual([
      'overdue-early', 'overdue-late', 'today-1', 'today-2', 'any-late',
    ]);
    expect(sortTasksForDisplay(tasks, TODAY).map(item => item.id)).toEqual([
      'overdue-early', 'overdue-late', 'today-1', 'today-2', 'any-late', 'future',
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
