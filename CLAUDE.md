# CLAUDE.md

This file provides guidance to Claude Code (claude.ai/code) when working with code in this repository.

## What this is

A read-mostly JSON API (OpenAPI 3.1) over the "Fleet Bearings" view of a [Firstmate](https://github.com/kunchenguid/firstmate) home. TypeScript with **no runtime dependencies**: Node 26 (`.nvmrc`) runs the `.ts` files directly (type stripping), so there is no build step. Package manager is pnpm, pinned via `packageManager`. `devDependencies` are only the compiler (TypeScript 7), oxlint, oxfmt and the spec validators used by `scripts/check.ts`.

## Commands

```sh
pnpm start           # node src/server.ts → http://localhost:4748 (docs at /docs, spec at /openapi.json)
pnpm typecheck       # tsc --noEmit, strict
pnpm lint            # oxlint (.oxlintrc.json)
pnpm fmt             # oxfmt (.oxfmtrc.json); pnpm fmt:check to verify only
pnpm check           # needs the server running; optional base URL: node scripts/check.ts http://127.0.0.1:4748
pnpm check --offline # spec + parser checks only, no server (what CI runs)
./start.sh           # background start via server.pid/server.log; sources .env.local; safe to run twice
```

There is no unit test framework. `scripts/check.ts` is the only test: it validates the OpenAPI document, runs the parsers in `status.ts` against fixed samples, then calls every endpoint on the running server and validates responses against the spec schemas with Ajv. The live part needs a real Firstmate home to get past the readiness wait; `--offline` stops before it. If the server has a key, run the check with the same `BEARINGS_API_KEY`.

## Architecture

- `src/server.ts`: plain `node:http` server with hand-rolled routing (regex per path). Middleware order: Host-header allowlist (anti DNS-rebinding, 421) → Origin check on writes (anti CSRF, 403) → public routes (`/openapi.json`, `/docs`, `/health`) → optional bearer key → `/api/v1/*`. Request bodies are validated by hand (`asAnswerRequest`, `asNoteRequest`) with strict key checks and a 20 KB cap.
- `src/gather.ts`: builds the `Bearings` snapshot by shelling out (`execFile`) to scripts in `$FM_HOME/bin/` (`fm-bearings-snapshot.sh --json`, `fm-crew-state.sh`, `fm-tasks-axi.sh`, `fm-inbox.sh`), plus `git`, `gh`, and `no-mistakes axi status`, and by reading `$FM_HOME/state/*.meta` and `*.status` files. The result is cached in memory and rebuilt on an interval (`BEARINGS_API_REFRESH`, default 300s). `POST /refresh` triggers a rebuild without waiting. Endpoints return 503 `not_ready` until the first build finishes. All GET endpoints are slices of the one cached snapshot.
- `src/status.ts`: pure text parsing. It turns raw Firstmate/no-mistakes CLI output into plain-English state and sentences (`describeTask`, `friendly`, `firstSentence`), pipeline steps (`parsePipeline`), and decision questions (`parseQuestions`, format `## Title :: Opt (Recommended) | Opt`).
- `src/types.ts`: the API response types plus `RawSnapshot` (the shape of the snapshot script's JSON). The enums (`TASK_STATES`, `STEP_NAMES`, `STEP_STATUSES`) are `as const` arrays here, and `openapi.ts` and `status.ts` import them.
- `src/openapi.ts`: the spec as a TS object built with small helpers (`ref`, `nullable`, `str`, `arrayOf`). **Object shapes are maintained by hand to mirror `types.ts`.** Any change to a response type or endpoint must be made in both files. Shared responses (401, 403, 413, 421) are added to every operation by a loop. `pnpm check` catches drift.

The API never acts on Firstmate directly. The only writes are `POST /questions/{id}/answers` and `POST /notes`, and both just pipe a text note into `fm-inbox.sh`.

## Environment

`FM_HOME` defaults to the directory two levels above the repo root (`start.sh` and `gather.ts` both assume this repo sits inside a Firstmate home). Other settings: `BEARINGS_API_PORT`, `BEARINGS_API_HOST`, `BEARINGS_API_KEY`, `BEARINGS_API_ALLOWED_HOSTS`, `BEARINGS_API_REFRESH`, `BEARINGS_LINEAR_BASE` and `BEARINGS_LINEAR_TEAMS`. The README has the table.

## TS constraints

`tsconfig` sets `erasableSyntaxOnly`, `verbatimModuleSyntax`, `allowImportingTsExtensions` and `noUncheckedIndexedAccess`. So: no enums, namespaces or parameter properties; use `import type` for types; local imports end in `.ts`; indexed access is `T | undefined`, and env vars are read as `process.env["X"]`.
