/**
 * Zod schemas for everything the API reads from outside: request bodies, query strings and
 * path ids, the snapshot script's JSON, and task meta files.
 *
 * @remarks
 * Each schema is checked against its type in `types.ts` with `satisfies`, so the two cannot
 * drift. Environment variables have their own schema in `env.ts`.
 *
 * @packageDocumentation
 */
import { z } from "zod";

import { ACTIVITY_LIMIT, TASK_STATES } from "./types.ts";
import type {
  AnswerRequest,
  NoteRequest,
  RawDecision,
  RawGate,
  RawLanded,
  RawRecordedPr,
  RawSnapshot,
  RawTask,
} from "./types.ts";

// ---------- requests ----------

/** The `limit` query parameter of `GET /api/v1/activity`. */
export const ActivityLimitSchema = z.coerce
  .number()
  .int()
  .min(1)
  .max(ACTIVITY_LIMIT)
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
        answer: z.string().max(2000).trim().min(1),
        question: z.int().min(1),
      }),
    )
    .min(1)
    .max(20)
    .refine((answers) => new Set(answers.map((item) => item.question)).size === answers.length, {
      error: "Each question may be answered only once.",
    }),
}) satisfies z.ZodType<AnswerRequest>;

/** A task or decision id in a path. */
export const IdSchema = z.string().regex(/^[A-Za-z0-9._-]+$/);

/** Body of `POST /api/v1/notes`: only a `text` key, non-blank and at most 4000 characters. */
export const NoteRequestSchema = z.strictObject({
  text: z.string().max(4000).trim().min(1),
}) satisfies z.ZodType<NoteRequest>;

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
    decisions_open: list(
      "decisions_open",
      item({ id: text("id"), summary: text("summary") }) satisfies z.ZodType<RawDecision>,
    ),
    gates: list(
      "gates",
      item({
        id: optionalText("id"),
        reason: optionalText("reason"),
        title: optionalText("title"),
      }) satisfies z.ZodType<RawGate>,
    ),
    in_flight: list(
      "in_flight",
      item({
        doing: text("doing"),
        id: text("id"),
        kind: text("kind"),
        name: text("name"),
        repo: text("repo"),
      }) satisfies z.ZodType<RawTask>,
    ),
    landed: list(
      "landed",
      item({
        artifact: text("artifact"),
        id: text("id"),
        what: text("what"),
      }) satisfies z.ZodType<RawLanded>,
    ),
    recorded_prs: list(
      "recorded_prs",
      item({ id: text("id"), url: text("url") }) satisfies z.ZodType<RawRecordedPr>,
    ),
  },
  { error: "is not a JSON object" },
) satisfies z.ZodType<RawSnapshot>;

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
