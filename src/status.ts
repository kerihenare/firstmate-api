import { stripVTControlCharacters } from "node:util";

import { STEP_NAMES, STEP_STATUSES } from "./types.ts";
import type { Finding, Pipeline, PipelineStep, StepName, StepStatus, TaskState } from "./types.ts";

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
const STEP_STATUS_SET = new Set<string>(STEP_STATUSES);

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

export interface ParsedQuestion {
  options: { recommended: boolean; text: string }[];
  title: string;
}

/** One plain-English sentence describing a task's current status, plus a machine state. */
export function describeTask(
  crewLine: string,
  pipeline: Pipeline | null,
  ready: boolean,
): { sentence: string; state: TaskState } {
  const { word, body } = friendly(crewLine);
  if (ready) return { sentence: "Ready for you to review and merge.", state: "ready_for_review" };
  if (pipeline) {
    const steps = pipeline.steps;
    const done = steps.filter((s) => s.status === "completed" || s.status === "skipped").length;
    if (pipeline.status === "cancelled" || pipeline.status === "canceled") {
      return {
        sentence: "The last validation run was cancelled and is waiting to be restarted.",
        state: "waiting",
      };
    }
    const failed = steps.find((s) => s.status === "failed");
    if (pipeline.status === "failed" || failed) {
      return {
        sentence: `Validation failed at ${failed ? STEP_PLAIN[failed.name] : "a step"}.`,
        state: "failed",
      };
    }
    if (pipeline.gate && pipeline.gate.status === "awaiting_approval") {
      const n = pipeline.findings.length;
      return {
        sentence: `Paused at ${STEP_PLAIN[pipeline.gate.step]} with ${n} finding${n === 1 ? "" : "s"} waiting for a decision.`,
        state: "waiting",
      };
    }
    const cur = steps.find((s) => s.status === "running" || s.status === "fixing");
    if (cur)
      return {
        sentence: `Running ${STEP_PLAIN[cur.name]}, ${done} of ${steps.length} steps done.`,
        state: "working",
      };
    if (done === steps.length)
      return { sentence: "All validation steps are done.", state: "working" };
  }
  const low = body.toLowerCase();
  if (low.includes("unverified") || word === "Status unclear") {
    return { sentence: "Waiting for the validation run to report in.", state: "unknown" };
  }
  if (low.includes("dev server"))
    return { sentence: "The dev server is running and waiting for you.", state: "waiting" };
  if (low.includes("harness busy") || low.includes("agent busy")) {
    return { sentence: "The worker is busy building the change.", state: "working" };
  }
  if (low.includes("harness idle") || low.includes("agent idle")) {
    return {
      sentence: "The worker is idle and waiting for its next instruction.",
      state: "waiting",
    };
  }
  if (word === "Blocked")
    return {
      sentence: `Stuck: ${firstSentence(body, 110) || "needs attention."}`,
      state: "blocked",
    };
  if (word === "Failed")
    return { sentence: firstSentence(body, 110) || "Failed.", state: "failed" };
  if (word === "Finished")
    return { sentence: body ? firstSentence(body, 110) : "Finished.", state: "finished" };
  if (word === "Working")
    return { sentence: firstSentence(body, 110) || "Working on it.", state: "working" };
  if (word === "Waiting" || word === "Paused")
    return { sentence: firstSentence(body, 110) || "Waiting.", state: "waiting" };
  return {
    sentence: firstSentence(body, 110) || word || "Status not available yet.",
    state: "unknown",
  };
}

export function firstSentence(text: string, max = 140): string {
  let t = text
    .replace(/https?:\/\/\S+/g, "")
    .replace(/\s+/g, " ")
    .replace(/^[\s\-·:]+|[\s\-·:]+$/g, "");
  const m = /^(.{20,}?[.!?])(\s|$)/.exec(t);
  let s = m && m[1] ? m[1] : t;
  if (s.length > max) s = `${s.slice(0, max).replace(/\s+\S*$/, "")}…`;
  if (s && !/[.!?…]$/.test(s)) s += ".";
  return s ? s.charAt(0).toUpperCase() + s.slice(1) : "";
}

/** Turn an internal status line into a state word plus a short plain-words body. */
export function friendly(line: string): { body: string; word: string } {
  if (!line) return { body: "", word: "" };
  const m = /^state: (\w+)/.exec(line);
  const word = m && m[1] ? (STATE_WORD[m[1]] ?? m[1]) : "";
  let body = line.replace(/^state: \w+ · /, "");
  body = body.replace(/source: [\w-]+ · /, "");
  body = body.replace(/https?:\/\/\S+/g, "");
  body = body.replace(/ · run: \S+/, "");
  body = body.replace(/\(still monitoring[^)]*\)/, "");
  body = body.replace("checks green: PR ready for review", "Checks green, ready for review");
  body = body.replace(/\s+/g, " ").replace(/^[\s:·]+|[\s:·]+$/g, "");
  return { body: body.slice(0, 150), word };
}

/**
 * Parse the text output of `no-mistakes axi status`. Tables are read by their
 * header (`  steps[3]{step,status,findings,duration_ms}:`), so added or reordered columns are fine.
 */
export function parsePipeline(raw: string): Pipeline | null {
  const text = stripVTControlCharacters(raw);
  const fields: Record<string, string> = {};
  const steps: PipelineStep[] = [];
  const findings: Finding[] = [];
  let block = "";
  let table = "";
  let cols: string[] = [];
  for (const line of text.split("\n")) {
    if (/^[a-z_]+:/.test(line)) {
      block = line.split(":")[0] ?? "";
      table = "";
      continue;
    }
    if (/^ {2}\S/.test(line)) {
      const header = /^ {2}(\w+)\[\d+\]\{([^}]*)\}:$/.exec(line);
      table = header?.[1] ? `${block}.${header[1]}` : "";
      cols = header?.[2] ? header[2].split(",") : [];
      const kv = /^ {2}(\w+): "?(.*?)"?$/.exec(line);
      if (kv?.[1] && kv[2] !== undefined) fields[`${block}.${kv[1]}`] = kv[2];
      continue;
    }
    if (!table || !/^ {4}\S/.test(line)) continue;
    const cells = splitRow(line.slice(4));
    const get = (col: string): string => (cells[cols.indexOf(col)] ?? "").trim();
    if (table === "run.steps") {
      const name = get("step");
      const status = get("status");
      // ponytail: unknown step names are dropped, since each needs a plain-English label in STEP_PLAIN.
      if (!STEP_NAME_SET.has(name)) continue;
      steps.push({
        findings: Number(get("findings")) || 0,
        name: name as StepName,
        status: (STEP_STATUS_SET.has(status) ? status : "unknown") as StepStatus,
      });
    }
    if (table === "gate.findings" && get("id")) {
      const sev = get("severity");
      findings.push({
        id: get("id"),
        severity: sev === "error" || sev === "warning" ? sev : "info",
        text: get("description").slice(0, 260),
      });
    }
  }
  const run = { id: fields["run.id"] ?? "", status: fields["run.status"] ?? "" };
  const gateStep = fields["gate.step"] ?? "";
  const gate = STEP_NAME_SET.has(gateStep)
    ? { status: fields["gate.status"] ?? "", step: gateStep as StepName }
    : null;
  if (steps.length === 0 || !run.id) return null;
  return {
    findings,
    gate,
    runId: run.id,
    status: run.status,
    steps,
    tool: "no-mistakes",
  };
}

/** Questions in a hold reason: separated by " ## ", each "Title :: option | option (Recommended) | option". */
export function parseQuestions(reason: string): ParsedQuestion[] {
  const out: ParsedQuestion[] = [];
  if (!reason.includes("::")) return out;
  for (const chunk of reason.split(" ## ")) {
    if (!chunk.includes("::")) continue;
    const idx = chunk.indexOf("::");
    const title = chunk
      .slice(0, idx)
      .replace(/^.*?##/, "")
      .trim();
    const options = chunk
      .slice(idx + 2)
      .split("|")
      .map((o) => o.trim())
      .filter(Boolean)
      .map((o) => ({
        recommended: /\(recommended\)/i.test(o),
        text: o.replace(/\s*\(recommended\)/i, "").trim(),
      }));
    // The spec allows at most 4 options; extras are dropped (the answer can still be free text).
    if (title && options.length > 0) out.push({ options: options.slice(0, 4), title });
  }
  return out;
}

export function readyForReview(line: string): boolean {
  return line.toLowerCase().includes("checks green");
}

/** owner/name from a GitHub remote URL (ssh or https), or "" when it is not GitHub. */
export function slugFromRemote(url: string): string {
  return /github\.com[:/]([^/\s]+\/[^/\s]+?)(?:\.git)?\/?$/.exec(url.trim())?.[1] ?? "";
}

/** Split one table row on commas outside double quotes. Quotes are removed and \x escapes unescaped. */
export function splitRow(row: string): string[] {
  const cells: string[] = [];
  let cell = "";
  let quoted = false;
  for (let i = 0; i < row.length; i++) {
    const c = row.charAt(i);
    if (quoted && c === "\\" && i + 1 < row.length) cell += row.charAt(++i);
    else if (c === '"') quoted = !quoted;
    else if (c === "," && !quoted) {
      cells.push(cell);
      cell = "";
    } else cell += c;
  }
  cells.push(cell);
  return cells;
}

/** The first ticket key in text whose team prefix is one of teams (for example LIV-12), or "". */
export function ticketKey(text: string, teams: string[]): string {
  if (teams.length === 0) return "";
  return new RegExp(`\\b(?:${teams.join("|")})-\\d+\\b`).exec(text)?.[0] ?? "";
}
