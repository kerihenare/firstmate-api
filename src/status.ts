import { stripVTControlCharacters } from "node:util";
import type { Finding, Pipeline, PipelineStep, StepName, StepStatus, TaskState } from "./types.ts";

const STEP_PLAIN: Record<StepName, string> = {
  intent: "the intent check",
  rebase: "the sync with the base branch",
  review: "the code review",
  test: "the tests",
  document: "the docs check",
  lint: "the lint check",
  push: "the push",
  pr: "opening the pull request",
  ci: "the final checks (CI)",
};

const STEP_NAMES = new Set<string>(Object.keys(STEP_PLAIN));
const STEP_STATUSES = new Set<string>([
  "completed",
  "running",
  "fixing",
  "awaiting_approval",
  "pending",
  "skipped",
  "failed",
]);

const STATE_WORD: Record<string, string> = {
  done: "Finished",
  working: "Working",
  parked: "Paused",
  blocked: "Blocked",
  unknown: "Status unclear",
  paused: "Waiting",
  failed: "Failed",
  queued: "Queued",
};

/** Turn an internal status line into a state word plus a short plain-words body. */
export function friendly(line: string): { word: string; body: string } {
  if (!line) return { word: "", body: "" };
  const m = /^state: (\w+)/.exec(line);
  const word = m && m[1] ? (STATE_WORD[m[1]] ?? m[1]) : "";
  let body = line.replace(/^state: \w+ · /, "");
  body = body.replace(/source: [\w-]+ · /, "");
  body = body.replace(/https?:\/\/\S+/g, "");
  body = body.replace(/ · run: \S+/, "");
  body = body.replace(/\(still monitoring[^)]*\)/, "");
  body = body.replace("checks green: PR ready for review", "Checks green, ready for review");
  body = body.replace(/\s+/g, " ").replace(/^[\s:·]+|[\s:·]+$/g, "");
  return { word, body: body.slice(0, 150) };
}

export function readyForReview(line: string): boolean {
  return line.toLowerCase().includes("checks green");
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

/** Parse the text output of `no-mistakes axi status`. */
export function parsePipeline(raw: string): Pipeline | null {
  const text = stripVTControlCharacters(raw);
  const run: Record<string, string> = {};
  const steps: PipelineStep[] = [];
  const findings: Finding[] = [];
  let gate: { step: StepName; status: string } | null = null;
  let gateStep = "";
  let gateStatus = "";
  let block = "";
  let inFindings = false;
  for (const line of text.split("\n")) {
    if (line.startsWith("run:")) {
      block = "run";
      continue;
    }
    if (line.startsWith("gate:")) {
      block = "gate";
      continue;
    }
    if (/^[a-z_]+:/.test(line)) {
      block = line.split(":")[0] ?? "";
      inFindings = false;
      continue;
    }
    if (block === "run") {
      const m = /^ {2}(id|status): "?(.*?)"?$/.exec(line);
      if (m && m[1] && m[2] !== undefined) run[m[1]] = m[2];
      const s = /^ {4}([a-z]+),(\w+),(\d+),(\d+)$/.exec(line);
      if (s && s[1] && s[2] && s[3] && STEP_NAMES.has(s[1]) && STEP_STATUSES.has(s[2])) {
        steps.push({ name: s[1] as StepName, status: s[2] as StepStatus, findings: Number(s[3]) });
      }
    }
    if (block === "gate") {
      const g = /^ {2}(step|status): (.+)$/.exec(line);
      if (g && g[1] === "step" && g[2]) gateStep = g[2];
      if (g && g[1] === "status" && g[2]) gateStatus = g[2];
      if (/^ {2}findings\[/.test(line)) {
        inFindings = true;
        continue;
      }
      if (inFindings) {
        const f = /^ {4}([a-z]+-\d+),(\w+),(.*)$/.exec(line);
        if (f && f[1] && f[2]) {
          const parts = (f[3] ?? "").split(",");
          const desc = (parts.length >= 3 ? parts.slice(2).join(",") : (f[3] ?? ""))
            .trim()
            .replace(/^"|"$/g, "");
          const severity = f[2] === "error" || f[2] === "warning" ? f[2] : "info";
          findings.push({ id: f[1], severity, text: desc.slice(0, 260) });
        }
      }
    }
  }
  if (STEP_NAMES.has(gateStep)) gate = { step: gateStep as StepName, status: gateStatus };
  if (steps.length === 0 || !run["id"]) return null;
  return {
    tool: "no-mistakes",
    runId: run["id"],
    status: run["status"] ?? "",
    steps,
    gate,
    findings,
  };
}

/** One plain-English sentence describing a task's current status, plus a machine state. */
export function describeTask(
  crewLine: string,
  pipeline: Pipeline | null,
  ready: boolean,
): { state: TaskState; sentence: string } {
  const { word, body } = friendly(crewLine);
  if (ready) return { state: "ready_for_review", sentence: "Ready for you to review and merge." };
  if (pipeline) {
    const steps = pipeline.steps;
    const done = steps.filter((s) => s.status === "completed" || s.status === "skipped").length;
    if (pipeline.status === "cancelled" || pipeline.status === "canceled") {
      return {
        state: "waiting",
        sentence: "The last validation run was cancelled and is waiting to be restarted.",
      };
    }
    const failed = steps.find((s) => s.status === "failed");
    if (pipeline.status === "failed" || failed) {
      return {
        state: "failed",
        sentence: `Validation failed at ${failed ? STEP_PLAIN[failed.name] : "a step"}.`,
      };
    }
    if (pipeline.gate && pipeline.gate.status === "awaiting_approval") {
      const n = pipeline.findings.length;
      return {
        state: "waiting",
        sentence: `Paused at ${STEP_PLAIN[pipeline.gate.step]} with ${n} finding${n === 1 ? "" : "s"} waiting for a decision.`,
      };
    }
    const cur = steps.find((s) => s.status === "running" || s.status === "fixing");
    if (cur)
      return {
        state: "working",
        sentence: `Running ${STEP_PLAIN[cur.name]}, ${done} of ${steps.length} steps done.`,
      };
    if (done === steps.length)
      return { state: "working", sentence: "All validation steps are done." };
  }
  const low = body.toLowerCase();
  if (low.includes("unverified") || word === "Status unclear") {
    return { state: "unknown", sentence: "Waiting for the validation run to report in." };
  }
  if (low.includes("dev server"))
    return { state: "waiting", sentence: "The dev server is running and waiting for you." };
  if (low.includes("harness busy") || low.includes("agent busy")) {
    return { state: "working", sentence: "The worker is busy building the change." };
  }
  if (low.includes("harness idle") || low.includes("agent idle")) {
    return {
      state: "waiting",
      sentence: "The worker is idle and waiting for its next instruction.",
    };
  }
  if (word === "Blocked")
    return {
      state: "blocked",
      sentence: `Stuck: ${firstSentence(body, 110) || "needs attention."}`,
    };
  if (word === "Failed")
    return { state: "failed", sentence: firstSentence(body, 110) || "Failed." };
  if (word === "Finished")
    return { state: "finished", sentence: body ? firstSentence(body, 110) : "Finished." };
  if (word === "Working")
    return { state: "working", sentence: firstSentence(body, 110) || "Working on it." };
  if (word === "Waiting" || word === "Paused")
    return { state: "waiting", sentence: firstSentence(body, 110) || "Waiting." };
  return {
    state: "unknown",
    sentence: firstSentence(body, 110) || word || "Status not available yet.",
  };
}

export interface ParsedQuestion {
  title: string;
  options: { text: string; recommended: boolean }[];
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
        text: o.replace(/\s*\(recommended\)/i, "").trim(),
        recommended: /\(recommended\)/i.test(o),
      }));
    if (title && options.length > 0) out.push({ title, options });
  }
  return out;
}
