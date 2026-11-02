/**
 * Contract check: validates the OpenAPI document and runs the parsers against fixed samples,
 * then calls the running API and validates every response against the schemas in that document.
 * Usage: node scripts/check.ts [baseUrl] [--offline]   (default http://127.0.0.1:4748)
 * --offline stops after the spec and parser checks, so it needs no server or Firstmate home.
 * Set BEARINGS_API_KEY to the server's key when it has one; the 401 case is then checked too.
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

const args = process.argv.slice(2);
const base = args.find((a) => !a.startsWith("--")) ?? "http://127.0.0.1:4748";
const key = process.env["BEARINGS_API_KEY"] ?? "";
const offline = args.includes("--offline");
let failures = 0;
const bad = (msg: string): void => {
  failures++;
  console.log(`  FAIL ${msg}`);
};
const ok = (msg: string): void => console.log(`  ok   ${msg}`);
const same = (label: string, got: unknown, want: unknown): void =>
  JSON.stringify(got) === JSON.stringify(want)
    ? ok(label)
    : bad(`${label}: got ${JSON.stringify(got)}, want ${JSON.stringify(want)}`);

await SwaggerParser.validate(structuredClone(openapi) as never);
ok("OpenAPI 3.1 document is valid");

const ajv = new Ajv2020({ allErrors: true, strict: false });
const addFormats = addFormatsImport as unknown as (a: Ajv2020) => void;
addFormats(ajv);
ajv.addSchema({ $id: "spec", components: openapi["components"] as { schemas: unknown } }, "spec");

async function call(
  method: string,
  path: string,
  init: { body?: string; noKey?: boolean; origin?: string; type?: string } = {},
): Promise<{ json: unknown; status: number }> {
  const headers: Record<string, string> = {};
  if (key && !init.noKey) headers["Authorization"] = `Bearer ${key}`;
  if (init.type) headers["Content-Type"] = init.type;
  if (init.origin) headers["Origin"] = init.origin;
  const r = await fetch(base + path, { body: init.body, headers, method });
  const text = await r.text();
  let json: unknown = null;
  try {
    json = JSON.parse(text);
  } catch {
    /* not json */
  }
  return { json, status: r.status };
}

function expect(
  label: string,
  got: { json: unknown; status: number },
  status: number,
  schema?: (v: unknown) => string | null,
): void {
  if (got.status !== status) return bad(`${label}: expected ${status}, got ${got.status}`);
  const problem = schema ? schema(got.json) : null;
  if (problem) return bad(`${label}: ${problem}`);
  ok(`${label} -> ${status}`);
}

function validator(name: string, array = false): (v: unknown) => string | null {
  const fn = ajv.getSchema(`spec#/components/schemas/${name}`);
  if (!fn) throw new Error(`no schema ${name}`);
  return (v) => {
    const list = array ? (Array.isArray(v) ? v : [null]) : [v];
    for (const item of list) {
      if (!fn(item)) return ajv.errorsText(fn.errors, { separator: "; " });
    }
    return null;
  };
}

// parsers, against fixed samples
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
  bad("parseQuestions sample");
else if (decisionProblem) bad(`sample Decision: ${decisionProblem}`);
else ok("parseQuestions output matches the Decision schema");

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
  bad(`parsePipeline sample: ${pipeProblem ?? "wrong finding count"}`);
else ok("parsePipeline output matches the Pipeline schema");
const described = describeTask("state: parked · source: run-step", pipeline, false);
if (
  described.sentence !== "Paused at the tests with 2 findings waiting for a decision." ||
  described.state !== "waiting"
)
  bad(`describeTask sample: ${described.sentence}`);
else ok("describeTask writes a plain sentence for a held run");

same("splitRow keeps quoted commas and escapes", splitRow('a,"b, c","say \\"hi\\"",'), [
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
same("parsePipeline reads columns by header and keeps unknown statuses", shuffled?.steps, [
  { findings: 0, name: "intent", status: "completed" },
  { findings: 0, name: "review", status: "unknown" },
  { findings: 1, name: "test", status: "running" },
]);
const shuffledProblem = shuffled ? validator("Pipeline")(shuffled) : "no pipeline parsed";
if (shuffledProblem) bad(`parsePipeline unknown status: ${shuffledProblem}`);
same(
  "slugFromRemote keeps dots in repo names",
  [
    slugFromRemote("git@github.com:vercel/next.js.git\n"),
    slugFromRemote("https://github.com/org/my.repo"),
    slugFromRemote("https://gitlab.com/org/repo.git"),
  ],
  ["vercel/next.js", "org/my.repo", ""],
);
same(
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

// wait for the first snapshot
let ready = false;
for (let i = 0; i < 40 && !ready; i++) {
  const h = await call("GET", "/health");
  ready = (h.json as { ready?: boolean } | null)?.ready === true;
  if (!ready) await new Promise((r) => setTimeout(r, 3000));
}
if (!ready) {
  bad("API never became ready");
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

// request validation, without creating any note
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
  ok("GET /openapi.json serves the spec");
else bad("GET /openapi.json");

console.log(failures === 0 ? "\nAll checks passed." : `\n${failures} check(s) failed.`);
process.exit(failures === 0 ? 0 : 1);
