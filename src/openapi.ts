/**
 * The OpenAPI 3.1 description of the Fleet Bearings API, served at `/openapi.json`.
 *
 * @remarks
 * The component schemas are generated from the Zod schemas in `types.ts` and `schemas.ts`, so
 * they always match the types. The operations (paths, parameters and responses) are written by
 * hand here; `pnpm check` calls every one and validates the responses against the spec.
 *
 * @packageDocumentation
 */
import { z } from "zod";

import { REFRESH_SECONDS } from "./gather.ts";
import { AnswerRequestSchema, NoteRequestSchema } from "./schemas.ts";
import { plural } from "./status.ts";
import {
  ACTIVITY_LIMIT,
  ActivityEventSchema,
  ApiErrorSchema,
  BearingsSchema,
  CountsSchema,
  DecisionSchema,
  FindingSchema,
  HealthSchema,
  LandedItemSchema,
  NoteReceiptSchema,
  PipelineSchema,
  PipelineStepSchema,
  PullRequestSchema,
  QuestionOptionSchema,
  QuestionSchema,
  QueuedItemSchema,
  ReadyToMergeSchema,
  RefreshReceiptSchema,
  TASK_STATES,
  TaskLinksSchema,
  TaskSchema,
  WaitingOnYouSchema,
} from "./types.ts";

/** Any JSON value. */
type Json = null | boolean | number | string | Json[] | { [key: string]: Json };

/** A JSON object, used for schemas and other parts of the OpenAPI document. */
type Schema = { [key: string]: Json };

/** A schema for an array whose items match `items`. */
const arrayOf = (items: Schema): Schema => ({ items, type: "array" });

/** A reference to one of the named {@link schemas}. */
const ref = (name: string): Schema => ({ $ref: `#/components/schemas/${name}` });

/** The refresh interval in words, for example `5 minutes` or `90 seconds`. */
const refreshInterval =
  REFRESH_SECONDS % 60 === 0
    ? plural(REFRESH_SECONDS / 60, "minute")
    : plural(REFRESH_SECONDS, "second");

/**
 * The Zod schemas that become the spec's component schemas, by component name. Every schema
 * the API sends or accepts is listed here; schemas used inside them become `$ref`s.
 */
const componentSchemas: Record<string, z.ZodType> = {
  ActivityEvent: ActivityEventSchema,
  AnswerRequest: AnswerRequestSchema,
  Bearings: BearingsSchema,
  Counts: CountsSchema,
  Decision: DecisionSchema,
  Error: ApiErrorSchema,
  Finding: FindingSchema,
  Health: HealthSchema,
  LandedItem: LandedItemSchema,
  NoteReceipt: NoteReceiptSchema,
  NoteRequest: NoteRequestSchema,
  Pipeline: PipelineSchema,
  PipelineStep: PipelineStepSchema,
  PullRequest: PullRequestSchema,
  Question: QuestionSchema,
  QuestionOption: QuestionOptionSchema,
  QueuedItem: QueuedItemSchema,
  ReadyToMerge: ReadyToMergeSchema,
  RefreshReceipt: RefreshReceiptSchema,
  Task: TaskSchema,
  TaskLinks: TaskLinksSchema,
  WaitingOnYou: WaitingOnYouSchema,
};

/**
 * Turn {@link componentSchemas} into JSON Schema for `components.schemas`.
 *
 * @remarks
 * `z.toJSONSchema` writes each schema as a standalone document with `$schema` and `$id`; those
 * are dropped, since a component is part of the OpenAPI document. Schemas that refer to one
 * another get `$ref`s to `#/components/schemas/<name>`.
 */
function buildComponentSchemas(): Record<string, Schema> {
  const registry = z.registry<{ id: string }>();

  for (const [id, schema] of Object.entries(componentSchemas)) {
    registry.add(schema, { id });
  }

  const { schemas: generated } = z.toJSONSchema(registry, {
    target: "draft-2020-12",
    uri: (id) => `#/components/schemas/${id}`,
  });

  return Object.fromEntries(
    Object.entries(generated).map(([id, { $id: _id, $schema: _schema, ...schema }]) => [
      id,
      schema as Schema,
    ]),
  );
}

/** The component schemas, generated from the Zod schemas in `types.ts` and `schemas.ts`. */
const schemas = buildComponentSchemas();

/** A response whose body is the `Error` schema. */
const errorResponse = (description: string): Schema => jsonBody("Error", description);

/** The `{id}` path parameter. Operations override the description where it means a decision. */
const idParam: Schema = {
  description: "Task id.",
  in: "path",
  name: "id",
  required: true,
  schema: { type: "string" },
};
/** The optional `Idempotency-Key` header of the write endpoints. */
const idempotencyKeyParam: Schema = {
  description:
    "Retry a write with the same key and the note is recorded once. 1 to 128 letters, digits or ._:-",
  in: "header",
  name: "Idempotency-Key",
  required: false,
  schema: { pattern: "^[A-Za-z0-9._:-]{1,128}$", type: "string" },
};

/** A response whose JSON body matches the named schema. */
const jsonBody = (name: string, description: string): Schema => ({
  content: { "application/json": { schema: ref(name) } },
  description,
});

/** The operations, by path and then by method. */
const paths: Record<string, Record<string, Schema>> = {
  "/api/v1/activity": {
    get: {
      description: "Finished work, decisions asked and made, and blockers, newest first.",
      operationId: "listActivity",
      parameters: [
        {
          description: "How many events.",
          in: "query",
          name: "limit",
          required: false,
          schema: { default: ACTIVITY_LIMIT, maximum: ACTIVITY_LIMIT, minimum: 1, type: "integer" },
        },
      ],
      responses: {
        "200": {
          content: { "application/json": { schema: arrayOf(ref("ActivityEvent")) } },
          description: "Events, newest first.",
        },
        "400": errorResponse(`limit is not a whole number from 1 to ${ACTIVITY_LIMIT}.`),
        "503": errorResponse("The first snapshot is still being built."),
      },
      summary: "Recent activity",
      tags: ["Activity"],
    },
  },
  "/api/v1/bearings": {
    get: {
      operationId: "getBearings",
      responses: {
        "200": jsonBody("Bearings", "The latest snapshot."),
        "503": errorResponse(
          "The first snapshot is still being built, or failed and will be retried. Retry shortly.",
        ),
      },
      summary: "Get the whole picture",
      tags: ["Bearings"],
    },
  },
  "/api/v1/notes": {
    post: {
      operationId: "sendNote",
      parameters: [idempotencyKeyParam],
      requestBody: {
        content: { "application/json": { schema: ref("NoteRequest") } },
        required: true,
      },
      responses: {
        "202": jsonBody("NoteReceipt", "Accepted and recorded."),
        "400": errorResponse(
          "The request body is not valid JSON or is the wrong shape, or the Idempotency-Key is malformed.",
        ),
        "415": errorResponse("Content-Type must be application/json."),
        "502": errorResponse("The note could not be recorded."),
      },
      summary: "Send a note to Firstmate",
      tags: ["Notes"],
    },
  },
  "/api/v1/questions": {
    get: {
      description: "Decisions with their questions and options, plus pull requests ready to merge.",
      operationId: "listQuestions",
      responses: {
        "200": jsonBody("WaitingOnYou", "Everything waiting on the captain."),
        "503": errorResponse("The first snapshot is still being built."),
      },
      summary: "List what is waiting on you",
      tags: ["Questions"],
    },
  },
  "/api/v1/questions/{id}": {
    get: {
      operationId: "getDecision",
      parameters: [{ ...idParam, description: "Decision id (the task it gates)." }],
      responses: {
        "200": jsonBody("Decision", "The decision."),
        "404": errorResponse("No such open decision."),
        "503": errorResponse("The first snapshot is still being built."),
      },
      summary: "Get one decision",
      tags: ["Questions"],
    },
  },
  "/api/v1/questions/{id}/answers": {
    post: {
      description:
        "Sends your answers to Firstmate as an inbox note. Firstmate reads it and records the decision; the question stays listed until it does.",
      operationId: "answerDecision",
      parameters: [
        { ...idParam, description: "Decision id (the task it gates)." },
        idempotencyKeyParam,
      ],
      requestBody: {
        content: { "application/json": { schema: ref("AnswerRequest") } },
        required: true,
      },
      responses: {
        "202": jsonBody("NoteReceipt", "Accepted and recorded as a note."),
        "400": errorResponse(
          "The request body is not valid JSON or is the wrong shape, or the Idempotency-Key is malformed.",
        ),
        "404": errorResponse("No such open decision."),
        "415": errorResponse("Content-Type must be application/json."),
        "422": errorResponse("A question number does not exist in the decision."),
        "502": errorResponse("The note could not be recorded."),
        "503": errorResponse("The first snapshot is still being built."),
      },
      summary: "Answer questions in a decision",
      tags: ["Questions"],
    },
  },
  "/api/v1/refresh": {
    post: {
      description:
        "Starts a rebuild and returns at once. Poll /api/v1/bearings and watch generatedAt.",
      operationId: "refresh",
      responses: {
        "202": jsonBody("RefreshReceipt", "A rebuild has started or is already running."),
      },
      summary: "Rebuild the snapshot now",
      tags: ["Service"],
    },
  },
  "/api/v1/tasks": {
    get: {
      operationId: "listTasks",
      parameters: [
        {
          description: "Only tasks in this state.",
          in: "query",
          name: "state",
          required: false,
          schema: { enum: [...TASK_STATES], type: "string" },
        },
      ],
      responses: {
        "200": {
          content: { "application/json": { schema: arrayOf(ref("Task")) } },
          description: "Tasks under way.",
        },
        "400": errorResponse("state is not one of the task states."),
        "503": errorResponse("The first snapshot is still being built."),
      },
      summary: "List work under way",
      tags: ["Tasks"],
    },
  },
  "/api/v1/tasks/{id}": {
    get: {
      operationId: "getTask",
      parameters: [idParam],
      responses: {
        "200": jsonBody("Task", "The task."),
        "404": errorResponse("No such task under way."),
        "503": errorResponse("The first snapshot is still being built."),
      },
      summary: "Get one task",
      tags: ["Tasks"],
    },
  },
  "/health": {
    get: {
      operationId: "getHealth",
      responses: {
        "200": jsonBody(
          "Health",
          "The service is up. ready is false until the first snapshot exists.",
        ),
      },
      security: [],
      summary: "Health",
      tags: ["Service"],
    },
  },
};

// Responses that many operations share, added here rather than repeated in each one:
// 421 and 500 for every operation, 401 unless it is public (`security: []`), 403 for writes,
// and 413 for operations with a body.
for (const ops of Object.values(paths)) {
  for (const [method, op] of Object.entries(ops)) {
    const responses = op["responses"] as Record<string, Json>;
    responses["421"] = errorResponse("The Host header is not an allowed host name.");
    responses["500"] = errorResponse("An unexpected error. The server log has the details.");
    if (op["security"] === undefined) {
      responses["401"] = errorResponse(
        "An API key is set and the bearer token is missing or wrong.",
      );
    }
    if (method === "post") {
      responses["403"] = errorResponse("The request came from another site.");
    }
    if (op["requestBody"]) {
      responses["413"] = errorResponse("The body is over 20 KB.");
    }
  }
}

/**
 * The complete OpenAPI document.
 *
 * @remarks
 * Top-level keys keep the conventional OpenAPI order, and tags keep the order `/docs` shows
 * them in, rather than being sorted.
 */
// oxlint-disable-next-line sort-keys
export const openapi: Schema = {
  openapi: "3.1.0",
  info: {
    description:
      "A read API over the Fleet Bearings view: the questions waiting on the captain, the work under way with its validation steps, what landed, what is queued, and recent activity. " +
      `Data is rebuilt every ${refreshInterval}. A few write endpoints send answers and notes to Firstmate as inbox notes; the API never answers a decision, merges, or changes a task by itself.`,
    summary: "What the fleet is doing, what needs you, and a way to answer.",
    title: "Fleet Bearings API",
    version: "1.0.0",
  },
  servers: [{ description: "This server", url: "/" }],
  tags: [
    { description: "The whole picture.", name: "Bearings" },
    { description: "Work under way.", name: "Tasks" },
    { description: "Decisions waiting on the captain, and answering them.", name: "Questions" },
    { description: "Recent events.", name: "Activity" },
    { description: "Messages to Firstmate.", name: "Notes" },
    { description: "Health and refresh.", name: "Service" },
  ],
  security: [{}, { bearerAuth: [] }],
  paths,
  components: {
    schemas,
    securitySchemes: {
      bearerAuth: {
        description:
          "Optional. When the server is started with BEARINGS_API_KEY set, send it as a bearer token. By default the API is open to local callers.",
        scheme: "bearer",
        type: "http",
      },
    },
  },
};
