#!/usr/bin/env bash
# WACMS 24/7 Forever Runner — auto-restarts on crash within 5 seconds

cd /home/node/.openclaw/workspace

NODE_PID=""

# On SIGTERM/SIGINT: kill child node process, but DON'T exit the loop
# The container restart will kill this script anyway; post-restart hook starts a new one
cleanup() {
  [ -n "$NODE_PID" ] && kill "$NODE_PID" 2>/dev/null
  sleep 1
  kill -0 "$NODE_PID" 2>/dev/null && kill -9 "$NODE_PID" 2>/dev/null
  exit 0
}
trap cleanup SIGTERM SIGINT

while true; do
  echo "[$(date -Iseconds)] Starting WACMS..." >> /tmp/wacms-runner.log
  node src/server.js >> /tmp/wacms.log 2>&1 &
  NODE_PID=$!
  wait "$NODE_PID"
  EXIT_CODE=$?
  echo "[$(date -Iseconds)] Server exited code $EXIT_CODE. Restarting in 5s..." >> /tmp/wacms-runner.log
  sleep 5
done
