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
import { open, readdir, readFile, stat } from "node:fs/promises";
import path from "node:path";
import { setTimeout as delay } from "node:timers/promises";
import { stripVTControlCharacters } from "node:util";

import { settings } from "./env.ts";
import { TaskMetaSchema } from "./schemas.ts";
import type {
  AnswerRequest,
  RawDecision,
  RawGate,
  RawLanded,
  RawSnapshot,
  RawTask,
  TaskMeta,
} from "./schemas.ts";
import {
  describeTask,
  firstSentence,
  parseHoldReason,
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
  Bearings,
  Decision,
  Health,
  LandedItem,
  Pipeline,
  QueuedItem,
  ReadyToMerge,
  Task,
  TaskLinks,
} from "./types.ts";

// ---------- settings ----------

/**
 * The Firstmate home directory.
 *
 * @defaultValue Two levels above this repo, which assumes the repo sits inside a Firstmate home.
 */
export const FM_HOME = settings.fmHome;

/** Events older than this are left out of the activity feed. */
const ACTIVITY_MAX_AGE_MS = 24 * 60 * 60 * 1000;

/** How many bytes from the end of each status file the activity feed reads at most. */
const ACTIVITY_TAIL_BYTES = 64 * 1024;

/** How many lines from the end of each status file the activity feed reads. */
const ACTIVITY_TAIL_LINES = 80;

/** The status file prefix for each kind of event the activity feed reports. */
const EVENT_KIND: Record<string, ActivityEvent["kind"]> = {
  blocked: "blocked",
  done: "finished",
  "needs-decision": "decision_asked",
  resolved: "decision_made",
};

/** The command that runs the GitHub CLI. */
const GH = settings.ghBin;

/** The command that runs git. */
const GIT = settings.gitBin;

/** How long a stopped command's process group gets to exit after SIGTERM, before SIGKILL. */
const KILL_GRACE_MS = 5000;

/** The base URL for ticket links, for example `https://linear.app/<workspace>/issue/`. */
const LINEAR_BASE = settings.linearBase;

/**
 * The Linear team keys to recognise, for example `["LIV", "ENG"]`.
 *
 * @remarks
 * Tasks get a ticket link only when this and {@link LINEAR_BASE} are both set. The settings
 * check refuses keys that are not plain letters and digits, which keeps them safe to use in a
 * regular expression.
 */
const LINEAR_TEAMS = settings.linearTeams;

/**
 * The most output a command may print, in bytes, across stdout and stderr. Past this it is
 * stopped.
 */
const MAX_OUTPUT_BYTES = 16 * 1024 * 1024;

/** The command that runs no-mistakes. */
const NO_MISTAKES = settings.noMistakesBin;

/**
 * Seconds between scheduled rebuilds.
 *
 * @remarks
 * At least 10, since every rebuild runs dozens of processes. A bad value stops the server at
 * startup (see `env.ts`).
 */
export const REFRESH_SECONDS = settings.refreshSeconds;

/** After a failed rebuild, retry this soon rather than waiting a full interval. */
const RETRY_SECONDS = Math.min(30, REFRESH_SECONDS);

/**
 * How many tasks are inspected at once.
 *
 * @remarks
 * Each task spawns up to five processes (crew, no-mistakes, git, gh, fm-tasks), and hold reasons
 * are read alongside with the same limit, so a refresh peaks at about 6 × TASK_CONCURRENCY
 * processes. The pull request checks for {@link findReadyToMerge} come after, with the same
 * limit.
 */
const TASK_CONCURRENCY = 4;

/** Every command {@link run} has started that has not finished yet, for {@link stopCommands}. */
const liveChildren = new Set<ChildProcess>();

/** `owner/name` slugs by project directory. Remotes rarely change, so they are kept for good. */
const repoSlugCache = new Map<string, string>();

/** True once {@link stopCommands} has been called. No more rebuilds start after that. */
let stopping = false;

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

/** The current state of the cache: what `GET /health` reports, apart from `ok`. */
export type ServiceStatus = Omit<Health, "ok">;

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
 * prefix (see {@link EVENT_KIND}) and an `at` timestamp in epoch seconds (at most 10 digits)
 * become events, and only events from the last {@link ACTIVITY_MAX_AGE_MS}. A line with a bad
 * timestamp is skipped on its own. Files that cannot be read are skipped, and files untouched
 * for longer than the maximum age are not opened.
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
      if (now - (await stat(filePath)).mtimeMs > ACTIVITY_MAX_AGE_MS) {
        continue;
      }

      const tail = await readTail(filePath, ACTIVITY_TAIL_BYTES);
      const lines = tail.split("\n").slice(-ACTIVITY_TAIL_LINES);

      for (const line of lines) {
        // prefix, then zero or more ` [key=value]` tags, then `: text`.
        const match = /^([\w-]+)((?: \[[^\]]+\])*):\s*(.*)$/.exec(line);
        const kind = match?.[1] ? EVENT_KIND[match[1]] : undefined;
        // Ten digits of seconds reach the year 2286. More is not seconds (often milliseconds),
        // and would make a date `toISOString` cannot write in the usual form.
        const atSeconds = match?.[2] ? /\[at=(\d{1,10})\]/.exec(match[2])?.[1] : undefined;
        const atMs = Number(atSeconds) * 1000;

        if (!kind || !atSeconds || now - atMs > ACTIVITY_MAX_AGE_MS) {
          continue;
        }

        events.push({
          at: new Date(atMs).toISOString(),
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
  const readyToMerge = await findReadyToMerge(raw, infoById, names);
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
 * A recorded pull request is ready when it has not landed yet, its task's crew line says the
 * checks are green, and GitHub does not say it is merged or closed (see {@link prStillOpen}).
 * The last check catches pull requests merged long enough ago to have left the landed list.
 */
async function findReadyToMerge(
  raw: RawSnapshot,
  infoById: Map<string, TaskInfo | undefined>,
  names: Map<string, string>,
): Promise<ReadyToMerge[]> {
  const landedUrls = new Set(raw.landed.map((item) => item.artifact));
  const candidates: ReadyToMerge[] = [];

  for (const pr of raw.recorded_prs) {
    if (landedUrls.has(pr.url)) {
      continue;
    }
    if (!readyForReview(infoById.get(pr.id)?.crew ?? "")) {
      continue;
    }

    const number = prNumber(pr.url);

    if (number === null) {
      continue;
    }

    candidates.push({
      name: names.get(pr.id) ?? pr.id,
      pullRequest: { number, url: pr.url },
      summary: "Ready for you to review and merge.",
      taskId: pr.id,
    });
  }

  const open = await mapLimit(candidates, TASK_CONCURRENCY, (candidate) =>
    prStillOpen(candidate.pullRequest.url),
  );

  return candidates.filter((_candidate, i) => open[i]);
}

/** A task's hold reason from `fm-tasks-axi.sh show <id>`, or `""` when it has none. */
async function holdReason(taskId: string): Promise<string> {
  const result = await run(bin("fm-tasks-axi.sh"), ["show", taskId], { timeoutMs: 30_000 });

  return parseHoldReason(result.stdout);
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
  if (signalGroup(child, "SIGTERM")) {
    setTimeout(() => signalGroup(child, "SIGKILL"), KILL_GRACE_MS).unref();
  }
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
  meta: TaskMeta,
  title: string,
  recordedPr: string,
): Promise<TaskLinks> {
  let prUrl = recordedPr || meta.pr || "";
  const { branch, project } = meta;

  if (!prUrl && branch && project) {
    prUrl = await openPrForBranch(project, branch);
  }

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

  if (!slug) {
    return "";
  }

  const args = ["pr", "list", "-R", slug, "--head", branch, "--state", "open"];
  const result = await run(GH, [...args, "--json", "url", "--jq", ".[0].url"], {
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
async function pipelineFor(meta: TaskMeta): Promise<Pipeline | null> {
  const { worktree } = meta;

  if (meta.mode !== "no-mistakes" || !worktree) {
    return null;
  }
  try {
    await stat(worktree);
  } catch {
    return null;
  }

  const result = await run(NO_MISTAKES, ["axi", "status"], { cwd: worktree, timeoutMs: 40_000 });

  return result.stdout ? parsePipeline(result.stdout) : null;
}

/** The number in a GitHub pull request URL, or `null` when the URL is not a pull request. */
function prNumber(url: string): number | null {
  const digits = /\/pull\/(\d+)/.exec(url)?.[1];

  return digits ? Number(digits) : null;
}

/**
 * Whether a pull request is still open, according to `gh pr view`.
 *
 * @remarks
 * Only a clear answer other than `OPEN` (such as `MERGED` or `CLOSED`) counts as not open. When
 * `gh` fails, for example because it is missing or not signed in, the pull request counts as
 * open, so it is not hidden just because GitHub could not be asked.
 */
async function prStillOpen(url: string): Promise<boolean> {
  const result = await run(GH, ["pr", "view", url, "--json", "state", "--jq", ".state"], {
    timeoutMs: 25_000,
  });
  const state = result.stdout.trim();

  return result.code !== 0 || state === "" || state === "OPEN";
}

/**
 * Read `state/<id>.meta`, a file of `key=value` lines, and keep the keys this API reads.
 *
 * @returns The keys and values (see {@link TaskMetaSchema}), or an empty object when the task
 *   has no meta file.
 */
async function readMeta(taskId: string): Promise<TaskMeta> {
  const pairs: Record<string, string> = {};
  let text: string;

  try {
    text = await readFile(path.join(FM_HOME, "state", `${taskId}.meta`), "utf8");
  } catch {
    return {};
  }
  for (const line of text.split("\n")) {
    const equals = line.indexOf("=");

    if (equals > 0) {
      pairs[line.slice(0, equals)] = line.slice(equals + 1);
    }
  }

  return TaskMetaSchema.parse(pairs);
}

/**
 * Read the end of a file: at most `maxBytes`, starting at a line boundary.
 *
 * @param filePath - The file to read.
 * @param maxBytes - The most bytes to read from the end.
 * @returns The text. When the file is longer than `maxBytes`, the first, probably cut, line is
 *   left out.
 */
async function readTail(filePath: string, maxBytes: number): Promise<string> {
  const handle = await open(filePath, "r");

  try {
    const { size } = await handle.stat();
    const start = Math.max(0, size - maxBytes);
    const buffer = Buffer.alloc(size - start);
    const { bytesRead } = await handle.read(buffer, 0, buffer.length, start);
    const text = buffer.subarray(0, bytesRead).toString("utf8");

    return start > 0 ? text.slice(text.indexOf("\n") + 1) : text;
  } finally {
    await handle.close();
  }
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

  if (cached !== undefined) {
    return cached;
  }

  const result = await run(GIT, ["-C", projectDir, "remote", "get-url", "origin"], {
    timeoutMs: 10_000,
  });
  const slug = slugFromRemote(result.stdout);

  // Only cache a real answer, so a timeout is retried on the next refresh.
  if (result.code === 0) {
    repoSlugCache.set(projectDir, slug);
  }

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

    liveChildren.add(child);

    const stdout: Buffer[] = [];
    const stderr: Buffer[] = [];
    let outputBytes = 0;
    /** Why the command was stopped, or `""` while it has not been. */
    let stoppedBecause = "";
    let settled = false;

    const stop = (reason: string): void => {
      if (stoppedBecause) {
        return;
      }
      stoppedBecause = reason;
      killGroup(child);
    };
    const timer = setTimeout(() => stop(`timed out after ${timeoutMs / 1000}s`), timeoutMs);

    const collect =
      (into: Buffer[]) =>
      (chunk: Buffer): void => {
        outputBytes += chunk.length;
        if (outputBytes > MAX_OUTPUT_BYTES) {
          return stop("printed too much output");
        }

        into.push(chunk);
      };

    child.stdout?.on("data", collect(stdout));
    child.stderr?.on("data", collect(stderr));

    /** Resolve once, whichever of `error` and `close` comes first. */
    const finish = (code: number, reason: string): void => {
      if (settled) {
        return;
      }
      settled = true;
      clearTimeout(timer);
      liveChildren.delete(child);

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
 * Send a signal to a command's process group (see {@link run}).
 *
 * @returns False when the group is already gone.
 */
function signalGroup(child: ChildProcess, signal: NodeJS.Signals): boolean {
  if (child.pid === undefined) {
    return false;
  }
  try {
    process.kill(-child.pid, signal);

    return true;
  } catch {
    return false;
  }
}

/**
 * Stop every running command, for a clean shutdown, and start no more rebuilds.
 *
 * @remarks
 * Commands run in their own process groups, so they do not get the terminal's Ctrl-C and would
 * outlive the server. Each group gets SIGTERM; any still running after {@link KILL_GRACE_MS}
 * gets SIGKILL. This resolves once all have exited or been sent SIGKILL.
 */
export async function stopCommands(): Promise<void> {
  stopping = true;
  clearTimeout(timer);

  for (const child of liveChildren) {
    signalGroup(child, "SIGTERM");
  }

  const deadline = Date.now() + KILL_GRACE_MS;

  while (liveChildren.size > 0 && Date.now() < deadline) {
    await delay(100);
  }
  for (const child of liveChildren) {
    signalGroup(child, "SIGKILL");
  }
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
  if (!current) {
    return null;
  }

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
 * previous snapshot and records the error. After {@link stopCommands}, nothing more is
 * scheduled. This never rejects.
 */
async function refresh(): Promise<void> {
  if (refreshing || stopping) {
    return;
  }
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
  }

  // After stopCommands, the build above failed or was cut short; schedule nothing more.
  if (!stopping) {
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
 * @param requestId - The note's request id (see {@link sendNote}).
 * @returns `ok: true` once the note is recorded, or the reason nothing was sent.
 * @throws When the inbox script fails.
 */
export async function sendAnswers(
  decisionId: string,
  request: AnswerRequest,
  requestId?: string,
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
    requestId,
  );

  return { ok: true };
}

/**
 * Send a free-form note to Firstmate's inbox.
 *
 * @param text - The note.
 * @param requestId - The note's request id (see {@link sendNote}).
 * @throws When the inbox script fails.
 */
export async function sendGeneralNote(text: string, requestId?: string): Promise<void> {
  await sendNote(`Reply from the Fleet Bearings API (general note):\n${text}`, requestId);
}

/**
 * Pipe a note into `fm-inbox.sh note --request-id <id>`.
 *
 * @remarks
 * `fm-inbox.sh` records a note once per request id. The id is the caller's `Idempotency-Key`
 * when it sent one, so a retried request does not add the note twice, and a fresh UUID
 * otherwise.
 *
 * @param body - The note.
 * @param requestId - The request id, or `undefined` for a fresh one.
 * @throws When the inbox script exits with an error. The message is the script's output.
 */
async function sendNote(body: string, requestId: string = randomUUID()): Promise<void> {
  const result = await run(bin("fm-inbox.sh"), ["note", "--request-id", requestId, "-"], {
    input: body,
    timeoutMs: 30_000,
  });

  if (result.code !== 0) {
    throw new Error((result.stderr || result.stdout || "inbox failed").trim().slice(0, 200));
  }
}
