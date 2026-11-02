/**
 * Contract check: validates the OpenAPI document and runs the parsers against fixed samples,
 * then calls the running API and validates every response against the schemas in that document.
 *
 * @remarks
 * Usage: `node scripts/check.ts [baseUrl] [--offline]`. The base URL defaults to
 * `http://127.0.0.1:4748`.
 *
 * `--offline` stops after the spec and parser checks, so it needs no server or Firstmate home.
 * Set `BEARINGS_API_KEY` to the server's key when it has one; the 401 case is then checked too.
 * The process exits with 1 when any check fails.
 *
 * @packageDocumentation
 */
import SwaggerParser from "@apidevtools/swagger-parser";
import addFormatsImport from "ajv-formats";
import { Ajv2020 } from "ajv/dist/2020.js";

import { openapi } from "../src/openapi.ts";
import {
  describeTask,
  parsePipeline,
  parseQuestions,
  slugFromRemote,
  splitRow,
  ticketKey,
} from "../src/status.ts";

/** Options for {@link call}. */
interface CallOptions {
  /** The request body. */
  body?: string;
  /** Leave out the API key, to check the 401 case. */
  noKey?: boolean;
  /** An Origin header, to check the cross-site write case. */
  origin?: string;
  /** A Content-Type header. */
  type?: string;
}

/** The HTTP status and parsed JSON body of a response (`null` when the body is not JSON). */
interface CallResult {
  json: unknown;
  status: number;
}

/** Checks a value against a schema, returning what is wrong with it or `null` when it is valid. */
type Validator = (value: unknown) => string | null;

const args = process.argv.slice(2);
const base = args.find((arg) => !arg.startsWith("--")) ?? "http://127.0.0.1:4748";
const key = process.env["BEARINGS_API_KEY"] ?? "";
const offline = args.includes("--offline");

/** How many checks have failed so far. */
let failures = 0;

/** Report a failed check. */
const fail = (message: string): void => {
  failures++;
  console.log(`  FAIL ${message}`);
};

/** Report a passed check. */
const pass = (message: string): void => console.log(`  ok   ${message}`);

/** Check that two values are equal once serialised as JSON. */
const expectEqual = (label: string, got: unknown, want: unknown): void =>
  JSON.stringify(got) === JSON.stringify(want)
    ? pass(label)
    : fail(`${label}: got ${JSON.stringify(got)}, want ${JSON.stringify(want)}`);

await SwaggerParser.validate(structuredClone(openapi) as never);
pass("OpenAPI 3.1 document is valid");

const ajv = new Ajv2020({ allErrors: true, strict: false });
const addFormats = addFormatsImport as unknown as (a: Ajv2020) => void;
addFormats(ajv);
ajv.addSchema({ $id: "spec", components: openapi["components"] as { schemas: unknown } }, "spec");

/** Call the running API, sending the API key unless told not to. */
async function call(method: string, path: string, options: CallOptions = {}): Promise<CallResult> {
  const headers: Record<string, string> = {};
  if (key && !options.noKey) headers["Authorization"] = `Bearer ${key}`;
  if (options.type) headers["Content-Type"] = options.type;
  if (options.origin) headers["Origin"] = options.origin;
  const response = await fetch(base + path, { body: options.body, headers, method });
  const text = await response.text();
  let json: unknown = null;
  try {
    json = JSON.parse(text);
  } catch {
    // Not JSON; leave it null.
  }
  return { json, status: response.status };
}

/**
 * Check a response's status and, when a validator is given, its body.
 *
 * @param label - What is being checked, for the report.
 * @param got - The response.
 * @param status - The expected HTTP status.
 * @param validate - Checks the body against a schema (see {@link validator}).
 */
function expect(label: string, got: CallResult, status: number, validate?: Validator): void {
  if (got.status !== status) return fail(`${label}: expected ${status}, got ${got.status}`);
  const problem = validate ? validate(got.json) : null;
  if (problem) return fail(`${label}: ${problem}`);
  pass(`${label} -> ${status}`);
}

/**
 * A {@link Validator} for one of the spec's component schemas.
 *
 * @param name - The schema name, for example `Task`.
 * @param array - Expect an array of the schema instead. A non-array then fails.
 * @throws When the spec has no schema by that name.
 */
function validator(name: string, array = false): Validator {
  const validate = ajv.getSchema(`spec#/components/schemas/${name}`);
  if (!validate) throw new Error(`no schema ${name}`);
  return (value) => {
    // [null] makes a non-array fail with a readable error.
    const items = array ? (Array.isArray(value) ? value : [null]) : [value];
    for (const item of items) {
      if (!validate(item)) return ajv.errorsText(validate.errors, { separator: "; " });
    }
    return null;
  };
}

// ---------- parsers, against fixed samples ----------
const reason =
  "Intro text. ## Engine :: Stub (Recommended) | Real OpenAI | Later ## Flag :: Set it (Recommended) | Preview | Off ## Many :: A | B | C | D | E";
const questions = parseQuestions(reason).map((q, i) => ({ number: i + 1, ...q }));
const sampleDecision = {
  id: "sample",
  questions,
  summary: "3 questions to answer. The recommended option is marked.",
  text: null,
  title: "Sample",
};
const decisionProblem = validator("Decision")(sampleDecision);
if (
  questions.length !== 3 ||
  questions[0]?.options.filter((o) => o.recommended).length !== 1 ||
  questions[2]?.options.length !== 4
)
  fail("parseQuestions sample");
else if (decisionProblem) fail(`sample Decision: ${decisionProblem}`);
else pass("parseQuestions output matches the Decision schema");

const sampleRun = [
  "run:",
  '  id: "01SAMPLE"',
  "  status: running",
  "  steps[3]{step,status,findings,duration_ms}:",
  "    intent,completed,0,4",
  "    test,awaiting_approval,2,210623",
  "    ci,pending,0,0",
  "gate:",
  "  step: test",
  "  status: awaiting_approval",
  "  findings[2]{id,severity,file,action,description}:",
  '    test-1,error,"","",configured test command failed with exit code 1',
  '    test-2,warning,"",ask-user,"live validation inconclusive, 0 of 2 driven"',
].join("\n");
const pipeline = parsePipeline(sampleRun);
const pipeProblem = pipeline ? validator("Pipeline")(pipeline) : "no pipeline parsed";
if (pipeProblem || pipeline?.findings.length !== 2)
  fail(`parsePipeline sample: ${pipeProblem ?? "wrong finding count"}`);
else pass("parsePipeline output matches the Pipeline schema");
const described = describeTask("state: parked · source: run-step", pipeline, false);
if (
  described.sentence !== "Paused at the tests with 2 findings waiting for a decision." ||
  described.state !== "waiting"
)
  fail(`describeTask sample: ${described.sentence}`);
else pass("describeTask writes a plain sentence for a held run");

expectEqual("splitRow keeps quoted commas and escapes", splitRow('a,"b, c","say \\"hi\\"",'), [
  "a",
  "b, c",
  'say "hi"',
  "",
]);
const shuffled = parsePipeline(
  [
    "run:",
    "  id: R2",
    "  status: running",
    "  steps[3]{status,step,findings,duration_ms,attempt}:",
    "    completed,intent,0,4,1",
    "    cancelled,review,0,,1",
    "    running,test,1,,2",
  ].join("\n"),
);
expectEqual("parsePipeline reads columns by header and keeps unknown statuses", shuffled?.steps, [
  { findings: 0, name: "intent", status: "completed" },
  { findings: 0, name: "review", status: "unknown" },
  { findings: 1, name: "test", status: "running" },
]);
const shuffledProblem = shuffled ? validator("Pipeline")(shuffled) : "no pipeline parsed";
if (shuffledProblem) fail(`parsePipeline unknown status: ${shuffledProblem}`);
expectEqual(
  "slugFromRemote keeps dots in repo names",
  [
    slugFromRemote("git@github.com:vercel/next.js.git\n"),
    slugFromRemote("https://github.com/org/my.repo"),
    slugFromRemote("https://gitlab.com/org/repo.git"),
  ],
  ["vercel/next.js", "org/my.repo", ""],
);
expectEqual(
  "ticketKey only matches configured teams",
  [
    ticketKey("Fix UTF-8 handling for LIV-42", ["LIV"]),
    ticketKey("Move to HTTP-2", ["LIV"]),
    ticketKey("LIV-42", []),
  ],
  ["LIV-42", "", ""],
);

if (offline) {
  console.log(failures === 0 ? "\nAll offline checks passed." : `\n${failures} check(s) failed.`);
  process.exit(failures === 0 ? 0 : 1);
}

// ---------- live API: wait for the first snapshot ----------
let ready = false;
for (let i = 0; i < 40 && !ready; i++) {
  const h = await call("GET", "/health");
  ready = (h.json as { ready?: boolean } | null)?.ready === true;
  if (!ready) await new Promise((r) => setTimeout(r, 3000));
}
if (!ready) {
  fail("API never became ready");
  process.exit(1);
}

const bearings = await call("GET", "/api/v1/bearings");
expect("GET /api/v1/bearings", bearings, 200, validator("Bearings"));
expect("GET /health", await call("GET", "/health"), 200, validator("Health"));
expect("GET /api/v1/tasks", await call("GET", "/api/v1/tasks"), 200, validator("Task", true));
expect(
  "GET /api/v1/tasks?state=working",
  await call("GET", "/api/v1/tasks?state=working"),
  200,
  validator("Task", true),
);
expect(
  "GET /api/v1/questions",
  await call("GET", "/api/v1/questions"),
  200,
  validator("WaitingOnYou"),
);
expect(
  "GET /api/v1/tasks?state=bogus",
  await call("GET", "/api/v1/tasks?state=bogus"),
  400,
  validator("Error"),
);
if (key)
  expect(
    "GET /api/v1/bearings without the key",
    await call("GET", "/api/v1/bearings", { noKey: true }),
    401,
    validator("Error"),
  );
else console.log("  skip BEARINGS_API_KEY not set, so the 401 case was not exercised");
expect(
  "GET /api/v1/activity?limit=3",
  await call("GET", "/api/v1/activity?limit=3"),
  200,
  validator("ActivityEvent", true),
);
expect(
  "GET /api/v1/activity?limit=0",
  await call("GET", "/api/v1/activity?limit=0"),
  400,
  validator("Error"),
);
expect("GET unknown task", await call("GET", "/api/v1/tasks/nope"), 404, validator("Error"));
expect(
  "GET unknown decision",
  await call("GET", "/api/v1/questions/nope"),
  404,
  validator("Error"),
);
expect("GET unknown path", await call("GET", "/api/v1/nothing"), 404, validator("Error"));

const first = (bearings.json as { underway: { id: string }[] }).underway[0];
if (first)
  expect(
    `GET /api/v1/tasks/${first.id}`,
    await call("GET", `/api/v1/tasks/${first.id}`),
    200,
    validator("Task"),
  );

// ---------- request validation, without creating any note ----------
expect(
  "POST answers wrong content type",
  await call("POST", "/api/v1/questions/x/answers", { body: "hi", type: "text/plain" }),
  415,
  validator("Error"),
);
expect(
  "POST answers invalid JSON",
  await call("POST", "/api/v1/questions/x/answers", { body: "{", type: "application/json" }),
  400,
  validator("Error"),
);
expect(
  "POST answers wrong shape",
  await call("POST", "/api/v1/questions/x/answers", { body: '{"a":1}', type: "application/json" }),
  400,
  validator("Error"),
);
expect(
  "POST answers unknown decision",
  await call("POST", "/api/v1/questions/nope/answers", {
    body: JSON.stringify({ answers: [{ answer: "x", question: 1 }] }),
    type: "application/json",
  }),
  404,
  validator("Error"),
);
expect(
  "POST note wrong shape",
  await call("POST", "/api/v1/notes", { body: '{"text":""}', type: "application/json" }),
  400,
  validator("Error"),
);
expect(
  "POST note from another site",
  await call("POST", "/api/v1/notes", {
    body: '{"text":"x"}',
    origin: "https://evil.example",
    type: "application/json",
  }),
  403,
  validator("Error"),
);
expect(
  "POST refresh from another site",
  await call("POST", "/api/v1/refresh", { origin: "https://evil.example" }),
  403,
  validator("Error"),
);
expect(
  "POST /api/v1/refresh",
  await call("POST", "/api/v1/refresh", { origin: base }),
  202,
  validator("RefreshReceipt"),
);
// Question 999 never exists (a free-text decision only takes question 1), so no note is sent.
const decision = (bearings.json as { waitingOnYou: { decisions: { id: string }[] } }).waitingOnYou
  .decisions[0];
if (decision)
  expect(
    "POST answers unknown question number",
    await call("POST", `/api/v1/questions/${decision.id}/answers`, {
      body: JSON.stringify({ answers: [{ answer: "x", question: 999 }] }),
      type: "application/json",
    }),
    422,
    validator("Error"),
  );
else console.log("  skip no open decision, so the 422 case was not exercised");

const spec = await call("GET", "/openapi.json");
if (spec.status === 200 && (spec.json as { openapi?: string } | null)?.openapi === "3.1.0")
  pass("GET /openapi.json serves the spec");
else fail("GET /openapi.json");

console.log(failures === 0 ? "\nAll checks passed." : `\n${failures} check(s) failed.`);
process.exit(failures === 0 ? 0 : 1);
