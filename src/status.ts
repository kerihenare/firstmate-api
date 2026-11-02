/**
 * Pure text parsing: turns raw Firstmate and no-mistakes CLI output into typed values and
 * plain-English sentences.
 *
 * @remarks
 * Nothing in this module does I/O, so `scripts/check.ts` tests it offline against fixed samples.
 *
 * @packageDocumentation
 */
import { stripVTControlCharacters } from "node:util";

import type { z } from "zod";

import { RawSnapshotSchema } from "./schemas.ts";
import { STEP_NAMES, STEP_STATUSES } from "./types.ts";
import type {
  Finding,
  Pipeline,
  PipelineStep,
  QuestionOption,
  RawSnapshot,
  StepName,
  StepStatus,
  TaskState,
} from "./types.ts";

/** The most options a question keeps. The spec allows four; the answer can still be free text. */
const MAX_OPTIONS = 4;

/** The longest sentence, in characters, that {@link describeTask} writes from a crew line. */
const SENTENCE_MAX = 110;

/** The display word for each `state:` value a crew line can start with. */
const STATE_WORD: Record<string, string> = {
  blocked: "Blocked",
  done: "Finished",
  failed: "Failed",
  parked: "Paused",
  paused: "Waiting",
  queued: "Queued",
  unknown: "Status unclear",
  working: "Working",
};

const STEP_NAME_SET = new Set<string>(STEP_NAMES);

/** How each step reads inside a sentence, as in "Running the tests". */
const STEP_PLAIN: Record<StepName, string> = {
  ci: "the final checks (CI)",
  document: "the docs check",
  intent: "the intent check",
  lint: "the lint check",
  pr: "opening the pull request",
  push: "the push",
  rebase: "the sync with the base branch",
  review: "the code review",
  test: "the tests",
};

const STEP_STATUS_SET = new Set<string>(STEP_STATUSES);

/** Reads one cell of the current table row by column name, or `""` when the column is absent. */
type CellReader = (column: string) => string;

/** A question parsed from a hold reason, before it is given its number. */
export interface ParsedQuestion {
  options: QuestionOption[];
  title: string;
}

/** A task's status, as {@link describeTask} returns it. */
export interface TaskDescription {
  /** One plain-English sentence for people. */
  sentence: string;
  /** The same status as a machine-readable value. */
  state: TaskState;
}

/** Describe a task from its crew line alone, for tasks with no informative pipeline. */
function describeCrewLine(crewLine: string): TaskDescription {
  const { body, word } = friendly(crewLine);
  const lower = body.toLowerCase();
  const summary = firstSentence(body, SENTENCE_MAX);

  if (lower.includes("unverified") || word === "Status unclear") {
    return { sentence: "Waiting for the validation run to report in.", state: "unknown" };
  }
  if (lower.includes("dev server")) {
    return { sentence: "The dev server is running and waiting for you.", state: "waiting" };
  }
  if (lower.includes("harness busy") || lower.includes("agent busy")) {
    return { sentence: "The worker is busy building the change.", state: "working" };
  }
  if (lower.includes("harness idle") || lower.includes("agent idle")) {
    return {
      sentence: "The worker is idle and waiting for its next instruction.",
      state: "waiting",
    };
  }

  switch (word) {
    case "Blocked":
      return { sentence: `Stuck: ${summary || "needs attention."}`, state: "blocked" };
    case "Failed":
      return { sentence: summary || "Failed.", state: "failed" };
    case "Finished":
      return { sentence: summary || "Finished.", state: "finished" };
    case "Paused":
    case "Queued":
    case "Waiting":
      return { sentence: summary || "Waiting.", state: "waiting" };
    case "Working":
      return { sentence: summary || "Working on it.", state: "working" };
  }

  return { sentence: summary || word || "Status not available yet.", state: "unknown" };
}

/**
 * Describe a task from its validation run.
 *
 * @returns The description, or `null` when the run says nothing useful (for example, steps are
 *   pending but none is running yet), so the caller falls back to the crew line.
 */
function describePipeline(pipeline: Pipeline): TaskDescription | null {
  const { findings, gate, status, steps } = pipeline;

  if (status === "cancelled" || status === "canceled") {
    return {
      sentence: "The last validation run was cancelled and is waiting to be restarted.",
      state: "waiting",
    };
  }

  const failedStep = steps.find((step) => step.status === "failed");

  if (status === "failed" || failedStep) {
    const where = failedStep ? STEP_PLAIN[failedStep.name] : "a step";

    return { sentence: `Validation failed at ${where}.`, state: "failed" };
  }

  if (gate?.status === "awaiting_approval") {
    return {
      sentence: `Paused at ${STEP_PLAIN[gate.step]} with ${plural(findings.length, "finding")} waiting for a decision.`,
      state: "waiting",
    };
  }

  const doneCount = steps.filter(
    (step) => step.status === "completed" || step.status === "skipped",
  ).length;
  const activeStep = steps.find((step) => step.status === "running" || step.status === "fixing");

  if (activeStep) {
    return {
      sentence: `Running ${STEP_PLAIN[activeStep.name]}, ${doneCount} of ${steps.length} steps done.`,
      state: "working",
    };
  }
  if (doneCount === steps.length) {
    return { sentence: "All validation steps are done.", state: "finished" };
  }

  return null;
}

/**
 * Describe where a task is, as one plain-English sentence plus a machine-readable state.
 *
 * @remarks
 * The sources are tried in order: a pull request ready for review wins, then the validation
 * run, then the crew line.
 *
 * @param crewLine - The first line of `fm-crew-state.sh <id>`, for example
 *   `state: working · source: harness · harness busy`.
 * @param pipeline - The task's validation run, or `null` when it has none.
 * @param ready - Whether the task's pull request is ready for review (see {@link readyForReview}).
 * @returns The sentence and state.
 */
export function describeTask(
  crewLine: string,
  pipeline: Pipeline | null,
  ready: boolean,
): TaskDescription {
  if (ready) {
    return { sentence: "Ready for you to review and merge.", state: "ready_for_review" };
  }

  const fromPipeline = pipeline ? describePipeline(pipeline) : null;

  return fromPipeline ?? describeCrewLine(crewLine);
}

/** Turn a row of the `gate.findings` table into a {@link Finding}, or `null` if it has no id. */
function findingFromRow(cell: CellReader): Finding | null {
  const id = cell("id");

  if (!id) {
    return null;
  }

  const severity = cell("severity");

  return {
    id,
    severity: severity === "error" || severity === "warning" ? severity : "info",
    text: cell("description").slice(0, 260),
  };
}

/**
 * Shorten free text to its first sentence, ready to show as a status line.
 *
 * @remarks
 * URLs are dropped, whitespace is collapsed and stray separators are trimmed. The first
 * sentence is the shortest run of at least 20 characters that ends in `.`, `!` or `?`; text
 * with no such run is used whole. Anything longer than `max` is cut at a word boundary and
 * given an ellipsis. The result starts with a capital letter and ends with punctuation.
 *
 * @param text - Any text, such as a crew line body or a status file entry.
 * @param max - The most characters to keep before the ellipsis.
 * @returns The sentence, or `""` when nothing is left after cleaning.
 */
export function firstSentence(text: string, max = 140): string {
  const cleaned = text
    .replace(/https?:\/\/\S+/g, "")
    .replace(/\s+/g, " ")
    .replace(/^[\s\-·:]+|[\s\-·:]+$/g, "");
  const match = /^(.{20,}?[.!?])(\s|$)/.exec(cleaned);
  let sentence = match?.[1] ?? cleaned;

  if (sentence.length > max) {
    sentence = `${sentence.slice(0, max).replace(/\s+\S*$/, "")}…`;
  }
  if (sentence && !/[.!?…]$/.test(sentence)) {
    sentence += ".";
  }

  return sentence ? sentence.charAt(0).toUpperCase() + sentence.slice(1) : "";
}

/**
 * Split an internal crew status line into a display word and a short plain-words body.
 *
 * @example
 * ```ts
 * friendly("state: parked · source: run-step · waiting on review");
 * // => { body: "waiting on review", word: "Paused" }
 * ```
 *
 * @param line - A crew line, which starts with `state: <value> · ` when it has a state.
 * @returns The display word from {@link STATE_WORD} (or the raw state when it is not listed, or
 *   `""` when there is none), and the rest of the line with internal details removed, at most
 *   150 characters.
 */
export function friendly(line: string): { body: string; word: string } {
  if (!line) {
    return { body: "", word: "" };
  }

  const state = /^state: (\w+)/.exec(line)?.[1];
  const word = state ? (STATE_WORD[state] ?? state) : "";
  const body = line
    // The state itself, already captured in `word`.
    .replace(/^state: \w+ · /, "")
    // Which script reported it.
    .replace(/source: [\w-]+ · /, "")
    .replace(/https?:\/\/\S+/g, "")
    // The no-mistakes run id.
    .replace(/ · run: \S+/, "")
    .replace(/\(still monitoring[^)]*\)/, "")
    .replace("checks green: PR ready for review", "Checks green, ready for review")
    .replace(/\s+/g, " ")
    .replace(/^[\s:·]+|[\s:·]+$/g, "");

  return { body: body.slice(0, 150), word };
}

/**
 * Parse the text output of `no-mistakes axi status` into a {@link Pipeline}.
 *
 * @remarks
 * The output is made of top-level sections (`run:`, `gate:`). Inside a section, lines indented
 * by two spaces are either `key: value` fields or table headers, and lines indented by four
 * spaces are comma-separated table rows:
 *
 * ```text
 * run:
 *   id: "01SAMPLE"
 *   status: running
 *   steps[2]{step,status,findings,duration_ms}:
 *     intent,completed,0,4
 *     test,running,0,0
 * ```
 *
 * Tables are read by the column names in their header, so added or reordered columns are fine.
 * Steps with a name this API does not know are dropped, since each step needs a plain-English
 * label for {@link describeTask}.
 *
 * @param raw - The command's stdout. Terminal colour codes are stripped.
 * @returns The run, or `null` when the output has no run id or no known steps.
 */
export function parsePipeline(raw: string): Pipeline | null {
  /** Every `key: value` field, keyed as `section.key`, for example `run.id`. */
  const fields: Record<string, string> = {};
  const findings: Finding[] = [];
  const steps: PipelineStep[] = [];

  let section = "";
  /** The table being read, as `section.name`, or `""` when not inside a table. */
  let table = "";
  let columns: string[] = [];

  for (const line of stripVTControlCharacters(raw).split("\n")) {
    // A top-level line such as `run:` starts a new section.
    if (/^[a-z_]+:/.test(line)) {
      section = line.split(":")[0] ?? "";
      table = "";
      continue;
    }

    // A two-space line is a table header (`  steps[3]{step,status}:`) or a field (`  id: x`).
    if (/^ {2}\S/.test(line)) {
      const header = /^ {2}(\w+)\[\d+\]\{([^}]*)\}:$/.exec(line);
      table = header?.[1] ? `${section}.${header[1]}` : "";
      columns = header?.[2] ? header[2].split(",") : [];
      const field = /^ {2}(\w+): "?(.*?)"?$/.exec(line);

      if (field?.[1] && field[2] !== undefined) {
        fields[`${section}.${field[1]}`] = field[2];
      }
      continue;
    }

    // A four-space line inside a table is one row.
    if (!table || !/^ {4}\S/.test(line)) {
      continue;
    }

    const cells = splitRow(line.slice(4));
    const cell: CellReader = (column) => (cells[columns.indexOf(column)] ?? "").trim();

    if (table === "run.steps") {
      const step = stepFromRow(cell);

      if (step) {
        steps.push(step);
      }
    }
    if (table === "gate.findings") {
      const finding = findingFromRow(cell);

      if (finding) {
        findings.push(finding);
      }
    }
  }

  const runId = fields["run.id"] ?? "";

  if (steps.length === 0 || !runId) {
    return null;
  }

  const gateStep = fields["gate.step"] ?? "";
  const gate = STEP_NAME_SET.has(gateStep)
    ? { status: fields["gate.status"] ?? "", step: gateStep as StepName }
    : null;

  return {
    findings,
    gate,
    runId,
    status: fields["run.status"] ?? "",
    steps,
    tool: "no-mistakes",
  };
}

/**
 * Parse the structured questions out of a task's hold reason.
 *
 * @remarks
 * Questions are separated by ` ## `. Each one is a title, `::`, then options separated by `|`.
 * An option marked `(Recommended)` is flagged and the marker removed. Text with no `::` (such
 * as an introduction before the first question) is ignored, and options past the fourth are
 * dropped.
 *
 * @example
 * ```ts
 * parseQuestions("Intro. ## Engine :: Stub (Recommended) | Real");
 * // => [{ options: [{ recommended: true, text: "Stub" }, { recommended: false, text: "Real" }],
 * //       title: "Engine" }]
 * ```
 *
 * @param reason - The hold reason from `fm-tasks-axi.sh show`.
 * @returns The questions in order, or an empty array for a free-text reason.
 */
export function parseQuestions(reason: string): ParsedQuestion[] {
  const questions: ParsedQuestion[] = [];

  for (const chunk of reason.split(" ## ")) {
    const separator = chunk.indexOf("::");

    if (separator === -1) {
      continue;
    }

    const title = chunk
      .slice(0, separator)
      // Drop anything up to a `##` the split missed, as when the reason starts with `## `.
      .replace(/^.*?##/, "")
      .trim();
    const options = chunk
      .slice(separator + 2)
      .split("|")
      .map((option) => option.trim())
      .filter(Boolean)
      .map((option) => ({
        recommended: /\(recommended\)/i.test(option),
        text: option.replace(/\s*\(recommended\)/i, "").trim(),
      }));

    if (title && options.length > 0) {
      questions.push({ options: options.slice(0, MAX_OPTIONS), title });
    }
  }

  return questions;
}

/**
 * Parse and check the JSON printed by `fm-bearings-snapshot.sh --json`.
 *
 * @remarks
 * The JSON is checked with {@link RawSnapshotSchema}. Only the fields this API reads are
 * checked, so the script may add fields freely. The point is a clear error naming what is
 * missing, rather than a `TypeError` from deep inside the snapshot build.
 *
 * @param text - The script's stdout.
 * @returns The snapshot, with every field this API does not read dropped.
 * @throws When the text is not JSON, or a list, item or field is missing or the wrong type. The
 *   message names the first problem, for example `The snapshot's in_flight[0] has no "doing" text.`
 */
export function parseSnapshot(text: string): RawSnapshot {
  let value: unknown;

  try {
    value = JSON.parse(text);
  } catch {
    throw new Error("The snapshot script printed something that is not JSON.");
  }

  const result = RawSnapshotSchema.safeParse(value);

  if (result.success) {
    return result.data;
  }

  const issue = result.error.issues[0];
  throw new Error(issue ? snapshotProblem(issue) : "The snapshot is not valid.");
}

/**
 * Format a count with a noun, adding an `s` unless the count is one.
 *
 * @example
 * ```ts
 * plural(1, "finding"); // => "1 finding"
 * plural(3, "finding"); // => "3 findings"
 * ```
 */
export function plural(count: number, noun: string): string {
  return `${count} ${noun}${count === 1 ? "" : "s"}`;
}

/**
 * Whether a crew line says the task's pull request has green checks and is ready for review.
 *
 * @param crewLine - The first line of `fm-crew-state.sh <id>`.
 */
export function readyForReview(crewLine: string): boolean {
  return crewLine.toLowerCase().includes("checks green");
}

/**
 * Say where in the snapshot an issue is, as a sentence.
 *
 * @example
 * ```ts
 * // An issue at ["in_flight", 0, "doing"] with the message `has no "doing" text`:
 * // => 'The snapshot\'s in_flight[0] has no "doing" text.'
 * ```
 */
function snapshotProblem(issue: z.core.$ZodIssue): string {
  const [listName, index] = issue.path;

  if (listName === "contributions") {
    return `The snapshot's "contributions" ${issue.message}.`;
  }
  if (listName === undefined || index === undefined) {
    return `The snapshot ${issue.message}.`;
  }

  return `The snapshot's ${String(listName)}[${String(index)}] ${issue.message}.`;
}

/**
 * Get the `owner/name` slug from a GitHub remote URL.
 *
 * @example
 * ```ts
 * slugFromRemote("git@github.com:vercel/next.js.git"); // => "vercel/next.js"
 * slugFromRemote("https://gitlab.com/org/repo.git"); // => ""
 * ```
 *
 * @param url - The output of `git remote get-url`, ssh or https. Surrounding whitespace is fine.
 * @returns The slug, or `""` when the remote is not on GitHub.
 */
export function slugFromRemote(url: string): string {
  return /github\.com[:/]([^/\s]+\/[^/\s]+?)(?:\.git)?\/?$/.exec(url.trim())?.[1] ?? "";
}

/**
 * Split one table row into cells.
 *
 * @remarks
 * Commas inside double quotes do not split. The quotes themselves are removed, and inside
 * quotes a backslash keeps the next character as-is (so `\"` is a literal quote).
 *
 * @example
 * ```ts
 * splitRow('a,"b, c","say \\"hi\\"",'); // => ["a", "b, c", 'say "hi"', ""]
 * ```
 */
export function splitRow(row: string): string[] {
  const cells: string[] = [];
  let cell = "";
  let quoted = false;

  for (let i = 0; i < row.length; i++) {
    const char = row.charAt(i);

    if (quoted && char === "\\" && i + 1 < row.length) {
      i++;
      cell += row.charAt(i);
    } else if (char === '"') {
      quoted = !quoted;
    } else if (char === "," && !quoted) {
      cells.push(cell);
      cell = "";
    } else {
      cell += char;
    }
  }

  cells.push(cell);

  return cells;
}

/** Turn a row of the `run.steps` table into a {@link PipelineStep}, or `null` for unknown steps. */
function stepFromRow(cell: CellReader): PipelineStep | null {
  const name = cell("step");

  if (!STEP_NAME_SET.has(name)) {
    return null;
  }

  const status = cell("status");

  return {
    findings: Number(cell("findings")) || 0,
    name: name as StepName,
    status: (STEP_STATUS_SET.has(status) ? status : "unknown") as StepStatus,
  };
}

/**
 * Find the first Linear ticket key in some text.
 *
 * @example
 * ```ts
 * ticketKey("Fix UTF-8 handling for LIV-42", ["LIV"]); // => "LIV-42"
 * ```
 *
 * @param text - Any text, such as a task title.
 * @param teams - The team prefixes to match, for example `["LIV", "ENG"]`. They are used in a
 *   regular expression as-is, so they must be plain letters and digits.
 * @returns The key, or `""` when none matches or `teams` is empty.
 */
export function ticketKey(text: string, teams: string[]): string {
  if (teams.length === 0) {
    return "";
  }

  return new RegExp(`\\b(?:${teams.join("|")})-\\d+\\b`).exec(text)?.[0] ?? "";
}
