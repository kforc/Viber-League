#!/bin/zsh
# Dev-only: run a CDP harness against the single-file build.
#
#   tools/cdp/run.sh tools/cdp/flow-club.mjs [outDir]
#
# Chrome MUST be started and killed inside this same shell invocation. The
# sandbox denies `code_sign_clone (file-delete)`, so a Chrome backgrounded from
# an earlier turn is already dead by the time a later command looks for it.
#
# Frame rate: headless Chrome has no compositor, so requestAnimationFrame *can*
# drop to ~1.6fps and a live match would then take minutes of wall clock per
# second of match time. Measured in practice it runs at ~58-60fps, so nothing is
# added here. Do NOT add `--disable-frame-rate-limit`: it reliably wedges
# `Page.captureScreenshot`, and `--run-all-compositor-stages-before-draw`
# wedges the page outright.
set -u

HARNESS="${1:?usage: run.sh <harness.mjs> [outDir]}"
OUT_DIR="${2:-docs/screens}"
ROOT="$(cd "$(dirname "$0")/../.." && pwd)"
CHROME="/Applications/Google Chrome.app/Contents/MacOS/Google Chrome"
PORT="${CDP_PORT:-9333}"
PROFILE=$(mktemp -d /tmp/vl-chrome-XXXXXX)

cleanup() {
  [[ -n "${CPID:-}" ]] && kill "$CPID" 2>/dev/null
  rm -rf "$PROFILE" 2>/dev/null
}
trap cleanup EXIT

pkill -f "remote-debugging-port=$PORT" 2>/dev/null
sleep 1

"$CHROME" \
  --headless=new --no-sandbox --disable-setuid-sandbox --disable-dev-shm-usage \
  --enable-unsafe-swiftshader --use-gl=angle --use-angle=swiftshader \
  --user-data-dir="$PROFILE" --remote-debugging-port="$PORT" \
  --window-size="${VW:-844},${VH:-390}" --hide-scrollbars \
  about:blank >/tmp/chrome-cdp.log 2>&1 &
CPID=$!

READY=0
for i in $(seq 1 60); do
  if ! kill -0 "$CPID" 2>/dev/null; then
    echo "chrome died during startup:"; tail -20 /tmp/chrome-cdp.log; exit 1
  fi
  # Check the status code, not just curl's exit status: a connection that is
  # accepted and then closed also exits 0, which would let the harness start
  # against a socket that is not actually serving CDP.
  code=$(curl -s -o /dev/null -w '%{http_code}' -m 2 "http://127.0.0.1:$PORT/json/version" 2>/dev/null)
  if [[ "$code" == "200" ]]; then
    READY=1; break
  fi
  sleep 0.5
done
if [[ "$READY" != "1" ]]; then
  echo "chrome never opened CDP on $PORT (last code=${code:-none}):"
  tail -20 /tmp/chrome-cdp.log; exit 1
fi
echo "chrome ready on $PORT after $i probe(s)"
sleep 1

CDP_PORT="$PORT" OUT_DIR="$OUT_DIR" VW="${VW:-844}" VH="${VH:-390}" \
  node "$HARNESS" "file://$ROOT/Viber-League.html"
