# CLAUDE.md

This file provides guidance to Claude Code (claude.ai/code) when working with code in this repository.

## What this is

A read-mostly JSON API (OpenAPI 3.1) over the "Fleet Bearings" view of a [Firstmate](https://github.com/kunchenguid/firstmate) home. TypeScript with three runtime dependencies: **Hono 4** (plus `@hono/node-server`) for HTTP and **Zod 4** to parse every input. Node 24+ (`.nvmrc` pins 24) runs the `.ts` files directly (type stripping), so there is no build step. Package manager is pnpm, pinned via `packageManager`. `devDependencies` are only the compiler (TypeScript 7), oxlint, oxfmt and the spec validators used by `scripts/check.ts`.

## Commands

```sh
pnpm start           # node src/server.ts (reads .env.local if present) → http://localhost:4748 (docs at /docs, spec at /openapi.json)
pnpm typecheck       # tsc --noEmit, strict
pnpm lint            # oxlint (.oxlintrc.json)
pnpm fmt             # oxfmt (.oxfmtrc.json); pnpm fmt:check to verify only
pnpm check           # needs the server running; optional base URL: node scripts/check.ts http://127.0.0.1:4748
pnpm check --offline # spec + parser checks only, no server
pnpm check --fixture # starts its own server on fixtures/home and runs everything (what CI runs)
./start.sh           # background start via server.pid/server.log; reads .env.local (env wins); safe to run twice
```

There is no unit test framework. `scripts/check.ts` is the only test: it validates the OpenAPI document, runs the parsers in `status.ts` against fixed samples, then calls every endpoint on a running server and validates responses against the spec schemas with Ajv. `--offline` stops before the live part. `--fixture` copies `fixtures/home` (a fake Firstmate home whose `bin/` stubs print fixed output, including `gh` and `no-mistakes`) to a temp dir, writes its `state/*.status` file with timestamps relative to now (the activity feed only keeps the last 24 hours), starts its own server on it (with a key and Linear settings), checks the exact values it should produce, and sends a note and an answer to the stub inbox, which logs them to `inbox.log`. When `gather.ts` starts reading something new from Firstmate, extend the stubs and the `fixture:` checks. Against a real server with a key, run the check with the same `BEARINGS_API_KEY`.

## Architecture

- `src/server.ts`: a Hono app (`strict: false`, so trailing slashes are ignored; HEAD is routed to GET handlers) served by `@hono/node-server`. Middleware and routes run in registration order, so the order of the `app.use`/`app.get` calls is the security order: Host-header allowlist (anti DNS-rebinding, 421) → Origin check on writes (anti CSRF, 403) → public routes (`/openapi.json`, `/docs`, `/health`) → optional bearer key (`app.use(checkKey)`, which also covers unknown paths) → `/api/v1/*`. A `noStore` middleware marks every response `no-store` and `nosniff`; `app.notFound` and `app.onError` give the 404 and 500 bodies. Request bodies (20 KB cap, read as a stream), query parameters, path ids and the optional `Idempotency-Key` header are parsed with the Zod schemas in `schemas.ts`. On SIGINT/SIGTERM it closes the listener and calls `stopCommands()` before exiting.
- `src/gather.ts`: builds the `Bearings` snapshot by running (`spawn`, never a shell) scripts in `$FM_HOME/bin/` (`fm-bearings-snapshot.sh --json`, `fm-crew-state.sh`, `fm-tasks-axi.sh`, `fm-inbox.sh`), plus `git`, `gh`, and `no-mistakes axi status` (each in its own process group, so a timeout kills everything it started; live children are tracked so `stopCommands()` can stop them all on shutdown), and by reading `$FM_HOME/state/*.meta` (parsed with `TaskMetaSchema`) and `*.status` files. The result is cached in memory and rebuilt on an interval (`BEARINGS_API_REFRESH`, default 300s). `POST /refresh` triggers a rebuild without waiting. Endpoints return 503 `not_ready` until the first build finishes. All GET endpoints are slices of the one cached snapshot. A recorded PR is listed as ready to merge only if `gh pr view` does not say it is merged or closed.
- `src/env.ts`: the Zod schema for every env var, parsed once into the exported `settings` (`parseSettings` is exported for tests). It throws at startup on a bad value (a `NaN` timer delay would make the refresh loop spin). Nothing else reads `process.env`; a new setting goes here, in `.env.example` and in the README table.
- `src/schemas.ts`: Zod schemas for every other input: `AnswerRequestSchema`, `NoteRequestSchema`, `IdSchema`, `IdempotencyKeySchema`, the query params, `RawSnapshotSchema` and `TaskMetaSchema`. Their types (`AnswerRequest`, `RawSnapshot`, `RawTask`, …) are inferred with `z.infer`.
- `src/status.ts`: pure text parsing. It checks the snapshot script's JSON (`parseSnapshot`, via `RawSnapshotSchema`) and turns raw Firstmate/no-mistakes CLI output into plain-English state and sentences (`describeTask`, `friendly`, `firstSentence`), pipeline steps (`parsePipeline`), hold reasons (`parseHoldReason`) and decision questions (`parseQuestions`, format `## Title :: Opt (Recommended) | Opt`).
- `src/types.ts`: the API response shapes as Zod schemas (`TaskSchema`, `BearingsSchema`, …), with descriptions in `.meta()`, and their types inferred with `z.infer`. The enums (`TASK_STATES`, `STEP_NAMES`, `STEP_STATUSES`) are `as const` arrays here, and `schemas.ts` and `status.ts` import them. The server does not parse its own responses with these schemas; they exist to be the single source for the types and the spec.
- `src/openapi.ts`: the spec. **Component schemas are generated** from the Zod schemas with `z.toJSONSchema` (listed by name in `componentSchemas`; a new response or request schema must be added there). The operations (paths, parameters, responses) are written by hand with `ref` and `arrayOf`. Shared responses (401, 403, 413, 421, 500) are added to every operation by a loop. `pnpm check` calls every operation and validates responses against the spec.

The API never acts on Firstmate directly. The only writes are `POST /questions/{id}/answers` and `POST /notes`, and both just pipe a text note into `fm-inbox.sh note --request-id <id>`. The id is the caller's `Idempotency-Key` header when sent (so a retry is recorded once), else a fresh UUID.

## Environment

`FM_HOME` defaults to the directory two levels above the repo root (`start.sh` and `env.ts` both assume this repo sits inside a Firstmate home). Other settings: `BEARINGS_API_PORT`, `BEARINGS_API_HOST`, `BEARINGS_API_KEY`, `BEARINGS_API_ALLOWED_HOSTS`, `BEARINGS_API_REFRESH`, `BEARINGS_LINEAR_BASE`, `BEARINGS_LINEAR_TEAMS`, `BEARINGS_GH_BIN`, `BEARINGS_GIT_BIN` and `BEARINGS_NO_MISTAKES_BIN` (plus `BEARINGS_API_NODE`, `BEARINGS_API_PID_FILE`, `BEARINGS_API_LOG_FILE` for `start.sh` only). `.env.example` lists them all; the README has the table.

## TS constraints

`tsconfig` sets `erasableSyntaxOnly`, `verbatimModuleSyntax`, `allowImportingTsExtensions` and `noUncheckedIndexedAccess`. So: no enums, namespaces or parameter properties; use `import type` for types; local imports end in `.ts`; indexed access is `T | undefined`, and env vars are read only in `env.ts`.

## Code layout

- Always use curly braces for control flow (oxlint `curly: all` enforces this).
- Put an empty line before a `return`, unless it is the first statement in its block.
- Put an empty line between statements of different kinds: control blocks (`if`, `for`, `while`, `switch`, `try`, …, separated from their neighbours outside the braces), function calls, and variable declarations. Consecutive statements of the same kind need no blank line. oxlint has no rule for these two, so keep to them by hand.

## Doc comments

Use TSDoc (`/** … */`), not plain JSDoc. Every module opens with a `@packageDocumentation` comment. Every function, type, interface field and module-level constant gets a doc comment unless its name already says everything. Tags: `@param name - description` (with the hyphen, no `{type}`), `@returns`, `@remarks` for detail beyond the one-line summary, `@example` with a fenced block, `@throws`, `@typeParam`, `@defaultValue`, and `{@link Name}`. oxlint's `jsdoc` plugin rejects unknown tags and `@param`/`@returns` tags with no description.

Write for a human reader: descriptive names over one-letter ones (loop indexes and `(a, b)` sort callbacks aside), and small named helpers over long functions.
