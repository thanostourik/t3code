#!/usr/bin/env bash
# Two-instance test harness for roaming (.plans/21-roaming-workspace.md, M0).
#
# Boots two independent T3 server processes on one box, each with its own
# base dir (state DB, secrets, environment id) and port. Every roaming
# milestone's acceptance criteria run against this pair.
#
# Usage:
#   scripts/roaming/harness.sh start|stop|status
#
# Layout (override root with T3_ROAMING_HARNESS_DIR):
#   $HARNESS_DIR/instance-a/{basedir,server.log,server.pid}   port 14801
#   $HARNESS_DIR/instance-b/{basedir,server.log,server.pid}   port 14802
set -euo pipefail

REPO_ROOT="$(cd "$(dirname "${BASH_SOURCE[0]}")/../.." && pwd)"
HARNESS_DIR="${T3_ROAMING_HARNESS_DIR:-/tmp/t3-roaming-harness}"
HOST=127.0.0.1
PORT_A=14801
PORT_B=14802

instance_port() { [ "$1" = instance-a ] && echo "$PORT_A" || echo "$PORT_B"; }

start_instance() {
  local name="$1" port dir
  port="$(instance_port "$name")"
  dir="$HARNESS_DIR/$name"
  mkdir -p "$dir/basedir"

  if [ -f "$dir/server.pid" ] && kill -0 "$(cat "$dir/server.pid")" 2>/dev/null; then
    echo "$name already running (pid $(cat "$dir/server.pid"))"
    return 0
  fi

  node "$REPO_ROOT/apps/server/src/bin.ts" serve \
    --base-dir "$dir/basedir" --host "$HOST" --port "$port" --no-browser \
    >"$dir/server.log" 2>&1 &
  echo $! >"$dir/server.pid"

  # Readiness = our child is alive AND the port answers with our own
  # environment id — a foreign server squatting the port must not pass.
  local descriptor envid
  for _ in $(seq 1 60); do
    if ! kill -0 "$(cat "$dir/server.pid")" 2>/dev/null; then
      echo "$name died during startup (port $port already taken?); log tail:" >&2
      tail -20 "$dir/server.log" >&2
      rm -f "$dir/server.pid"
      return 1
    fi
    if descriptor="$(curl -fsS "http://$HOST:$port/.well-known/t3/environment" 2>/dev/null)"; then
      envid="$(cat "$dir/basedir/userdata/environment-id" 2>/dev/null || true)"
      case "$descriptor" in
        *"$envid"*) [ -n "$envid" ] && {
          echo "$name up: http://$HOST:$port (pid $(cat "$dir/server.pid"), base dir $dir/basedir)"
          return 0
        } ;;
      esac
    fi
    sleep 0.5
  done
  echo "$name did not become ready within 30s; log tail:" >&2
  tail -20 "$dir/server.log" >&2
  return 1
}

stop_instance() {
  local name="$1" dir="$HARNESS_DIR/$1"
  if [ -f "$dir/server.pid" ] && kill -0 "$(cat "$dir/server.pid")" 2>/dev/null; then
    kill "$(cat "$dir/server.pid")"
    echo "$name stopped"
  else
    echo "$name not running"
  fi
  rm -f "$dir/server.pid"
}

status_instance() {
  local name="$1" port
  port="$(instance_port "$name")"
  local descriptor
  if descriptor="$(curl -fsS "http://$HOST:$port/.well-known/t3/environment" 2>/dev/null)"; then
    echo "$name: up on http://$HOST:$port — $descriptor"
  else
    echo "$name: down"
  fi
}

case "${1:-}" in
  start)  start_instance instance-a && start_instance instance-b ;;
  stop)   stop_instance instance-a; stop_instance instance-b ;;
  status) status_instance instance-a; status_instance instance-b ;;
  *) echo "usage: $0 start|stop|status" >&2; exit 2 ;;
esac
