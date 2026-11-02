/**
 * Contract check: validates the OpenAPI document and runs the parsers against fixed samples,
 * then calls the running API and validates every response against the schemas in that document.
 *
 * @remarks
 * Usage: `node scripts/check.ts [baseUrl] [--offline | --fixture]`. The base URL defaults to
 * `http://127.0.0.1:4748`.
 *
 * `--offline` stops after the spec and parser checks, so it needs no server or Firstmate home.
 *
 * `--fixture` copies the fixed Firstmate home in `fixtures/home` (stub scripts, plus `gh` and
 * `no-mistakes` stubs named by `BEARINGS_GH_BIN` and `BEARINGS_NO_MISTAKES_BIN`) to a temporary
 * directory, writes a status file with timestamps relative to now, and starts its own server on
 * it on a free port, with an API key and Linear settings. It then runs every check, plus checks
 * of the exact values that home should produce, and sends a note and an answer to the stub
 * inbox. This is what CI runs.
 *
 * Otherwise, set `BEARINGS_API_KEY` to the server's key when it has one; the 401 case is then
 * checked too. The process exits with 1 when any check fails.
 *
 * @packageDocumentation
 */
import { spawn } from "node:child_process";
import { readFileSync, rmSync } from "node:fs";
import { cp, mkdtemp, writeFile } from "node:fs/promises";
import { createServer } from "node:net";
import { tmpdir } from "node:os";
import path from "node:path";
import { fileURLToPath } from "node:url";

import SwaggerParser from "@apidevtools/swagger-parser";
import addFormatsImport from "ajv-formats";
import { Ajv2020 } from "ajv/dist/2020.js";

import { parseSettings } from "../src/env.ts";
import { openapi } from "../src/openapi.ts";
import { ActivityLimitSchema, AnswerRequestSchema, NoteRequestSchema } from "../src/schemas.ts";
import {
  describeTask,
  parseHoldReason,
  parsePipeline,
  parseQuestions,
  parseSnapshot,
  slugFromRemote,
  splitRow,
  ticketKey,
} from "../src/status.ts";
import type { Bearings } from "../src/types.ts";

/** Options for {@link call}. */
interface CallOptions {
  /** An Authorization header to send instead of the usual `Bearer <key>`. */
  authorization?: string;
  /** The request body. */
  body?: string;
  /** An Idempotency-Key header. */
  idempotencyKey?: string;
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

/** The API key the fixture server is started with, so the fixture run checks the 401 case. */
const FIXTURE_KEY = "fixture-key";

const args = process.argv.slice(2);
const fixture = args.includes("--fixture");
const key = fixture ? FIXTURE_KEY : (process.env["BEARINGS_API_KEY"] ?? "");
const offline = args.includes("--offline");
/** The fixture home in use under `--fixture` (a temporary copy), or `""` otherwise. */
let fixtureHome = "";
/** The API under test. Replaced by the fixture server's address under `--fixture`. */
let base = args.find((arg) => !arg.startsWith("--")) ?? "http://127.0.0.1:4748";

/**
 * How long to wait for the first snapshot. The snapshot script alone may take 150 s, and the
 * per-task lookups come after it, so this allows a slow home plenty of room.
 */
const READY_TIMEOUT_MS = 300_000;

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

  if (options.authorization) {
    headers["Authorization"] = options.authorization;
  } else if (key && !options.noKey) {
    headers["Authorization"] = `Bearer ${key}`;
  }
  if (options.idempotencyKey) {
    headers["Idempotency-Key"] = options.idempotencyKey;
  }
  if (options.type) {
    headers["Content-Type"] = options.type;
  }
  if (options.origin) {
    headers["Origin"] = options.origin;
  }

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

/** A TCP port that is free right now, found by letting the system pick one. */
function freePort(): Promise<number> {
  return new Promise((resolve, reject) => {
    const probe = createServer();

    probe.on("error", reject);
    probe.listen(0, "127.0.0.1", () => {
      const address = probe.address();
      const port = typeof address === "object" && address ? address.port : 0;

      probe.close(() => resolve(port));
    });
  });
}

/**
 * Copy `fixtures/home` to a temporary directory and write its status file.
 *
 * @remarks
 * The activity feed only reports events from the last 24 hours, so the status file is written
 * with timestamps relative to now rather than committed. It also has an event that is too old
 * and one with a timestamp in milliseconds, which must both be left out. The copy is deleted
 * when this script exits.
 *
 * @returns The temporary home's path.
 */
async function makeFixtureHome(): Promise<string> {
  const repo = fileURLToPath(new URL("..", import.meta.url));
  const home = await mkdtemp(path.join(tmpdir(), "bearings-fixture-"));
  const nowSeconds = Math.floor(Date.now() / 1000);
  const statusLines = [
    `done [at=${nowSeconds - 3600}]: Shipped the first half of the fix.`,
    `blocked [at=${nowSeconds - 60}]: Waiting on a test database.`,
    `done [at=${nowSeconds - 2 * 86_400}]: An event from two days ago, past the window.`,
    `done [at=${nowSeconds * 1000}]: A timestamp in milliseconds, which is not seconds.`,
  ];

  process.on("exit", () => rmSync(home, { force: true, recursive: true }));
  await cp(path.join(repo, "fixtures", "home"), home, { recursive: true });
  await writeFile(path.join(home, "state", "ship-1.status"), `${statusLines.join("\n")}\n`);

  return home;
}

/**
 * Start the API against a copy of `fixtures/home` on a free port. It is stopped when this
 * script exits, and this script fails at once if the server exits first.
 *
 * @param home - The fixture home (see {@link makeFixtureHome}).
 * @returns The server's base URL.
 */
async function startFixtureServer(home: string): Promise<string> {
  const port = await freePort();
  const repo = fileURLToPath(new URL("..", import.meta.url));
  const server = spawn(process.execPath, [path.join(repo, "src", "server.ts")], {
    env: {
      ...process.env,
      BEARINGS_API_KEY: FIXTURE_KEY,
      BEARINGS_API_PORT: String(port),
      BEARINGS_GH_BIN: path.join(home, "bin", "gh"),
      BEARINGS_LINEAR_BASE: "https://linear.example/issue/",
      BEARINGS_LINEAR_TEAMS: "LIV",
      BEARINGS_NO_MISTAKES_BIN: path.join(home, "bin", "no-mistakes"),
      FM_HOME: home,
    },
    stdio: ["ignore", "ignore", "inherit"],
  });

  server.on("exit", (code, signal) => {
    fail(`the fixture server exited early (${signal ?? `code ${code}`})`);
    process.exit(1);
  });
  process.on("exit", () => {
    server.removeAllListeners("exit");
    server.kill();
  });

  return `http://127.0.0.1:${port}`;
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
  if (got.status !== status) {
    return fail(`${label}: expected ${status}, got ${got.status}`);
  }

  const problem = validate ? validate(got.json) : null;

  if (problem) {
    return fail(`${label}: ${problem}`);
  }

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

  if (!validate) {
    throw new Error(`no schema ${name}`);
  }

  return (value) => {
    // [null] makes a non-array fail with a readable error.
    const items = array ? (Array.isArray(value) ? value : [null]) : [value];

    for (const item of items) {
      if (!validate(item)) {
        return ajv.errorsText(validate.errors, { separator: "; " });
      }
    }

    return null;
  };
}

/**
 * Check that the snapshot built from `fixtures/home` has the values that home should produce.
 *
 * @remarks
 * The schema checks only show the shapes are right. This shows the gathering is: the pipeline
 * is read, the Linear key is found, hold reasons become questions, and so on.
 */
function checkFixtureValues(bearings: Bearings): void {
  const ship = bearings.underway.find((task) => task.id === "ship-1");

  expectEqual(
    "fixture: tasks under way",
    bearings.underway.map((task) => [task.id, task.kind, task.state]),
    [
      ["ship-1", "ship", "working"],
      ["scout-1", "scout", "waiting"],
    ],
  );
  expectEqual(
    "fixture: pipeline and Linear link",
    [ship?.status, ship?.pipeline?.runId, ship?.links.linear],
    [
      "Running the tests, 1 of 3 steps done.",
      "01FIXTURE",
      { key: "LIV-42", url: "https://linear.example/issue/LIV-42" },
    ],
  );
  expectEqual(
    "fixture: decisions",
    bearings.waitingOnYou.decisions.map((decision) => [
      decision.id,
      decision.title,
      decision.questions.map((question) => question.title),
      decision.text,
    ]),
    [
      ["scout-1", "Engine choice", ["Engine", "Flag"], null],
      ["free-1", "Old flag", [], 'Should the "old" flag stay for one more release?'],
    ],
  );
  expectEqual(
    "fixture: activity keeps the last day and skips bad timestamps",
    bearings.activity.map((event) => [event.kind, event.taskName, event.text]),
    [
      ["blocked", "Fix LIV-42 login bug", "Waiting on a test database."],
      ["finished", "Fix LIV-42 login bug", "Shipped the first half of the fix."],
    ],
  );
  expectEqual(
    "fixture: ready to merge, landed and queued",
    [
      bearings.waitingOnYou.readyToMerge.map((pr) => [pr.taskId, pr.pullRequest.number]),
      bearings.recentlyLanded.map((item) => item.kind),
      bearings.queued.map((item) => item.id),
      bearings.counts,
    ],
    [
      // done-2's pull request is merged on GitHub, so it is not waiting.
      [["done-1", 7]],
      ["pull_request", "report"],
      ["queued-1"],
      { landed: 2, queued: 1, underway: 2, waitingOnYou: 3 },
    ],
  );
}

/**
 * Send a note and an answer to the fixture's stub inbox, and check what it received.
 *
 * @remarks
 * Only run against the fixture, since against a real home these would reach Firstmate.
 */
async function checkFixtureWrites(): Promise<void> {
  const json = "application/json";

  expect(
    "fixture: POST note with an Idempotency-Key",
    await call("POST", "/api/v1/notes", {
      body: '{"text":"Hello from the check."}',
      idempotencyKey: "check-note-1",
      type: json,
    }),
    202,
    validator("NoteReceipt"),
  );
  expect(
    "fixture: POST answers",
    await call("POST", "/api/v1/questions/scout-1/answers", {
      body: JSON.stringify({ answers: [{ answer: "Stub", question: 1 }] }),
      type: json,
    }),
    202,
    validator("NoteReceipt"),
  );
  expect(
    "fixture: POST note with a malformed Idempotency-Key",
    await call("POST", "/api/v1/notes", {
      body: '{"text":"x"}',
      idempotencyKey: "has spaces",
      type: json,
    }),
    400,
    validator("Error"),
  );

  const inbox = readFileSync(path.join(fixtureHome, "inbox.log"), "utf8");
  const requestIds = [...inbox.matchAll(/^request-id: (.*)$/gm)].map((match) => match[1]);

  expectEqual(
    "fixture: the inbox got the key as the request id, then a fresh UUID",
    [
      requestIds[0],
      /^[0-9a-f-]{36}$/.test(requestIds[1] ?? ""),
      inbox.includes("Hello from the check."),
      inbox.includes("1. Engine → Stub"),
    ],
    ["check-note-1", true, true, true],
  );
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
) {
  fail("parseQuestions sample");
} else if (decisionProblem) {
  fail(`sample Decision: ${decisionProblem}`);
} else {
  pass("parseQuestions output matches the Decision schema");
}

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

if (pipeProblem || pipeline?.findings.length !== 2) {
  fail(`parsePipeline sample: ${pipeProblem ?? "wrong finding count"}`);
} else {
  pass("parsePipeline output matches the Pipeline schema");
}

const described = describeTask("state: parked · source: run-step", pipeline, false);

if (
  described.sentence !== "Paused at the tests with 2 findings waiting for a decision." ||
  described.state !== "waiting"
) {
  fail(`describeTask sample: ${described.sentence}`);
} else {
  pass("describeTask writes a plain sentence for a held run");
}

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

if (shuffledProblem) {
  fail(`parsePipeline unknown status: ${shuffledProblem}`);
}

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

expectEqual(
  "describeTask treats queued work as waiting",
  describeTask("state: queued · source: gate", null, false).state,
  "waiting",
);

const doneRun = parsePipeline(
  [
    "run:",
    "  id: R3",
    "  status: completed",
    "  steps[2]{step,status}:",
    "    intent,completed",
    "    ci,skipped",
  ].join("\n"),
);

expectEqual("describeTask calls a fully done run finished", describeTask("", doneRun, false), {
  sentence: "All validation steps are done.",
  state: "finished",
});

/** The error `parseSnapshot` throws for some text, or `""` when it accepts it. */
const snapshotError = (text: string): string => {
  try {
    parseSnapshot(text);

    return "";
  } catch (error) {
    return error instanceof Error ? error.message : String(error);
  }
};
const goodSnapshot = {
  contributions: { checked: 1, complete: true, known: 1 },
  decisions_open: [{ id: "d", summary: "Pick: one" }],
  gates: [{ id: "g" }],
  in_flight: [{ doing: "x", id: "t", kind: "ship", name: "T", repo: "r", state: "working" }],
  landed: [],
  recorded_prs: [],
};

expectEqual(
  "parseSnapshot accepts a good snapshot and names what is wrong with bad ones",
  [
    snapshotError(JSON.stringify(goodSnapshot)),
    snapshotError("not json"),
    snapshotError(JSON.stringify({ ...goodSnapshot, landed: undefined })),
    snapshotError(JSON.stringify({ ...goodSnapshot, in_flight: [{ id: "t" }] })),
    snapshotError(JSON.stringify({ ...goodSnapshot, gates: [{ reason: 3 }] })),
    snapshotError(JSON.stringify({ ...goodSnapshot, contributions: {} })),
  ],
  [
    "",
    "The snapshot script printed something that is not JSON.",
    'The snapshot has no "landed" list.',
    'The snapshot\'s in_flight[0] has no "doing" text.',
    'The snapshot\'s gates[0] has a "reason" that is not text.',
    'The snapshot\'s "contributions" needs checked, complete and known.',
  ],
);

/** The error `parseSettings` throws for some variables, or `""` when it accepts them. */
const settingsError = (env: Record<string, string>): string => {
  try {
    parseSettings(env);

    return "";
  } catch (error) {
    return error instanceof Error ? error.message : String(error);
  }
};
const defaults = parseSettings({ BEARINGS_API_PORT: " ", FM_HOME: "/tmp/fm" });

expectEqual(
  "parseSettings fills in defaults and treats blank variables as unset",
  [defaults.port, defaults.refreshSeconds, defaults.allowedHosts, defaults.fmHome, defaults.ghBin],
  [4748, 300, ["localhost", "127.0.0.1", "[::1]"], "/tmp/fm", "gh"],
);
expectEqual(
  "parseSettings reads lists and names every bad variable",
  [
    parseSettings({ BEARINGS_API_ALLOWED_HOSTS: "A.local, ,b", BEARINGS_LINEAR_TEAMS: "liv,ENG" })
      .allowedHosts,
    parseSettings({ BEARINGS_LINEAR_TEAMS: "liv, ENG" }).linearTeams,
    settingsError({ BEARINGS_API_PORT: "80x", BEARINGS_API_REFRESH: "5" }),
    settingsError({ BEARINGS_LINEAR_BASE: "javascript:alert(1)", BEARINGS_LINEAR_TEAMS: "L(V" }),
  ],
  [
    ["a.local", "b"],
    ["LIV", "ENG"],
    "Bad settings: BEARINGS_API_PORT must be a whole number from 1 to 65535; BEARINGS_API_REFRESH must be a whole number from 10 to 86400.",
    "Bad settings: BEARINGS_LINEAR_BASE must be an http or https URL; BEARINGS_LINEAR_TEAMS.0 must be letters and digits.",
  ],
);

expectEqual(
  "request schemas trim and refuse bad bodies",
  [
    AnswerRequestSchema.safeParse({ answers: [{ answer: " yes ", question: 1 }] }).data,
    AnswerRequestSchema.safeParse({ answers: [{ answer: "x", extra: 1, question: 1 }] }).success,
    AnswerRequestSchema.safeParse({ answers: [{ answer: "x", question: 1.5 }] }).success,
    AnswerRequestSchema.safeParse({ answers: [] }).success,
    NoteRequestSchema.safeParse({ text: "  hi " }).data,
    NoteRequestSchema.safeParse({ text: "   " }).success,
    NoteRequestSchema.safeParse({ text: "x".repeat(4001) }).success,
  ],
  [
    { answers: [{ answer: "yes", question: 1 }] },
    false,
    false,
    false,
    { text: "hi" },
    false,
    false,
  ],
);
expectEqual(
  "ActivityLimitSchema defaults, reads plain digits and bounds the limit",
  [undefined, "3", "0", "17", "2.5", "abc", "0x10", "1e1", ""].map(
    (limit) => ActivityLimitSchema.safeParse(limit).data ?? null,
  ),
  [16, 3, null, null, null, null, null, null, null],
);
expectEqual(
  "parseHoldReason reads bare and quoted reasons, with escapes",
  [
    parseHoldReason('id: x\nhold_reason: "Pick \\"fast\\" or \\\\ not"\n'),
    parseHoldReason("hold_reason: Plain words"),
    parseHoldReason("hold_reason: -"),
    parseHoldReason('hold_reason: "-"'),
    parseHoldReason("nothing here"),
  ],
  ['Pick "fast" or \\ not', "Plain words", "", "", ""],
);

if (offline) {
  console.log(failures === 0 ? "\nAll offline checks passed." : `\n${failures} check(s) failed.`);
  process.exit(failures === 0 ? 0 : 1);
}

// ---------- live API: wait for the first snapshot ----------
if (fixture) {
  fixtureHome = await makeFixtureHome();
  base = await startFixtureServer(fixtureHome);
}

let ready = false;
const readyDeadline = Date.now() + READY_TIMEOUT_MS;

while (!ready && Date.now() < readyDeadline) {
  try {
    const health = await call("GET", "/health");
    ready = (health.json as { ready?: boolean } | null)?.ready === true;
  } catch {
    // Not listening yet.
  }
  if (!ready) {
    await new Promise((resolve) => setTimeout(resolve, 3000));
  }
}
if (!ready) {
  fail("API never became ready");
  process.exit(1);
}

const bearings = await call("GET", "/api/v1/bearings");

expect("GET /api/v1/bearings", bearings, 200, validator("Bearings"));
expect("GET /health", await call("GET", "/health"), 200, validator("Health"));

if (fixture) {
  checkFixtureValues(bearings.json as Bearings);
}

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

if (key) {
  expect(
    "GET /api/v1/bearings without the key",
    await call("GET", "/api/v1/bearings", { noKey: true }),
    401,
    validator("Error"),
  );
  expect(
    "GET /api/v1/bearings with a lowercase bearer scheme",
    await call("GET", "/api/v1/bearings", { authorization: `bearer ${key}` }),
    200,
    validator("Bearings"),
  );
} else {
  console.log("  skip BEARINGS_API_KEY not set, so the 401 case was not exercised");
}

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
expect("HEAD /api/v1/bearings", await call("HEAD", "/api/v1/bearings"), 200);

const first = (bearings.json as { underway: { id: string }[] }).underway[0];

if (first) {
  expect(
    `GET /api/v1/tasks/${first.id}`,
    await call("GET", `/api/v1/tasks/${first.id}`),
    200,
    validator("Task"),
  );
}

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
  "POST answers the same question twice",
  await call("POST", "/api/v1/questions/x/answers", {
    body: JSON.stringify({
      answers: [
        { answer: "a", question: 1 },
        { answer: "b", question: 1 },
      ],
    }),
    type: "application/json",
  }),
  400,
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
  "POST refresh from another port on this machine",
  await call("POST", "/api/v1/refresh", { origin: "http://127.0.0.1:1" }),
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

if (decision) {
  expect(
    "POST answers unknown question number",
    await call("POST", `/api/v1/questions/${decision.id}/answers`, {
      body: JSON.stringify({ answers: [{ answer: "x", question: 999 }] }),
      type: "application/json",
    }),
    422,
    validator("Error"),
  );
} else {
  console.log("  skip no open decision, so the 422 case was not exercised");
}

if (fixture) {
  await checkFixtureWrites();
}

const spec = await call("GET", "/openapi.json");

if (spec.status === 200 && (spec.json as { openapi?: string } | null)?.openapi === "3.1.0") {
  pass("GET /openapi.json serves the spec");
} else {
  fail("GET /openapi.json");
}

console.log(failures === 0 ? "\nAll checks passed." : `\n${failures} check(s) failed.`);
process.exit(failures === 0 ? 0 : 1);
