/**
 * Zod schemas for everything the API reads from outside: request bodies, query strings and
 * path ids, the snapshot script's JSON, and task meta files.
 *
 * @remarks
 * The types of these inputs are inferred from the schemas, so the two cannot drift. The request
 * body schemas also become the spec's `AnswerRequest` and `NoteRequest` components (see
 * `openapi.ts`). Environment variables have their own schema in `env.ts`.
 *
 * @packageDocumentation
 */
import { z } from "zod";

import { ACTIVITY_LIMIT, TASK_STATES } from "./types.ts";

// ---------- requests ----------

/**
 * The `limit` query parameter of `GET /api/v1/activity`: plain digits, from 1 to
 * {@link ACTIVITY_LIMIT}, which is also the default. Forms like `0x10` or `1e1` are refused.
 */
export const ActivityLimitSchema = z
  .string()
  .regex(/^\d+$/)
  .transform(Number)
  .pipe(z.int().min(1).max(ACTIVITY_LIMIT))
  .default(ACTIVITY_LIMIT);

/**
 * Body of `POST /api/v1/questions/{id}/answers`.
 *
 * @remarks
 * Unknown keys are refused at both levels. There must be 1 to 20 answers, each with a whole
 * question number of at least 1 and a non-blank answer of at most 2000 characters, which is
 * trimmed. Each question may be answered only once.
 */
export const AnswerRequestSchema = z.strictObject({
  answers: z
    .array(
      z.strictObject({
        answer: z
          .string()
          .max(2000)
          .trim()
          .min(1)
          .meta({ description: "One of the question's options, or your own words." }),
        question: z.int().min(1).meta({
          description:
            "The question number inside the decision. A decision with no structured questions is answered as question 1.",
        }),
      }),
    )
    .min(1)
    .max(20)
    .refine((answers) => new Set(answers.map((item) => item.question)).size === answers.length, {
      error: "Each question may be answered only once.",
    })
    .meta({ description: "One entry per question answered. Each question may be answered once." }),
});

/** See {@link AnswerRequestSchema}. */
export type AnswerRequest = z.infer<typeof AnswerRequestSchema>;

/** A task or decision id in a path. */
export const IdSchema = z.string().regex(/^[A-Za-z0-9._-]+$/);

/**
 * The optional `Idempotency-Key` header of the write endpoints.
 *
 * @remarks
 * It becomes the inbox note's request id, so a client that retries with the same key does not
 * record the note twice. It is limited to 1 to 128 letters, digits and `._:-`, since it is
 * passed to `fm-inbox.sh` as an argument.
 */
export const IdempotencyKeySchema = z
  .string()
  .regex(/^[A-Za-z0-9._:-]{1,128}$/)
  .optional();

/** Body of `POST /api/v1/notes`: only a `text` key, non-blank and at most 4000 characters. */
export const NoteRequestSchema = z.strictObject({
  text: z
    .string()
    .max(4000)
    .trim()
    .min(1)
    .meta({ description: "Anything you want Firstmate to read." }),
});

/** See {@link NoteRequestSchema}. */
export type NoteRequest = z.infer<typeof NoteRequestSchema>;

/** The `state` query parameter of `GET /api/v1/tasks`. */
export const TaskStateFilterSchema = z.enum(TASK_STATES).optional();

// ---------- the snapshot script's JSON ----------

/** The error for a missing or malformed `contributions` object or any of its fields. */
const CONTRIBUTIONS_ERROR = "needs checked, complete and known";

/**
 * A list item, which must be an object. Fields not listed are dropped.
 *
 * @param shape - The fields this API reads.
 */
function item<Shape extends z.ZodRawShape>(shape: Shape): z.ZodObject<Shape> {
  return z.object(shape, { error: "is not an object" });
}

/**
 * A list of items in the snapshot.
 *
 * @typeParam T - The item type.
 * @param name - The list name, for the error.
 * @param itemSchema - The fields each item has.
 */
function list<T>(name: string, itemSchema: z.ZodType<T>): z.ZodArray<z.ZodType<T>> {
  return z.array(itemSchema, { error: `has no "${name}" list` });
}

/**
 * An optional text field. `null` counts as absent.
 *
 * @param field - The field name, for the error.
 */
function optionalText(field: string): z.ZodType<string | undefined> {
  return z
    .string({ error: `has a "${field}" that is not text` })
    .nullish()
    .transform((value) => value ?? undefined);
}

/**
 * A required text field.
 *
 * @param field - The field name, for the error.
 */
function text(field: string): z.ZodString {
  return z.string({
    error: (issue) =>
      issue.input === undefined ? `has no "${field}" text` : `has a "${field}" that is not text`,
  });
}

/**
 * The JSON printed by `fm-bearings-snapshot.sh --json`.
 *
 * @remarks
 * Only the fields this API reads are checked, and the rest are dropped, so the script may add
 * fields freely.
 */
export const RawSnapshotSchema = z.object(
  {
    contributions: z.object(
      {
        checked: z.number({ error: CONTRIBUTIONS_ERROR }),
        complete: z.boolean({ error: CONTRIBUTIONS_ERROR }),
        known: z.number({ error: CONTRIBUTIONS_ERROR }),
      },
      { error: CONTRIBUTIONS_ERROR },
    ),
    decisions_open: list("decisions_open", item({ id: text("id"), summary: text("summary") })),
    gates: list(
      "gates",
      item({
        id: optionalText("id"),
        reason: optionalText("reason"),
        title: optionalText("title"),
      }),
    ),
    in_flight: list(
      "in_flight",
      item({
        doing: text("doing"),
        id: text("id"),
        kind: text("kind"),
        name: text("name"),
        repo: text("repo"),
      }),
    ),
    landed: list(
      "landed",
      item({
        artifact: text("artifact"),
        id: text("id"),
        what: text("what"),
      }),
    ),
    recorded_prs: list("recorded_prs", item({ id: text("id"), url: text("url") })),
  },
  { error: "is not a JSON object" },
);

/** The fields this API reads from the snapshot script's JSON (see {@link RawSnapshotSchema}). */
export type RawSnapshot = z.infer<typeof RawSnapshotSchema>;

/** An open decision. Its `summary` is `Title: details`; the title becomes the decision title. */
export type RawDecision = RawSnapshot["decisions_open"][number];

/** A gate holding queued work. Every field may be missing. */
export type RawGate = RawSnapshot["gates"][number];

/** Something that landed. `artifact` is a pull request URL, or a report path. */
export type RawLanded = RawSnapshot["landed"][number];

/** A task in flight. `doing` is the script's own status line, used when the crew script gives nothing. */
export type RawTask = RawSnapshot["in_flight"][number];

// ---------- task meta files ----------

/**
 * The keys this API reads from `state/<id>.meta`. Each is optional and any others are dropped.
 */
export const TaskMetaSchema = z.object({
  branch: z.string().optional(),
  mode: z.string().optional(),
  pr: z.string().optional(),
  project: z.string().optional(),
  worktree: z.string().optional(),
});

/** What {@link TaskMetaSchema} keeps from a meta file. */
export type TaskMeta = z.infer<typeof TaskMetaSchema>;
