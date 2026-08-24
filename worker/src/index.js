import {
  addComment,
  authenticate,
  createSpace,
  disconnectDevice,
  getSpace,
  getTask,
  joinSpace,
  listComments,
  listTasks,
  removeSubscription,
  rotatePairing,
  saveSubscription,
  upsertTask,
} from "./db.js";
import { runReminderSweep, sendTestPush } from "./push.js";
import { HttpError, identifier, nowIso, readJson } from "./validation.js";

const DEFAULT_ALLOWED_ORIGINS = ["https://lvmelon.github.io"];

function allowedOrigins(env) {
  const value = typeof env?.ALLOWED_ORIGINS === "string" ? env.ALLOWED_ORIGINS : "";
  const origins = value.split(",").map((origin) => origin.trim()).filter(Boolean);
  return origins.length ? origins : DEFAULT_ALLOWED_ORIGINS;
}

function corsHeaders(origin, env) {
  const headers = new Headers();
  if (origin) {
    if (!allowedOrigins(env).includes(origin)) throw new HttpError(403, "origin_not_allowed", "Origin is not allowed");
    headers.set("Access-Control-Allow-Origin", origin);
    headers.set("Vary", "Origin");
  }
  headers.set("Access-Control-Allow-Methods", "GET,POST,PUT,PATCH,DELETE,OPTIONS");
  headers.set("Access-Control-Allow-Headers", "Authorization, Content-Type");
  headers.set("Access-Control-Max-Age", "600");
  return headers;
}

function json(data, status, headers = new Headers()) {
  headers.set("Content-Type", "application/json; charset=utf-8");
  headers.set("Cache-Control", "no-store");
  return new Response(JSON.stringify(data), { status, headers });
}

function success(data, status, origin, env) {
  return json(data, status, corsHeaders(origin, env));
}

function errorResponse(error, origin, env) {
  const known = error instanceof HttpError;
  const status = known ? error.status : 500;
  const body = known
    ? { error: error.code, message: error.message, ...(error.details ? { details: error.details } : {}) }
    : { error: "internal_error", message: "Something went wrong" };
  let headers;
  try {
    headers = corsHeaders(origin, env);
  } catch {
    headers = new Headers();
  }
  return json(body, status, headers);
}

function pathSegments(url) {
  return url.pathname.split("/").filter(Boolean).map((segment) => decodeURIComponent(segment));
}

function routeSpaceId(segments) {
  return identifier(segments[2], "spaceId");
}

async function authorized(request, env, ctx, spaceId) {
  return authenticate(request, env, spaceId);
}

async function routeRequest(request, env, ctx) {
  const url = new URL(request.url);
  const segments = pathSegments(url);
  const method = request.method.toUpperCase();

  if (segments.length === 1 && segments[0] === "health" && method === "GET") {
    return {
      ok: true,
      service: "stardew-todo-worker",
      version: env.APP_VERSION ?? "1.0.0",
      databaseConfigured: Boolean(env.DB),
      pushConfigured: Boolean(env.VAPID_SUBJECT && env.VAPID_PUBLIC_KEY && env.VAPID_PRIVATE_KEY),
      timestamp: nowIso(),
    };
  }

  if (segments.length === 2 && segments[0] === "v1" && segments[1] === "config" && method === "GET") {
    return {
      version: env.APP_VERSION ?? "1.0.0",
      vapidPublicKey: env.VAPID_PUBLIC_KEY ?? null,
      pushEnabled: Boolean(env.VAPID_SUBJECT && env.VAPID_PUBLIC_KEY && env.VAPID_PRIVATE_KEY),
    };
  }

  if (segments.length === 2 && segments[0] === "v1" && segments[1] === "spaces" && method === "POST") {
    return createSpace(env, await readJson(request));
  }

  if (segments.length < 3 || segments[0] !== "v1" || segments[1] !== "spaces") {
    throw new HttpError(404, "not_found", "Route not found");
  }

  const spaceId = routeSpaceId(segments);

  if (segments.length === 4 && segments[3] === "join" && method === "POST") {
    return joinSpace(env, spaceId, await readJson(request));
  }

  const auth = await authorized(request, env, ctx, spaceId);

  if (segments.length === 3 && method === "GET") return getSpace(env, auth);

  if (segments.length === 4 && segments[3] === "pairing" && method === "POST") {
    return rotatePairing(env, auth);
  }

  if ((segments.length === 4 && segments[3] === "devices" || segments.length === 5 && segments[3] === "devices" && ["me", "current"].includes(segments[4])) && method === "DELETE") {
    return disconnectDevice(env, auth);
  }

  if (segments.length === 4 && segments[3] === "tasks") {
    if (method === "GET") {
      return listTasks(env, auth, { includeDeleted: url.searchParams.get("includeDeleted") === "1" });
    }
    if (method === "POST") return upsertTask(env, auth, await readJson(request));
  }

  if (segments.length === 5 && segments[3] === "tasks") {
    const taskId = identifier(segments[4], "taskId");
    if (method === "GET") return getTask(env, auth, taskId);
    if (method === "PUT" || method === "PATCH" || method === "POST") {
      return upsertTask(env, auth, await readJson(request), taskId);
    }
  }

  if (segments.length === 6 && segments[3] === "tasks" && segments[5] === "comments") {
    const taskId = identifier(segments[4], "taskId");
    if (method === "GET") return listComments(env, auth, taskId);
    if (method === "POST") return addComment(env, auth, taskId, await readJson(request));
  }

  if (segments.length === 4 && segments[3] === "push-subscriptions") {
    if (method === "POST") return saveSubscription(env, auth, await readJson(request));
    if (method === "DELETE") return removeSubscription(env, auth, await readJson(request));
  }

  if (segments.length === 4 && segments[3] === "push-test" && method === "POST") {
    return sendTestPush(env, auth);
  }

  throw new HttpError(405, "method_not_allowed", "Method is not allowed for this route");
}

export async function handleRequest(request, env, ctx) {
  const origin = request.headers.get("origin");
  try {
    const headers = corsHeaders(origin, env);
    if (request.method.toUpperCase() === "OPTIONS") return new Response(null, { status: 204, headers });
    const result = await routeRequest(request, env, ctx);
    if (result && result.__httpStatus) {
      const { __httpStatus: status, ...body } = result;
      return json(body, status, headers);
    }
    return json(result, 200, headers);
  } catch (error) {
    return errorResponse(error, origin, env);
  }
}

const worker = {
  fetch(request, env, ctx) {
    return handleRequest(request, env, ctx);
  },

  scheduled(controller, env, ctx) {
    const sweep = runReminderSweep(env, new Date(controller.scheduledTime)).catch(() => {
      // Cron failures are deliberately not logged with request data or
      // subscription credentials. Cloudflare may retry the next minute.
      return { skipped: "sweep_failed" };
    });
    if (ctx?.waitUntil) {
      ctx.waitUntil(sweep);
      return;
    }
    return sweep;
  },
};

export default worker;
export { allowedOrigins, corsHeaders, json };
