/** The OpenAPI 3.1 description of the Fleet Bearings API. Served at /openapi.json. */
import { STEP_NAMES, STEP_STATUSES, TASK_STATES } from "./types.ts";

type Json = null | boolean | number | string | Json[] | { [key: string]: Json };
type Schema = { [key: string]: Json };

const arrayOf = (items: Schema): Schema => ({ items, type: "array" });
const nullable = (s: Schema): Schema => ({ oneOf: [s, { type: "null" }] });
const ref = (name: string): Schema => ({ $ref: `#/components/schemas/${name}` });
const str = (description: string, extra: Schema = {}): Schema => ({
  description,
  type: "string",
  ...extra,
});

const stepNames = [...STEP_NAMES];

const schemas: Record<string, Schema> = {
  ActivityEvent: {
    additionalProperties: false,
    properties: {
      at: str("When it happened.", { format: "date-time" }),
      kind: { enum: ["blocked", "decision_asked", "decision_made", "finished"], type: "string" },
      taskId: str("Task id."),
      taskName: str("Task name."),
      text: str("One sentence."),
    },
    required: ["at", "kind", "taskId", "taskName", "text"],
    type: "object",
  },
  AnswerRequest: {
    additionalProperties: false,
    properties: {
      answers: {
        items: {
          additionalProperties: false,
          properties: {
            answer: {
              description: "One of the question's options, or your own words.",
              maxLength: 2000,
              minLength: 1,
              type: "string",
            },
            question: {
              description:
                "The question number inside the decision. A decision with no structured questions is answered as question 1.",
              minimum: 1,
              type: "integer",
            },
          },
          required: ["answer", "question"],
          type: "object",
        },
        maxItems: 20,
        minItems: 1,
        type: "array",
      },
    },
    required: ["answers"],
    type: "object",
  },
  Bearings: {
    additionalProperties: false,
    description: "The whole picture of the fleet at one moment.",
    properties: {
      activity: arrayOf(ref("ActivityEvent")),
      contributions: {
        additionalProperties: false,
        properties: {
          checked: { type: "integer" },
          complete: { type: "boolean" },
          known: { type: "integer" },
        },
        required: ["checked", "complete", "known"],
        type: "object",
      },
      counts: ref("Counts"),
      error: nullable(
        str(
          "The last refresh error, if the latest rebuild failed. The data is then from the previous good snapshot.",
        ),
      ),
      generatedAt: nullable(str("When this snapshot was built.", { format: "date-time" })),
      nextRefreshAt: nullable(str("When the next rebuild is due.", { format: "date-time" })),
      queued: arrayOf(ref("QueuedItem")),
      recentlyLanded: arrayOf(ref("LandedItem")),
      refreshing: { description: "True while a rebuild is running.", type: "boolean" },
      underway: arrayOf(ref("Task")),
      waitingOnYou: ref("WaitingOnYou"),
    },
    required: [
      "activity",
      "contributions",
      "counts",
      "error",
      "generatedAt",
      "nextRefreshAt",
      "queued",
      "recentlyLanded",
      "refreshing",
      "underway",
      "waitingOnYou",
    ],
    type: "object",
  },
  Counts: {
    additionalProperties: false,
    properties: {
      landed: { minimum: 0, type: "integer" },
      queued: { minimum: 0, type: "integer" },
      underway: { minimum: 0, type: "integer" },
      waitingOnYou: { minimum: 0, type: "integer" },
    },
    required: ["landed", "queued", "underway", "waitingOnYou"],
    type: "object",
  },
  Decision: {
    additionalProperties: false,
    description: "A set of questions that wait on the captain.",
    properties: {
      id: str("The id of the task the decision gates. Use it in the answers endpoint."),
      questions: arrayOf(ref("Question")),
      summary: str("One plain-English sentence."),
      text: nullable(str("Free text when the decision has no structured questions.")),
      title: str("Short title."),
    },
    required: ["id", "questions", "summary", "text", "title"],
    type: "object",
  },
  Error: {
    additionalProperties: false,
    properties: {
      error: {
        additionalProperties: false,
        properties: {
          code: str("Stable machine-readable code."),
          message: str("Plain-English explanation."),
        },
        required: ["code", "message"],
        type: "object",
      },
    },
    required: ["error"],
    type: "object",
  },
  Finding: {
    additionalProperties: false,
    properties: {
      id: str("Finding id, for example review-1."),
      severity: { enum: ["error", "info", "warning"], type: "string" },
      text: str("Plain description of the finding."),
    },
    required: ["id", "severity", "text"],
    type: "object",
  },
  Health: {
    additionalProperties: false,
    properties: {
      error: nullable(
        str(
          'Last refresh error. Without a valid key (when one is set) it is only "refresh failed".',
        ),
      ),
      generatedAt: nullable(str("When the current snapshot was built.", { format: "date-time" })),
      ok: { type: "boolean" },
      ready: { description: "False until the first snapshot has been built.", type: "boolean" },
      refreshing: { type: "boolean" },
    },
    required: ["error", "generatedAt", "ok", "ready", "refreshing"],
    type: "object",
  },
  LandedItem: {
    additionalProperties: false,
    properties: {
      id: str("Task id."),
      kind: { enum: ["pull_request", "report"], type: "string" },
      path: nullable(str("Report path on the Firstmate machine.")),
      title: str("What landed."),
      url: nullable(str("Pull request URL.", { format: "uri" })),
    },
    required: ["id", "kind", "path", "title", "url"],
    type: "object",
  },
  NoteReceipt: {
    additionalProperties: false,
    properties: {
      accepted: { const: true, type: "boolean" },
      receivedAt: str("When the note was recorded.", { format: "date-time" }),
    },
    required: ["accepted", "receivedAt"],
    type: "object",
  },
  NoteRequest: {
    additionalProperties: false,
    properties: {
      text: {
        description: "Anything you want Firstmate to read.",
        maxLength: 4000,
        minLength: 1,
        type: "string",
      },
    },
    required: ["text"],
    type: "object",
  },
  Pipeline: {
    additionalProperties: false,
    description: "The no-mistakes validation run for a task.",
    properties: {
      findings: { ...arrayOf(ref("Finding")), description: "Findings at the current gate." },
      gate: nullable({
        additionalProperties: false,
        description: "The step the run is held at, if any.",
        properties: {
          status: str("Gate status, for example awaiting_approval."),
          step: { enum: stepNames, type: "string" },
        },
        required: ["status", "step"],
        type: "object",
      }),
      runId: str("Run id."),
      status: str("Run status as reported by no-mistakes, for example running or failed."),
      steps: arrayOf(ref("PipelineStep")),
      tool: { const: "no-mistakes", type: "string" },
    },
    required: ["findings", "gate", "runId", "status", "steps", "tool"],
    type: "object",
  },
  PipelineStep: {
    additionalProperties: false,
    properties: {
      findings: { description: "Findings raised by the step.", minimum: 0, type: "integer" },
      name: { description: "Validation step.", enum: stepNames, type: "string" },
      status: {
        description: "unknown stands for a status this API does not recognise.",
        enum: [...STEP_STATUSES],
        type: "string",
      },
    },
    required: ["findings", "name", "status"],
    type: "object",
  },
  PullRequest: {
    additionalProperties: false,
    properties: {
      number: { type: "integer" },
      url: str("Pull request URL.", { format: "uri" }),
    },
    required: ["number", "url"],
    type: "object",
  },
  Question: {
    additionalProperties: false,
    properties: {
      number: { description: "1-based position inside its decision.", minimum: 1, type: "integer" },
      options: { ...arrayOf(ref("QuestionOption")), maxItems: 4, minItems: 1 },
      title: str("The question."),
    },
    required: ["number", "options", "title"],
    type: "object",
  },
  QuestionOption: {
    additionalProperties: false,
    properties: {
      recommended: { description: "True for the option Firstmate recommends.", type: "boolean" },
      text: str("The option."),
    },
    required: ["recommended", "text"],
    type: "object",
  },
  QueuedItem: {
    additionalProperties: false,
    properties: {
      id: str("Task id."),
      reason: str("Why it is waiting."),
      title: str("Queued work."),
    },
    required: ["id", "reason", "title"],
    type: "object",
  },
  ReadyToMerge: {
    additionalProperties: false,
    properties: {
      name: str("Task name."),
      pullRequest: ref("PullRequest"),
      summary: str("One plain-English sentence."),
      taskId: str("Task id."),
    },
    required: ["name", "pullRequest", "summary", "taskId"],
    type: "object",
  },
  RefreshReceipt: {
    additionalProperties: false,
    properties: { accepted: { const: true, type: "boolean" } },
    required: ["accepted"],
    type: "object",
  },
  Task: {
    additionalProperties: false,
    properties: {
      id: str("Stable task id."),
      kind: {
        description: "ship changes a project, scout investigates.",
        enum: ["other", "scout", "ship"],
        type: "string",
      },
      links: ref("TaskLinks"),
      name: str("Human name of the task."),
      pipeline: nullable(ref("Pipeline")),
      repo: str("Repository the task works in."),
      state: { description: "Machine-readable state.", enum: [...TASK_STATES], type: "string" },
      status: str("One plain-English sentence describing where the task is."),
    },
    required: ["id", "kind", "links", "name", "pipeline", "repo", "state", "status"],
    type: "object",
  },
  TaskLinks: {
    additionalProperties: false,
    properties: {
      linear: nullable({
        additionalProperties: false,
        properties: {
          key: str("Ticket key, for example LIV-3692."),
          url: str("Ticket URL.", { format: "uri" }),
        },
        required: ["key", "url"],
        type: "object",
      }),
      pullRequest: nullable(ref("PullRequest")),
    },
    required: ["linear", "pullRequest"],
    type: "object",
  },
  WaitingOnYou: {
    additionalProperties: false,
    description: "Decisions with their questions, plus pull requests ready to merge.",
    properties: {
      decisions: arrayOf(ref("Decision")),
      readyToMerge: arrayOf(ref("ReadyToMerge")),
    },
    required: ["decisions", "readyToMerge"],
    type: "object",
  },
};

const errorResponse = (description: string): Schema => jsonBody("Error", description);
const idParam: Schema = {
  description: "Task id.",
  in: "path",
  name: "id",
  required: true,
  schema: { type: "string" },
};
const jsonBody = (name: string, description: string): Schema => ({
  content: { "application/json": { schema: ref(name) } },
  description,
});

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
          schema: { default: 16, maximum: 16, minimum: 1, type: "integer" },
        },
      ],
      responses: {
        "200": {
          content: { "application/json": { schema: arrayOf(ref("ActivityEvent")) } },
          description: "Events, newest first.",
        },
        "400": errorResponse("limit is not a whole number from 1 to 16."),
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
      requestBody: {
        content: { "application/json": { schema: ref("NoteRequest") } },
        required: true,
      },
      responses: {
        "202": jsonBody("NoteReceipt", "Accepted and recorded."),
        "400": errorResponse("The request body is not valid JSON or is the wrong shape."),
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
      parameters: [{ ...idParam, description: "Decision id (the task it gates)." }],
      requestBody: {
        content: { "application/json": { schema: ref("AnswerRequest") } },
        required: true,
      },
      responses: {
        "202": jsonBody("NoteReceipt", "Accepted and recorded as a note."),
        "400": errorResponse("The request body is not valid JSON or is the wrong shape."),
        "404": errorResponse("No such open decision."),
        "415": errorResponse("Content-Type must be application/json."),
        "422": errorResponse("A question number does not exist in the decision."),
        "502": errorResponse("The note could not be recorded."),
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

// Responses every operation shares, added here rather than repeated in each one.
for (const ops of Object.values(paths)) {
  for (const [method, op] of Object.entries(ops)) {
    const responses = op["responses"] as Record<string, Json>;
    responses["421"] = errorResponse("The Host header is not an allowed host name.");
    if (op["security"] === undefined)
      responses["401"] = errorResponse(
        "An API key is set and the bearer token is missing or wrong.",
      );
    if (method === "post") responses["403"] = errorResponse("The request came from another site.");
    if (op["requestBody"]) responses["413"] = errorResponse("The body is over 20 KB.");
  }
}

// Top-level keys keep the conventional OpenAPI order, and tags keep the order /docs shows them in.
// oxlint-disable-next-line sort-keys
export const openapi: Schema = {
  openapi: "3.1.0",
  info: {
    description:
      "A read API over the Fleet Bearings view: the questions waiting on the captain, the work under way with its validation steps, what landed, what is queued, and recent activity. " +
      "Data is rebuilt every 5 minutes. A few write endpoints send answers and notes to Firstmate as inbox notes; the API never answers a decision, merges, or changes a task by itself.",
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
