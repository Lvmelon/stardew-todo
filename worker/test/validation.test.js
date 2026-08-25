import { describe, expect, it } from "vitest";
import { normalizeTaskInput, stringField } from "../src/validation.js";

describe("Worker input limits", () => {
  it("keeps task and comment text within the lightweight UI contract", () => {
    const base = {
      taskId: "task-1",
      title: "正常标题",
      description: "正常描述",
      emoji: "📌",
      startDate: "2026-08-25",
      dueDate: null,
      status: "open",
      createdAt: "2026-08-25T00:00:00.000Z",
      updatedAt: "2026-08-25T00:00:00.000Z",
      ownerRole: "owner",
      revision: 1,
      reminderMode: "none",
      reminderAt: null,
      overdueAt: null,
    };
    expect(() => normalizeTaskInput({ ...base, title: "字".repeat(41) })).toThrow("title is too long");
    expect(() => normalizeTaskInput({ ...base, description: "字".repeat(121) })).toThrow("description is too long");
    expect(() => normalizeTaskInput({ ...base, startDate: "2026-08-30", dueDate: "2026-08-29" })).toThrow("dueDate cannot be before startDate");
    expect(() => stringField("字".repeat(501), "content", { max: 500, allowNewlines: true })).toThrow("content is too long");
  });
});
