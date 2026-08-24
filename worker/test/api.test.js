import { env } from "cloudflare:workers";
import { createExecutionContext, waitOnExecutionContext } from "cloudflare:test";
import { describe, expect, it } from "vitest";
import worker from "../src/index.js";
import { runReminderSweep } from "../src/push.js";

const ORIGIN = "https://lvmelon.github.io";

async function call(path, { method = "GET", body, token: accessToken, origin = ORIGIN, contentType = "application/json" } = {}) {
  const headers = new Headers({ Origin: origin });
  if (body !== undefined) headers.set("Content-Type", contentType);
  if (accessToken) headers.set("Authorization", `Bearer ${accessToken}`);
  const request = new Request(`https://worker.example.test${path}`, {
    method,
    headers,
    body: body === undefined ? undefined : JSON.stringify(body),
  });
  const context = createExecutionContext();
  const response = await worker.fetch(request, env, context);
  try {
    await waitOnExecutionContext(context);
  } catch {
    // Expected route errors are converted to HTTP responses by the Worker.
  }
  let data = null;
  try {
    data = await response.json();
  } catch {
    // OPTIONS has no body.
  }
  return { response, data };
}

describe("shared mirror API", () => {
  it("supports pairing, role-owned mirror writes, comments, CORS, and reminders", async () => {
    const created = await call("/v1/spaces", { method: "POST", body: { displayName: "我" } });
    expect(created.response.status).toBe(200);
    expect(created.data.accessToken).toMatch(/^[A-Za-z0-9_-]{43}$/);
    expect(created.data.pairingToken).toMatch(/^[A-Za-z0-9_-]{43}$/);
    expect(created.data.recoveryCode).toMatch(/^[A-Za-z0-9_-]{43}$/);

    const storedSpace = await env.DB.prepare("SELECT * FROM spaces WHERE space_id = ?").bind(created.data.spaceId).first();
    expect(storedSpace.pairing_secret_hash).toMatch(/^[0-9a-f]{64}$/);
    expect(storedSpace.recovery_secret_hash).toMatch(/^[0-9a-f]{64}$/);
    expect(storedSpace.pairing_secret_hash).not.toBe(created.data.pairingToken);
    expect(storedSpace.recovery_secret_hash).not.toBe(created.data.recoveryCode);

    const joined = await call(`/v1/spaces/${created.data.spaceId}/join`, {
      method: "POST",
      body: { pairingToken: created.data.pairingToken, displayName: "她" },
    });
    expect(joined.response.status).toBe(200);
    expect(joined.data.role).toBe("partner");

    const task = {
      taskId: "task-pickup",
      title: "取快递",
      description: "下班路上带回来",
      emoji: "📦",
      dueDate: "2026-08-24",
      status: "open",
      createdAt: "2026-08-25T09:00:00.000Z",
      updatedAt: "2026-08-25T09:00:00.000Z",
      ownerRole: "partner-spoof",
      revision: 1,
      reminderMode: "custom",
      reminderAt: "2026-08-25T10:00:00.000Z",
      overdueAt: "2026-08-24T16:00:00.000Z",
    };
    const mirrored = await call(`/v1/spaces/${created.data.spaceId}/tasks`, {
      method: "POST",
      token: created.data.accessToken,
      body: task,
    });
    expect(mirrored.response.status).toBe(200);
    expect(mirrored.data.accepted).toBe(true);
    expect(mirrored.data.task.title).toBe("取快递");

    const partnerTasks = await call(`/v1/spaces/${created.data.spaceId}/tasks`, { token: joined.data.accessToken });
    expect(partnerTasks.response.status).toBe(200);
    expect(partnerTasks.data).toHaveLength(1);
    expect(partnerTasks.data[0].status).toBe("open");

    const forbidden = await call(`/v1/spaces/${created.data.spaceId}/tasks/${task.taskId}`, {
      method: "PUT",
      token: joined.data.accessToken,
      body: { ...task, title: "不应被修改", revision: 2 },
    });
    expect(forbidden.response.status).toBe(403);

    const stale = await call(`/v1/spaces/${created.data.spaceId}/tasks/${task.taskId}`, {
      method: "PUT",
      token: created.data.accessToken,
      body: { ...task, title: "旧版本", revision: 0 },
    });
    expect(stale.response.status).toBe(200);
    expect(stale.data.accepted).toBe(false);
    expect(stale.data.stale).toBe(true);
    expect(stale.data.task.title).toBe("取快递");

    const partnerTask = {
      ...task,
      taskId: "partner-task",
      title: "她的委托",
      ownerRole: "owner",
      revision: 1,
      reminderMode: "none",
      reminderAt: null,
      dueDate: null,
      overdueAt: null,
    };
    const partnerMirror = await call(`/v1/spaces/${created.data.spaceId}/tasks`, {
      method: "POST",
      token: joined.data.accessToken,
      body: partnerTask,
    });
    expect(partnerMirror.response.status).toBe(200);
    expect(partnerMirror.data.accepted).toBe(true);
    expect(partnerMirror.data.task.ownerRole).toBe("partner");
    const partnerUpdate = await call(`/v1/spaces/${created.data.spaceId}/tasks/${partnerTask.taskId}`, {
      method: "PUT",
      token: joined.data.accessToken,
      body: { ...partnerTask, title: "她的委托（更新）", revision: 2 },
    });
    expect(partnerUpdate.response.status).toBe(200);
    expect(partnerUpdate.data.accepted).toBe(true);
    const ownerCannotChangePartner = await call(`/v1/spaces/${created.data.spaceId}/tasks/${partnerTask.taskId}`, {
      method: "PUT",
      token: created.data.accessToken,
      body: { ...partnerTask, title: "不应被修改", revision: 3 },
    });
    expect(ownerCannotChangePartner.response.status).toBe(403);

    const comment = await call(`/v1/spaces/${created.data.spaceId}/tasks/${task.taskId}/comments`, {
      method: "POST",
      token: joined.data.accessToken,
      body: { commentId: "comment-1", content: "下班记得去拿哦" },
    });
    expect(comment.response.status).toBe(200);
    expect(comment.data.comment.authorRole).toBe("partner");
    expect(comment.data.comment.authorLabel).toBe("她");
    const comments = await call(`/v1/spaces/${created.data.spaceId}/tasks/${task.taskId}/comments`, {
      token: created.data.accessToken,
    });
    expect(comments.data).toHaveLength(1);
    const subscription = await call(`/v1/spaces/${created.data.spaceId}/push-subscriptions`, {
      method: "POST",
      token: created.data.accessToken,
      body: {
        endpoint: "https://push.example.test/subscription-1",
        keys: { p256dh: "p256dh-test", auth: "auth-test" },
      },
    });
    expect(subscription.response.status).toBe(200);
    const partnerSubscription = await call(`/v1/spaces/${created.data.spaceId}/push-subscriptions`, {
      method: "POST",
      token: joined.data.accessToken,
      body: {
        endpoint: "https://push.example.test/subscription-2",
        keys: { p256dh: "p256dh-test-2", auth: "auth-test-2" },
      },
    });
    expect(partnerSubscription.response.status).toBe(200);
    const pushTest = await call(`/v1/spaces/${created.data.spaceId}/push-test`, {
      method: "POST",
      token: created.data.accessToken,
      body: {},
    });
    expect(pushTest.response.status).toBe(200);
    expect(pushTest.data.skipped).toBe("vapid_not_configured");

    for (const status of ["completed", "deleted"]) {
      const inactiveMirror = await call(`/v1/spaces/${created.data.spaceId}/tasks`, {
        method: "POST",
        token: created.data.accessToken,
        body: { ...task, taskId: `${status}-task`, title: `${status} 不应提醒`, status, revision: 1 },
      });
      expect(inactiveMirror.response.status).toBe(200);
    }

    const sent = [];
    const firstSweep = await runReminderSweep(
      env,
      new Date("2026-08-25T12:00:00.000Z"),
      async (target, message) => {
        sent.push({ target: target.endpoint, message });
        return new Response(null, { status: 201 });
      },
    );
    expect(firstSweep.reminders).toBe(0);
    expect(firstSweep.overdue).toBe(1);
    expect(sent).toHaveLength(1);
    expect(sent[0].message.type).toBe("overdue");
    expect(sent.every(({ message }) => message.deliveryId && message.tag)).toBe(true);
    const secondSweep = await runReminderSweep(
      env,
      new Date("2026-08-25T12:01:00.000Z"),
      async () => new Response(null, { status: 201 }),
    );
    expect(secondSweep.reminders).toBe(0);
    expect(secondSweep.overdue).toBe(0);

    const indexes = await env.DB.prepare("PRAGMA index_list('tasks')").all();
    const indexNames = indexes.results.map((row) => row.name);
    expect(indexNames).toContain("idx_tasks_reminder_due");
    expect(indexNames).toContain("idx_tasks_overdue_at");

    const removePartnerSubscription = await call(`/v1/spaces/${created.data.spaceId}/push-subscriptions`, {
      method: "DELETE",
      token: joined.data.accessToken,
      body: { endpoint: "https://push.example.test/subscription-2" },
    });
    expect(removePartnerSubscription.data.deleted).toBe(true);
    const noSubscriptionTask = {
      ...task,
      taskId: "no-sub-task",
      title: "没有订阅的任务",
      dueDate: null,
      overdueAt: null,
      reminderAt: "2026-08-25T11:00:00.000Z",
      reminderMode: "custom",
      revision: 1,
    };
    await call(`/v1/spaces/${created.data.spaceId}/tasks`, {
      method: "POST",
      token: joined.data.accessToken,
      body: noSubscriptionTask,
    });
    const noSubscriptionSweep = await runReminderSweep(
      env,
      new Date("2026-08-25T12:02:00.000Z"),
      async () => { throw new Error("must not send without a subscription"); },
    );
    expect(noSubscriptionSweep.reminders).toBe(0);
    const noSubscriptionRow = await env.DB
      .prepare("SELECT reminder_sent_at, reminder_claimed_at FROM tasks WHERE space_id = ? AND task_id = ?")
      .bind(created.data.spaceId, "no-sub-task")
      .first();
    expect(noSubscriptionRow.reminder_sent_at).toBeNull();
    expect(noSubscriptionRow.reminder_claimed_at).toBeNull();

    const retryTask = {
      ...task,
      taskId: "retry-task",
      title: "稍后重试的任务",
      dueDate: null,
      overdueAt: null,
      reminderAt: "2026-08-25T11:00:00.000Z",
      reminderMode: "custom",
      revision: 1,
    };
    await call(`/v1/spaces/${created.data.spaceId}/tasks`, {
      method: "POST",
      token: created.data.accessToken,
      body: retryTask,
    });
    const failedSweep = await runReminderSweep(
      env,
      new Date("2026-08-25T12:03:00.000Z"),
      async () => new Response(null, { status: 503 }),
    );
    expect(failedSweep.reminders).toBe(0);
    const failedRow = await env.DB
      .prepare("SELECT reminder_sent_at, reminder_claimed_at FROM tasks WHERE space_id = ? AND task_id = ?")
      .bind(created.data.spaceId, "retry-task")
      .first();
    expect(failedRow.reminder_sent_at).toBeNull();
    expect(failedRow.reminder_claimed_at).toBeNull();
    const retrySweep = await runReminderSweep(
      env,
      new Date("2026-08-25T12:04:00.000Z"),
      async () => new Response(null, { status: 201 }),
    );
    expect(retrySweep.reminders).toBe(1);
    const retryRow = await env.DB
      .prepare("SELECT reminder_sent_at, reminder_claimed_at FROM tasks WHERE space_id = ? AND task_id = ?")
      .bind(created.data.spaceId, "retry-task")
      .first();
    expect(retryRow.reminder_sent_at).not.toBeNull();
    expect(retryRow.reminder_claimed_at).toBeNull();

    const claimTask = {
      ...retryTask,
      taskId: "claim-task",
      title: "并发领取的任务",
      revision: 1,
    };
    await call(`/v1/spaces/${created.data.spaceId}/tasks`, {
      method: "POST",
      token: created.data.accessToken,
      body: claimTask,
    });
    let releaseSlow;
    const slowDelivery = new Promise((resolve) => { releaseSlow = resolve; });
    const firstClaim = runReminderSweep(
      env,
      new Date("2026-08-25T12:05:00.000Z"),
      async () => slowDelivery.then(() => new Response(null, { status: 201 })),
    );
    for (let attempt = 0; attempt < 20; attempt += 1) {
      const row = await env.DB
        .prepare("SELECT reminder_claimed_at FROM tasks WHERE space_id = ? AND task_id = ?")
        .bind(created.data.spaceId, "claim-task")
        .first();
      if (row?.reminder_claimed_at) break;
      await new Promise((resolve) => setTimeout(resolve, 5));
    }
    const duplicateClaim = await runReminderSweep(
      env,
      new Date("2026-08-25T12:05:00.000Z"),
      async () => new Response(null, { status: 201 }),
    );
    expect(duplicateClaim.reminders).toBe(0);
    releaseSlow();
    expect((await firstClaim).reminders).toBe(1);

    const preflight = await call("/v1/config", { method: "OPTIONS" });
    expect(preflight.response.status).toBe(204);
    expect(preflight.response.headers.get("Access-Control-Allow-Origin")).toBe(ORIGIN);
    const rejectedOrigin = await call("/v1/config", { origin: "https://not-allowed.example" });
    expect(rejectedOrigin.response.status).toBe(403);
    expect(rejectedOrigin.response.headers.get("Access-Control-Allow-Origin")).toBeNull();
    const unsupportedContentType = await call("/v1/spaces", {
      method: "POST",
      body: { displayName: "不应创建" },
      contentType: "text/plain",
    });
    expect(unsupportedContentType.response.status).toBe(415);
  });
});
