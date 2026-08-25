export const MAX_BODY_BYTES = 32 * 1024;

export class HttpError extends Error {
  constructor(status, code, message = code, details = undefined) {
    super(message);
    this.name = "HttpError";
    this.status = status;
    this.code = code;
    this.details = details;
  }
}

export function fail(status, code, message = code, details = undefined) {
  throw new HttpError(status, code, message, details);
}

export function assert(condition, status, code, message = code, details = undefined) {
  if (!condition) fail(status, code, message, details);
}

export function asObject(value) {
  assert(value && typeof value === "object" && !Array.isArray(value), 400, "invalid_json", "Request body must be a JSON object");
  return value;
}

export function stringField(value, name, { required = true, max = 256, allowNewlines = false } = {}) {
  if (value === undefined || value === null) {
    if (required) fail(400, "invalid_input", `${name} is required`);
    return null;
  }
  assert(typeof value === "string", 400, "invalid_input", `${name} must be a string`);
  assert(value.length <= max, 413, "input_too_large", `${name} is too long`);
  const controlPattern = allowNewlines ? /[\u0000-\u0008\u000B\u000C\u000E-\u001F\u007F]/ : /[\u0000-\u001F\u007F]/;
  assert(!controlPattern.test(value), 400, "invalid_input", `${name} contains unsupported control characters`);
  if (required) assert(value.trim().length > 0, 400, "invalid_input", `${name} cannot be empty`);
  return value;
}

export function optionalString(value, name, options = {}) {
  return stringField(value, name, { ...options, required: false });
}

export function identifier(value, name) {
  const result = stringField(value, name, { max: 128 });
  assert(/^[A-Za-z0-9][A-Za-z0-9_-]{0,127}$/.test(result), 400, "invalid_input", `${name} has an invalid format`);
  return result;
}

export function token(value, name = "token") {
  const result = stringField(value, name, { max: 256 });
  assert(/^[A-Za-z0-9_-]{32,256}$/.test(result), 400, "invalid_input", `${name} has an invalid format`);
  return result;
}

export function isoDateTime(value, name, { required = true } = {}) {
  if (value === undefined || value === null || value === "") {
    if (required) fail(400, "invalid_input", `${name} is required`);
    return null;
  }
  const result = stringField(value, name, { max: 40 });
  assert(/^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2}(?:\.\d{1,3})?Z$/.test(result), 400, "invalid_input", `${name} must be an ISO UTC timestamp`);
  assert(!Number.isNaN(Date.parse(result)), 400, "invalid_input", `${name} is not a valid timestamp`);
  return result;
}

export function calendarDate(value, name, { required = false } = {}) {
  if (value === undefined || value === null || value === "") {
    if (required) fail(400, "invalid_input", `${name} is required`);
    return null;
  }
  const result = stringField(value, name, { max: 10 });
  assert(/^\d{4}-\d{2}-\d{2}$/.test(result), 400, "invalid_input", `${name} must be YYYY-MM-DD`);
  const date = new Date(`${result}T00:00:00.000Z`);
  assert(date.toISOString().slice(0, 10) === result, 400, "invalid_input", `${name} is not a valid calendar date`);
  return result;
}

export function integer(value, name, { min = 0, max = Number.MAX_SAFE_INTEGER, required = true } = {}) {
  if (value === undefined || value === null) {
    if (required) fail(400, "invalid_input", `${name} is required`);
    return null;
  }
  assert(Number.isInteger(value), 400, "invalid_input", `${name} must be an integer`);
  assert(value >= min && value <= max, 400, "invalid_input", `${name} is out of range`);
  return value;
}

export function enumValue(value, name, choices, { required = true } = {}) {
  if (value === undefined || value === null) {
    if (required) fail(400, "invalid_input", `${name} is required`);
    return null;
  }
  assert(typeof value === "string" && choices.includes(value), 400, "invalid_input", `${name} is invalid`);
  return value;
}

export function base64Url(bytes) {
  let binary = "";
  for (const byte of bytes) binary += String.fromCharCode(byte);
  return btoa(binary).replace(/\+/g, "-").replace(/\//g, "_").replace(/=+$/g, "");
}

export function randomToken(bytes = 32) {
  assert(Number.isInteger(bytes) && bytes >= 16 && bytes <= 128, 500, "configuration_error", "Invalid token size");
  const buffer = new Uint8Array(bytes);
  crypto.getRandomValues(buffer);
  return base64Url(buffer);
}

export function bytesToHex(bytes) {
  return Array.from(bytes, (value) => value.toString(16).padStart(2, "0")).join("");
}

export async function sha256Hex(value) {
  const digest = await crypto.subtle.digest("SHA-256", new TextEncoder().encode(value));
  return bytesToHex(new Uint8Array(digest));
}

export async function readJson(request) {
  const contentType = String(request.headers.get("content-type") || "").split(";", 1)[0].trim().toLowerCase();
  if (request.body && contentType !== "application/json") {
    fail(415, "unsupported_media_type", "Content-Type must be application/json");
  }
  const contentLength = request.headers.get("content-length");
  if (contentLength !== null && (!/^\d+$/.test(contentLength) || Number(contentLength) > MAX_BODY_BYTES)) {
    fail(413, "request_too_large", "Request body is too large");
  }

  if (!request.body) return {};
  const reader = request.body.getReader();
  const chunks = [];
  let total = 0;
  while (true) {
    const { done, value } = await reader.read();
    if (done) break;
    total += value.byteLength;
    if (total > MAX_BODY_BYTES) fail(413, "request_too_large", "Request body is too large");
    chunks.push(value);
  }
  const bytes = new Uint8Array(total);
  let offset = 0;
  for (const chunk of chunks) {
    bytes.set(chunk, offset);
    offset += chunk.byteLength;
  }
  const text = new TextDecoder().decode(bytes);
  if (!text.trim()) return {};
  try {
    return asObject(JSON.parse(text));
  } catch (error) {
    if (error instanceof HttpError) throw error;
    fail(400, "invalid_json", "Request body is not valid JSON");
  }
}

export function nowIso(now = new Date()) {
  return now.toISOString();
}

export function normalizeTaskInput(body, { partial = false } = {}) {
  const result = {};
  if (!partial || body.taskId !== undefined) result.taskId = identifier(body.taskId, "taskId");
  if (!partial || body.title !== undefined) result.title = stringField(body.title, "title", { max: 40 });
  if (body.description !== undefined || !partial) result.description = stringField(body.description ?? "", "description", { max: 120, allowNewlines: true });
  if (body.emoji !== undefined || !partial) result.emoji = stringField(body.emoji ?? "🌱", "emoji", { max: 16 });
  if (body.startDate !== undefined || !partial) result.startDate = calendarDate(body.startDate, "startDate");
  if (body.dueDate !== undefined || !partial) result.dueDate = calendarDate(body.dueDate, "dueDate");
  if (result.startDate && result.dueDate && result.dueDate < result.startDate) {
    fail(400, "invalid_input", "dueDate cannot be before startDate");
  }
  if (!partial || body.status !== undefined) result.status = enumValue(body.status ?? "open", "status", ["open", "completed", "deleted"]);
  if (!partial || body.createdAt !== undefined) result.createdAt = isoDateTime(body.createdAt, "createdAt");
  if (!partial || body.updatedAt !== undefined) result.updatedAt = isoDateTime(body.updatedAt, "updatedAt");
  if (!partial || body.ownerRole !== undefined) result.ownerRole = stringField(body.ownerRole ?? "我", "ownerRole", { max: 32 });
  if (!partial || body.revision !== undefined) result.revision = integer(body.revision ?? 0, "revision");
  if (body.reminderMode !== undefined || !partial) {
    const requestedMode = body.reminderMode === "off" ? "none" : body.reminderMode;
    result.reminderMode = enumValue(requestedMode ?? "none", "reminderMode", ["none", "default", "custom"]);
  }
  if (body.reminderAt !== undefined || !partial) result.reminderAt = isoDateTime(body.reminderAt, "reminderAt", { required: false });
  if (body.overdueAt !== undefined || !partial) result.overdueAt = isoDateTime(body.overdueAt, "overdueAt", { required: false });
  if (result.overdueAt === null && result.dueDate) {
    // Older clients can omit the absolute boundary; use UTC end-of-day until
    // they start sending their local-time boundary explicitly.
    result.overdueAt = new Date(`${result.dueDate}T23:59:59.999Z`).toISOString();
  }
  if (result.reminderMode === "none") result.reminderAt = null;
  if (result.reminderMode !== "none" && result.reminderAt === null) {
    fail(400, "invalid_input", "reminderAt is required when reminders are enabled");
  }
  return result;
}
