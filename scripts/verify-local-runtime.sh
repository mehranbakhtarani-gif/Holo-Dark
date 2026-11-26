#!/usr/bin/env bash
set -Eeuo pipefail

ROOT_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")/.." && pwd)"
cd "$ROOT_DIR"

PORT="${PORT:-3187}"
HEALTH_URL="http://127.0.0.1:${PORT}/api/health"
LOG_FILE="${TMPDIR:-/tmp}/holoo-runtime-preflight-${PORT}.log"
SERVER_PID=""

cleanup() {
  if [[ -n "$SERVER_PID" ]] && kill -0 "$SERVER_PID" 2>/dev/null; then
    kill "$SERVER_PID" 2>/dev/null || true
    wait "$SERVER_PID" 2>/dev/null || true
  fi
}
trap cleanup EXIT INT TERM

if ! command -v node >/dev/null 2>&1; then
  echo "FAIL: Node.js is not installed."
  exit 1
fi
if ! command -v npm >/dev/null 2>&1; then
  echo "FAIL: npm is not installed."
  exit 1
fi
if [[ ! -d node_modules ]]; then
  echo "Dependencies are missing. Run npm install first."
  exit 1
fi

echo "[1/3] Building production PWA..."
npm run build
[[ -s dist/index.html ]] || { echo "FAIL: dist/index.html was not generated."; exit 1; }

echo "[2/3] Starting Express on port $PORT..."
./node_modules/.bin/tsx server.ts >"$LOG_FILE" 2>&1 &
SERVER_PID=$!

echo "[3/3] Waiting for /api/health..."
node --input-type=module - "$HEALTH_URL" <<'NODE'
const url = process.argv[2];
let lastError = "server did not respond";
for (let attempt = 0; attempt < 30; attempt += 1) {
  try {
    const response = await fetch(url, { signal: AbortSignal.timeout(1500) });
    if (!response.ok) throw new Error(`HTTP ${response.status}`);
    const body = await response.json();
    if (body.status !== "ok" || body.service !== "holoo-apex-corporate-erp") {
      throw new Error("unexpected health response");
    }
    if (!body.timestamp || Number.isNaN(Date.parse(body.timestamp))) {
      throw new Error("health timestamp is missing or invalid");
    }
    console.log("PASS: build output exists and Express health endpoint is healthy.");
    console.log(JSON.stringify(body));
    process.exit(0);
  } catch (error) {
    lastError = error instanceof Error ? error.message : String(error);
    await new Promise((resolve) => setTimeout(resolve, 1000));
  }
}
console.error(`FAIL: ${lastError}`);
process.exit(1);
NODE
