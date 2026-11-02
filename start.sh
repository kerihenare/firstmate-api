#!/usr/bin/env bash
# Start the Fleet Bearings API in the background (idempotent via pidfile).
# Settings come from the environment and an optional .env.local; see .env.example.
set -u
here="$(cd "$(dirname "$0")" && pwd)"
# Common install locations, for launchers (cron, launchd) that start with a bare PATH.
export PATH="$PATH:/usr/local/bin:/opt/homebrew/bin"
# Optional local settings (not committed). Variables already set in the environment win.
if [ -f "$here/.env.local" ]; then
  saved="$(export -p)"
  set -a && . "$here/.env.local" && set +a
  eval "$saved" 2>/dev/null
fi
export FM_HOME="${FM_HOME:-$(cd "$here/../.." && pwd)}"
node_bin="${BEARINGS_API_NODE:-node}"
pidfile="${BEARINGS_API_PID_FILE:-$here/server.pid}"
logfile="${BEARINGS_API_LOG_FILE:-$here/server.log}"
# The pidfile counts only when its process is alive and is this server: a stale pidfile's
# number may have been reused by an unrelated process.
running_pid() {
  [ -f "$pidfile" ] || return 1
  pid="$(cat "$pidfile")"
  kill -0 "$pid" 2>/dev/null && ps -p "$pid" -o command= 2>/dev/null | grep -q "src/server.ts"
}
if running_pid; then
  echo "already running (pid $pid)"
else
  # setsid detaches from the terminal's session where it exists (Linux); macOS has no setsid.
  detach=""
  command -v setsid >/dev/null 2>&1 && detach="setsid"
  $detach nohup "$node_bin" "$here/src/server.ts" >>"$logfile" 2>&1 </dev/null &
  echo $! >"$pidfile"
  sleep 2
  if ! running_pid; then
    rm -f "$pidfile"
    echo "failed to start; the end of $logfile:" >&2
    tail -n 20 "$logfile" >&2
    exit 1
  fi
fi
echo "http://localhost:${BEARINGS_API_PORT:-4748}/docs"
