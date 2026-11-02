/**
 * The HTTP server: security checks, routing and request validation.
 *
 * @remarks
 * Each request passes these checks in order:
 *
 * 1. The Host header must be an allowed host name (421). This blocks DNS rebinding.
 * 2. Writes must not come from another site's page (403). This blocks CSRF.
 * 3. `/openapi.json`, `/docs` and `/health` are public.
 * 4. Everything else needs the API key, when one is set (401).
 * 5. The `/api/v1/*` routes.
 *
 * @packageDocumentation
 */
import { timingSafeEqual } from "node:crypto";
import { createServer } from "node:http";
import type { IncomingMessage, ServerResponse } from "node:http";

import { settings } from "./env.ts";
import {
  getBearings,
  refreshInBackground,
  sendAnswers,
  sendGeneralNote,
  status,
} from "./gather.ts";
import type { AnswerOutcome } from "./gather.ts";
import { openapi } from "./openapi.ts";
import {
  ActivityLimitSchema,
  AnswerRequestSchema,
  IdSchema,
  NoteRequestSchema,
  TaskStateFilterSchema,
} from "./schemas.ts";
import { ACTIVITY_LIMIT, TASK_STATES } from "./types.ts";
import type { ApiError, Bearings, NoteReceipt, RefreshReceipt } from "./types.ts";

// ---------- settings ----------

/** Host names this server answers to. Requests for any other Host get 421. */
const ALLOWED_HOSTS = new Set(settings.allowedHosts);

/** `/api/v1/questions/{id}/answers`. The id is captured and checked with {@link IdSchema}. */
const ANSWERS_ROUTE = /^\/api\/v1\/questions\/([^/]+)\/answers$/;

/** The bearer token every `/api/v1/*` request must send, or `""` to leave the API open. */
const API_KEY = settings.apiKey;

/** `/api/v1/questions/{id}`. The id is captured and checked with {@link IdSchema}. */
const DECISION_ROUTE = /^\/api\/v1\/questions\/([^/]+)$/;

// SWAGGER comes before DOCS because DOCS is built from it.
/** Where the Swagger UI assets for `/docs` are loaded from, pinned with subresource integrity. */
const SWAGGER = "https://cdnjs.cloudflare.com/ajax/libs/swagger-ui/5.17.14";

/** The `/docs` page: Swagger UI pointed at `/openapi.json`. */
const DOCS = `<!doctype html><html lang="en"><head><meta charset="utf-8"><meta content="width=device-width,initial-scale=1" name="viewport">
<title>Fleet Bearings API</title>
<link crossorigin="anonymous" href="${SWAGGER}/swagger-ui.min.css" integrity="sha512-+9UD8YSD9GF7FzOH38L9S6y56aYNx3R4dYbOCgvTJ2ZHpJScsahNdaMQJU/8osUiz9FPu0YZ8wdKf4evUbsGSg==" rel="stylesheet">
<style>body{margin:0}</style></head><body><div id="ui"></div>
<script crossorigin="anonymous" integrity="sha512-7ihPQv5ibiTr0DW6onbl2MIKegdT6vjpPySyIb4Ftp68kER6Z7Yiub0tFoMmCHzZfQE9+M+KSjQndv6NhYxDgg==" src="${SWAGGER}/swagger-ui-bundle.min.js"></script>
<script>window.onload=function(){SwaggerUIBundle({deepLinking:true,dom_id:"#ui",url:"/openapi.json"})}</script></body></html>`;

/** The interface to listen on. Loopback only by default. */
const HOST = settings.host;

/** The largest request body accepted, in bytes. Larger bodies get 413. */
const MAX_BODY_BYTES = 20_000;

/** The port to listen on. */
const PORT = settings.port;

/** `/api/v1/tasks/{id}`. The id is captured and checked with {@link IdSchema}. */
const TASK_ROUTE = /^\/api\/v1\/tasks\/([^/]+)$/;

// ---------- types ----------

/** The outcome of {@link readJson}: the parsed body, or the error response to send instead. */
type JsonBody =
  | { ok: true; value: unknown }
  | {
      /** A stable error code for the API response. */
      code: string;
      /** A plain-English message for the API response. */
      message: string;
      ok: false;
      /** The HTTP status to respond with. */
      status: number;
    };

// ---------- request parsing ----------

/**
 * The id a route captures, when the route matches and the id is valid.
 *
 * @param pattern - A route with one capture group for the id.
 * @param route - The request path, without a trailing slash.
 * @returns The id, or `undefined` when the route does not match or the id is not valid (see
 *   {@link IdSchema}), in which case the request falls through to 404.
 */
function routeId(pattern: RegExp, route: string): string | undefined {
  const parsed = IdSchema.safeParse(pattern.exec(route)?.[1]);
  return parsed.success ? parsed.data : undefined;
}

/** A query parameter, or `undefined` when it is absent, ready for a Zod schema. */
function query(url: URL, name: string): string | undefined {
  return url.searchParams.get(name) ?? undefined;
}

/**
 * Read and parse a JSON request body.
 *
 * @remarks
 * The Content-Type must be `application/json` (415) and the body at most
 * {@link MAX_BODY_BYTES} (413). An empty body parses as `null`.
 */
async function readJson(req: IncomingMessage): Promise<JsonBody> {
  if (!/^application\/json\b/i.test(req.headers["content-type"] ?? "")) {
    return {
      code: "unsupported_media_type",
      message: "Content-Type must be application/json.",
      ok: false,
      status: 415,
    };
  }

  const chunks: Buffer[] = [];
  let size = 0;
  for await (const chunk of req) {
    const buffer = chunk as Buffer;
    size += buffer.length;
    if (size > MAX_BODY_BYTES) {
      return { code: "too_large", message: "The body is too large.", ok: false, status: 413 };
    }
    chunks.push(buffer);
  }

  const text = Buffer.concat(chunks).toString("utf8");
  try {
    return { ok: true, value: JSON.parse(text || "null") as unknown };
  } catch {
    return { code: "invalid_json", message: "The body is not valid JSON.", ok: false, status: 400 };
  }
}

// ---------- security checks ----------

/**
 * Whether the Host header names an allowed host. The port is ignored, and IPv6 hosts keep
 * their brackets (`[::1]`).
 */
function hostOk(req: IncomingMessage): boolean {
  const host = (req.headers.host ?? "").toLowerCase();
  const name = host.startsWith("[") ? `${host.split("]")[0]}]` : host.replace(/:\d+$/, "");
  return ALLOWED_HOSTS.has(name);
}

/**
 * Whether the request carries the API key as a bearer token. Always true when no key is set.
 *
 * @remarks
 * The comparison takes the same time however much of the key matches, so the key cannot be
 * guessed one character at a time.
 */
function keyOk(req: IncomingMessage): boolean {
  if (!API_KEY) return true;
  const given = /^Bearer (.+)$/.exec(req.headers.authorization ?? "")?.[1] ?? "";
  const givenBytes = Buffer.from(given);
  const keyBytes = Buffer.from(API_KEY);
  return givenBytes.length === keyBytes.length && timingSafeEqual(givenBytes, keyBytes);
}

/**
 * Whether a write may go ahead, judged by its Origin header.
 *
 * @remarks
 * Browsers send Origin on cross-site writes, so a write from a page on another site (CSRF) is
 * refused. Callers that send no Origin, such as curl and scripts, are unaffected.
 */
function originOk(req: IncomingMessage): boolean {
  const origin = req.headers.origin;
  if (origin === undefined) return true;
  try {
    return ALLOWED_HOSTS.has(new URL(origin).hostname.toLowerCase());
  } catch {
    return false;
  }
}

// ---------- responses ----------

/**
 * Run an inbox write and respond with a receipt (202), or with an error when the write is
 * refused (404, 422) or the inbox fails (502).
 */
async function deliver(res: ServerResponse, write: () => Promise<AnswerOutcome>): Promise<void> {
  try {
    const outcome = await write();
    if (!outcome.ok) return fail(res, outcome.status, outcome.code, outcome.message);
  } catch (error) {
    const message = error instanceof Error ? error.message : "The note could not be recorded.";
    return fail(res, 502, "note_failed", message);
  }
  const receipt: NoteReceipt = { accepted: true, receivedAt: new Date().toISOString() };
  return send(res, 202, receipt);
}

/**
 * Respond with an {@link ApiError}.
 *
 * @param status - The HTTP status.
 * @param code - A stable machine-readable error code.
 * @param message - A plain-English explanation.
 */
function fail(res: ServerResponse, status: number, code: string, message: string): void {
  const body: ApiError = { error: { code, message } };
  send(res, status, body);
}

/**
 * The cached snapshot, or `null` after responding 503 because there is none yet.
 *
 * @remarks
 * Callers return straight away on `null`, since the response has already been sent.
 */
function needBearings(res: ServerResponse): Bearings | null {
  const bearings = getBearings();
  if (bearings) return bearings;
  const { error } = status();
  const message = error
    ? `The first snapshot failed and will be retried shortly: ${error}`
    : "The first snapshot is still being built. Retry shortly.";
  fail(res, 503, "not_ready", message);
  return null;
}

/**
 * Send a complete response. Strings are sent as-is and anything else as JSON.
 *
 * @remarks
 * Every response is marked `no-store` (the data changes every refresh) and `nosniff`.
 */
function send(
  res: ServerResponse,
  status: number,
  body: unknown,
  contentType = "application/json; charset=utf-8",
): void {
  const text = typeof body === "string" ? body : JSON.stringify(body);
  res.writeHead(status, {
    "Cache-Control": "no-store",
    "Content-Length": Buffer.byteLength(text),
    "Content-Type": contentType,
    "X-Content-Type-Options": "nosniff",
  });
  res.end(text);
}

// ---------- routing ----------

/** Handle one request. See the module comment for the order of checks. */
async function handle(req: IncomingMessage, res: ServerResponse): Promise<void> {
  if (!hostOk(req)) return fail(res, 421, "bad_host", "Use localhost to reach this API.");

  const url = new URL(req.url ?? "/", "http://localhost");
  // Trailing slashes are ignored, so /api/v1/tasks/ is /api/v1/tasks.
  const route = url.pathname.replace(/\/+$/, "") || "/";
  const method = req.method ?? "GET";
  // HEAD is routed like GET; Node leaves the body out of HEAD responses by itself.
  const isRead = method === "GET" || method === "HEAD";
  if (!isRead && !originOk(req)) {
    return fail(res, 403, "bad_origin", "Writes from other sites are not allowed.");
  }

  // Public: the spec, the docs page and health never need the key.
  if (isRead && route === "/openapi.json") return send(res, 200, openapi);
  if (isRead && (route === "/docs" || route === "/")) {
    return send(res, 200, DOCS, "text/html; charset=utf-8");
  }
  if (isRead && route === "/health") {
    const health = status();
    // The error text can name local paths, so only callers with the key see it.
    const error = health.error && !keyOk(req) ? "refresh failed" : health.error;
    return send(res, 200, { ok: true, ...health, error });
  }

  if (!keyOk(req)) return fail(res, 401, "unauthorized", "Send the API key as a bearer token.");

  if (isRead) {
    if (route === "/api/v1/bearings") {
      const bearings = needBearings(res);
      return bearings ? send(res, 200, bearings) : undefined;
    }

    if (route === "/api/v1/tasks") {
      const parsed = TaskStateFilterSchema.safeParse(query(url, "state"));
      if (!parsed.success) {
        return fail(res, 400, "invalid_state", `state must be one of: ${TASK_STATES.join(", ")}.`);
      }
      const state = parsed.data;
      const bearings = needBearings(res);
      if (!bearings) return;
      const tasks = state
        ? bearings.underway.filter((task) => task.state === state)
        : bearings.underway;
      return send(res, 200, tasks);
    }

    const taskId = routeId(TASK_ROUTE, route);
    if (taskId) {
      const bearings = needBearings(res);
      if (!bearings) return;
      const task = bearings.underway.find((t) => t.id === taskId);
      if (!task) return fail(res, 404, "task_not_found", `No task under way with id "${taskId}".`);
      return send(res, 200, task);
    }

    if (route === "/api/v1/questions") {
      const bearings = needBearings(res);
      return bearings ? send(res, 200, bearings.waitingOnYou) : undefined;
    }

    const decisionId = routeId(DECISION_ROUTE, route);
    if (decisionId) {
      const bearings = needBearings(res);
      if (!bearings) return;
      const decision = bearings.waitingOnYou.decisions.find((d) => d.id === decisionId);
      if (!decision) {
        return fail(res, 404, "decision_not_found", `No open decision with id "${decisionId}".`);
      }
      return send(res, 200, decision);
    }

    if (route === "/api/v1/activity") {
      const limit = ActivityLimitSchema.safeParse(query(url, "limit"));
      if (!limit.success) {
        return fail(
          res,
          400,
          "invalid_limit",
          `limit must be a whole number from 1 to ${ACTIVITY_LIMIT}.`,
        );
      }
      const bearings = needBearings(res);
      if (!bearings) return;
      return send(res, 200, bearings.activity.slice(0, limit.data));
    }
  }

  if (method === "POST") {
    const answersFor = routeId(ANSWERS_ROUTE, route);
    if (answersFor) {
      // Answers are checked against the open decisions, so there must be a snapshot.
      if (!needBearings(res)) return;
      const body = await readJson(req);
      if (!body.ok) return fail(res, body.status, body.code, body.message);
      const request = AnswerRequestSchema.safeParse(body.value);
      if (!request.success) {
        const expected =
          'Expected {"answers":[{"question":1,"answer":"..."}]}, with each question answered once.';
        return fail(res, 400, "invalid_body", expected);
      }
      return deliver(res, () => sendAnswers(answersFor, request.data));
    }

    if (route === "/api/v1/notes") {
      const body = await readJson(req);
      if (!body.ok) return fail(res, body.status, body.code, body.message);
      const request = NoteRequestSchema.safeParse(body.value);
      if (!request.success) return fail(res, 400, "invalid_body", 'Expected {"text":"..."}.');
      return deliver(res, async () => {
        await sendGeneralNote(request.data.text);
        return { ok: true };
      });
    }

    if (route === "/api/v1/refresh") {
      refreshInBackground();
      const receipt: RefreshReceipt = { accepted: true };
      return send(res, 202, receipt);
    }
  }

  return fail(res, 404, "not_found", "No such endpoint. See /docs.");
}

// ---------- start ----------

const server = createServer((req, res) => {
  handle(req, res).catch((error: unknown) => {
    console.error(`${req.method ?? "?"} ${req.url ?? "?"} failed:`, error);
    if (!res.headersSent) fail(res, 500, "internal_error", "Something went wrong.");
  });
});

refreshInBackground();
server.listen(PORT, HOST, () => {
  console.log(`bearings-api on http://localhost:${PORT}/  (docs: /docs, spec: /openapi.json)`);
});
