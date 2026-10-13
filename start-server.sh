#!/bin/sh
# Mac / Linux: double-click (Mac: rename to start-server.command) or run ./start-server.sh
cd "$(dirname "$0")"
if ! command -v node >/dev/null 2>&1; then
  echo "Node.js is not installed. Get the LTS version from https://nodejs.org"; exit 1
fi
node server.js 8080
