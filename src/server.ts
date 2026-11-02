import { createServer } from "node:http";
import type { IncomingMessage, ServerResponse } from "node:http";
import { timingSafeEqual } from "node:crypto";
import {
  getBearings,
  requestRefresh,
  sendAnswers,
  sendGeneralNote,
  startRefreshLoop,
  status,
} from "./gather.ts";
import { openapi } from "./openapi.ts";
import type { AnswerRequest, ApiError, Bearings, NoteReceipt, NoteRequest } from "./types.ts";

const HOST = process.env["BEARINGS_API_HOST"] ?? "127.0.0.1";
const PORT = Number(process.env["BEARINGS_API_PORT"] ?? 4748);
const API_KEY = process.env["BEARINGS_API_KEY"] ?? "";
const ALLOWED_HOSTS = new Set(
  (process.env["BEARINGS_API_ALLOWED_HOSTS"] ?? "localhost,127.0.0.1,[::1]")
    .split(",")
    .map((h) => h.trim())
    .filter(Boolean),
);
const MAX_BODY = 20_000;

function send(
  res: ServerResponse,
  code: number,
  body: unknown,
  type = "application/json; charset=utf-8",
): void {
  const text = typeof body === "string" ? body : JSON.stringify(body);
  res.writeHead(code, {
    "Content-Type": type,
    "Content-Length": Buffer.byteLength(text),
    "Cache-Control": "no-store",
    "X-Content-Type-Options": "nosniff",
  });
  res.end(text);
}

function fail(res: ServerResponse, code: number, errorCode: string, message: string): void {
  const body: ApiError = { error: { code: errorCode, message } };
  send(res, code, body);
}

function hostOk(req: IncomingMessage): boolean {
  const host = req.headers.host ?? "";
  const name = host.startsWith("[") ? `${host.split("]")[0]}]` : host.replace(/:\d+$/, "");
  return ALLOWED_HOSTS.has(name);
}

function keyOk(req: IncomingMessage): boolean {
  if (!API_KEY) return true;
  const given = /^Bearer (.+)$/.exec(req.headers.authorization ?? "")?.[1] ?? "";
  const a = Buffer.from(given);
  const b = Buffer.from(API_KEY);
  return a.length === b.length && timingSafeEqual(a, b);
}

async function readJson(
  req: IncomingMessage,
): Promise<
  { ok: true; value: unknown } | { ok: false; code: number; error: string; message: string }
> {
  if (!/^application\/json\b/i.test(req.headers["content-type"] ?? "")) {
    return {
      ok: false,
      code: 415,
      error: "unsupported_media_type",
      message: "Content-Type must be application/json.",
    };
  }
  const chunks: Buffer[] = [];
  let size = 0;
  for await (const chunk of req) {
    size += (chunk as Buffer).length;
    if (size > MAX_BODY)
      return { ok: false, code: 413, error: "too_large", message: "The body is too large." };
    chunks.push(chunk as Buffer);
  }
  try {
    return {
      ok: true,
      value: JSON.parse(Buffer.concat(chunks).toString("utf8") || "null") as unknown,
    };
  } catch {
    return { ok: false, code: 400, error: "invalid_json", message: "The body is not valid JSON." };
  }
}

const isRecord = (v: unknown): v is Record<string, unknown> =>
  typeof v === "object" && v !== null && !Array.isArray(v);

function asAnswerRequest(v: unknown): AnswerRequest | null {
  if (!isRecord(v) || Object.keys(v).some((k) => k !== "answers") || !Array.isArray(v["answers"]))
    return null;
  const list = v["answers"] as unknown[];
  if (list.length < 1 || list.length > 20) return null;
  const answers: AnswerRequest["answers"] = [];
  for (const a of list) {
    if (!isRecord(a) || Object.keys(a).some((k) => k !== "question" && k !== "answer")) return null;
    const q = a["question"];
    const t = a["answer"];
    if (typeof q !== "number" || !Number.isInteger(q) || q < 1) return null;
    if (typeof t !== "string" || t.trim().length < 1 || t.length > 2000) return null;
    answers.push({ question: q, answer: t.trim() });
  }
  return { answers };
}

function asNoteRequest(v: unknown): NoteRequest | null {
  if (!isRecord(v) || Object.keys(v).some((k) => k !== "text")) return null;
  const t = v["text"];
  return typeof t === "string" && t.trim().length >= 1 && t.length <= 4000
    ? { text: t.trim() }
    : null;
}

const DOCS = `<!doctype html><html lang="en"><head><meta charset="utf-8"><meta name="viewport" content="width=device-width,initial-scale=1">
<title>Fleet Bearings API</title>
<link rel="stylesheet" href="https://cdnjs.cloudflare.com/ajax/libs/swagger-ui/5.17.14/swagger-ui.min.css">
<style>body{margin:0}</style></head><body><div id="ui"></div>
<script src="https://cdnjs.cloudflare.com/ajax/libs/swagger-ui/5.17.14/swagger-ui-bundle.min.js"></script>
<script>window.onload=function(){SwaggerUIBundle({url:"/openapi.json",dom_id:"#ui",deepLinking:true})}</script></body></html>`;

const needBearings = (res: ServerResponse): Bearings | null => {
  const b = getBearings();
  if (!b) fail(res, 503, "not_ready", "The first snapshot is still being built. Retry shortly.");
  return b;
};

async function handle(req: IncomingMessage, res: ServerResponse): Promise<void> {
  if (!hostOk(req)) return fail(res, 421, "bad_host", "Use localhost to reach this API.");
  const url = new URL(req.url ?? "/", "http://localhost");
  const route = url.pathname.replace(/\/+$/, "") || "/";
  const method = req.method ?? "GET";

  // Public: the spec, the docs page and health never need the key.
  if (method === "GET" && route === "/openapi.json") return send(res, 200, openapi);
  if (method === "GET" && (route === "/docs" || route === "/"))
    return send(res, 200, DOCS, "text/html; charset=utf-8");
  if (method === "GET" && route === "/health") {
    const s = status();
    return send(res, 200, { ok: true, ...s });
  }
  if (!keyOk(req)) return fail(res, 401, "unauthorized", "Send the API key as a bearer token.");

  if (method === "GET" && route === "/api/v1/bearings") {
    const b = needBearings(res);
    return b ? send(res, 200, b) : undefined;
  }
  if (method === "GET" && route === "/api/v1/tasks") {
    const b = needBearings(res);
    if (!b) return;
    const state = url.searchParams.get("state");
    return send(res, 200, state ? b.underway.filter((t) => t.state === state) : b.underway);
  }
  const task = /^\/api\/v1\/tasks\/([A-Za-z0-9._-]+)$/.exec(route);
  if (method === "GET" && task && task[1]) {
    const b = needBearings(res);
    if (!b) return;
    const t = b.underway.find((x) => x.id === task[1]);
    return t
      ? send(res, 200, t)
      : fail(res, 404, "task_not_found", `No task under way with id "${task[1]}".`);
  }
  if (method === "GET" && route === "/api/v1/questions") {
    const b = needBearings(res);
    return b ? send(res, 200, b.waitingOnYou) : undefined;
  }
  const dec = /^\/api\/v1\/questions\/([A-Za-z0-9._-]+)$/.exec(route);
  if (method === "GET" && dec && dec[1]) {
    const b = needBearings(res);
    if (!b) return;
    const d = b.waitingOnYou.decisions.find((x) => x.id === dec[1]);
    return d
      ? send(res, 200, d)
      : fail(res, 404, "decision_not_found", `No open decision with id "${dec[1]}".`);
  }
  if (method === "GET" && route === "/api/v1/activity") {
    const b = needBearings(res);
    if (!b) return;
    const raw = url.searchParams.get("limit");
    const limit = raw === null ? 16 : Number(raw);
    if (!Number.isInteger(limit) || limit < 1 || limit > 16)
      return fail(res, 400, "invalid_limit", "limit must be a whole number from 1 to 16.");
    return send(res, 200, b.activity.slice(0, limit));
  }

  const ans = /^\/api\/v1\/questions\/([A-Za-z0-9._-]+)\/answers$/.exec(route);
  if (method === "POST" && ans && ans[1]) {
    const body = await readJson(req);
    if (!body.ok) return fail(res, body.code, body.error, body.message);
    const parsed = asAnswerRequest(body.value);
    if (!parsed)
      return fail(
        res,
        400,
        "invalid_body",
        'Expected {"answers":[{"question":1,"answer":"..."}]}.',
      );
    try {
      const out = await sendAnswers(ans[1], parsed);
      if (!out.ok) return fail(res, out.status, out.code, out.message);
    } catch (e) {
      return fail(
        res,
        502,
        "note_failed",
        e instanceof Error ? e.message : "The note could not be recorded.",
      );
    }
    const receipt: NoteReceipt = { accepted: true, receivedAt: new Date().toISOString() };
    return send(res, 202, receipt);
  }
  if (method === "POST" && route === "/api/v1/notes") {
    const body = await readJson(req);
    if (!body.ok) return fail(res, body.code, body.error, body.message);
    const parsed = asNoteRequest(body.value);
    if (!parsed) return fail(res, 400, "invalid_body", 'Expected {"text":"..."}.');
    try {
      await sendGeneralNote(parsed.text);
    } catch (e) {
      return fail(
        res,
        502,
        "note_failed",
        e instanceof Error ? e.message : "The note could not be recorded.",
      );
    }
    const receipt: NoteReceipt = { accepted: true, receivedAt: new Date().toISOString() };
    return send(res, 202, receipt);
  }
  if (method === "POST" && route === "/api/v1/refresh") {
    await requestRefresh();
    return send(res, 202, { accepted: true });
  }
  return fail(res, 404, "not_found", "No such endpoint. See /docs.");
}

const server = createServer((req, res) => {
  handle(req, res).catch(() => {
    if (!res.headersSent) fail(res, 500, "internal_error", "Something went wrong.");
  });
});

startRefreshLoop();
server.listen(PORT, HOST, () => {
  console.log(`bearings-api on http://localhost:${PORT}/  (docs: /docs, spec: /openapi.json)`);
});
