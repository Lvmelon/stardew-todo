import {
  HttpError,
  assert,
  identifier,
  integer,
  isoDateTime,
  normalizeTaskInput,
  nowIso,
  randomToken,
  sha256Hex,
  stringField,
  token,
} from "./validation.js";

function database(env) {
  if (!env?.DB) throw new HttpError(503, "database_unavailable", "Shared space is temporarily unavailable");
  return env.DB;
}

function changed(result) {
  return Number(result?.meta?.changes ?? result?.changes ?? 0);
}

function taskFromRow(row) {
  if (!row) return null;
  return {
    taskId: row.task_id,
    spaceId: row.space_id,
    title: row.title,
    description: row.description,
    emoji: row.emoji,
    dueDate: row.due_date,
    status: row.status,
    createdAt: row.created_at,
    updatedAt: row.updated_at,
    ownerRole: row.owner_role,
    revision: Number(row.revision),
    reminderMode: row.reminder_mode,
    reminderAt: row.reminder_at,
    overdueAt: row.overdue_at,
    reminderSentAt: row.reminder_sent_at,
    overdueReminderSentAt: row.overdue_reminder_sent_at,
  };
}

function commentFromRow(row) {
  return {
    commentId: row.comment_id,
    taskId: row.task_id,
    spaceId: row.space_id,
    authorRole: row.author_role,
    authorLabel: row.author_label || "",
    authorName: row.author_label || "",
    content: row.content,
    createdAt: row.created_at,
  };
}

function subscriptionFromRow(row) {
  return {
    subscriptionId: row.subscription_id,
    endpoint: row.endpoint,
    expirationTime: row.expiration_time === null ? null : Number(row.expiration_time),
  };
}

function bearer(request) {
  const header = request.headers.get("authorization") || "";
  const match = /^Bearer\s+([A-Za-z0-9_-]{32,256})$/.exec(header);
  if (!match) throw new HttpError(401, "unauthorized", "A valid access token is required");
  return match[1];
}

export async function authenticate(request, env, spaceId) {
  const rawToken = bearer(request);
  const hash = await sha256Hex(rawToken);
  const row = await database(env)
    .prepare(
      `SELECT d.device_id, d.space_id, d.role, d.display_name, d.created_at,
              d.last_seen_at
       FROM devices d
       WHERE d.space_id = ? AND d.access_token_hash = ?`,
    )
    .bind(spaceId, hash)
    .first();
  if (!row) throw new HttpError(401, "unauthorized", "A valid access token is required");
  return {
    deviceId: row.device_id,
    spaceId: row.space_id,
    role: row.role,
    displayName: row.display_name,
  };
}

function taskOwnerRequiredResult() {
  return {
    __httpStatus: 403,
    error: "owner_required",
    message: "Only the task owner can change this shared task",
  };
}

export async function createSpace(env, body, now = new Date()) {
  const displayName = stringField(body.displayName ?? "我", "displayName", { max: 32 });
  const spaceId = randomToken(16);
  const deviceId = randomToken(16);
  const accessToken = randomToken(32);
  const pairingToken = randomToken(32);
  const recoveryCode = randomToken(32);
  const createdAt = nowIso(now);
  const db = database(env);
  const statements = [
    db
      .prepare(
        `INSERT INTO spaces
         (space_id, pairing_secret_hash, recovery_secret_hash, created_at, updated_at)
         VALUES (?, ?, ?, ?, ?)`,
      )
      .bind(spaceId, await sha256Hex(pairingToken), await sha256Hex(recoveryCode), createdAt, createdAt),
    db
      .prepare(
        `INSERT INTO devices
         (device_id, space_id, access_token_hash, role, display_name, created_at, last_seen_at)
         VALUES (?, ?, ?, 'owner', ?, ?, ?)`,
      )
      .bind(deviceId, spaceId, await sha256Hex(accessToken), displayName, createdAt, createdAt),
  ];
  if (typeof db.batch === "function") await db.batch(statements);
  else for (const statement of statements) await statement.run();
  return {
    spaceId,
    deviceId,
    role: "owner",
    displayName,
    accessToken,
    pairingToken,
    recoveryCode,
    createdAt,
  };
}

export async function joinSpace(env, spaceId, body, now = new Date()) {
  identifier(spaceId, "spaceId");
  const pairingToken = body.pairingToken === undefined ? null : token(body.pairingToken, "pairingToken");
  const recoveryCode = body.recoveryCode === undefined ? null : token(body.recoveryCode, "recoveryCode");
  assert(pairingToken || recoveryCode, 400, "invalid_input", "pairingToken or recoveryCode is required");
  const displayName = stringField(body.displayName ?? "她", "displayName", { max: 32 });
  const db = database(env);
  const pairingHash = pairingToken ? await sha256Hex(pairingToken) : null;
  const recoveryHash = recoveryCode ? await sha256Hex(recoveryCode) : null;
  const pairRow = pairingHash
    ? await db
        .prepare("SELECT space_id FROM spaces WHERE space_id = ? AND pairing_secret_hash = ?")
        .bind(spaceId, pairingHash)
        .first()
    : null;
  const recoveryRow = !pairRow && recoveryHash
    ? await db
        .prepare("SELECT space_id FROM spaces WHERE space_id = ? AND recovery_secret_hash = ?")
        .bind(spaceId, recoveryHash)
        .first()
    : null;
  const matched = pairRow || recoveryRow;
  if (!matched) throw new HttpError(401, "invalid_pairing", "Pairing or recovery code is not valid");
  const role = pairRow ? "partner" : "owner";
  const deviceId = randomToken(16);
  const accessToken = randomToken(32);
  const timestamp = nowIso(now);
  await db
    .prepare(
      `INSERT INTO devices
       (device_id, space_id, access_token_hash, role, display_name, created_at, last_seen_at)
       VALUES (?, ?, ?, ?, ?, ?, ?)`,
    )
    .bind(deviceId, spaceId, await sha256Hex(accessToken), role, displayName, timestamp, timestamp)
    .run();
  return { spaceId, deviceId, role, displayName, accessToken, joinedAt: timestamp };
}

export async function rotatePairing(env, auth, now = new Date()) {
  if (auth.role !== "owner") return taskOwnerRequiredResult();
  const pairingToken = randomToken(32);
  const recoveryCode = randomToken(32);
  await database(env)
    .prepare(
      `UPDATE spaces
       SET pairing_secret_hash = ?, recovery_secret_hash = ?, updated_at = ?
       WHERE space_id = ?`,
    )
    .bind(await sha256Hex(pairingToken), await sha256Hex(recoveryCode), nowIso(now), auth.spaceId)
    .run();
  return { pairingToken, recoveryCode, rotatedAt: nowIso(now) };
}

export async function getSpace(env, auth) {
  const row = await database(env)
    .prepare(
      `SELECT s.space_id, s.created_at, s.updated_at,
              (SELECT COUNT(*) FROM devices d WHERE d.space_id = s.space_id) AS device_count
       FROM spaces s WHERE s.space_id = ?`,
    )
    .bind(auth.spaceId)
    .first();
  if (!row) throw new HttpError(404, "space_not_found", "Space not found");
  return {
    spaceId: row.space_id,
    createdAt: row.created_at,
    updatedAt: row.updated_at,
    deviceCount: Number(row.device_count),
    currentDevice: { deviceId: auth.deviceId, role: auth.role, displayName: auth.displayName },
  };
}

export async function upsertTask(env, auth, body, taskId = undefined, now = new Date()) {
  if (taskId !== undefined && body.taskId !== undefined && body.taskId !== taskId) {
    throw new HttpError(400, "invalid_input", "taskId does not match the URL");
  }
  // The authenticated device role is the only authoritative owner marker;
  // client-provided labels cannot be used to claim another person's task.
  const normalizedBody = { ...body, taskId: taskId ?? body.taskId, ownerRole: auth.role };
  const task = normalizeTaskInput(normalizedBody);
  const db = database(env);
  const existing = await db
    .prepare("SELECT * FROM tasks WHERE space_id = ? AND task_id = ?")
    .bind(auth.spaceId, task.taskId)
    .first();
  if (existing && existing.owner_role !== auth.role) return taskOwnerRequiredResult();
  if (existing && Number(existing.revision) >= task.revision) {
    return { task: taskFromRow(existing), accepted: false, stale: Number(existing.revision) > task.revision };
  }
  const result = await db
    .prepare(
      `INSERT INTO tasks
       (space_id, task_id, title, description, emoji, due_date, status,
        created_at, updated_at, owner_role, revision, reminder_mode, reminder_at, overdue_at)
       VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
       ON CONFLICT(space_id, task_id) DO UPDATE SET
         title = excluded.title,
         description = excluded.description,
         emoji = excluded.emoji,
         due_date = excluded.due_date,
         status = excluded.status,
         updated_at = excluded.updated_at,
         owner_role = excluded.owner_role,
         revision = excluded.revision,
         reminder_mode = excluded.reminder_mode,
         reminder_at = excluded.reminder_at,
         overdue_at = excluded.overdue_at
       WHERE excluded.revision > tasks.revision`,
    )
    .bind(
      auth.spaceId,
      task.taskId,
      task.title,
      task.description,
      task.emoji,
      task.dueDate,
      task.status,
      task.createdAt,
      task.updatedAt,
      task.ownerRole,
      task.revision,
      task.reminderMode,
      task.reminderAt,
      task.overdueAt,
    )
    .run();
  if (changed(result) === 0) {
    const current = await db.prepare("SELECT * FROM tasks WHERE space_id = ? AND task_id = ?").bind(auth.spaceId, task.taskId).first();
    return { task: taskFromRow(current), accepted: false, stale: true };
  }
  await db
    .prepare("UPDATE spaces SET updated_at = ? WHERE space_id = ?")
    .bind(nowIso(now), auth.spaceId)
    .run();
  const current = await db.prepare("SELECT * FROM tasks WHERE space_id = ? AND task_id = ?").bind(auth.spaceId, task.taskId).first();
  return { task: taskFromRow(current), accepted: true, stale: false };
}

export async function listTasks(env, auth, { includeDeleted = false } = {}) {
  const sql = includeDeleted
    ? `SELECT * FROM tasks WHERE space_id = ? ORDER BY
         CASE status WHEN 'open' THEN 0 WHEN 'completed' THEN 1 ELSE 2 END,
         CASE WHEN due_date IS NULL THEN 1 ELSE 0 END, due_date, created_at`
    : `SELECT * FROM tasks WHERE space_id = ? AND status <> 'deleted' ORDER BY
         CASE status WHEN 'open' THEN 0 ELSE 1 END,
         CASE WHEN due_date IS NULL THEN 1 ELSE 0 END, due_date, created_at`;
  const result = await database(env).prepare(sql).bind(auth.spaceId).all();
  return (result.results ?? []).map(taskFromRow);
}

export async function getTask(env, auth, taskId) {
  const row = await database(env)
    .prepare("SELECT * FROM tasks WHERE space_id = ? AND task_id = ?")
    .bind(auth.spaceId, identifier(taskId, "taskId"))
    .first();
  if (!row) throw new HttpError(404, "task_not_found", "Task not found");
  return taskFromRow(row);
}

export async function listComments(env, auth, taskId) {
  const safeTaskId = identifier(taskId, "taskId");
  const task = await database(env).prepare("SELECT task_id FROM tasks WHERE space_id = ? AND task_id = ?").bind(auth.spaceId, safeTaskId).first();
  if (!task) throw new HttpError(404, "task_not_found", "Task not found");
  const result = await database(env)
    .prepare("SELECT * FROM comments WHERE space_id = ? AND task_id = ? ORDER BY created_at, comment_id")
    .bind(auth.spaceId, safeTaskId)
    .all();
  return (result.results ?? []).map(commentFromRow);
}

export async function addComment(env, auth, taskId, body, now = new Date()) {
  const safeTaskId = identifier(taskId, "taskId");
  const content = stringField(body.content, "content", { max: 500, allowNewlines: true });
  const task = await database(env).prepare("SELECT task_id FROM tasks WHERE space_id = ? AND task_id = ?").bind(auth.spaceId, safeTaskId).first();
  if (!task) throw new HttpError(404, "task_not_found", "Task not found");
  const commentId = body.commentId === undefined ? randomToken(16) : identifier(body.commentId, "commentId");
  const createdAt = nowIso(now);
  const result = await database(env)
    .prepare(
      `INSERT OR IGNORE INTO comments
       (space_id, comment_id, task_id, author_role, author_label, content, created_at)
       VALUES (?, ?, ?, ?, ?, ?, ?)`,
    )
    .bind(auth.spaceId, commentId, safeTaskId, auth.role, auth.displayName, content, createdAt)
    .run();
  const row = await database(env)
    .prepare("SELECT * FROM comments WHERE space_id = ? AND comment_id = ?")
    .bind(auth.spaceId, commentId)
    .first();
  return { comment: commentFromRow(row), created: changed(result) > 0 };
}

function subscriptionInput(body) {
  const nested = body.subscription && typeof body.subscription === "object" ? body.subscription : body;
  const endpoint = stringField(nested.endpoint, "endpoint", { max: 2048 });
  let parsed;
  try {
    parsed = new URL(endpoint);
  } catch {
    throw new HttpError(400, "invalid_input", "endpoint must be a valid HTTPS URL");
  }
  assert(parsed.protocol === "https:", 400, "invalid_input", "endpoint must be a valid HTTPS URL");
  const keys = nested.keys && typeof nested.keys === "object" ? nested.keys : nested;
  const p256dh = stringField(keys.p256dh, "p256dh", { max: 512 });
  const auth = stringField(keys.auth, "auth", { max: 512 });
  const expirationTime = nested.expirationTime === null || nested.expirationTime === undefined
    ? null
    : integer(nested.expirationTime, "expirationTime", { max: Number.MAX_SAFE_INTEGER });
  return { endpoint, p256dh, auth, expirationTime };
}

export async function saveSubscription(env, auth, body, now = new Date()) {
  const input = subscriptionInput(body);
  const subscriptionId = randomToken(16);
  const timestamp = nowIso(now);
  await database(env)
    .prepare(
      `INSERT INTO push_subscriptions
       (subscription_id, space_id, device_id, endpoint, p256dh, auth,
        expiration_time, created_at, updated_at)
       VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?)
       ON CONFLICT(space_id, endpoint) DO UPDATE SET
         device_id = excluded.device_id,
         p256dh = excluded.p256dh,
         auth = excluded.auth,
         expiration_time = excluded.expiration_time,
         updated_at = excluded.updated_at`,
    )
    .bind(subscriptionId, auth.spaceId, auth.deviceId, input.endpoint, input.p256dh, input.auth, input.expirationTime, timestamp, timestamp)
    .run();
  const row = await database(env)
    .prepare("SELECT * FROM push_subscriptions WHERE space_id = ? AND endpoint = ?")
    .bind(auth.spaceId, input.endpoint)
    .first();
  return subscriptionFromRow(row);
}

export async function removeSubscription(env, auth, body) {
  const nested = body.subscription && typeof body.subscription === "object" ? body.subscription : body;
  const endpoint = stringField(nested.endpoint, "endpoint", { max: 2048 });
  let parsed;
  try {
    parsed = new URL(endpoint);
  } catch {
    throw new HttpError(400, "invalid_input", "endpoint must be a valid HTTPS URL");
  }
  assert(parsed.protocol === "https:", 400, "invalid_input", "endpoint must be a valid HTTPS URL");
  const result = await database(env)
    .prepare("DELETE FROM push_subscriptions WHERE space_id = ? AND device_id = ? AND endpoint = ?")
    .bind(auth.spaceId, auth.deviceId, endpoint)
    .run();
  return { deleted: changed(result) > 0 };
}

export async function disconnectDevice(env, auth) {
  const result = await database(env).prepare("DELETE FROM devices WHERE space_id = ? AND device_id = ?").bind(auth.spaceId, auth.deviceId).run();
  return { disconnected: changed(result) > 0 };
}

export { taskFromRow };
