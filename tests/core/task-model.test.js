import { describe, expect, it } from 'vitest';
import {
  completeTask,
  createTask,
  deleteTask,
  markReminderSent,
  markTaskShareSynced,
  normalizeTask,
  updateTask,
} from '../../task-model.js';

const now = () => '2026-08-25T10:00:00.000Z';

describe('task model V1 fields and soft state transitions', () => {
  it('creates a task with reminder/share fields and a pending mirror marker', () => {
    const task = createTask({ title: '取快递', startDate: '2026-08-25', dueDate: '2026-08-27', reminderMode: 'custom', reminderAt: '2026-08-25T20:00:00+08:00' }, () => 'task-1', now);
    expect(task).toMatchObject({
      id: 'task-1', status: 'open', ownerRole: 'me', sourceRevision: 1, pendingShareSync: true,
      startDate: '2026-08-25', dueDate: '2026-08-27', reminderMode: 'custom', reminderSentAt: null, overdueReminderSentAt: null,
    });
  });

  it('increments local source revision and resets reminder sent state when schedule changes', () => {
    const original = createTask({ title: '浇花', reminderMode: 'custom', reminderAt: '2026-08-25T20:00:00+08:00' }, () => 'task-1', now);
    const sent = markReminderSent(original, now);
    const updated = updateTask(sent, { title: '浇花', description: '', emoji: '🌱', dueDate: '', reminderMode: 'custom', reminderAt: '2026-08-26T20:00:00+08:00' }, () => '2026-08-25T11:00:00.000Z');
    expect(updated.sourceRevision).toBe(2);
    expect(updated.pendingShareSync).toBe(true);
    expect(updated.reminderSentAt).toBeNull();
  });

  it('preserves a computed overdue reminder time supplied by the editor', () => {
    const original = createTask({ title: '交房租', dueDate: '2026-08-25', reminderMode: 'default' }, () => 'task-1', now);
    const updated = updateTask(original, {
      title: '交房租', description: '', emoji: '💌', dueDate: '2026-08-26', reminderMode: 'default',
      reminderAt: null, overdueAt: '2026-08-27T01:00:00.000Z',
    }, () => '2026-08-25T11:00:00.000Z');
    expect(updated.overdueAt).toBe('2026-08-27T01:00:00.000Z');
  });

  it('requires the data needed by default and custom reminder modes', () => {
    expect(() => createTask({ title: '无日期提醒', reminderMode: 'default' }, () => 'task-1', now)).toThrow('默认提醒需要');
    expect(() => createTask({ title: '缺时间提醒', reminderMode: 'custom' }, () => 'task-1', now)).toThrow('自定义提醒需要');
  });

  it('rejects an end date before the start date', () => {
    expect(() => createTask({ title: '日期颠倒', startDate: '2026-08-26', dueDate: '2026-08-25' }, () => 'task-1', now)).toThrow('截止日期不能早于开始日期');
  });

  it('keeps completed and deleted records as soft states', () => {
    const original = createTask({ title: '收衣服' }, () => 'task-1', now);
    const completed = completeTask(original, () => '2026-08-25T11:00:00.000Z');
    const deleted = deleteTask(original, () => '2026-08-25T12:00:00.000Z');
    expect(completed.status).toBe('completed');
    expect(deleted.status).toBe('deleted');
    expect(completed.id).toBe(original.id);
    expect(deleted.id).toBe(original.id);
  });

  it('adds missing V1 defaults without removing legacy fields', () => {
    const legacy = normalizeTask({ id: 'legacy', title: '旧任务', customLegacyField: 'keep', status: 'open', dueDate: '' }, now);
    expect(legacy).toMatchObject({ id: 'legacy', customLegacyField: 'keep', startDate: '', reminderMode: 'none', overdueAt: null, sourceRevision: 0, pendingShareSync: false });
  });

  it('clears pending mirror state only after explicit share success', () => {
    const original = createTask({ title: '买菜' }, () => 'task-1', now);
    const synced = markTaskShareSynced(original, now);
    expect(original.pendingShareSync).toBe(true);
    expect(synced.pendingShareSync).toBe(false);
  });
});
