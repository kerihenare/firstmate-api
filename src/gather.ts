import { execFile } from "node:child_process";
import { randomUUID } from "node:crypto";
import { readdir, readFile, stat } from "node:fs/promises";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { stripVTControlCharacters } from "node:util";

import {
  describeTask,
  firstSentence,
  parsePipeline,
  parseQuestions,
  readyForReview,
  slugFromRemote,
  ticketKey,
} from "./status.ts";
import type {
  ActivityEvent,
  AnswerRequest,
  Bearings,
  Decision,
  LandedItem,
  Pipeline,
  QueuedItem,
  RawSnapshot,
  ReadyToMerge,
  Task,
  TaskLinks,
} from "./types.ts";

// HERE comes first because FM_HOME is built from it.
const HERE = path.dirname(fileURLToPath(import.meta.url));
export const FM_HOME = process.env["FM_HOME"] ?? path.resolve(HERE, "..", "..", "..");
const KIND_LABEL: Record<string, ActivityEvent["kind"]> = {
  blocked: "blocked",
  done: "finished",
  "needs-decision": "decision_asked",
  resolved: "decision_made",
};
/** Base URL for ticket links, for example https://linear.app/<workspace>/issue/. */
const LINEAR_BASE = process.env["BEARINGS_LINEAR_BASE"] ?? "";
/** Linear team keys to recognise, for example LIV,ENG. Tasks get a ticket link only when this and LINEAR_BASE are set. */
const LINEAR_TEAMS = (process.env["BEARINGS_LINEAR_TEAMS"] ?? "")
  .split(",")
  .map((t) => t.trim().toUpperCase())
  .filter((t) => /^[A-Z0-9]+$/.test(t));
export const REFRESH_SECONDS = Number(process.env["BEARINGS_API_REFRESH"] ?? 300);
/** After a failed rebuild, retry this soon rather than waiting a full interval. */
const RETRY_SECONDS = Math.min(30, REFRESH_SECONDS);
/**
 * Each task spawns up to five processes (crew, no-mistakes, git, gh, fm-tasks), and hold reasons
 * run alongside with the same limit, so a refresh peaks at about 6 × TASK_CONCURRENCY processes.
 */
const TASK_CONCURRENCY = 4;

const repoCache = new Map<string, string>();

interface RunResult {
  code: number;
  stderr: string;
  stdout: string;
}

interface TaskInfo {
  crew: string;
  links: TaskLinks | null;
  pipeline: Pipeline | null;
}

async function activityFeed(names: Map<string, string>, limit = 16): Promise<ActivityEvent[]> {
  const events: ActivityEvent[] = [];
  const now = Date.now();
  let files: string[] = [];
  try {
    files = (await readdir(path.join(FM_HOME, "state"))).filter((f) => f.endsWith(".status"));
  } catch {
    return [];
  }
  for (const f of files) {
    const p = path.join(FM_HOME, "state", f);
    try {
      if (now - (await stat(p)).mtimeMs > 86_400_000) continue;
      const lines = (await readFile(p, "utf8")).split("\n").slice(-80);
      const taskId = f.slice(0, -7);
      for (const line of lines) {
        const m = /^([\w-]+)((?: \[[^\]]+\])*):\s*(.*)$/.exec(line);
        const kind = m && m[1] ? KIND_LABEL[m[1]] : undefined;
        const at = m && m[2] ? /\[at=(\d+)\]/.exec(m[2])?.[1] : undefined;
        if (!m || !kind || !at) continue;
        events.push({
          at: new Date(Number(at) * 1000).toISOString(),
          kind,
          taskId,
          taskName: names.get(taskId) ?? taskId.replace(/-/g, " "),
          text: firstSentence(m[3] ?? "", 150),
        });
      }
    } catch {
      /* skip unreadable status */
    }
  }
  events.sort((a, b) => b.at.localeCompare(a.at));
  return events.slice(0, limit);
}

function bin(name: string): string {
  return path.join(FM_HOME, "bin", name);
}

async function build(): Promise<Bearings> {
  const snap = await run(bin("fm-bearings-snapshot.sh"), ["--json"], { timeoutMs: 150_000 });
  if (snap.code !== 0 || !snap.stdout.trim())
    throw new Error((snap.stderr || "snapshot failed").trim().slice(0, 300));
  const raw = JSON.parse(snap.stdout) as RawSnapshot;
  const recordedPr = new Map(raw.recorded_prs.map((p) => [p.id, p.url]));
  const names = new Map(raw.in_flight.map((t) => [t.id, t.name]));

  const ids = [...new Set([...names.keys(), ...raw.recorded_prs.map((p) => p.id)])];
  const [infoList, holdList, activity] = await Promise.all([
    mapLimit(ids, TASK_CONCURRENCY, (id) => taskInfo(id, names.get(id), recordedPr.get(id) ?? "")),
    mapLimit(raw.decisions_open, TASK_CONCURRENCY, (d) => holdReason(d.id)),
    activityFeed(names),
  ]);
  const info = new Map(ids.map((id, i) => [id, infoList[i]]));
  const holds = new Map(raw.decisions_open.map((d, i) => [d.id, holdList[i] ?? ""]));

  const underway: Task[] = raw.in_flight.map((t) => {
    const i = info.get(t.id);
    const line = i?.crew || t.doing;
    const pipeline = i?.pipeline ?? null;
    const { state, sentence } = describeTask(line, pipeline, readyForReview(line));
    return {
      id: t.id,
      kind: taskKind(t.kind),
      links: i?.links ?? { linear: null, pullRequest: null },
      name: t.name,
      pipeline,
      repo: t.repo,
      state,
      status: sentence,
    };
  });

  const decisions: Decision[] = raw.decisions_open.map((d) => {
    const title = (d.summary.split(":")[0] ?? d.id).trim();
    const reason = holds.get(d.id) || d.summary;
    const qs = parseQuestions(reason);
    return {
      id: d.id,
      questions: qs.map((q, i) => ({ number: i + 1, options: q.options, title: q.title })),
      summary:
        qs.length > 0
          ? `${qs.length} question${qs.length === 1 ? "" : "s"} to answer. The recommended option is marked.`
          : "Needs your answer.",
      text: qs.length > 0 ? null : reason,
      title,
    };
  });

  const landedUrls = new Set(raw.landed.map((l) => l.artifact));
  const readyToMerge: ReadyToMerge[] = [];
  for (const p of raw.recorded_prs) {
    if (landedUrls.has(p.url) || !readyForReview(info.get(p.id)?.crew ?? "")) continue;
    const number = prNumber(p.url);
    if (number === null) continue;
    readyToMerge.push({
      name: names.get(p.id) ?? p.id,
      pullRequest: { number, url: p.url },
      summary: "Ready for you to review and merge.",
      taskId: p.id,
    });
  }

  const landed: LandedItem[] = raw.landed.map((l) => {
    const isUrl = l.artifact.startsWith("http");
    return {
      id: l.id,
      kind: isUrl ? "pull_request" : "report",
      path: isUrl ? null : l.artifact,
      title: l.what,
      url: isUrl ? l.artifact : null,
    };
  });
  const queued: QueuedItem[] = raw.gates.map((g) => ({
    id: g.id ?? "",
    reason: firstSentence(g.reason ?? "", 110),
    title: g.title ?? g.id ?? "",
  }));

  return {
    activity,
    contributions: {
      checked: raw.contributions.checked,
      complete: raw.contributions.complete,
      known: raw.contributions.known,
    },
    counts: {
      landed: landed.length,
      queued: queued.length,
      underway: underway.length,
      waitingOnYou: decisions.length + readyToMerge.length,
    },
    error: null,
    generatedAt: null,
    nextRefreshAt: null,
    queued,
    recentlyLanded: landed,
    refreshing: false,
    underway,
    waitingOnYou: { decisions, readyToMerge },
  };
}

async function crewLine(taskId: string): Promise<string> {
  const r = await run(bin("fm-crew-state.sh"), [taskId], { timeoutMs: 30_000 });
  return ((r.stdout || r.stderr).trim().split("\n")[0] ?? "").slice(0, 400);
}

async function holdReason(taskId: string): Promise<string> {
  const r = await run(bin("fm-tasks-axi.sh"), ["show", taskId], { timeoutMs: 30_000 });
  const m = /hold_reason: "?(.*?)"?$/m.exec(r.stdout);
  return m && m[1] && m[1] !== "-" ? m[1] : "";
}

async function linksFor(
  taskId: string,
  meta: Record<string, string>,
  title: string,
  recordedPr: string,
): Promise<TaskLinks> {
  let pr = recordedPr || meta["pr"] || "";
  if (!pr && meta["branch"] && meta["project"]) {
    const slug = await repoSlug(meta["project"]);
    if (slug) {
      const r = await run(
        "gh",
        [
          "pr",
          "list",
          "-R",
          slug,
          "--head",
          meta["branch"],
          "--state",
          "open",
          "--json",
          "url",
          "--jq",
          ".[0].url",
        ],
        { timeoutMs: 25_000 },
      );
      pr = r.code === 0 && r.stdout.trim().startsWith("http") ? r.stdout.trim() : "";
    }
  }
  let key = "";
  if (LINEAR_BASE && LINEAR_TEAMS.length > 0) {
    key = ticketKey(title, LINEAR_TEAMS);
    if (!key) {
      const r = await run(bin("fm-tasks-axi.sh"), ["show", taskId, "--full"], {
        timeoutMs: 25_000,
      });
      key = ticketKey(r.stdout, LINEAR_TEAMS);
    }
  }
  const num = pr ? prNumber(pr) : null;
  return {
    linear: key ? { key, url: LINEAR_BASE + key } : null,
    pullRequest: pr && num !== null ? { number: num, url: pr } : null,
  };
}

/** Like Promise.all over items.map(fn), but with at most `limit` calls in flight. */
async function mapLimit<T, R>(
  items: T[],
  limit: number,
  fn: (item: T) => Promise<R>,
): Promise<R[]> {
  const out: R[] = [];
  let next = 0;
  const worker = async (): Promise<void> => {
    while (next < items.length) {
      const i = next++;
      out[i] = await fn(items[i] as T);
    }
  };
  await Promise.all(Array.from({ length: Math.min(limit, items.length) }, worker));
  return out;
}

async function pipelineFor(meta: Record<string, string>): Promise<Pipeline | null> {
  if (meta["mode"] !== "no-mistakes" || !meta["worktree"]) return null;
  try {
    await stat(meta["worktree"]);
  } catch {
    return null;
  }
  const r = await run("no-mistakes", ["axi", "status"], {
    cwd: meta["worktree"],
    timeoutMs: 40_000,
  });
  return r.stdout ? parsePipeline(r.stdout) : null;
}

function prNumber(url: string): number | null {
  const m = /\/pull\/(\d+)/.exec(url);
  return m && m[1] ? Number(m[1]) : null;
}

async function readMeta(taskId: string): Promise<Record<string, string>> {
  const meta: Record<string, string> = {};
  try {
    const text = await readFile(path.join(FM_HOME, "state", `${taskId}.meta`), "utf8");
    for (const line of text.split("\n")) {
      const i = line.indexOf("=");
      if (i > 0) meta[line.slice(0, i)] = line.slice(i + 1);
    }
  } catch {
    /* no record */
  }
  return meta;
}

async function repoSlug(projectDir: string): Promise<string> {
  const hit = repoCache.get(projectDir);
  if (hit !== undefined) return hit;
  const r = await run("git", ["-C", projectDir, "remote", "get-url", "origin"], {
    timeoutMs: 10_000,
  });
  const slug = slugFromRemote(r.stdout);
  // Only cache a real answer, so a timeout is retried on the next refresh.
  if (r.code === 0) repoCache.set(projectDir, slug);
  return slug;
}

function run(
  cmd: string,
  args: string[],
  opts: { cwd?: string; input?: string; timeoutMs?: number } = {},
): Promise<RunResult> {
  return new Promise((resolve) => {
    const child = execFile(
      cmd,
      args,
      {
        cwd: opts.cwd ?? FM_HOME,
        env: { ...process.env, FM_HOME, NO_COLOR: "1" },
        maxBuffer: 16 * 1024 * 1024,
        timeout: opts.timeoutMs ?? 60_000,
      },
      (error, stdout, stderr) => {
        const code =
          error && typeof (error as { code?: unknown }).code === "number"
            ? (error as { code: number }).code
            : error
              ? 1
              : 0;
        // A missing binary or a timeout leaves stderr empty; keep the reason.
        const err = stripVTControlCharacters(String(stderr)) || (error ? error.message : "");
        resolve({ code, stderr: err, stdout: stripVTControlCharacters(String(stdout)) });
      },
    );
    if (opts.input !== undefined) {
      // EPIPE when the child exits before reading; the exit code already reports the failure.
      child.stdin?.on("error", () => {});
      child.stdin?.end(opts.input);
    }
  });
}

/** Crew line for any task; pipeline and links only for tasks in flight (title given). */
async function taskInfo(
  taskId: string,
  title: string | undefined,
  recordedPr: string,
): Promise<TaskInfo> {
  const meta = await readMeta(taskId);
  const [crew, pipeline, links] = await Promise.all([
    crewLine(taskId),
    title === undefined ? null : pipelineFor(meta),
    title === undefined ? null : linksFor(taskId, meta, title, recordedPr),
  ]);
  return { crew, links, pipeline };
}

function taskKind(kind: string): Task["kind"] {
  return kind === "ship" || kind === "scout" ? kind : "other";
}

// ---------- cache and refresh loop ----------

let current: Bearings | null = null;
let generatedMs = 0;
let lastError: string | null = null;
let nextMs = 0;
let refreshing = false;
let timer: ReturnType<typeof setTimeout> | undefined;

/** The latest bearings, or null before the first refresh finishes. */
export function getBearings(): Bearings | null {
  if (!current) return null;
  return {
    ...current,
    error: lastError,
    generatedAt: new Date(generatedMs).toISOString(),
    nextRefreshAt: refreshing ? null : new Date(nextMs).toISOString(),
    refreshing,
  };
}

/** Rebuild now. Every finished rebuild, scheduled or manual, schedules the next one a full interval later. */
export async function refresh(): Promise<void> {
  if (refreshing) return;
  refreshing = true;
  try {
    current = await build();
    generatedMs = Date.now();
    lastError = null;
  } catch (e) {
    lastError = e instanceof Error ? e.message.slice(0, 300) : "refresh failed";
  } finally {
    refreshing = false;
    clearTimeout(timer);
    const wait = (lastError ? RETRY_SECONDS : REFRESH_SECONDS) * 1000;
    nextMs = Date.now() + wait;
    timer = setTimeout(() => void refresh(), wait);
    timer.unref();
  }
}

export async function requestRefresh(): Promise<void> {
  void refresh();
}

export function startRefreshLoop(): void {
  void refresh();
}

export function status(): {
  error: string | null;
  generatedAt: string | null;
  ready: boolean;
  refreshing: boolean;
} {
  return {
    error: lastError,
    generatedAt: current ? new Date(generatedMs).toISOString() : null,
    ready: current !== null,
    refreshing,
  };
}

// ---------- replies to firstmate (inbox notes) ----------

export type AnswerOutcome =
  | { ok: true }
  | { code: string; message: string; ok: false; status: 404 | 422 };

export async function sendAnswers(decisionId: string, req: AnswerRequest): Promise<AnswerOutcome> {
  const b = getBearings();
  const decision = b?.waitingOnYou.decisions.find((d) => d.id === decisionId);
  if (!decision)
    return {
      code: "decision_not_found",
      message: `No open decision with id "${decisionId}".`,
      ok: false,
      status: 404,
    };
  const lines: string[] = [];
  // A free-text decision has no structured questions; it is answered as question 1.
  const freeText = decision.questions.length === 0;
  for (const a of req.answers) {
    const q = decision.questions.find((x) => x.number === a.question);
    if (!q && !(freeText && a.question === 1)) {
      return {
        code: "unknown_question",
        message: `Decision "${decisionId}" has no question ${a.question}.`,
        ok: false,
        status: 422,
      };
    }
    lines.push(q ? `${q.number}. ${q.title} → ${a.answer}` : a.answer);
  }
  await sendNote(
    `Reply from the Fleet Bearings API to the open question "${decision.title}" (task ${decision.id}):\n${lines.join("\n")}`,
  );
  return { ok: true };
}

export async function sendGeneralNote(text: string): Promise<void> {
  await sendNote(`Reply from the Fleet Bearings API (general note):\n${text}`);
}

async function sendNote(body: string): Promise<void> {
  const r = await run(bin("fm-inbox.sh"), ["note", "--request-id", randomUUID(), "-"], {
    input: body,
    timeoutMs: 30_000,
  });
  if (r.code !== 0) throw new Error((r.stderr || r.stdout || "inbox failed").trim().slice(0, 200));
}
