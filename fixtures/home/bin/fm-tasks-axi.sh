#!/usr/bin/env bash
# Fixture for `pnpm check --fixture`: `show <id> [--full]` prints a task's hold reason.
case "$2" in
  scout-1) echo 'hold_reason: "Two calls to make. ## Engine :: Stub (Recommended) | Real ## Flag :: On | Off (Recommended)"' ;;
  free-1) echo 'hold_reason: "Should the \"old\" flag stay for one more release?"' ;;
  *) echo 'hold_reason: -' ;;
esac
