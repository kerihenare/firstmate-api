/**
 * Public shapes of the Fleet Bearings API, plus the raw snapshot shape it is built from.
 *
 * @remarks
 * The OpenAPI document in `openapi.ts` mirrors these types by hand, so a change here needs the
 * same change there. `pnpm check` catches drift between the two.
 *
 * The enums are `as const` arrays defined once here. `openapi.ts` and `status.ts` read the same
 * arrays, so the spec, the parsers and the types can never disagree on the allowed values.
 *
 * The request and `Raw*` types are also checked at runtime by the Zod schemas in `schemas.ts`,
 * which are tied to these types with `satisfies`.
 *
 * @packageDocumentation
 */

/** The most activity events the API keeps and returns. */
export const ACTIVITY_LIMIT = 16;

/** The no-mistakes validation steps, in the order no-mistakes runs them. */
export const STEP_NAMES = [
  "intent",
  "rebase",
  "review",
  "test",
  "document",
  "lint",
  "push",
  "pr",
  "ci",
] as const;

/** One of the {@link STEP_NAMES}. */
export type StepName = (typeof STEP_NAMES)[number];

/**
 * The statuses a validation step can have.
 *
 * @remarks
 * `unknown` stands for any status this API does not recognise, so the step is still listed
 * and counted rather than dropped.
 */
export const STEP_STATUSES = [
  "awaiting_approval",
  "completed",
  "failed",
  "fixing",
  "pending",
  "running",
  "skipped",
  "unknown",
] as const;

/** One of the {@link STEP_STATUSES}. */
export type StepStatus = (typeof STEP_STATUSES)[number];

/** Machine-readable task states. Each task also has a plain-English `status` sentence. */
export const TASK_STATES = [
  "blocked",
  "failed",
  "finished",
  "ready_for_review",
  "unknown",
  "waiting",
  "working",
] as const;

/** One of the {@link TASK_STATES}. */
export type TaskState = (typeof TASK_STATES)[number];

/** Something that happened to a task, read from its `state/<id>.status` file. */
export interface ActivityEvent {
  /** When it happened, as an ISO 8601 timestamp. */
  at: string;
  /** What kind of event it was. */
  kind: "blocked" | "decision_asked" | "decision_made" | "finished";
  /** The id of the task it happened to. */
  taskId: string;
  /** The task's human name, or its id with dashes as spaces when the name is not known. */
  taskName: string;
  /** One plain-English sentence. */
  text: string;
}

/** Body of `POST /api/v1/questions/{id}/answers`. */
export interface AnswerRequest {
  /** One entry per question answered. Between 1 and 20 entries. */
  answers: {
    /** One of the question's options, or the caller's own words. */
    answer: string;
    /** The 1-based question number inside the decision. */
    question: number;
  }[];
}

/** Body of every error response. */
export interface ApiError {
  error: {
    /** Stable machine-readable code, for example `task_not_found`. */
    code: string;
    /** Plain-English explanation for people. */
    message: string;
  };
}

/** The whole picture of the fleet at one moment. Every GET endpoint returns a slice of it. */
export interface Bearings {
  /** Recent events, newest first. */
  activity: ActivityEvent[];
  /** How many contribution records the snapshot script knew about and checked. */
  contributions: { checked: number; complete: boolean; known: number };
  /** How many items are in each list, for badges and summaries. */
  counts: { landed: number; queued: number; underway: number; waitingOnYou: number };
  /**
   * The last refresh error, or `null`. When set, the rest of the data comes from the previous
   * good snapshot.
   */
  error: string | null;
  /** When this snapshot was built, as an ISO 8601 timestamp. */
  generatedAt: string | null;
  /** When the next rebuild is due, or `null` while one is running. */
  nextRefreshAt: string | null;
  /** Work waiting to start. */
  queued: QueuedItem[];
  /** Pull requests and reports that recently landed. */
  recentlyLanded: LandedItem[];
  /** True while a rebuild is running. */
  refreshing: boolean;
  /** Tasks in flight. */
  underway: Task[];
  /** Decisions and pull requests that need the captain. */
  waitingOnYou: WaitingOnYou;
}

/** A set of questions that a task is held on until the captain answers. */
export interface Decision {
  /** The id of the task the decision gates. */
  id: string;
  /** The structured questions, in order. Empty when the decision is free text. */
  questions: Question[];
  /** One plain-English sentence. */
  summary: string;
  /** The free-text question, present only when the decision has no structured questions. */
  text: string | null;
  /** A short title. */
  title: string;
}

/** A finding raised at a validation gate. */
export interface Finding {
  /** The finding's id, for example `review-1`. */
  id: string;
  /** How serious it is. Anything no-mistakes reports other than error or warning is `info`. */
  severity: "error" | "info" | "warning";
  /** A plain description, at most 260 characters. */
  text: string;
}

/** Something that recently landed: a merged pull request or a written report. */
export interface LandedItem {
  /** The id of the task that produced it. */
  id: string;
  /** Whether it is a pull request (has a `url`) or a report (has a `path`). */
  kind: "pull_request" | "report";
  /** The report's path on the Firstmate machine, or `null` for a pull request. */
  path: string | null;
  /** What landed. */
  title: string;
  /** The pull request URL, or `null` for a report. */
  url: string | null;
}

/** Response to a write that was passed on to Firstmate's inbox. */
export interface NoteReceipt {
  accepted: true;
  /** When the note was recorded, as an ISO 8601 timestamp. */
  receivedAt: string;
}

/** Body of `POST /api/v1/notes`. */
export interface NoteRequest {
  /** Anything the caller wants Firstmate to read. Between 1 and 4000 characters. */
  text: string;
}

/** A task's no-mistakes validation run. */
export interface Pipeline {
  /** The findings at the current gate. */
  findings: Finding[];
  /** The step the run is held at, or `null` when it is not held. */
  gate: { status: string; step: StepName } | null;
  /** The no-mistakes run id. */
  runId: string;
  /** The run status as no-mistakes reports it, for example `running` or `failed`. */
  status: string;
  /** The steps in pipeline order. */
  steps: PipelineStep[];
  /** The tool that produced the run. Always `no-mistakes` for now. */
  tool: "no-mistakes";
}

/** One step of a validation run. */
export interface PipelineStep {
  /** How many findings the step raised. */
  findings: number;
  /** Which step it is. */
  name: StepName;
  /** Where the step is. */
  status: StepStatus;
}

/** A GitHub pull request. */
export interface PullRequest {
  /** The pull request number. */
  number: number;
  /** The pull request URL. */
  url: string;
}

/** One question inside a {@link Decision}. */
export interface Question {
  /** The 1-based position inside its decision. Answers refer to questions by this number. */
  number: number;
  /** Between one and four options to choose from. */
  options: QuestionOption[];
  /** The question itself. */
  title: string;
}

/** One option of a {@link Question}. */
export interface QuestionOption {
  /** True for the option Firstmate recommends. */
  recommended: boolean;
  /** The option's text. */
  text: string;
}

/** Work waiting to start. */
export interface QueuedItem {
  /** The task id. */
  id: string;
  /** One sentence on why it is waiting. */
  reason: string;
  /** What the work is. */
  title: string;
}

/** An open decision, as `fm-bearings-snapshot.sh` reports it. */
export interface RawDecision {
  id: string;
  /** `Title: details`. The part before the first colon becomes the decision title. */
  summary: string;
}

/** A gate holding queued work, as `fm-bearings-snapshot.sh` reports it. Every field is optional. */
export interface RawGate {
  id?: string;
  reason?: string;
  title?: string;
}

/** Something that landed, as `fm-bearings-snapshot.sh` reports it. */
export interface RawLanded {
  /** A pull request URL, or a report path when it does not start with `http`. */
  artifact: string;
  id: string;
  what: string;
}

/** A pull request a task recorded, as `fm-bearings-snapshot.sh` reports it. */
export interface RawRecordedPr {
  id: string;
  url: string;
}

/**
 * The JSON printed by `bin/fm-bearings-snapshot.sh --json`.
 *
 * @remarks
 * Only the fields this API reads are listed. The script may print more.
 */
export interface RawSnapshot {
  contributions: { checked: number; complete: boolean; known: number };
  decisions_open: RawDecision[];
  gates: RawGate[];
  in_flight: RawTask[];
  landed: RawLanded[];
  recorded_prs: RawRecordedPr[];
}

/** A task in flight, as `fm-bearings-snapshot.sh` reports it. */
export interface RawTask {
  /** The script's own status line, used when the crew script gives nothing. */
  doing: string;
  id: string;
  /** `ship`, `scout`, or something else. */
  kind: string;
  name: string;
  repo: string;
}

/** A pull request whose checks are green and which is waiting for the captain to merge. */
export interface ReadyToMerge {
  /** The task's human name. */
  name: string;
  /** The pull request. */
  pullRequest: PullRequest;
  /** One plain-English sentence. */
  summary: string;
  /** The id of the task that opened it. */
  taskId: string;
}

/** Response to `POST /api/v1/refresh`. */
export interface RefreshReceipt {
  accepted: true;
}

/** A task in flight. */
export interface Task {
  /** The stable task id. */
  id: string;
  /** `ship` changes a project, `scout` investigates, anything else is `other`. */
  kind: "other" | "scout" | "ship";
  /** Links to the task's ticket and pull request, when known. */
  links: TaskLinks;
  /** The task's human name. */
  name: string;
  /** The task's validation run, or `null` when it does not use no-mistakes. */
  pipeline: Pipeline | null;
  /** The repository the task works in. */
  repo: string;
  /** Where the task is, as a machine-readable value. */
  state: TaskState;
  /** Where the task is, as one plain-English sentence. */
  status: string;
}

/** Links from a task to things outside Firstmate. */
export interface TaskLinks {
  /** The Linear ticket, or `null` when Linear is not configured or no key was found. */
  linear: { key: string; url: string } | null;
  /** The task's open pull request, or `null` when it has none. */
  pullRequest: PullRequest | null;
}

/** Everything that needs the captain. */
export interface WaitingOnYou {
  /** Decisions with their questions. */
  decisions: Decision[];
  /** Pull requests ready to merge. */
  readyToMerge: ReadyToMerge[];
}
