#!/usr/bin/env bash
# Fixture for `pnpm check --fixture`: one crew line per task id.
case "$1" in
  ship-1) echo "state: working · source: harness · harness busy" ;;
  scout-1) echo "state: parked · source: run-step · waiting on the captain" ;;
  done-1) echo "state: done · source: gh · checks green: PR ready for review" ;;
  done-2) echo "state: done · source: gh · checks green: PR ready for review" ;;
  *) echo "state: unknown · source: none" ;;
esac
