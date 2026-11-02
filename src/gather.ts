import { execFile } from "node:child_process";
import { randomUUID } from "node:crypto";
import { readFile, readdir, stat } from "node:fs/promises";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { stripVTControlCharacters } from "node:util";
import {
  describeTask,
  firstSentence,
  parsePipeline,
  parseQuestions,
  readyForReview,
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

const HERE = path.dirname(fileURLToPath(import.meta.url));
export const FM_HOME = process.env["FM_HOME"] ?? path.resolve(HERE, "..", "..", "..");
export const REFRESH_SECONDS = Number(process.env["BEARINGS_API_REFRESH"] ?? 300);
/** Base URL for ticket links, for example https://linear.app/<workspace>/issue/. Without it, tasks carry no ticket link. */
const LINEAR_BASE = process.env["BEARINGS_LINEAR_BASE"] ?? "";

interface RunResult {
  code: number;
  stdout: string;
  stderr: string;
}

function run(
  cmd: string,
  args: string[],
  opts: { cwd?: string; timeoutMs?: number; input?: string } = {},
): Promise<RunResult> {
  return new Promise((resolve) => {
    const child = execFile(
      cmd,
      args,
      {
        cwd: opts.cwd ?? FM_HOME,
        env: { ...process.env, FM_HOME, NO_COLOR: "1" },
        timeout: opts.timeoutMs ?? 60_000,
        maxBuffer: 16 * 1024 * 1024,
      },
      (error, stdout, stderr) => {
        const code =
          error && typeof (error as { code?: unknown }).code === "number"
            ? (error as { code: number }).code
            : error
              ? 1
              : 0;
        resolve({
          code,
          stdout: stripVTControlCharacters(String(stdout)),
          stderr: stripVTControlCharacters(String(stderr)),
        });
      },
    );
    if (opts.input !== undefined) {
      child.stdin?.end(opts.input);
    }
  });
}

const bin = (name: string): string => path.join(FM_HOME, "bin", name);

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

async function pipelineFor(taskId: string): Promise<Pipeline | null> {
  const meta = await readMeta(taskId);
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

async function crewLine(taskId: string): Promise<string> {
  const r = await run(bin("fm-crew-state.sh"), [taskId], { timeoutMs: 30_000 });
  return ((r.stdout || r.stderr).trim().split("\n")[0] ?? "").slice(0, 400);
}

async function holdReason(taskId: string): Promise<string> {
  const r = await run(bin("fm-tasks-axi.sh"), ["show", taskId], { timeoutMs: 30_000 });
  const m = /hold_reason: "?(.*?)"?$/m.exec(r.stdout);
  return m && m[1] && m[1] !== "-" ? m[1] : "";
}

const repoCache = new Map<string, string>();
async function repoSlug(projectDir: string): Promise<string> {
  const hit = repoCache.get(projectDir);
  if (hit !== undefined) return hit;
  const r = await run("git", ["-C", projectDir, "remote", "get-url", "origin"], {
    timeoutMs: 10_000,
  });
  const m = /github\.com[:/]([^/]+\/[^/.\s]+)/.exec(r.stdout);
  const slug = m && m[1] ? m[1] : "";
  repoCache.set(projectDir, slug);
  return slug;
}

function prNumber(url: string): number | null {
  const m = /\/pull\/(\d+)/.exec(url);
  return m && m[1] ? Number(m[1]) : null;
}

async function linksFor(taskId: string, title: string, recordedPr: string): Promise<TaskLinks> {
  const meta = await readMeta(taskId);
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
  let key = /\b([A-Z]{2,5}-\d+)\b/.exec(title)?.[1] ?? "";
  if (!key) {
    const r = await run(bin("fm-tasks-axi.sh"), ["show", taskId, "--full"], { timeoutMs: 25_000 });
    key = /\b(LIV-\d+)\b/.exec(r.stdout)?.[1] ?? "";
  }
  const num = pr ? prNumber(pr) : null;
  return {
    linear: key && LINEAR_BASE ? { key, url: LINEAR_BASE + key } : null,
    pullRequest: pr && num !== null ? { number: num, url: pr } : null,
  };
}

const KIND_LABEL: Record<string, ActivityEvent["kind"]> = {
  done: "finished",
  resolved: "decision_made",
  "needs-decision": "decision_asked",
  blocked: "blocked",
};

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
          taskId,
          taskName: names.get(taskId) ?? taskId.replace(/-/g, " "),
          kind,
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

function taskKind(kind: string): Task["kind"] {
  return kind === "ship" || kind === "scout" ? kind : "other";
}

async function build(): Promise<Bearings> {
  const snap = await run(bin("fm-bearings-snapshot.sh"), ["--json"], { timeoutMs: 150_000 });
  if (snap.code !== 0 || !snap.stdout.trim())
    throw new Error((snap.stderr || "snapshot failed").trim().slice(0, 300));
  const raw = JSON.parse(snap.stdout) as RawSnapshot;
  const recordedPr = new Map(raw.recorded_prs.map((p) => [p.id, p.url]));
  const names = new Map(raw.in_flight.map((t) => [t.id, t.name]));

  const ids = [
    ...new Set([...raw.in_flight.map((t) => t.id), ...raw.recorded_prs.map((p) => p.id)]),
  ];
  const crew = new Map(await Promise.all(ids.map(async (id) => [id, await crewLine(id)] as const)));
  const pipelines = new Map(
    await Promise.all(ids.map(async (id) => [id, await pipelineFor(id)] as const)),
  );
  const links = new Map(
    await Promise.all(
      raw.in_flight.map(
        async (t) => [t.id, await linksFor(t.id, t.name, recordedPr.get(t.id) ?? "")] as const,
      ),
    ),
  );
  const holds = new Map(
    await Promise.all(raw.decisions_open.map(async (d) => [d.id, await holdReason(d.id)] as const)),
  );

  const underway: Task[] = raw.in_flight.map((t) => {
    const line = crew.get(t.id) || t.doing;
    const pipeline = pipelines.get(t.id) ?? null;
    const { state, sentence } = describeTask(line, pipeline, readyForReview(line));
    return {
      id: t.id,
      name: t.name,
      repo: t.repo,
      kind: taskKind(t.kind),
      state,
      status: sentence,
      links: links.get(t.id) ?? { linear: null, pullRequest: null },
      pipeline,
    };
  });

  const decisions: Decision[] = raw.decisions_open.map((d) => {
    const title = (d.summary.split(":")[0] ?? d.id).trim();
    const reason = holds.get(d.id) || d.summary;
    const qs = parseQuestions(reason);
    return {
      id: d.id,
      title,
      summary:
        qs.length > 0
          ? `${qs.length} question${qs.length === 1 ? "" : "s"} to answer. The recommended option is marked.`
          : "Needs your answer.",
      questions: qs.map((q, i) => ({ number: i + 1, title: q.title, options: q.options })),
      text: qs.length > 0 ? null : reason,
    };
  });

  const landedUrls = new Set(raw.landed.map((l) => l.artifact));
  const readyToMerge: ReadyToMerge[] = [];
  for (const p of raw.recorded_prs) {
    if (landedUrls.has(p.url) || !readyForReview(crew.get(p.id) ?? "")) continue;
    const number = prNumber(p.url);
    if (number === null) continue;
    readyToMerge.push({
      taskId: p.id,
      name: names.get(p.id) ?? p.id,
      summary: "Ready for you to review and merge.",
      pullRequest: { number, url: p.url },
    });
  }

  const landed: LandedItem[] = raw.landed.map((l) => {
    const isUrl = l.artifact.startsWith("http");
    return {
      id: l.id,
      title: l.what,
      kind: isUrl ? "pull_request" : "report",
      url: isUrl ? l.artifact : null,
      path: isUrl ? null : l.artifact,
    };
  });
  const queued: QueuedItem[] = raw.gates.map((g) => ({
    id: g.id ?? "",
    title: g.title ?? g.id ?? "",
    reason: firstSentence(g.reason ?? "", 110),
  }));

  return {
    generatedAt: null,
    nextRefreshAt: null,
    refreshing: false,
    error: null,
    counts: {
      waitingOnYou: decisions.length + readyToMerge.length,
      underway: underway.length,
      landed: landed.length,
      queued: queued.length,
    },
    waitingOnYou: { decisions, readyToMerge },
    underway,
    recentlyLanded: landed,
    queued,
    activity: await activityFeed(names),
    contributions: {
      known: raw.contributions.known,
      checked: raw.contributions.checked,
      complete: raw.contributions.complete,
    },
  };
}

// ---------- cache and refresh loop ----------

let current: Bearings | null = null;
let generatedMs = 0;
let refreshing = false;
let lastError: string | null = null;

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
  }
}

export function startRefreshLoop(): void {
  void refresh();
  setInterval(() => void refresh(), REFRESH_SECONDS * 1000).unref();
}

/** The latest bearings, or null before the first refresh finishes. */
export function getBearings(): Bearings | null {
  if (!current) return null;
  return {
    ...current,
    generatedAt: new Date(generatedMs).toISOString(),
    nextRefreshAt: new Date(generatedMs + REFRESH_SECONDS * 1000).toISOString(),
    refreshing,
    error: lastError,
  };
}

export function status(): {
  ready: boolean;
  refreshing: boolean;
  error: string | null;
  generatedAt: string | null;
} {
  return {
    ready: current !== null,
    refreshing,
    error: lastError,
    generatedAt: current ? new Date(generatedMs).toISOString() : null,
  };
}

// ---------- replies to firstmate (inbox notes) ----------

async function sendNote(body: string): Promise<void> {
  const r = await run(bin("fm-inbox.sh"), ["note", "--request-id", randomUUID(), "-"], {
    timeoutMs: 30_000,
    input: body,
  });
  if (r.code !== 0) throw new Error((r.stderr || r.stdout || "inbox failed").trim().slice(0, 200));
}

export async function sendGeneralNote(text: string): Promise<void> {
  await sendNote(`Reply from the Fleet Bearings API (general note):\n${text}`);
}

export type AnswerOutcome =
  | { ok: true }
  | { ok: false; status: 404 | 422; code: string; message: string };

export async function sendAnswers(decisionId: string, req: AnswerRequest): Promise<AnswerOutcome> {
  const b = getBearings();
  const decision = b?.waitingOnYou.decisions.find((d) => d.id === decisionId);
  if (!decision)
    return {
      ok: false,
      status: 404,
      code: "decision_not_found",
      message: `No open decision with id "${decisionId}".`,
    };
  const lines: string[] = [];
  for (const a of req.answers) {
    const q = decision.questions.find((x) => x.number === a.question);
    if (!q && decision.questions.length > 0) {
      return {
        ok: false,
        status: 422,
        code: "unknown_question",
        message: `Decision "${decisionId}" has no question ${a.question}.`,
      };
    }
    lines.push(q ? `${q.number}. ${q.title} → ${a.answer}` : a.answer);
  }
  await sendNote(
    `Reply from the Fleet Bearings API to the open question "${decision.title}" (task ${decision.id}):\n${lines.join("\n")}`,
  );
  return { ok: true };
}

export async function requestRefresh(): Promise<void> {
  void refresh();
}
