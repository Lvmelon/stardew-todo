import { rawPayload, sendPushNotification, WebPushError } from "@mmmike/web-push/send";
import { nowIso } from "./validation.js";

const CLAIM_LEASE_MS = 5 * 60 * 1000;

function changed(result) {
  return Number(result?.meta?.changes ?? result?.changes ?? 0);
}

function vapidConfig(env) {
  return {
    subject: env.VAPID_SUBJECT,
    publicKey: env.VAPID_PUBLIC_KEY,
    privateKey: env.VAPID_PRIVATE_KEY,
  };
}

export async function sendWebPush(subscription, message, env) {
  try {
    const delivered = await sendPushNotification(
      {
        endpoint: subscription.endpoint,
        expirationTime: subscription.expiration_time === null ? null : Number(subscription.expiration_time),
        keys: { p256dh: subscription.p256dh, auth: subscription.auth },
      },
      rawPayload(JSON.stringify(message)),
      vapidConfig(env),
      { ttl: 86_400, urgency: "normal" },
    );
    return new Response(null, { status: delivered ? 201 : 410 });
  } catch (error) {
    if (error instanceof WebPushError) {
      return new Response(null, { status: error.statusCode });
    }
    throw error;
  }
}

function beforeIso(now, milliseconds) {
  return new Date(now.getTime() - milliseconds).toISOString();
}

function isSuccess(response) {
  const status = Number(response?.status);
  return response?.ok === true || (status >= 200 && status < 300);
}

async function claimTask(db, task, field, timestamp, expiredBefore) {
  const result = await db
    .prepare(
      `UPDATE tasks SET ${field} = ?
       WHERE space_id = ? AND task_id = ? AND status = 'open'
         AND ${field.replace("claimed", "sent")} IS NULL
         AND (${field} IS NULL OR ${field} < ?)`,
    )
    .bind(timestamp, task.space_id, task.task_id, expiredBefore)
    .run();
  return changed(result) > 0;
}

async function releaseClaim(db, task, claimField, sentField, timestamp) {
  await db
    .prepare(
      `UPDATE tasks SET ${claimField} = NULL
       WHERE space_id = ? AND task_id = ? AND ${claimField} = ? AND ${sentField} IS NULL`,
    )
    .bind(task.space_id, task.task_id, timestamp)
    .run();
}

async function markSent(db, task, claimField, sentField, timestamp) {
  const result = await db
    .prepare(
      `UPDATE tasks SET ${sentField} = ?, ${claimField} = NULL
       WHERE space_id = ? AND task_id = ? AND ${claimField} = ? AND ${sentField} IS NULL`,
    )
    .bind(timestamp, task.space_id, task.task_id, timestamp)
    .run();
  return changed(result) > 0;
}

async function subscriptionsFor(db, spaceId, ownerRole) {
  const result = await db
    .prepare(
      `SELECT p.subscription_id, p.endpoint, p.p256dh, p.auth, p.expiration_time
       FROM push_subscriptions p
       INNER JOIN devices d ON d.device_id = p.device_id AND d.space_id = p.space_id
       WHERE p.space_id = ? AND d.role = ?`,
    )
    .bind(spaceId, ownerRole)
    .all();
  return result.results ?? [];
}

async function deliver(db, env, task, kind, timestamp, expiredBefore, pushSender) {
  const sentField = kind === "overdue" ? "overdue_reminder_sent_at" : "reminder_sent_at";
  const claimField = kind === "overdue" ? "overdue_reminder_claimed_at" : "reminder_claimed_at";
  const claimed = await claimTask(db, task, claimField, timestamp, expiredBefore);
  if (!claimed) return { claimed: false, sent: 0, failed: 0, removed: 0 };

  const subscriptions = await subscriptionsFor(db, task.space_id, task.owner_role);
  if (!subscriptions.length) {
    await releaseClaim(db, task, claimField, sentField, timestamp);
    return { claimed: false, sent: 0, failed: 0, removed: 0, released: true };
  }
  const deliveryId = `stardew-todo:${kind}:${task.space_id}:${task.task_id}`;
  const tag = `stardew-todo-${kind}-${task.task_id}`;
  const message = kind === "overdue"
    ? {
        title: "今日任务",
        body: `「${task.title}」还没有完成`,
        taskId: task.task_id,
        type: "overdue",
        deliveryId,
        tag,
      }
    : {
        title: "今日任务提醒",
        body: `提醒：记得完成「${task.title}」`,
        taskId: task.task_id,
        type: "reminder",
        deliveryId,
        tag,
      };
  let sent = 0;
  let failed = 0;
  let removed = 0;
  await Promise.all(
    subscriptions.map(async (subscription) => {
      try {
        const response = await pushSender(subscription, message, env);
        if (response.status === 404 || response.status === 410) {
          await db.prepare("DELETE FROM push_subscriptions WHERE subscription_id = ?").bind(subscription.subscription_id).run();
          removed += 1;
        } else if (isSuccess(response)) {
          sent += 1;
        } else {
          failed += 1;
        }
      } catch {
        failed += 1;
      }
    }),
  );
  if (sent > 0) {
    await markSent(db, task, claimField, sentField, timestamp);
    return { claimed: true, sent, failed, removed };
  }
  await releaseClaim(db, task, claimField, sentField, timestamp);
  return { claimed: false, sent: 0, failed, removed, released: true };
}

export async function runReminderSweep(env, now = new Date(), pushSender = sendWebPush) {
  if (!env?.DB) return { skipped: "database_unavailable", reminders: 0, overdue: 0 };
  if (pushSender === sendWebPush && !(env.VAPID_SUBJECT && env.VAPID_PUBLIC_KEY && env.VAPID_PRIVATE_KEY)) {
    return { skipped: "vapid_not_configured", reminders: 0, overdue: 0 };
  }
  const db = env.DB;
  const timestamp = nowIso(now);
  const expiredBefore = beforeIso(now, CLAIM_LEASE_MS);
  const [reminders, overdue] = await Promise.all([
    db
      .prepare(
        `SELECT space_id, task_id, title, owner_role
         FROM tasks
         WHERE status = 'open'
           AND reminder_at IS NOT NULL
           AND reminder_at <= ?
           AND reminder_sent_at IS NULL
           AND (overdue_at IS NULL OR overdue_at > ?)
           AND (reminder_claimed_at IS NULL OR reminder_claimed_at < ?)
         ORDER BY reminder_at
         LIMIT 100`,
      )
      .bind(timestamp, timestamp, expiredBefore)
      .all(),
    db
      .prepare(
        `SELECT space_id, task_id, title, owner_role
         FROM tasks
         WHERE status = 'open'
           AND overdue_at IS NOT NULL
           AND overdue_at <= ?
           AND overdue_reminder_sent_at IS NULL
           AND (overdue_reminder_claimed_at IS NULL OR overdue_reminder_claimed_at < ?)
         ORDER BY overdue_at
         LIMIT 100`,
      )
      .bind(timestamp, expiredBefore)
      .all(),
  ]);

  const reminderResults = await Promise.all((reminders.results ?? []).map((task) => deliver(db, env, task, "reminder", timestamp, expiredBefore, pushSender)));
  const overdueResults = await Promise.all((overdue.results ?? []).map((task) => deliver(db, env, task, "overdue", timestamp, expiredBefore, pushSender)));
  return {
    reminders: reminderResults.filter((result) => result.claimed).length,
    overdue: overdueResults.filter((result) => result.claimed).length,
    sent: [...reminderResults, ...overdueResults].reduce((sum, result) => sum + result.sent, 0),
    failed: [...reminderResults, ...overdueResults].reduce((sum, result) => sum + result.failed, 0),
    removed: [...reminderResults, ...overdueResults].reduce((sum, result) => sum + result.removed, 0),
  };
}

export async function sendTestPush(env, auth, pushSender = sendWebPush) {
  if (!env?.DB) return { sent: 0, skipped: "database_unavailable" };
  if (pushSender === sendWebPush && !(env.VAPID_SUBJECT && env.VAPID_PUBLIC_KEY && env.VAPID_PRIVATE_KEY)) {
    return { sent: 0, skipped: "vapid_not_configured" };
  }
  const result = await env.DB
    .prepare(
      `SELECT subscription_id, endpoint, p256dh, auth, expiration_time
       FROM push_subscriptions
       WHERE space_id = ? AND device_id = ?`,
    )
    .bind(auth.spaceId, auth.deviceId)
    .all();
  const message = {
    title: "今日任务",
    body: "通知已经准备好了。",
    type: "test",
    deliveryId: `stardew-todo:test:${auth.spaceId}:${auth.deviceId}`,
    tag: `stardew-todo-test-${auth.deviceId}`,
  };
  let sent = 0;
  let removed = 0;
  await Promise.all(
    (result.results ?? []).map(async (subscription) => {
      const response = await pushSender(subscription, message, env);
      if (response.status === 404 || response.status === 410) {
        await env.DB.prepare("DELETE FROM push_subscriptions WHERE subscription_id = ?").bind(subscription.subscription_id).run();
        removed += 1;
      } else if (isSuccess(response)) {
        sent += 1;
      }
    }),
  );
  return { sent, removed };
}
