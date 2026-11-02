/** Public shapes of the Fleet Bearings API. The OpenAPI spec in openapi.ts mirrors these. */

export type TaskState =
  | "working"
  | "waiting_on_you"
  | "waiting"
  | "ready_for_review"
  | "blocked"
  | "failed"
  | "finished"
  | "unknown";

export type StepName =
  | "intent"
  | "rebase"
  | "review"
  | "test"
  | "document"
  | "lint"
  | "push"
  | "pr"
  | "ci";

export type StepStatus =
  | "completed"
  | "running"
  | "fixing"
  | "awaiting_approval"
  | "pending"
  | "skipped"
  | "failed";

export interface Finding {
  id: string;
  severity: "error" | "warning" | "info";
  text: string;
}

export interface PipelineStep {
  name: StepName;
  status: StepStatus;
  findings: number;
}

export interface Pipeline {
  tool: "no-mistakes";
  runId: string;
  status: string;
  steps: PipelineStep[];
  gate: { step: StepName; status: string } | null;
  findings: Finding[];
}

export interface TaskLinks {
  linear: { key: string; url: string } | null;
  pullRequest: { number: number; url: string } | null;
}

export interface Task {
  id: string;
  name: string;
  repo: string;
  kind: "ship" | "scout" | "other";
  state: TaskState;
  /** One plain-English sentence describing where the task is. */
  status: string;
  links: TaskLinks;
  pipeline: Pipeline | null;
}

export interface QuestionOption {
  text: string;
  recommended: boolean;
}

export interface Question {
  /** 1-based position inside its decision. */
  number: number;
  title: string;
  options: QuestionOption[];
}

export interface Decision {
  /** The id of the task the decision gates. */
  id: string;
  title: string;
  /** One plain-English sentence. */
  summary: string;
  questions: Question[];
  /** Free text, present only when the decision has no structured questions. */
  text: string | null;
}

export interface ReadyToMerge {
  taskId: string;
  name: string;
  summary: string;
  pullRequest: { number: number; url: string };
}

export interface LandedItem {
  id: string;
  title: string;
  kind: "pull_request" | "report";
  url: string | null;
  path: string | null;
}

export interface QueuedItem {
  id: string;
  title: string;
  reason: string;
}

export interface ActivityEvent {
  at: string;
  taskId: string;
  taskName: string;
  kind: "finished" | "decision_made" | "decision_asked" | "blocked";
  text: string;
}

export interface Bearings {
  generatedAt: string | null;
  nextRefreshAt: string | null;
  refreshing: boolean;
  error: string | null;
  counts: { waitingOnYou: number; underway: number; landed: number; queued: number };
  waitingOnYou: { decisions: Decision[]; readyToMerge: ReadyToMerge[] };
  underway: Task[];
  recentlyLanded: LandedItem[];
  queued: QueuedItem[];
  activity: ActivityEvent[];
  contributions: { known: number; checked: number; complete: boolean };
}

export interface AnswerRequest {
  answers: { question: number; answer: string }[];
}

export interface NoteRequest {
  text: string;
}

export interface NoteReceipt {
  accepted: true;
  receivedAt: string;
}

export interface ApiError {
  error: { code: string; message: string };
}

/** Raw snapshot from bin/fm-bearings-snapshot.sh --json (only the fields the API reads). */
export interface RawSnapshot {
  in_flight: {
    id: string;
    kind: string;
    state: string;
    repo: string;
    name: string;
    doing: string;
  }[];
  decisions_open: { id: string; summary: string }[];
  landed: { id: string; what: string; artifact: string }[];
  gates: { id?: string; title?: string; reason?: string }[];
  recorded_prs: { id: string; url: string }[];
  contributions: { known: number; checked: number; complete: boolean };
}
