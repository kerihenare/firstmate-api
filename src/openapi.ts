/** The OpenAPI 3.1 description of the Fleet Bearings API. Served at /openapi.json. */

type Json = null | boolean | number | string | Json[] | { [key: string]: Json };
type Schema = { [key: string]: Json };

const ref = (name: string): Schema => ({ $ref: `#/components/schemas/${name}` });
const arrayOf = (items: Schema): Schema => ({ type: "array", items });
const nullable = (s: Schema): Schema => ({ oneOf: [s, { type: "null" }] });
const str = (description: string, extra: Schema = {}): Schema => ({ type: "string", description, ...extra });

const STEP_NAMES = ["intent", "rebase", "review", "test", "document", "lint", "push", "pr", "ci"];
const STEP_STATUSES = ["completed", "running", "fixing", "awaiting_approval", "pending", "skipped", "failed"];
const TASK_STATES = ["working", "waiting_on_you", "waiting", "ready_for_review", "blocked", "failed", "finished", "unknown"];

const schemas: Record<string, Schema> = {
  Finding: {
    type: "object", additionalProperties: false, required: ["id", "severity", "text"],
    properties: { id: str("Finding id, for example review-1."), severity: { type: "string", enum: ["error", "warning", "info"] }, text: str("Plain description of the finding.") },
  },
  PipelineStep: {
    type: "object", additionalProperties: false, required: ["name", "status", "findings"],
    properties: {
      name: { type: "string", enum: STEP_NAMES, description: "Validation step." },
      status: { type: "string", enum: STEP_STATUSES },
      findings: { type: "integer", minimum: 0, description: "Findings raised by the step." },
    },
  },
  Pipeline: {
    type: "object", additionalProperties: false, required: ["tool", "runId", "status", "steps", "gate", "findings"],
    description: "The no-mistakes validation run for a task.",
    properties: {
      tool: { type: "string", const: "no-mistakes" },
      runId: str("Run id."),
      status: str("Run status as reported by no-mistakes, for example running or failed."),
      steps: arrayOf(ref("PipelineStep")),
      gate: nullable({
        type: "object", additionalProperties: false, required: ["step", "status"],
        description: "The step the run is held at, if any.",
        properties: { step: { type: "string", enum: STEP_NAMES }, status: str("Gate status, for example awaiting_approval.") },
      }),
      findings: { ...arrayOf(ref("Finding")), description: "Findings at the current gate." },
    },
  },
  TaskLinks: {
    type: "object", additionalProperties: false, required: ["linear", "pullRequest"],
    properties: {
      linear: nullable({
        type: "object", additionalProperties: false, required: ["key", "url"],
        properties: { key: str("Ticket key, for example LIV-3692."), url: str("Ticket URL.", { format: "uri" }) },
      }),
      pullRequest: nullable({
        type: "object", additionalProperties: false, required: ["number", "url"],
        properties: { number: { type: "integer" }, url: str("Pull request URL.", { format: "uri" }) },
      }),
    },
  },
  Task: {
    type: "object", additionalProperties: false, required: ["id", "name", "repo", "kind", "state", "status", "links", "pipeline"],
    properties: {
      id: str("Stable task id."),
      name: str("Human name of the task."),
      repo: str("Repository the task works in."),
      kind: { type: "string", enum: ["ship", "scout", "other"], description: "ship changes a project, scout investigates." },
      state: { type: "string", enum: TASK_STATES, description: "Machine-readable state." },
      status: str("One plain-English sentence describing where the task is."),
      links: ref("TaskLinks"),
      pipeline: nullable(ref("Pipeline")),
    },
  },
  QuestionOption: {
    type: "object", additionalProperties: false, required: ["text", "recommended"],
    properties: { text: str("The option."), recommended: { type: "boolean", description: "True for the option Firstmate recommends." } },
  },
  Question: {
    type: "object", additionalProperties: false, required: ["number", "title", "options"],
    properties: {
      number: { type: "integer", minimum: 1, description: "1-based position inside its decision." },
      title: str("The question."),
      options: { ...arrayOf(ref("QuestionOption")), minItems: 1, maxItems: 4 },
    },
  },
  Decision: {
    type: "object", additionalProperties: false, required: ["id", "title", "summary", "questions", "text"],
    description: "A set of questions that wait on the captain.",
    properties: {
      id: str("The id of the task the decision gates. Use it in the answers endpoint."),
      title: str("Short title."),
      summary: str("One plain-English sentence."),
      questions: arrayOf(ref("Question")),
      text: nullable(str("Free text when the decision has no structured questions.")),
    },
  },
  ReadyToMerge: {
    type: "object", additionalProperties: false, required: ["taskId", "name", "summary", "pullRequest"],
    properties: {
      taskId: str("Task id."), name: str("Task name."), summary: str("One plain-English sentence."),
      pullRequest: {
        type: "object", additionalProperties: false, required: ["number", "url"],
        properties: { number: { type: "integer" }, url: str("Pull request URL.", { format: "uri" }) },
      },
    },
  },
  LandedItem: {
    type: "object", additionalProperties: false, required: ["id", "title", "kind", "url", "path"],
    properties: {
      id: str("Task id."), title: str("What landed."),
      kind: { type: "string", enum: ["pull_request", "report"] },
      url: nullable(str("Pull request URL.", { format: "uri" })),
      path: nullable(str("Report path on the Firstmate machine.")),
    },
  },
  QueuedItem: {
    type: "object", additionalProperties: false, required: ["id", "title", "reason"],
    properties: { id: str("Task id."), title: str("Queued work."), reason: str("Why it is waiting.") },
  },
  ActivityEvent: {
    type: "object", additionalProperties: false, required: ["at", "taskId", "taskName", "kind", "text"],
    properties: {
      at: str("When it happened.", { format: "date-time" }), taskId: str("Task id."), taskName: str("Task name."),
      kind: { type: "string", enum: ["finished", "decision_made", "decision_asked", "blocked"] },
      text: str("One sentence."),
    },
  },
  Counts: {
    type: "object", additionalProperties: false, required: ["waitingOnYou", "underway", "landed", "queued"],
    properties: {
      waitingOnYou: { type: "integer", minimum: 0 }, underway: { type: "integer", minimum: 0 },
      landed: { type: "integer", minimum: 0 }, queued: { type: "integer", minimum: 0 },
    },
  },
  Bearings: {
    type: "object", additionalProperties: false,
    required: ["generatedAt", "nextRefreshAt", "refreshing", "error", "counts", "waitingOnYou", "underway", "recentlyLanded", "queued", "activity", "contributions"],
    description: "The whole picture of the fleet at one moment.",
    properties: {
      generatedAt: nullable(str("When this snapshot was built.", { format: "date-time" })),
      nextRefreshAt: nullable(str("When the next rebuild is due.", { format: "date-time" })),
      refreshing: { type: "boolean", description: "True while a rebuild is running." },
      error: nullable(str("The last refresh error, if the latest rebuild failed. The data is then from the previous good snapshot.")),
      counts: ref("Counts"),
      waitingOnYou: {
        type: "object", additionalProperties: false, required: ["decisions", "readyToMerge"],
        properties: { decisions: arrayOf(ref("Decision")), readyToMerge: arrayOf(ref("ReadyToMerge")) },
      },
      underway: arrayOf(ref("Task")),
      recentlyLanded: arrayOf(ref("LandedItem")),
      queued: arrayOf(ref("QueuedItem")),
      activity: arrayOf(ref("ActivityEvent")),
      contributions: {
        type: "object", additionalProperties: false, required: ["known", "checked", "complete"],
        properties: { known: { type: "integer" }, checked: { type: "integer" }, complete: { type: "boolean" } },
      },
    },
  },
  AnswerRequest: {
    type: "object", additionalProperties: false, required: ["answers"],
    properties: {
      answers: {
        type: "array", minItems: 1, maxItems: 20,
        items: {
          type: "object", additionalProperties: false, required: ["question", "answer"],
          properties: {
            question: { type: "integer", minimum: 1, description: "The question number inside the decision." },
            answer: { type: "string", minLength: 1, maxLength: 2000, description: "One of the question's options, or your own words." },
          },
        },
      },
    },
  },
  NoteRequest: {
    type: "object", additionalProperties: false, required: ["text"],
    properties: { text: { type: "string", minLength: 1, maxLength: 4000, description: "Anything you want Firstmate to read." } },
  },
  NoteReceipt: {
    type: "object", additionalProperties: false, required: ["accepted", "receivedAt"],
    properties: { accepted: { type: "boolean", const: true }, receivedAt: str("When the note was recorded.", { format: "date-time" }) },
  },
  Health: {
    type: "object", additionalProperties: false, required: ["ok", "ready", "refreshing", "error", "generatedAt"],
    properties: {
      ok: { type: "boolean" }, ready: { type: "boolean", description: "False until the first snapshot has been built." },
      refreshing: { type: "boolean" }, error: nullable(str("Last refresh error.")),
      generatedAt: nullable(str("When the current snapshot was built.", { format: "date-time" })),
    },
  },
  Error: {
    type: "object", additionalProperties: false, required: ["error"],
    properties: {
      error: {
        type: "object", additionalProperties: false, required: ["code", "message"],
        properties: { code: str("Stable machine-readable code."), message: str("Plain-English explanation.") },
      },
    },
  },
};

const jsonBody = (name: string, description: string): Schema => ({
  description, content: { "application/json": { schema: ref(name) } },
});
const errorResponse = (description: string): Schema => jsonBody("Error", description);
const idParam: Schema = {
  name: "id", in: "path", required: true, schema: { type: "string" }, description: "Task id.",
};

export const openapi: Schema = {
  openapi: "3.1.0",
  info: {
    title: "Fleet Bearings API",
    version: "1.0.0",
    summary: "What the fleet is doing, what needs you, and a way to answer.",
    description:
      "A read API over the Fleet Bearings view: the questions waiting on the captain, the work under way with its validation steps, what landed, what is queued, and recent activity. " +
      "Data is rebuilt every 5 minutes. A few write endpoints send answers and notes to Firstmate as inbox notes; the API never answers a decision, merges, or changes a task by itself.",
  },
  servers: [{ url: "http://localhost:4748", description: "Local, on the Firstmate machine" }],
  tags: [
    { name: "Bearings", description: "The whole picture." },
    { name: "Tasks", description: "Work under way." },
    { name: "Questions", description: "Decisions waiting on the captain, and answering them." },
    { name: "Activity", description: "Recent events." },
    { name: "Notes", description: "Messages to Firstmate." },
    { name: "Service", description: "Health and refresh." },
  ],
  security: [{}, { bearerAuth: [] }],
  paths: {
    "/api/v1/bearings": {
      get: {
        tags: ["Bearings"], operationId: "getBearings", summary: "Get the whole picture",
        responses: {
          "200": jsonBody("Bearings", "The latest snapshot."),
          "503": errorResponse("The first snapshot is still being built. Retry shortly."),
        },
      },
    },
    "/api/v1/tasks": {
      get: {
        tags: ["Tasks"], operationId: "listTasks", summary: "List work under way",
        parameters: [{ name: "state", in: "query", required: false, schema: { type: "string", enum: TASK_STATES }, description: "Only tasks in this state." }],
        responses: {
          "200": { description: "Tasks under way.", content: { "application/json": { schema: arrayOf(ref("Task")) } } },
          "503": errorResponse("The first snapshot is still being built."),
        },
      },
    },
    "/api/v1/tasks/{id}": {
      get: {
        tags: ["Tasks"], operationId: "getTask", summary: "Get one task",
        parameters: [idParam],
        responses: { "200": jsonBody("Task", "The task."), "404": errorResponse("No such task under way."), "503": errorResponse("The first snapshot is still being built.") },
      },
    },
    "/api/v1/questions": {
      get: {
        tags: ["Questions"], operationId: "listQuestions", summary: "List what is waiting on you",
        description: "Decisions with their questions and options, plus pull requests ready to merge.",
        responses: {
          "200": {
            description: "Everything waiting on the captain.",
            content: { "application/json": { schema: {
              type: "object", additionalProperties: false, required: ["decisions", "readyToMerge"],
              properties: { decisions: arrayOf(ref("Decision")), readyToMerge: arrayOf(ref("ReadyToMerge")) },
            } } },
          },
          "503": errorResponse("The first snapshot is still being built."),
        },
      },
    },
    "/api/v1/questions/{id}": {
      get: {
        tags: ["Questions"], operationId: "getDecision", summary: "Get one decision",
        parameters: [{ ...idParam, description: "Decision id (the task it gates)." }],
        responses: { "200": jsonBody("Decision", "The decision."), "404": errorResponse("No such open decision."), "503": errorResponse("The first snapshot is still being built.") },
      },
    },
    "/api/v1/questions/{id}/answers": {
      post: {
        tags: ["Questions"], operationId: "answerDecision", summary: "Answer questions in a decision",
        description: "Sends your answers to Firstmate as an inbox note. Firstmate reads it and records the decision; the question stays listed until it does.",
        parameters: [{ ...idParam, description: "Decision id (the task it gates)." }],
        requestBody: { required: true, content: { "application/json": { schema: ref("AnswerRequest") } } },
        responses: {
          "202": jsonBody("NoteReceipt", "Accepted and recorded as a note."),
          "400": errorResponse("The request body is not valid JSON or is the wrong shape."),
          "404": errorResponse("No such open decision."),
          "415": errorResponse("Content-Type must be application/json."),
          "422": errorResponse("A question number does not exist in the decision."),
          "502": errorResponse("The note could not be recorded."),
        },
      },
    },
    "/api/v1/activity": {
      get: {
        tags: ["Activity"], operationId: "listActivity", summary: "Recent activity",
        description: "Finished work, decisions asked and made, and blockers, newest first.",
        parameters: [{ name: "limit", in: "query", required: false, schema: { type: "integer", minimum: 1, maximum: 16, default: 16 }, description: "How many events." }],
        responses: {
          "200": { description: "Events, newest first.", content: { "application/json": { schema: arrayOf(ref("ActivityEvent")) } } },
          "503": errorResponse("The first snapshot is still being built."),
        },
      },
    },
    "/api/v1/notes": {
      post: {
        tags: ["Notes"], operationId: "sendNote", summary: "Send a note to Firstmate",
        requestBody: { required: true, content: { "application/json": { schema: ref("NoteRequest") } } },
        responses: {
          "202": jsonBody("NoteReceipt", "Accepted and recorded."),
          "400": errorResponse("The request body is not valid JSON or is the wrong shape."),
          "415": errorResponse("Content-Type must be application/json."),
          "502": errorResponse("The note could not be recorded."),
        },
      },
    },
    "/api/v1/refresh": {
      post: {
        tags: ["Service"], operationId: "refresh", summary: "Rebuild the snapshot now",
        description: "Starts a rebuild and returns at once. Poll /api/v1/bearings and watch generatedAt.",
        responses: { "202": { description: "A rebuild has started or is already running." } },
      },
    },
    "/health": {
      get: {
        tags: ["Service"], operationId: "getHealth", summary: "Health", security: [],
        responses: { "200": jsonBody("Health", "The service is up. ready is false until the first snapshot exists.") },
      },
    },
  },
  components: {
    schemas,
    securitySchemes: {
      bearerAuth: {
        type: "http", scheme: "bearer",
        description: "Optional. When the server is started with BEARINGS_API_KEY set, send it as a bearer token. By default the API is open to local callers.",
      },
    },
  },
};
