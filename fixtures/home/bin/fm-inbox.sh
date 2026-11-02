#!/usr/bin/env bash
# Fixture for `pnpm check --fixture`: `note --request-id <id> -` appends the request id and the
# note to $FM_HOME/inbox.log, so the check can see what was sent.
{
  echo "request-id: $3"
  cat
  echo
} >>"$FM_HOME/inbox.log"
