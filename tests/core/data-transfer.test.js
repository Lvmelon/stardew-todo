import { describe, expect, it } from 'vitest';
import {
  BACKUP_TYPE,
  ImportValidationError,
  buildExportPayload,
  mergeImport,
  parseImport,
  readImportSource,
  replaceImport,
  summarizeImport,
} from '../../data-transfer.js';

const task = {
  id: 'task-1', title: '取快递', description: '', emoji: '📦', startDate: '2026-08-25', dueDate: '', status: 'open',
  createdAt: '2026-08-25T00:00:00.000Z', updatedAt: '2026-08-25T00:00:00.000Z',
};

function payload(tasks = [task]) {
  return JSON.stringify(buildExportPayload({ tasks, sharedTasks: [], comments: [], settings: {} }, { pretty: false }));
}

describe('strict JSON backup transfer', () => {
  it('reads a browser File-like source before treating it as a plain object', async () => {
    const expected = payload();
    const source = { text: async () => expected };
    expect(await readImportSource(source)).toBe(expected);
  });

  it('exports a credential-free schema and summarizes task counts', () => {
    const parsed = JSON.parse(payload());
    expect(parsed.type).toBe(BACKUP_TYPE);
    expect(parsed).not.toHaveProperty('meta');
    expect(summarizeImport(parsed, new Date(2026, 7, 25))).toMatchObject({ taskCount: 1, openCount: 1, anytimeCount: 1 });
  });

  it('exports cached Worker comments in a form that can be imported again', () => {
    const exported = buildExportPayload({
      tasks: [task],
      sharedTasks: [],
      comments: [{
        commentId: 'comment-1', taskId: 'task-1', spaceId: 'space-1', authorRole: 'partner',
        authorName: '她', content: '收到～', createdAt: '2026-08-25T01:00:00.000Z',
      }],
      settings: {},
    }, { pretty: false });
    expect(() => parseImport(exported)).not.toThrow();
    expect(exported.comments[0]).toMatchObject({ authorLabel: '她', content: '收到～' });
    expect(exported.comments[0]).not.toHaveProperty('authorName');
  });

  it('rejects unknown fields and malformed JSON', () => {
    expect(() => parseImport('{')).toThrow(ImportValidationError);
    const invalid = JSON.parse(payload());
    invalid.untrusted = true;
    expect(() => parseImport(invalid)).toThrow(ImportValidationError);
  });

  it('merges records by id without dropping newer local data', () => {
    const local = { tasks: [{ ...task, title: '本机标题', updatedAt: '2026-08-25T12:00:00.000Z' }], sharedTasks: [], comments: [], settings: {} };
    const incoming = JSON.parse(payload([{ ...task, title: '旧标题', updatedAt: '2026-08-25T11:00:00.000Z' }]));
    expect(mergeImport(local, incoming).tasks[0].title).toBe('本机标题');
  });

  it('replace mode returns only imported records', () => {
    const incoming = JSON.parse(payload());
    const result = replaceImport({ tasks: [{ ...task, id: 'old' }] }, incoming);
    expect(result.tasks.map(item => item.id)).toEqual(['task-1']);
  });

  it('rejects imports over one megabyte', () => {
    const incoming = JSON.parse(payload());
    incoming.tasks[0].description = '字'.repeat(600000);
    expect(() => parseImport(JSON.stringify(incoming))).toThrow(ImportValidationError);
  });
});
