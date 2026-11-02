/** Public shapes of the Fleet Bearings API. The OpenAPI spec in openapi.ts mirrors these. */

/** Enums are defined once here; openapi.ts and status.ts read the same arrays. */

/** In pipeline order, the order no-mistakes runs them in. */
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
export type StepName = (typeof STEP_NAMES)[number];

/** "unknown" stands for any status this API does not recognise, so the step still counts. */
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
export type StepStatus = (typeof STEP_STATUSES)[number];

export const TASK_STATES = [
  "blocked",
  "failed",
  "finished",
  "ready_for_review",
  "unknown",
  "waiting",
  "working",
] as const;
export type TaskState = (typeof TASK_STATES)[number];

export interface ActivityEvent {
  at: string;
  kind: "blocked" | "decision_asked" | "decision_made" | "finished";
  taskId: string;
  taskName: string;
  text: string;
}

export interface AnswerRequest {
  answers: { answer: string; question: number }[];
}

export interface ApiError {
  error: { code: string; message: string };
}

export interface Bearings {
  activity: ActivityEvent[];
  contributions: { checked: number; complete: boolean; known: number };
  counts: { landed: number; queued: number; underway: number; waitingOnYou: number };
  error: string | null;
  generatedAt: string | null;
  nextRefreshAt: string | null;
  queued: QueuedItem[];
  recentlyLanded: LandedItem[];
  refreshing: boolean;
  underway: Task[];
  waitingOnYou: WaitingOnYou;
}

export interface Decision {
  /** The id of the task the decision gates. */
  id: string;
  questions: Question[];
  /** One plain-English sentence. */
  summary: string;
  /** Free text, present only when the decision has no structured questions. */
  text: string | null;
  title: string;
}

export interface Finding {
  id: string;
  severity: "error" | "info" | "warning";
  text: string;
}

export interface LandedItem {
  id: string;
  kind: "pull_request" | "report";
  path: string | null;
  title: string;
  url: string | null;
}

export interface NoteReceipt {
  accepted: true;
  receivedAt: string;
}

export interface NoteRequest {
  text: string;
}

export interface Pipeline {
  findings: Finding[];
  gate: { status: string; step: StepName } | null;
  runId: string;
  status: string;
  steps: PipelineStep[];
  tool: "no-mistakes";
}

export interface PipelineStep {
  findings: number;
  name: StepName;
  status: StepStatus;
}

export interface PullRequest {
  number: number;
  url: string;
}

export interface Question {
  /** 1-based position inside its decision. */
  number: number;
  options: QuestionOption[];
  title: string;
}

export interface QuestionOption {
  recommended: boolean;
  text: string;
}

export interface QueuedItem {
  id: string;
  reason: string;
  title: string;
}

/** Raw snapshot from bin/fm-bearings-snapshot.sh --json (only the fields the API reads). */
export interface RawSnapshot {
  contributions: { checked: number; complete: boolean; known: number };
  decisions_open: { id: string; summary: string }[];
  gates: { id?: string; reason?: string; title?: string }[];
  in_flight: {
    doing: string;
    id: string;
    kind: string;
    name: string;
    repo: string;
    state: string;
  }[];
  landed: { artifact: string; id: string; what: string }[];
  recorded_prs: { id: string; url: string }[];
}

export interface ReadyToMerge {
  name: string;
  pullRequest: PullRequest;
  summary: string;
  taskId: string;
}

export interface RefreshReceipt {
  accepted: true;
}

export interface Task {
  id: string;
  kind: "other" | "scout" | "ship";
  links: TaskLinks;
  name: string;
  pipeline: Pipeline | null;
  repo: string;
  state: TaskState;
  /** One plain-English sentence describing where the task is. */
  status: string;
}

export interface TaskLinks {
  linear: { key: string; url: string } | null;
  pullRequest: PullRequest | null;
}

export interface WaitingOnYou {
  decisions: Decision[];
  readyToMerge: ReadyToMerge[];
}
