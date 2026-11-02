/**
 * The API's response shapes, defined once as Zod schemas, with their types inferred from them.
 *
 * @remarks
 * These schemas are the single source for both the TypeScript types and the OpenAPI component
 * schemas: `openapi.ts` turns them into JSON Schema with `z.toJSONSchema`, so the spec cannot
 * drift from the types. Descriptions given with `.meta()` become the spec's descriptions.
 *
 * The enums are `as const` arrays defined once here. `schemas.ts` and `status.ts` read the same
 * arrays, so the spec, the parsers and the types can never disagree on the allowed values.
 *
 * The server does not parse its own responses with these schemas; `pnpm check` validates real
 * responses against the spec built from them.
 *
 * Schemas are declared before the schemas that use them, so they are not in alphabetical order.
 *
 * @packageDocumentation
 */
import { z } from "zod";

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

// ---------- helpers ----------

/**
 * A schema with a description for the spec.
 *
 * @typeParam T - The schema type.
 * @param schema - The schema to describe.
 * @param description - What the value means, in plain English.
 */
function described<T extends z.ZodType>(schema: T, description: string): T {
  return schema.meta({ description });
}

/** A count, a whole number of at least 0. */
const count = (): z.ZodInt => z.int().nonnegative();

/**
 * An ISO 8601 timestamp, as `Date.prototype.toISOString` writes it.
 *
 * @param description - What the time is.
 */
const timestamp = (description: string): z.ZodISODateTime =>
  described(z.iso.datetime(), description);

/**
 * A text field.
 *
 * @param description - What the text is.
 */
const text = (description: string): z.ZodString => described(z.string(), description);

// ---------- schemas ----------

/** Something that happened to a task, read from its `state/<id>.status` file. */
export const ActivityEventSchema = z.object({
  at: timestamp("When it happened."),
  kind: described(
    z.enum(["blocked", "decision_asked", "decision_made", "finished"]),
    "What kind of event it was.",
  ),
  taskId: text("The id of the task it happened to."),
  taskName: text("The task's name, or its id with dashes as spaces when the name is not known."),
  text: text("One plain-English sentence."),
});

/** Body of every error response. */
export const ApiErrorSchema = z.object({
  error: z.object({
    code: text("Stable machine-readable code, for example task_not_found."),
    message: text("Plain-English explanation."),
  }),
});

/** How many items are in each list, for badges and summaries. */
export const CountsSchema = z.object({
  landed: count(),
  queued: count(),
  underway: count(),
  waitingOnYou: count(),
});

/** A finding raised at a validation gate. */
export const FindingSchema = z.object({
  id: text("Finding id, for example review-1."),
  severity: described(
    z.enum(["error", "info", "warning"]),
    "How serious it is. Anything no-mistakes reports other than error or warning is info.",
  ),
  text: text("A plain description, at most 260 characters."),
});

/** The current state of the cache, as `GET /health` reports it. */
export const HealthSchema = z.object({
  error: described(
    z.string().nullable(),
    'The last refresh error, or null. Without a valid key (when one is set) it is only "refresh failed".',
  ),
  generatedAt: described(
    z.iso.datetime().nullable(),
    "When the current snapshot was built, or null before the first one.",
  ),
  ok: z.boolean(),
  ready: described(z.boolean(), "False until the first snapshot has been built."),
  refreshing: described(z.boolean(), "True while a rebuild is running."),
});

/** Something that recently landed: a merged pull request or a written report. */
export const LandedItemSchema = z.object({
  id: text("The id of the task that produced it."),
  kind: described(z.enum(["pull_request", "report"]), "pull_request has a url, report has a path."),
  path: described(
    z.string().nullable(),
    "The report's path on the Firstmate machine, or null for a pull request.",
  ),
  title: text("What landed."),
  url: described(z.url().nullable(), "The pull request URL, or null for a report."),
});

/** Response to a write that was passed on to Firstmate's inbox. */
export const NoteReceiptSchema = z.object({
  accepted: z.literal(true),
  receivedAt: timestamp("When the note was recorded."),
});

/** One step of a validation run. */
export const PipelineStepSchema = z.object({
  findings: described(count(), "How many findings the step raised."),
  name: described(z.enum(STEP_NAMES), "Which step it is."),
  status: described(
    z.enum(STEP_STATUSES),
    "Where the step is. unknown stands for a status this API does not recognise.",
  ),
});

/** A task's no-mistakes validation run. */
export const PipelineSchema = described(
  z.object({
    findings: described(z.array(FindingSchema), "The findings at the current gate."),
    gate: described(
      z
        .object({
          status: text("Gate status, for example awaiting_approval."),
          step: z.enum(STEP_NAMES),
        })
        .nullable(),
      "The step the run is held at, or null when it is not held.",
    ),
    runId: text("The no-mistakes run id."),
    status: text("The run status as no-mistakes reports it, for example running or failed."),
    steps: described(z.array(PipelineStepSchema), "The steps in pipeline order."),
    tool: z.literal("no-mistakes"),
  }),
  "The no-mistakes validation run for a task.",
);

/** A GitHub pull request. */
export const PullRequestSchema = z.object({
  number: described(count(), "The pull request number."),
  url: described(z.url(), "The pull request URL."),
});

/** One option of a question. */
export const QuestionOptionSchema = z.object({
  recommended: described(z.boolean(), "True for the option Firstmate recommends."),
  text: text("The option's text."),
});

/** One question inside a decision. */
export const QuestionSchema = z.object({
  number: described(
    z.int().min(1),
    "The 1-based position inside its decision. Answers refer to questions by this number.",
  ),
  options: z.array(QuestionOptionSchema).min(1).max(4),
  title: text("The question itself."),
});

/** A set of questions that a task is held on until the captain answers. */
export const DecisionSchema = described(
  z.object({
    id: text("The id of the task the decision gates. Use it in the answers endpoint."),
    questions: described(
      z.array(QuestionSchema),
      "The structured questions, in order. Empty when the decision is free text.",
    ),
    summary: text("One plain-English sentence."),
    text: described(
      z.string().nullable(),
      "The free-text question, present only when the decision has no structured questions.",
    ),
    title: text("A short title."),
  }),
  "A set of questions that wait on the captain.",
);

/** Work waiting to start. */
export const QueuedItemSchema = z.object({
  id: text("The task id."),
  reason: text("One sentence on why it is waiting."),
  title: text("What the work is."),
});

/** An open pull request whose checks are green and which is waiting for the captain to merge. */
export const ReadyToMergeSchema = z.object({
  name: text("The task's name."),
  pullRequest: PullRequestSchema,
  summary: text("One plain-English sentence."),
  taskId: text("The id of the task that opened it."),
});

/** Response to `POST /api/v1/refresh`. */
export const RefreshReceiptSchema = z.object({ accepted: z.literal(true) });

/** Links from a task to things outside Firstmate. */
export const TaskLinksSchema = z.object({
  linear: described(
    z
      .object({
        key: text("Ticket key, for example LIV-42."),
        url: described(z.url(), "Ticket URL."),
      })
      .nullable(),
    "The Linear ticket, or null when Linear is not configured or no key was found.",
  ),
  pullRequest: described(
    PullRequestSchema.nullable(),
    "The task's pull request, or null when it has none.",
  ),
});

/** A task in flight. */
export const TaskSchema = z.object({
  id: text("The stable task id."),
  kind: described(
    z.enum(["other", "scout", "ship"]),
    "ship changes a project, scout investigates, anything else is other.",
  ),
  links: TaskLinksSchema,
  name: text("The task's name."),
  pipeline: described(
    PipelineSchema.nullable(),
    "The task's validation run, or null when it does not use no-mistakes.",
  ),
  repo: text("The repository the task works in."),
  state: described(z.enum(TASK_STATES), "Where the task is, as a machine-readable value."),
  status: text("Where the task is, as one plain-English sentence."),
});

/** Everything that needs the captain. */
export const WaitingOnYouSchema = described(
  z.object({
    decisions: z.array(DecisionSchema),
    readyToMerge: z.array(ReadyToMergeSchema),
  }),
  "Decisions with their questions, plus pull requests ready to merge.",
);

/** The whole picture of the fleet at one moment. Every GET endpoint returns a slice of it. */
export const BearingsSchema = described(
  z.object({
    activity: described(z.array(ActivityEventSchema), "Recent events, newest first."),
    contributions: described(
      z.object({ checked: count(), complete: z.boolean(), known: count() }),
      "How many contribution records the snapshot script knew about and checked.",
    ),
    counts: CountsSchema,
    error: described(
      z.string().nullable(),
      "The last refresh error, or null. When set, the rest of the data is from the previous good snapshot.",
    ),
    generatedAt: described(z.iso.datetime().nullable(), "When this snapshot was built."),
    nextRefreshAt: described(
      z.iso.datetime().nullable(),
      "When the next rebuild is due, or null while one is running.",
    ),
    queued: described(z.array(QueuedItemSchema), "Work waiting to start."),
    recentlyLanded: described(
      z.array(LandedItemSchema),
      "Pull requests and reports that recently landed.",
    ),
    refreshing: described(z.boolean(), "True while a rebuild is running."),
    underway: described(z.array(TaskSchema), "Tasks in flight."),
    waitingOnYou: WaitingOnYouSchema,
  }),
  "The whole picture of the fleet at one moment.",
);

// ---------- types ----------

/** See {@link ActivityEventSchema}. */
export type ActivityEvent = z.infer<typeof ActivityEventSchema>;

/** See {@link ApiErrorSchema}. */
export type ApiError = z.infer<typeof ApiErrorSchema>;

/** See {@link BearingsSchema}. */
export type Bearings = z.infer<typeof BearingsSchema>;

/** See {@link DecisionSchema}. */
export type Decision = z.infer<typeof DecisionSchema>;

/** See {@link FindingSchema}. */
export type Finding = z.infer<typeof FindingSchema>;

/** See {@link HealthSchema}. */
export type Health = z.infer<typeof HealthSchema>;

/** See {@link LandedItemSchema}. */
export type LandedItem = z.infer<typeof LandedItemSchema>;

/** See {@link NoteReceiptSchema}. */
export type NoteReceipt = z.infer<typeof NoteReceiptSchema>;

/** See {@link PipelineSchema}. */
export type Pipeline = z.infer<typeof PipelineSchema>;

/** See {@link PipelineStepSchema}. */
export type PipelineStep = z.infer<typeof PipelineStepSchema>;

/** See {@link PullRequestSchema}. */
export type PullRequest = z.infer<typeof PullRequestSchema>;

/** See {@link QuestionSchema}. */
export type Question = z.infer<typeof QuestionSchema>;

/** See {@link QuestionOptionSchema}. */
export type QuestionOption = z.infer<typeof QuestionOptionSchema>;

/** See {@link QueuedItemSchema}. */
export type QueuedItem = z.infer<typeof QueuedItemSchema>;

/** See {@link ReadyToMergeSchema}. */
export type ReadyToMerge = z.infer<typeof ReadyToMergeSchema>;

/** See {@link RefreshReceiptSchema}. */
export type RefreshReceipt = z.infer<typeof RefreshReceiptSchema>;

/** See {@link TaskSchema}. */
export type Task = z.infer<typeof TaskSchema>;

/** See {@link TaskLinksSchema}. */
export type TaskLinks = z.infer<typeof TaskLinksSchema>;

/** See {@link WaitingOnYouSchema}. */
export type WaitingOnYou = z.infer<typeof WaitingOnYouSchema>;
