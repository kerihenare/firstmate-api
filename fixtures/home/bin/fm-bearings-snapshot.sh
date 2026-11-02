#!/usr/bin/env bash
# Fixture for `pnpm check --fixture`: a fixed snapshot covering every list the API builds.
cat <<'JSON'
{
  "contributions": { "checked": 3, "complete": true, "known": 3 },
  "decisions_open": [
    { "id": "scout-1", "summary": "Engine choice: which engine and flag to use" },
    { "id": "free-1", "summary": "Old flag: keep it or not" }
  ],
  "gates": [{ "id": "queued-1", "reason": "Waiting for a free worker. Then it starts.", "title": "Tidy the docs" }],
  "in_flight": [
    { "doing": "building", "id": "ship-1", "kind": "ship", "name": "Fix LIV-42 login bug", "repo": "acme/app", "state": "working" },
    { "doing": "asking", "id": "scout-1", "kind": "scout", "name": "Compare engines", "repo": "acme/app", "state": "parked" }
  ],
  "landed": [
    { "artifact": "https://github.com/acme/app/pull/5", "id": "old-1", "what": "Faster startup" },
    { "artifact": "reports/old-2.md", "id": "old-2", "what": "Survey of caching options" }
  ],
  "recorded_prs": [
    { "id": "done-1", "url": "https://github.com/acme/app/pull/7" },
    { "id": "done-2", "url": "https://github.com/acme/app/pull/8" }
  ]
}
JSON
