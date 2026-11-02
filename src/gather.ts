/**
 * Builds the {@link Bearings} snapshot, keeps it cached and refreshed, and sends notes to
 * Firstmate's inbox.
 *
 * @remarks
 * The snapshot is built by running scripts in `$FM_HOME/bin/` (plus `git`, `gh` and
 * `no-mistakes`) and reading `$FM_HOME/state/`. Building takes a while, so it runs in the
 * background on an interval and every request reads the cached result.
 *
 * @packageDocumentation
 */
import { spawn } from "node:child_process";
import type { ChildProcess } from "node:child_process";
import { randomUUID } from "node:crypto";
import { readdir, readFile, stat } from "node:fs/promises";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { stripVTControlCharacters } from "node:util";

import { integerSetting } from "./env.ts";
import {
  describeTask,
  firstSentence,
  parsePipeline,
  parseQuestions,
  parseSnapshot,
  plural,
  readyForReview,
  slugFromRemote,
  ticketKey,
} from "./status.ts";
import { ACTIVITY_LIMIT } from "./types.ts";
import type {
  ActivityEvent,
  AnswerRequest,
  Bearings,
  Decision,
  LandedItem,
  Pipeline,
  QueuedItem,
  RawDecision,
  RawGate,
  RawLanded,
  RawSnapshot,
  RawTask,
  ReadyToMerge,
  Task,
  TaskLinks,
} from "./types.ts";

// ---------- settings ----------

// HERE comes first because FM_HOME is built from it.
const HERE = path.dirname(fileURLToPath(import.meta.url));

/**
 * The Firstmate home directory.
 *
 * @defaultValue Two levels above this repo, which assumes the repo sits inside a Firstmate home.
 */
export const FM_HOME = process.env["FM_HOME"] ?? path.resolve(HERE, "..", "..", "..");

/** Status files untouched for longer than this are left out of the activity feed. */
const ACTIVITY_MAX_AGE_MS = 24 * 60 * 60 * 1000;

/** How many lines from the end of each status file the activity feed reads. */
const ACTIVITY_TAIL_LINES = 80;

/** The status file prefix for each kind of event the activity feed reports. */
const EVENT_KIND: Record<string, ActivityEvent["kind"]> = {
  blocked: "blocked",
  done: "finished",
  "needs-decision": "decision_asked",
  resolved: "decision_made",
};

/** How long a stopped command's process group gets to exit after SIGTERM, before SIGKILL. */
const KILL_GRACE_MS = 5000;

/** The base URL for ticket links, for example `https://linear.app/<workspace>/issue/`. */
const LINEAR_BASE = process.env["BEARINGS_LINEAR_BASE"] ?? "";

/**
 * The Linear team keys to recognise, for example `LIV,ENG`.
 *
 * @remarks
 * Tasks get a ticket link only when this and {@link LINEAR_BASE} are both set. Keys that are
 * not plain letters and digits are ignored, which keeps them safe to use in a regular expression.
 */
const LINEAR_TEAMS = (process.env["BEARINGS_LINEAR_TEAMS"] ?? "")
  .split(",")
  .map((team) => team.trim().toUpperCase())
  .filter((team) => /^[A-Z0-9]+$/.test(team));

/**
 * The most output a command may print, in bytes, across stdout and stderr. Past this it is
 * stopped.
 */
const MAX_OUTPUT_BYTES = 16 * 1024 * 1024;

/**
 * Seconds between scheduled rebuilds.
 *
 * @remarks
 * At least 10, since every rebuild runs dozens of processes. A bad value stops the server at
 * startup (see {@link integerSetting}).
 */
export const REFRESH_SECONDS = integerSetting("BEARINGS_API_REFRESH", 300, 10, 86_400);

/** After a failed rebuild, retry this soon rather than waiting a full interval. */
const RETRY_SECONDS = Math.min(30, REFRESH_SECONDS);

/**
 * How many tasks are inspected at once.
 *
 * @remarks
 * Each task spawns up to five processes (crew, no-mistakes, git, gh, fm-tasks), and hold reasons
 * are read alongside with the same limit, so a refresh peaks at about 6 × TASK_CONCURRENCY
 * processes.
 */
const TASK_CONCURRENCY = 4;

/** `owner/name` slugs by project directory. Remotes rarely change, so they are kept for good. */
const repoSlugCache = new Map<string, string>();

// ---------- types ----------

/** The outcome of an inbox write that can be refused before anything is sent. */
export type AnswerOutcome =
  | { ok: true }
  | {
      /** A stable error code for the API response. */
      code: string;
      /** A plain-English message for the API response. */
      message: string;
      ok: false;
      /** The HTTP status to respond with. */
      status: 404 | 422;
    };

/** Options for {@link run}. */
interface RunOptions {
  /** The working directory. Defaults to {@link FM_HOME}. */
  cwd?: string;
  /** Text to write to the command's stdin. */
  input?: string;
  /** How long to wait before the command is killed. Defaults to 60 seconds. */
  timeoutMs?: number;
}

/** What a finished command produced. Terminal colour codes are already stripped. */
interface RunResult {
  /** The exit code: 0 for success, and 1 when the command failed without one (timeout, missing). */
  code: number;
  /** Stderr, or the failure reason when the command produced none. */
  stderr: string;
  stdout: string;
}

/** The current state of the cache, as `GET /health` reports it. */
export interface ServiceStatus {
  /** The last refresh error, or `null` when the last refresh succeeded. */
  error: string | null;
  /** When the cached snapshot was built, or `null` before the first one. */
  generatedAt: string | null;
  /** Whether a snapshot exists yet. */
  ready: boolean;
  /** Whether a rebuild is running now. */
  refreshing: boolean;
}

/** What was learned about one task by running its scripts. */
interface TaskInfo {
  /** The first line of `fm-crew-state.sh <id>`. */
  crew: string;
  /** Ticket and pull request links, or `null` for tasks no longer in flight. */
  links: TaskLinks | null;
  /** The validation run, or `null` when there is none or the task is no longer in flight. */
  pipeline: Pipeline | null;
}

// ---------- building the snapshot ----------

/**
 * Read recent events from every `state/*.status` file.
 *
 * @remarks
 * A status line looks like `done [at=1730600000]: Shipped the fix.`. Only lines with a known
 * prefix (see {@link EVENT_KIND}) and an `at` timestamp become events. Files that cannot be read
 * are skipped.
 *
 * @param names - Task names by id, used to label each event.
 * @returns At most {@link ACTIVITY_LIMIT} events, newest first.
 */
async function activityFeed(names: Map<string, string>): Promise<ActivityEvent[]> {
  const stateDir = path.join(FM_HOME, "state");
  let files: string[];
  try {
    files = (await readdir(stateDir)).filter((file) => file.endsWith(".status"));
  } catch {
    return [];
  }

  const events: ActivityEvent[] = [];
  const now = Date.now();
  for (const file of files) {
    const filePath = path.join(stateDir, file);
    const taskId = file.slice(0, -".status".length);
    try {
      if (now - (await stat(filePath)).mtimeMs > ACTIVITY_MAX_AGE_MS) continue;
      const lines = (await readFile(filePath, "utf8")).split("\n").slice(-ACTIVITY_TAIL_LINES);
      for (const line of lines) {
        // prefix, then zero or more ` [key=value]` tags, then `: text`.
        const match = /^([\w-]+)((?: \[[^\]]+\])*):\s*(.*)$/.exec(line);
        const kind = match?.[1] ? EVENT_KIND[match[1]] : undefined;
        const atSeconds = match?.[2] ? /\[at=(\d+)\]/.exec(match[2])?.[1] : undefined;
        if (!kind || !atSeconds) continue;
        events.push({
          at: new Date(Number(atSeconds) * 1000).toISOString(),
          kind,
          taskId,
          taskName: names.get(taskId) ?? taskId.replace(/-/g, " "),
          text: firstSentence(match?.[3] ?? "", 150),
        });
      }
    } catch {
      // The file vanished or is unreadable; leave its events out.
    }
  }
  events.sort((a, b) => b.at.localeCompare(a.at));
  return events.slice(0, ACTIVITY_LIMIT);
}

/** The path of a Firstmate script in `$FM_HOME/bin/`. */
function bin(name: string): string {
  return path.join(FM_HOME, "bin", name);
}

/**
 * Build a fresh snapshot.
 *
 * @remarks
 * The time fields (`generatedAt`, `nextRefreshAt`, `refreshing`, `error`) are left empty here;
 * {@link getBearings} fills them in from the cache state when the snapshot is read.
 *
 * @throws When the snapshot script fails or prints something that is not JSON.
 */
async function build(): Promise<Bearings> {
  const raw = await readSnapshot();
  const names = new Map(raw.in_flight.map((task) => [task.id, task.name]));
  const recordedPrs = new Map(raw.recorded_prs.map((pr) => [pr.id, pr.url]));

  // Every task in flight, plus finished ones with a recorded PR, which may be ready to merge.
  const taskIds = [...new Set([...names.keys(), ...recordedPrs.keys()])];
  const [infoList, holdReasons, activity] = await Promise.all([
    mapLimit(taskIds, TASK_CONCURRENCY, (id) =>
      taskInfo(id, names.get(id), recordedPrs.get(id) ?? ""),
    ),
    mapLimit(raw.decisions_open, TASK_CONCURRENCY, (decision) => holdReason(decision.id)),
    activityFeed(names),
  ]);
  const infoById = new Map(taskIds.map((id, i) => [id, infoList[i]]));

  const underway = raw.in_flight.map((task) => toTask(task, infoById.get(task.id)));
  const decisions = raw.decisions_open.map((decision, i) =>
    toDecision(decision, holdReasons[i] || decision.summary),
  );
  const readyToMerge = findReadyToMerge(raw, infoById, names);
  const recentlyLanded = raw.landed.map(toLandedItem);
  const queued = raw.gates.map(toQueuedItem);

  return {
    activity,
    contributions: {
      checked: raw.contributions.checked,
      complete: raw.contributions.complete,
      known: raw.contributions.known,
    },
    counts: {
      landed: recentlyLanded.length,
      queued: queued.length,
      underway: underway.length,
      waitingOnYou: decisions.length + readyToMerge.length,
    },
    error: null,
    generatedAt: null,
    nextRefreshAt: null,
    queued,
    recentlyLanded,
    refreshing: false,
    underway,
    waitingOnYou: { decisions, readyToMerge },
  };
}

/** The first line of `fm-crew-state.sh <id>` (or of its stderr), at most 400 characters. */
async function crewLine(taskId: string): Promise<string> {
  const result = await run(bin("fm-crew-state.sh"), [taskId], { timeoutMs: 30_000 });
  const firstLine = (result.stdout || result.stderr).trim().split("\n")[0] ?? "";
  return firstLine.slice(0, 400);
}

/**
 * The pull requests waiting for the captain to merge.
 *
 * @remarks
 * A recorded pull request is ready when it has not landed yet and its task's crew line says
 * the checks are green.
 */
function findReadyToMerge(
  raw: RawSnapshot,
  infoById: Map<string, TaskInfo | undefined>,
  names: Map<string, string>,
): ReadyToMerge[] {
  const landedUrls = new Set(raw.landed.map((item) => item.artifact));
  const ready: ReadyToMerge[] = [];
  for (const pr of raw.recorded_prs) {
    if (landedUrls.has(pr.url)) continue;
    if (!readyForReview(infoById.get(pr.id)?.crew ?? "")) continue;
    const number = prNumber(pr.url);
    if (number === null) continue;
    ready.push({
      name: names.get(pr.id) ?? pr.id,
      pullRequest: { number, url: pr.url },
      summary: "Ready for you to review and merge.",
      taskId: pr.id,
    });
  }
  return ready;
}

/** A task's hold reason from `fm-tasks-axi.sh show <id>`, or `""` when it has none. */
async function holdReason(taskId: string): Promise<string> {
  const result = await run(bin("fm-tasks-axi.sh"), ["show", taskId], { timeoutMs: 30_000 });
  const reason = /hold_reason: "?(.*?)"?$/m.exec(result.stdout)?.[1];
  return reason && reason !== "-" ? reason : "";
}

/**
 * Stop a command and everything it started.
 *
 * @remarks
 * {@link run} starts each command in its own process group, so signalling the group also
 * reaches the processes a script started (`git`, `gh`, ...). Signalling only the script would
 * leave those running. The group gets SIGTERM, then SIGKILL after {@link KILL_GRACE_MS} if any
 * of it is still there.
 */
function killGroup(child: ChildProcess): void {
  const pid = child.pid;
  if (pid === undefined) return;
  /** Signal the group. False when it is already gone. */
  const signalGroup = (signal: NodeJS.Signals): boolean => {
    try {
      process.kill(-pid, signal);
      return true;
    } catch {
      return false;
    }
  };
  if (signalGroup("SIGTERM")) setTimeout(() => signalGroup("SIGKILL"), KILL_GRACE_MS).unref();
}

/**
 * Find a task's pull request and Linear ticket.
 *
 * @remarks
 * The pull request is the recorded one, else the one in the task's meta file, else the open PR
 * for the task's branch on GitHub. The ticket key is looked for in the title first, then in the
 * task's full record. Lookups that fail leave the link `null`.
 *
 * @param taskId - The task id.
 * @param meta - The task's meta file (see {@link readMeta}).
 * @param title - The task's name.
 * @param recordedPr - The PR URL the snapshot recorded for the task, or `""`.
 */
async function linksFor(
  taskId: string,
  meta: Record<string, string>,
  title: string,
  recordedPr: string,
): Promise<TaskLinks> {
  let prUrl = recordedPr || meta["pr"] || "";
  const branch = meta["branch"];
  const project = meta["project"];
  if (!prUrl && branch && project) prUrl = await openPrForBranch(project, branch);

  let key = "";
  if (LINEAR_BASE && LINEAR_TEAMS.length > 0) {
    key = ticketKey(title, LINEAR_TEAMS);
    if (!key) {
      const result = await run(bin("fm-tasks-axi.sh"), ["show", taskId, "--full"], {
        timeoutMs: 25_000,
      });
      key = ticketKey(result.stdout, LINEAR_TEAMS);
    }
  }

  const number = prUrl ? prNumber(prUrl) : null;
  return {
    linear: key ? { key, url: LINEAR_BASE + key } : null,
    pullRequest: number === null ? null : { number, url: prUrl },
  };
}

/**
 * Like `Promise.all(items.map(fn))`, but with at most `limit` calls running at once.
 *
 * @typeParam T - The item type.
 * @typeParam R - The result type.
 * @returns The results, in the same order as `items`.
 */
async function mapLimit<T, R>(
  items: T[],
  limit: number,
  fn: (item: T) => Promise<R>,
): Promise<R[]> {
  const results: R[] = [];
  let nextIndex = 0;
  // Each worker takes the next unclaimed item until none are left.
  const worker = async (): Promise<void> => {
    while (nextIndex < items.length) {
      const index = nextIndex++;
      results[index] = await fn(items[index] as T);
    }
  };
  await Promise.all(Array.from({ length: Math.min(limit, items.length) }, worker));
  return results;
}

/**
 * The URL of the open GitHub pull request for a branch, or `""` when there is none or the
 * project is not on GitHub.
 */
async function openPrForBranch(projectDir: string, branch: string): Promise<string> {
  const slug = await repoSlug(projectDir);
  if (!slug) return "";
  const args = ["pr", "list", "-R", slug, "--head", branch, "--state", "open"];
  const result = await run("gh", [...args, "--json", "url", "--jq", ".[0].url"], {
    timeoutMs: 25_000,
  });
  const url = result.stdout.trim();
  return result.code === 0 && url.startsWith("http") ? url : "";
}

/**
 * A task's no-mistakes validation run.
 *
 * @returns The run, or `null` when the task does not use no-mistakes, its worktree is gone, or
 *   the status output cannot be parsed.
 */
async function pipelineFor(meta: Record<string, string>): Promise<Pipeline | null> {
  const worktree = meta["worktree"];
  if (meta["mode"] !== "no-mistakes" || !worktree) return null;
  try {
    await stat(worktree);
  } catch {
    return null;
  }
  const result = await run("no-mistakes", ["axi", "status"], { cwd: worktree, timeoutMs: 40_000 });
  return result.stdout ? parsePipeline(result.stdout) : null;
}

/** The number in a GitHub pull request URL, or `null` when the URL is not a pull request. */
function prNumber(url: string): number | null {
  const digits = /\/pull\/(\d+)/.exec(url)?.[1];
  return digits ? Number(digits) : null;
}

/**
 * Read `state/<id>.meta`, a file of `key=value` lines.
 *
 * @returns The keys and values, or an empty object when the task has no meta file.
 */
async function readMeta(taskId: string): Promise<Record<string, string>> {
  const meta: Record<string, string> = {};
  let text: string;
  try {
    text = await readFile(path.join(FM_HOME, "state", `${taskId}.meta`), "utf8");
  } catch {
    return meta;
  }
  for (const line of text.split("\n")) {
    const equals = line.indexOf("=");
    if (equals > 0) meta[line.slice(0, equals)] = line.slice(equals + 1);
  }
  return meta;
}

/**
 * Run `fm-bearings-snapshot.sh --json` and parse its output.
 *
 * @throws When the script fails or prints nothing, or its output is not the expected JSON
 *   (see {@link parseSnapshot}).
 */
async function readSnapshot(): Promise<RawSnapshot> {
  const result = await run(bin("fm-bearings-snapshot.sh"), ["--json"], { timeoutMs: 150_000 });
  if (result.code !== 0 || !result.stdout.trim()) {
    throw new Error((result.stderr || "snapshot failed").trim().slice(0, 300));
  }
  return parseSnapshot(result.stdout);
}

/** The GitHub `owner/name` of a project's `origin` remote, or `""` when it is not on GitHub. */
async function repoSlug(projectDir: string): Promise<string> {
  const cached = repoSlugCache.get(projectDir);
  if (cached !== undefined) return cached;
  const result = await run("git", ["-C", projectDir, "remote", "get-url", "origin"], {
    timeoutMs: 10_000,
  });
  const slug = slugFromRemote(result.stdout);
  // Only cache a real answer, so a timeout is retried on the next refresh.
  if (result.code === 0) repoSlugCache.set(projectDir, slug);
  return slug;
}

/**
 * Run a command and collect its output.
 *
 * @remarks
 * This never rejects: a failure is reported through {@link RunResult.code}. The command gets
 * `FM_HOME` and `NO_COLOR=1` in its environment. It runs in its own process group, so when it
 * times out or prints more than {@link MAX_OUTPUT_BYTES}, {@link killGroup} stops it along with
 * everything it started.
 */
function run(cmd: string, args: string[], opts: RunOptions = {}): Promise<RunResult> {
  return new Promise((resolve) => {
    const timeoutMs = opts.timeoutMs ?? 60_000;
    const child = spawn(cmd, args, {
      cwd: opts.cwd ?? FM_HOME,
      detached: true,
      env: { ...process.env, FM_HOME, NO_COLOR: "1" },
      stdio: [opts.input === undefined ? "ignore" : "pipe", "pipe", "pipe"],
    });

    const stdout: Buffer[] = [];
    const stderr: Buffer[] = [];
    let outputBytes = 0;
    /** Why the command was stopped, or `""` while it has not been. */
    let stoppedBecause = "";
    let settled = false;

    const stop = (reason: string): void => {
      if (stoppedBecause) return;
      stoppedBecause = reason;
      killGroup(child);
    };
    const timer = setTimeout(() => stop(`timed out after ${timeoutMs / 1000}s`), timeoutMs);

    const collect =
      (into: Buffer[]) =>
      (chunk: Buffer): void => {
        outputBytes += chunk.length;
        if (outputBytes > MAX_OUTPUT_BYTES) return stop("printed too much output");
        into.push(chunk);
      };
    child.stdout?.on("data", collect(stdout));
    child.stderr?.on("data", collect(stderr));

    /** Resolve once, whichever of `error` and `close` comes first. */
    const finish = (code: number, reason: string): void => {
      if (settled) return;
      settled = true;
      clearTimeout(timer);
      const errorText = stripVTControlCharacters(Buffer.concat(stderr).toString("utf8"));
      const stopped = stoppedBecause ? `${path.basename(cmd)} ${stoppedBecause}.` : "";
      resolve({
        code: stoppedBecause ? 1 : code,
        // A missing binary or a timeout leaves stderr empty, so give the reason instead.
        stderr: [stopped, errorText || reason].filter(Boolean).join(" "),
        stdout: stripVTControlCharacters(Buffer.concat(stdout).toString("utf8")),
      });
    };
    // `error` is a command that could not start, such as a missing binary.
    child.on("error", (error) => finish(1, error.message));
    child.on("close", (code, signal) => finish(code ?? 1, signal ? `killed by ${signal}` : ""));

    if (opts.input !== undefined) {
      // EPIPE when the child exits before reading; the exit code already reports the failure.
      child.stdin?.on("error", () => {});
      child.stdin?.end(opts.input);
    }
  });
}

/**
 * Gather what is known about one task.
 *
 * @param taskId - The task id.
 * @param title - The task's name when it is in flight, or `undefined` when it is not. Only
 *   tasks in flight get a pipeline and links; for the others only the crew line is needed.
 * @param recordedPr - The PR URL the snapshot recorded for the task, or `""`.
 */
async function taskInfo(
  taskId: string,
  title: string | undefined,
  recordedPr: string,
): Promise<TaskInfo> {
  const meta = await readMeta(taskId);
  const inFlight = title !== undefined;
  const [crew, pipeline, links] = await Promise.all([
    crewLine(taskId),
    inFlight ? pipelineFor(meta) : null,
    inFlight ? linksFor(taskId, meta, title, recordedPr) : null,
  ]);
  return { crew, links, pipeline };
}

/** Turn an open decision and its hold reason into a {@link Decision}. */
function toDecision(decision: RawDecision, reason: string): Decision {
  const questions = parseQuestions(reason);
  const hasQuestions = questions.length > 0;
  return {
    id: decision.id,
    questions: questions.map((question, i) => ({ number: i + 1, ...question })),
    summary: hasQuestions
      ? `${plural(questions.length, "question")} to answer. The recommended option is marked.`
      : "Needs your answer.",
    text: hasQuestions ? null : reason,
    title: decision.summary.split(":")[0]?.trim() || decision.id,
  };
}

/** Turn a landed artifact into a {@link LandedItem}. URLs are pull requests, paths are reports. */
function toLandedItem(item: RawLanded): LandedItem {
  const isUrl = item.artifact.startsWith("http");
  return {
    id: item.id,
    kind: isUrl ? "pull_request" : "report",
    path: isUrl ? null : item.artifact,
    title: item.what,
    url: isUrl ? item.artifact : null,
  };
}

/** Turn a gate into a {@link QueuedItem}. */
function toQueuedItem(gate: RawGate): QueuedItem {
  return {
    id: gate.id ?? "",
    reason: firstSentence(gate.reason ?? "", 110),
    title: gate.title ?? gate.id ?? "",
  };
}

/** Turn a task in flight, plus what was gathered about it, into a {@link Task}. */
function toTask(task: RawTask, info: TaskInfo | undefined): Task {
  const line = info?.crew || task.doing;
  const pipeline = info?.pipeline ?? null;
  const { sentence, state } = describeTask(line, pipeline, readyForReview(line));
  return {
    id: task.id,
    kind: task.kind === "ship" || task.kind === "scout" ? task.kind : "other",
    links: info?.links ?? { linear: null, pullRequest: null },
    name: task.name,
    pipeline,
    repo: task.repo,
    state,
    status: sentence,
  };
}

// ---------- cache and refresh loop ----------

/** The last snapshot that built successfully, or `null` before the first one. */
let current: Bearings | null = null;
/** When {@link current} was built, in epoch milliseconds. */
let generatedMs = 0;
/** The error from the last rebuild, or `null` when it succeeded. */
let lastError: string | null = null;
/** When the next scheduled rebuild is due, in epoch milliseconds. */
let nextMs = 0;
/** True while a rebuild is running. Stops two rebuilds from overlapping. */
let refreshing = false;
/** The timer for the next scheduled rebuild. */
let timer: ReturnType<typeof setTimeout> | undefined;

/**
 * The latest snapshot, with its time fields filled in.
 *
 * @returns The snapshot, or `null` before the first rebuild finishes.
 */
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

/**
 * Rebuild the snapshot now, unless a rebuild is already running.
 *
 * @remarks
 * Every rebuild that finishes, scheduled or manual, schedules the next one: a full interval
 * later after a success, or {@link RETRY_SECONDS} later after a failure. A failure keeps the
 * previous snapshot and records the error. This never rejects.
 */
async function refresh(): Promise<void> {
  if (refreshing) return;
  refreshing = true;
  try {
    current = await build();
    generatedMs = Date.now();
    lastError = null;
  } catch (error) {
    lastError = error instanceof Error ? error.message.slice(0, 300) : "refresh failed";
  } finally {
    refreshing = false;
    clearTimeout(timer);
    const waitMs = (lastError ? RETRY_SECONDS : REFRESH_SECONDS) * 1000;
    nextMs = Date.now() + waitMs;
    timer = setTimeout(() => void refresh(), waitMs);
    // Don't keep the process alive just for the next rebuild.
    timer.unref();
  }
}

/**
 * Start a rebuild in the background and return at once.
 *
 * @remarks
 * The server calls this at startup to build the first snapshot, after which each rebuild
 * schedules the next, and for `POST /api/v1/refresh`.
 */
export function refreshInBackground(): void {
  void refresh();
}

/** The cache state, for `GET /health`. */
export function status(): ServiceStatus {
  return {
    error: lastError,
    generatedAt: current ? new Date(generatedMs).toISOString() : null,
    ready: current !== null,
    refreshing,
  };
}

// ---------- replies to Firstmate (inbox notes) ----------

/**
 * Send answers to an open decision's questions to Firstmate as an inbox note.
 *
 * @remarks
 * Firstmate reads the note and records the decision itself, so the decision stays open until
 * it does. A decision with no structured questions takes one free-text answer as question 1.
 *
 * @param decisionId - The id of the task the decision gates.
 * @param request - The validated request body.
 * @returns `ok: true` once the note is recorded, or the reason nothing was sent.
 * @throws When the inbox script fails.
 */
export async function sendAnswers(
  decisionId: string,
  request: AnswerRequest,
): Promise<AnswerOutcome> {
  const decision = getBearings()?.waitingOnYou.decisions.find((d) => d.id === decisionId);
  if (!decision) {
    return {
      code: "decision_not_found",
      message: `No open decision with id "${decisionId}".`,
      ok: false,
      status: 404,
    };
  }

  const isFreeText = decision.questions.length === 0;
  const lines: string[] = [];
  for (const { answer, question: number } of request.answers) {
    const question = decision.questions.find((q) => q.number === number);
    // One line per answer, so an answer cannot add lines that look like part of the note.
    const oneLine = answer.replace(/\s+/g, " ");
    if (question) {
      lines.push(`${question.number}. ${question.title} → ${oneLine}`);
    } else if (isFreeText && number === 1) {
      lines.push(oneLine);
    } else {
      return {
        code: "unknown_question",
        message: `Decision "${decisionId}" has no question ${number}.`,
        ok: false,
        status: 422,
      };
    }
  }

  await sendNote(
    `Reply from the Fleet Bearings API to the open question "${decision.title}" (task ${decision.id}):\n${lines.join("\n")}`,
  );
  return { ok: true };
}

/**
 * Send a free-form note to Firstmate's inbox.
 *
 * @throws When the inbox script fails.
 */
export async function sendGeneralNote(text: string): Promise<void> {
  await sendNote(`Reply from the Fleet Bearings API (general note):\n${text}`);
}

/**
 * Pipe a note into `fm-inbox.sh note`, with a fresh request id so it is recorded once.
 *
 * @throws When the inbox script exits with an error. The message is the script's output.
 */
async function sendNote(body: string): Promise<void> {
  const result = await run(bin("fm-inbox.sh"), ["note", "--request-id", randomUUID(), "-"], {
    input: body,
    timeoutMs: 30_000,
  });
  if (result.code !== 0) {
    throw new Error((result.stderr || result.stdout || "inbox failed").trim().slice(0, 200));
  }
}
