# Fleet Bearings API

A JSON API over the Fleet Bearings view of a [Firstmate](https://github.com/kunchenguid/firstmate) home: the questions waiting on the captain, the work under way with its validation steps, what landed, what is queued, and recent activity. It is described by an OpenAPI 3.1 spec that the server itself serves.

TypeScript with one runtime dependency, [Zod](https://zod.dev), which checks every input: settings, request bodies, query and path parameters, and what Firstmate prints. Node 26 runs the `.ts` files directly. Uses pnpm (pinned in `packageManager`).

## Run it

It reads a Firstmate home, so run it on the machine that has one.

```sh
pnpm install       # Zod, plus the dev tools: the TypeScript compiler, oxlint, oxfmt and the spec validators
cp .env.example .env.local   # optional: settings (see below)
pnpm start         # http://localhost:4748
```

- Interactive docs: <http://localhost:4748/docs>
- OpenAPI spec: <http://localhost:4748/openapi.json>
- `start.sh` starts it in the background and is safe to run twice.

Data is rebuilt every 5 minutes by default (`BEARINGS_API_REFRESH`). `POST /api/v1/refresh` rebuilds it now.

## Endpoints

| Method | Path                                          | What                                                                 |
| ------ | --------------------------------------------- | -------------------------------------------------------------------- |
| GET    | `/api/v1/bearings`                            | The whole picture                                                    |
| GET    | `/api/v1/tasks`, `/api/v1/tasks/{id}`         | Work under way, with a plain-English status and its validation steps |
| GET    | `/api/v1/questions`, `/api/v1/questions/{id}` | Decisions waiting on the captain, and PRs ready to merge             |
| POST   | `/api/v1/questions/{id}/answers`              | Send answers to Firstmate                                            |
| GET    | `/api/v1/activity`                            | Recent events, newest first                                          |
| POST   | `/api/v1/notes`                               | Send a note to Firstmate                                             |
| POST   | `/api/v1/refresh`                             | Rebuild now                                                          |
| GET    | `/health`                                     | Health                                                               |

The API never answers a decision, merges, or changes a task. Answers and notes become Firstmate inbox notes that it reads. A decision with no structured questions is answered as question 1.

Writes (`POST`) that carry an `Origin` header from another site get a 403, so a web page cannot post to the API from your browser. If the first snapshot fails, it is retried every 30 seconds and the 503 says why.

## Settings

| Variable                     | Default                     | What                                                                                                                 |
| ---------------------------- | --------------------------- | -------------------------------------------------------------------------------------------------------------------- |
| `FM_HOME`                    | three folders above `src/`  | The Firstmate home to read                                                                                           |
| `BEARINGS_API_PORT`          | `4748`                      | Port                                                                                                                 |
| `BEARINGS_API_HOST`          | `127.0.0.1`                 | Interface                                                                                                            |
| `BEARINGS_API_KEY`           | none                        | When set, `/api/v1/*` needs `Authorization: Bearer <key>`                                                            |
| `BEARINGS_API_ALLOWED_HOSTS` | `localhost,127.0.0.1,[::1]` | Host names it answers to                                                                                             |
| `BEARINGS_API_REFRESH`       | `300`                       | Seconds between rebuilds, from 10 to 86400                                                                           |
| `BEARINGS_LINEAR_BASE`       | none                        | Ticket link base, for example `https://linear.app/<workspace>/issue/`                                                |
| `BEARINGS_LINEAR_TEAMS`      | none                        | Linear team keys to recognise, for example `LIV,ENG`. Tasks get a ticket link only when both Linear settings are set |
| `BEARINGS_GH_BIN`            | `gh`                        | The GitHub CLI command (a name on `PATH` or an absolute path)                                                        |
| `BEARINGS_GIT_BIN`           | `git`                       | The git command                                                                                                      |
| `BEARINGS_NO_MISTAKES_BIN`   | `no-mistakes`               | The no-mistakes command                                                                                              |

`.env.example` lists them all. Copy it to `.env.local` (not committed): `pnpm start` and `start.sh` both read it, and variables already set in the environment win. Blank values count as unset. A bad value (a port that is not a number, a Linear base that is not an http(s) URL, a team key with symbols) stops the server at startup with a message naming each bad variable.

`start.sh` also takes `BEARINGS_API_NODE` (the node binary), `BEARINGS_API_PID_FILE` and `BEARINGS_API_LOG_FILE` (default `server.pid` and `server.log` in the repo).

## Checks

```sh
pnpm typecheck      # strict TypeScript
pnpm lint           # oxlint
pnpm fmt:check      # oxfmt (pnpm fmt to fix)
pnpm check          # validates the OpenAPI document and runs the parsers on samples, then calls the
                    # running API and checks every response against the schemas in the document
pnpm check --offline  # spec and parser checks only; no server needed
pnpm check --fixture  # starts its own server on the fixed Firstmate home in fixtures/home and
                      # runs every check, plus the exact values that home should give (CI runs this)
```

`fixtures/home` has stub `bin/` scripts (and a `no-mistakes` stub, used via `BEARINGS_NO_MISTAKES_BIN`) that print fixed output. When you change what the API reads from Firstmate, update the stubs and the `fixture:` checks in `scripts/check.ts` to match.

The spec is in `src/openapi.ts` and mirrors the types in `src/types.ts`.
