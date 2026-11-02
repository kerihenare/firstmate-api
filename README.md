# Fleet Bearings API

A JSON API over the Fleet Bearings view of a [Firstmate](https://github.com/kunchenguid/firstmate) home: the questions waiting on the captain, the work under way with its validation steps, what landed, what is queued, and recent activity. It is described by an OpenAPI 3.1 spec that the server itself serves.

TypeScript, no runtime dependencies. Node 26 runs the `.ts` files directly. Uses pnpm (pinned in `packageManager`).

## Run it

It reads a Firstmate home, so run it on the machine that has one.

```sh
pnpm install       # dev tools only: the TypeScript compiler, oxlint, oxfmt and the spec validators
pnpm start         # http://localhost:4748
```

- Interactive docs: <http://localhost:4748/docs>
- OpenAPI spec: <http://localhost:4748/openapi.json>
- `start.sh` starts it in the background and is safe to run twice.

Data is rebuilt every 5 minutes. `POST /api/v1/refresh` rebuilds it now.

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

The API never answers a decision, merges, or changes a task. Answers and notes become Firstmate inbox notes that it reads.

## Settings

| Variable                     | Default                     | What                                                                                                          |
| ---------------------------- | --------------------------- | ------------------------------------------------------------------------------------------------------------- |
| `FM_HOME`                    | three folders above `src/`  | The Firstmate home to read                                                                                    |
| `BEARINGS_API_PORT`          | `4748`                      | Port                                                                                                          |
| `BEARINGS_API_HOST`          | `127.0.0.1`                 | Interface                                                                                                     |
| `BEARINGS_API_KEY`           | none                        | When set, `/api/v1/*` needs `Authorization: Bearer <key>`                                                     |
| `BEARINGS_API_ALLOWED_HOSTS` | `localhost,127.0.0.1,[::1]` | Host names it answers to                                                                                      |
| `BEARINGS_API_REFRESH`       | `300`                       | Seconds between rebuilds                                                                                      |
| `BEARINGS_LINEAR_BASE`       | none                        | Ticket link base, for example `https://linear.app/<workspace>/issue/`. Without it, tasks carry no ticket link |

`start.sh` also reads an optional `.env.local` (not committed).

## Checks

```sh
pnpm typecheck      # strict TypeScript
pnpm lint           # oxlint
pnpm fmt:check      # oxfmt (pnpm fmt to fix)
pnpm check          # validates the OpenAPI document, then calls the running API and
                    # checks every response against the schemas in the document
```

The spec is in `src/openapi.ts` and mirrors the types in `src/types.ts`.
