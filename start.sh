#!/usr/bin/env bash
# Start the Fleet Bearings API in the background (idempotent via pidfile).
set -u
export PATH="/usr/local/bin:$PATH"
here="$(cd "$(dirname "$0")" && pwd)"
# Optional local settings (not committed): BEARINGS_LINEAR_BASE, BEARINGS_API_KEY, BEARINGS_API_PORT, ...
[ -f "$here/.env.local" ] && set -a && . "$here/.env.local" && set +a
pidfile="$here/server.pid"
if [ -f "$pidfile" ] && kill -0 "$(cat "$pidfile")" 2>/dev/null; then
  echo "already running (pid $(cat "$pidfile"))"
else
  FM_HOME="$(cd "$here/../.." && pwd)" setsid nohup node "$here/src/server.ts" >>"$here/server.log" 2>&1 </dev/null &
  echo $! >"$pidfile"
  sleep 2
fi
echo "http://localhost:${BEARINGS_API_PORT:-4748}/docs"
