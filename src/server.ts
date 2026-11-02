/**
 * The HTTP server: security checks, routing and request validation, built on Hono.
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
 * Hono runs middleware and handlers in the order they are registered, and stops at the first
 * one that returns a response, so the order of the `app.*` calls below is the order above.
 *
 * On SIGINT or SIGTERM the server stops listening and stops every command a rebuild or write
 * started (see `stopCommands`) before it exits.
 *
 * @packageDocumentation
 */
import { timingSafeEqual } from "node:crypto";

import { serve } from "@hono/node-server";
import { Hono } from "hono";
import type { Context, MiddlewareHandler } from "hono";

import { settings } from "./env.ts";
import {
  getBearings,
  refreshInBackground,
  sendAnswers,
  sendGeneralNote,
  status,
  stopCommands,
} from "./gather.ts";
import type { AnswerOutcome } from "./gather.ts";
import { openapi } from "./openapi.ts";
import {
  ActivityLimitSchema,
  AnswerRequestSchema,
  IdempotencyKeySchema,
  IdSchema,
  NoteRequestSchema,
  TaskStateFilterSchema,
} from "./schemas.ts";
import { ACTIVITY_LIMIT, TASK_STATES } from "./types.ts";
import type { ApiError, Bearings, Health, NoteReceipt, RefreshReceipt } from "./types.ts";

// ---------- settings ----------

/** Host names this server answers to. Requests for any other Host get 421. */
const ALLOWED_HOSTS = new Set(settings.allowedHosts);

/** The bearer token every `/api/v1/*` request must send, or `""` to leave the API open. */
const API_KEY = settings.apiKey;

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

// ---------- types ----------

/** Every HTTP status an error response can carry. */
type ErrorStatus = 400 | 401 | 403 | 404 | 413 | 415 | 421 | 422 | 500 | 502 | 503;

/** The outcome of {@link readIdempotencyKey}: the key, or `ok: false` when it is malformed. */
type IdempotencyKey = { ok: true; value: string | undefined } | { ok: false };

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
      status: ErrorStatus;
    };

// ---------- request parsing ----------

/**
 * The optional `Idempotency-Key` header (see {@link IdempotencyKeySchema}).
 *
 * @returns The key, `undefined` when the header is absent, or `ok: false` when it is malformed.
 */
function readIdempotencyKey(c: Context): IdempotencyKey {
  const parsed = IdempotencyKeySchema.safeParse(c.req.header("idempotency-key"));

  return parsed.success ? { ok: true, value: parsed.data } : { ok: false };
}

/**
 * The `id` path parameter, when it is valid.
 *
 * @returns The id, or `undefined` when it is not valid (see {@link IdSchema}), in which case
 *   the caller responds 404 as if the route did not exist.
 */
function routeId(c: Context): string | undefined {
  const parsed = IdSchema.safeParse(c.req.param("id"));

  return parsed.success ? parsed.data : undefined;
}

/**
 * Read and parse a JSON request body.
 *
 * @remarks
 * The Content-Type must be `application/json` (415) and the body at most
 * {@link MAX_BODY_BYTES} (413). The body is read as a stream, so an oversized body is refused
 * without being buffered whole. An empty body parses as `null`.
 */
async function readJson(c: Context): Promise<JsonBody> {
  if (!/^application\/json\b/i.test(c.req.header("content-type") ?? "")) {
    return {
      code: "unsupported_media_type",
      message: "Content-Type must be application/json.",
      ok: false,
      status: 415,
    };
  }

  const chunks: Uint8Array[] = [];
  let size = 0;

  for await (const chunk of c.req.raw.body ?? []) {
    size += chunk.byteLength;
    if (size > MAX_BODY_BYTES) {
      return { code: "too_large", message: "The body is too large.", ok: false, status: 413 };
    }

    chunks.push(chunk);
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
function hostOk(c: Context): boolean {
  const host = (c.req.header("host") ?? "").toLowerCase();
  const name = host.startsWith("[") ? `${host.split("]")[0]}]` : host.replace(/:\d+$/, "");

  return ALLOWED_HOSTS.has(name);
}

/** Whether the request only reads. HEAD is routed like GET, and Hono drops its body. */
function isRead(c: Context): boolean {
  return c.req.method === "GET" || c.req.method === "HEAD";
}

/**
 * Whether the request carries the API key as a bearer token. Always true when no key is set.
 *
 * @remarks
 * The `Bearer` scheme name is matched in any case, as RFC 9110 requires. The comparison takes the
 * same time however much of the key matches, so the key cannot be guessed one character at a
 * time.
 */
function keyOk(c: Context): boolean {
  if (!API_KEY) {
    return true;
  }

  const given = /^bearer (.+)$/i.exec(c.req.header("authorization") ?? "")?.[1] ?? "";
  const givenBytes = Buffer.from(given);
  const keyBytes = Buffer.from(API_KEY);

  return givenBytes.length === keyBytes.length && timingSafeEqual(givenBytes, keyBytes);
}

/**
 * Whether a write may go ahead, judged by its Origin header.
 *
 * @remarks
 * Browsers send Origin on cross-origin writes, so a write from any other page (CSRF) is
 * refused, including one served from another port on the same machine. The Origin's host and
 * port must match the Host header, which {@link hostOk} has already checked. An Origin of
 * `null` (a sandboxed frame or a local file) is refused too. Callers that send no Origin, such
 * as curl and scripts, are unaffected.
 */
function originOk(c: Context): boolean {
  const origin = c.req.header("origin");

  if (origin === undefined) {
    return true;
  }
  try {
    return new URL(origin).host === (c.req.header("host") ?? "").toLowerCase();
  } catch {
    return false;
  }
}

// ---------- responses ----------

/** Respond 400 because the `Idempotency-Key` header is malformed. */
function badIdempotencyKey(c: Context): Response {
  return fail(
    c,
    400,
    "invalid_idempotency_key",
    "Idempotency-Key must be 1 to 128 letters, digits or ._:-",
  );
}

/**
 * Run an inbox write and respond with a receipt (202), or with an error when the write is
 * refused (404, 422) or the inbox fails (502).
 */
async function deliver(c: Context, write: () => Promise<AnswerOutcome>): Promise<Response> {
  try {
    const outcome = await write();

    if (!outcome.ok) {
      return fail(c, outcome.status, outcome.code, outcome.message);
    }
  } catch (error) {
    const message = error instanceof Error ? error.message : "The note could not be recorded.";

    return fail(c, 502, "note_failed", message);
  }

  const receipt: NoteReceipt = { accepted: true, receivedAt: new Date().toISOString() };

  return c.json(receipt, 202);
}

/**
 * Respond with an {@link ApiError}.
 *
 * @param status - The HTTP status.
 * @param code - A stable machine-readable error code.
 * @param message - A plain-English explanation.
 */
function fail(c: Context, status: ErrorStatus, code: string, message: string): Response {
  const body: ApiError = { error: { code, message } };

  return c.json(body, status);
}

/** Respond 503 because there is no snapshot yet, saying whether the first build failed. */
function notReady(c: Context): Response {
  const { error } = status();
  const message = error
    ? `The first snapshot failed and will be retried shortly: ${error}`
    : "The first snapshot is still being built. Retry shortly.";

  return fail(c, 503, "not_ready", message);
}

/**
 * Run a handler with the cached snapshot, or respond 503 (see {@link notReady}) when there is
 * none yet.
 *
 * @param respond - Builds the response from the snapshot.
 */
function withBearings(c: Context, respond: (bearings: Bearings) => Response): Response {
  const bearings = getBearings();

  return bearings ? respond(bearings) : notReady(c);
}

// ---------- middleware ----------

/** Refuse requests whose Host header is not an allowed host name (421). */
const checkHost: MiddlewareHandler = async (c, next) => {
  if (!hostOk(c)) {
    return fail(c, 421, "bad_host", "Use localhost to reach this API.");
  }

  await next();
};

/** Refuse requests without the API key (401), when one is set. */
const checkKey: MiddlewareHandler = async (c, next) => {
  if (!keyOk(c)) {
    return fail(c, 401, "unauthorized", "Send the API key as a bearer token.");
  }

  await next();
};

/** Refuse writes sent from another site's page (403). */
const checkOrigin: MiddlewareHandler = async (c, next) => {
  if (!isRead(c) && !originOk(c)) {
    return fail(c, 403, "bad_origin", "Writes from other sites are not allowed.");
  }

  await next();
};

/** Mark every response `no-store` (the data changes every refresh) and `nosniff`. */
const noStore: MiddlewareHandler = async (c, next) => {
  await next();
  c.res.headers.set("Cache-Control", "no-store");
  c.res.headers.set("X-Content-Type-Options", "nosniff");
};

// ---------- routing ----------

// `strict: false` ignores a trailing slash, so /api/v1/tasks/ is /api/v1/tasks.
const app = new Hono({ strict: false });

app.use(noStore, checkHost, checkOrigin);

// Public: the spec, the docs page and health never need the key.
app.get("/openapi.json", (c) => c.json(openapi));
app.get("/docs", (c) => c.html(DOCS));
app.get("/", (c) => c.html(DOCS));
app.get("/health", (c) => {
  const cache = status();
  // The error text can name local paths, so only callers with the key see it.
  const error = cache.error && !keyOk(c) ? "refresh failed" : cache.error;
  const health: Health = { ...cache, error, ok: true };

  return c.json(health);
});

// Everything below needs the key, including unknown paths.
app.use(checkKey);

app.get("/api/v1/activity", (c) => {
  const limit = ActivityLimitSchema.safeParse(c.req.query("limit"));

  if (!limit.success) {
    return fail(
      c,
      400,
      "invalid_limit",
      `limit must be a whole number from 1 to ${ACTIVITY_LIMIT}.`,
    );
  }

  return withBearings(c, (bearings) => c.json(bearings.activity.slice(0, limit.data)));
});

app.get("/api/v1/bearings", (c) => withBearings(c, (bearings) => c.json(bearings)));

app.get("/api/v1/questions", (c) => withBearings(c, (bearings) => c.json(bearings.waitingOnYou)));

app.get("/api/v1/questions/:id", (c) => {
  const decisionId = routeId(c);

  if (!decisionId) {
    return c.notFound();
  }

  return withBearings(c, (bearings) => {
    const decision = bearings.waitingOnYou.decisions.find((d) => d.id === decisionId);

    if (!decision) {
      return fail(c, 404, "decision_not_found", `No open decision with id "${decisionId}".`);
    }

    return c.json(decision);
  });
});

app.get("/api/v1/tasks", (c) => {
  const parsed = TaskStateFilterSchema.safeParse(c.req.query("state"));

  if (!parsed.success) {
    return fail(c, 400, "invalid_state", `state must be one of: ${TASK_STATES.join(", ")}.`);
  }

  const state = parsed.data;

  return withBearings(c, (bearings) =>
    c.json(state ? bearings.underway.filter((task) => task.state === state) : bearings.underway),
  );
});

app.get("/api/v1/tasks/:id", (c) => {
  const taskId = routeId(c);

  if (!taskId) {
    return c.notFound();
  }

  return withBearings(c, (bearings) => {
    const task = bearings.underway.find((t) => t.id === taskId);

    if (!task) {
      return fail(c, 404, "task_not_found", `No task under way with id "${taskId}".`);
    }

    return c.json(task);
  });
});

app.post("/api/v1/notes", async (c) => {
  const idempotencyKey = readIdempotencyKey(c);

  if (!idempotencyKey.ok) {
    return badIdempotencyKey(c);
  }

  const body = await readJson(c);

  if (!body.ok) {
    return fail(c, body.status, body.code, body.message);
  }

  const request = NoteRequestSchema.safeParse(body.value);

  if (!request.success) {
    return fail(c, 400, "invalid_body", 'Expected {"text":"..."}.');
  }

  return deliver(c, async () => {
    await sendGeneralNote(request.data.text, idempotencyKey.value);

    return { ok: true };
  });
});

app.post("/api/v1/questions/:id/answers", async (c) => {
  const answersFor = routeId(c);

  if (!answersFor) {
    return c.notFound();
  }
  // Answers are checked against the open decisions, so there must be a snapshot.
  if (!getBearings()) {
    return notReady(c);
  }

  const idempotencyKey = readIdempotencyKey(c);

  if (!idempotencyKey.ok) {
    return badIdempotencyKey(c);
  }

  const body = await readJson(c);

  if (!body.ok) {
    return fail(c, body.status, body.code, body.message);
  }

  const request = AnswerRequestSchema.safeParse(body.value);

  if (!request.success) {
    const expected =
      'Expected {"answers":[{"question":1,"answer":"..."}]}, with each question answered once.';

    return fail(c, 400, "invalid_body", expected);
  }

  return deliver(c, () => sendAnswers(answersFor, request.data, idempotencyKey.value));
});

app.post("/api/v1/refresh", (c) => {
  refreshInBackground();

  const receipt: RefreshReceipt = { accepted: true };

  return c.json(receipt, 202);
});

app.notFound((c) => fail(c, 404, "not_found", "No such endpoint. See /docs."));

app.onError((error, c) => {
  console.error(`${c.req.method} ${c.req.url} failed:`, error);

  return fail(c, 500, "internal_error", "Something went wrong.");
});

// ---------- start and stop ----------

/** True once a shutdown signal has arrived, so a second one does not start another shutdown. */
let shuttingDown = false;

refreshInBackground();

const server = serve({ fetch: app.fetch, hostname: HOST, port: PORT }, () => {
  console.log(`bearings-api on http://localhost:${PORT}/  (docs: /docs, spec: /openapi.json)`);
});

/**
 * Stop listening, stop every running command, and exit.
 *
 * @param signal - The signal that asked for the shutdown, for the log.
 */
async function shutDown(signal: NodeJS.Signals): Promise<void> {
  if (shuttingDown) {
    return;
  }
  shuttingDown = true;
  console.log(`bearings-api: ${signal}, stopping`);
  server.close();
  await stopCommands();
  process.exit(0);
}

process.on("SIGINT", (signal) => void shutDown(signal));
process.on("SIGTERM", (signal) => void shutDown(signal));
