#!/usr/bin/env bash
set -euo pipefail

LOG_FILE="/home/ubuntu/.paperclip/instances/default/logs/health-watchdog.log"
LOCK_FILE="/tmp/paperclip-health-watchdog.lock"
HEALTH_URL="${PAPERCLIP_HEALTH_URL:-http://127.0.0.1:3100/api/health}"
MAX_TIME_SECONDS="${PAPERCLIP_HEALTH_MAX_TIME_SECONDS:-10}"
LATENCY_THRESHOLD_MS="${PAPERCLIP_HEALTH_LATENCY_THRESHOLD_MS:-3000}"

mkdir -p "$(dirname "$LOG_FILE")"

log() {
  echo "[$(date '+%Y-%m-%d %H:%M:%S')] $*" | tee -a "$LOG_FILE"
}

cleanup() {
  rm -f "$LOCK_FILE"
}
trap cleanup EXIT

if [ -f "$LOCK_FILE" ]; then
  pid=$(cat "$LOCK_FILE" 2>/dev/null || true)
  if [ -n "$pid" ] && kill -0 "$pid" 2>/dev/null; then
    log "SKIP: another watchdog run is active (PID $pid)"
    exit 0
  fi
  rm -f "$LOCK_FILE"
fi
echo $$ > "$LOCK_FILE"

if systemctl is-active --quiet paperclip-update.service; then
  log "SKIP: paperclip-update.service is active"
  exit 0
fi

body_file=$(mktemp)
metrics_file=$(mktemp)
cleanup_files() {
  rm -f "$body_file" "$metrics_file"
  cleanup
}
trap cleanup_files EXIT

set +e
curl -sS --max-time "$MAX_TIME_SECONDS" -o "$body_file" -w '%{http_code} %{time_total}' "$HEALTH_URL" > "$metrics_file" 2>>"$LOG_FILE"
curl_status=$?
set -e

metrics=$(cat "$metrics_file" 2>/dev/null || true)
http_code=$(awk '{print $1}' <<<"$metrics")
time_total=$(awk '{print $2}' <<<"$metrics")
latency_ms=$(awk -v t="${time_total:-0}" 'BEGIN { printf "%d", t * 1000 }')

if [ "$curl_status" -eq 0 ] && [ "$http_code" = "200" ] && [ "$latency_ms" -le "$LATENCY_THRESHOLD_MS" ]; then
  log "OK: health http=$http_code latency_ms=$latency_ms"
  exit 0
fi

body_preview=$(head -c 300 "$body_file" | tr '\n' ' ' || true)
log "FAIL: health curl_status=$curl_status http=${http_code:-none} latency_ms=$latency_ms threshold_ms=$LATENCY_THRESHOLD_MS body=${body_preview}"
log "ACTION: restarting paperclip.service"
systemctl restart paperclip.service
sleep 5

set +e
curl -sS --max-time "$MAX_TIME_SECONDS" -o "$body_file" -w '%{http_code} %{time_total}' "$HEALTH_URL" > "$metrics_file" 2>>"$LOG_FILE"
verify_status=$?
set -e
metrics=$(cat "$metrics_file" 2>/dev/null || true)
verify_http=$(awk '{print $1}' <<<"$metrics")
verify_time=$(awk '{print $2}' <<<"$metrics")
verify_latency_ms=$(awk -v t="${verify_time:-0}" 'BEGIN { printf "%d", t * 1000 }')

if [ "$verify_status" -eq 0 ] && [ "$verify_http" = "200" ]; then
  log "RECOVERED: health http=$verify_http latency_ms=$verify_latency_ms"
  exit 0
fi

log "ERROR: restart did not recover health verify_status=$verify_status http=${verify_http:-none} latency_ms=$verify_latency_ms"
exit 1
