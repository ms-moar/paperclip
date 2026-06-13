#!/usr/bin/env bash
set -euo pipefail

LOG_FILE="${PAPERCLIP_HEALTH_LOG_FILE:-/home/ubuntu/.paperclip/instances/default/logs/health-watchdog.log}"
LOCK_FILE="${PAPERCLIP_HEALTH_LOCK_FILE:-/tmp/paperclip-health-watchdog.lock}"
HEALTH_URL="${PAPERCLIP_HEALTH_URL:-http://127.0.0.1:3100/api/health}"
ROOT_URL="${PAPERCLIP_ROOT_URL:-http://127.0.0.1:3100/}"
UI_INDEX_PATH="${PAPERCLIP_UI_INDEX_PATH:-/home/ubuntu/paperclip/ui/dist/index.html}"
MAX_TIME_SECONDS="${PAPERCLIP_HEALTH_MAX_TIME_SECONDS:-10}"
LATENCY_THRESHOLD_MS="${PAPERCLIP_HEALTH_LATENCY_THRESHOLD_MS:-3000}"
ROOT_MIN_BYTES="${PAPERCLIP_ROOT_MIN_BYTES:-1000}"
UI_INDEX_MIN_BYTES="${PAPERCLIP_UI_INDEX_MIN_BYTES:-1000}"
RESTART_SLEEP_SECONDS="${PAPERCLIP_HEALTH_RESTART_SLEEP_SECONDS:-5}"

mkdir -p "$(dirname "$LOG_FILE")"

log() {
  echo "[$(date '+%Y-%m-%d %H:%M:%S')] $*" | tee -a "$LOG_FILE"
}

cleanup_lock() {
  rm -f "$LOCK_FILE"
}
trap cleanup_lock EXIT

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
root_body_file=$(mktemp)
root_metrics_file=$(mktemp)
cleanup_files() {
  rm -f "$body_file" "$metrics_file" "$root_body_file" "$root_metrics_file"
  cleanup_lock
}
trap cleanup_files EXIT

check_api_health() {
  set +e
  curl -sS --max-time "$MAX_TIME_SECONDS" -o "$body_file" -w '%{http_code} %{time_total}' "$HEALTH_URL" > "$metrics_file" 2>>"$LOG_FILE"
  local curl_status=$?
  set -e

  local metrics http_code time_total latency_ms
  metrics=$(cat "$metrics_file" 2>/dev/null || true)
  http_code=$(awk '{print $1}' <<<"$metrics")
  time_total=$(awk '{print $2}' <<<"$metrics")
  latency_ms=$(awk -v t="${time_total:-0}" 'BEGIN { printf "%d", t * 1000 }')

  if [ "$curl_status" -eq 0 ] && [ "$http_code" = "200" ] && [ "$latency_ms" -le "$LATENCY_THRESHOLD_MS" ]; then
    echo "OK: api http=$http_code latency_ms=$latency_ms"
    return 0
  fi

  local body_preview
  body_preview=$(head -c 300 "$body_file" | tr '\n' ' ' || true)
  echo "FAIL: api curl_status=$curl_status http=${http_code:-none} latency_ms=$latency_ms threshold_ms=$LATENCY_THRESHOLD_MS body=${body_preview}"
  return 1
}

check_root_shell() {
  set +e
  curl -sS --max-time "$MAX_TIME_SECONDS" -o "$root_body_file" -w '%{http_code} %{time_total} %{size_download}' "$ROOT_URL" > "$root_metrics_file" 2>>"$LOG_FILE"
  local curl_status=$?
  set -e

  local metrics http_code time_total size_download latency_ms
  metrics=$(cat "$root_metrics_file" 2>/dev/null || true)
  http_code=$(awk '{print $1}' <<<"$metrics")
  time_total=$(awk '{print $2}' <<<"$metrics")
  size_download=$(awk '{print $3}' <<<"$metrics")
  latency_ms=$(awk -v t="${time_total:-0}" 'BEGIN { printf "%d", t * 1000 }')

  if [ "$curl_status" -ne 0 ] || [ "$http_code" != "200" ]; then
    echo "FAIL: root curl_status=$curl_status http=${http_code:-none} latency_ms=$latency_ms bytes=${size_download:-0}"
    return 1
  fi

  if [ "${size_download:-0}" -lt "$ROOT_MIN_BYTES" ]; then
    echo "FAIL: root body too small bytes=${size_download:-0} min=$ROOT_MIN_BYTES"
    return 1
  fi

  if ! grep -qi '<div[^>]*id=["'"'"']root["'"'"']' "$root_body_file"; then
    echo "FAIL: root body missing #root mount"
    return 1
  fi

  if ! grep -qi '</html>' "$root_body_file"; then
    echo "FAIL: root body missing </html>"
    return 1
  fi

  echo "OK: root http=$http_code latency_ms=$latency_ms bytes=$size_download"
  return 0
}

check_ui_index_file() {
  if [ ! -s "$UI_INDEX_PATH" ]; then
    echo "FAIL: ui index missing or empty path=$UI_INDEX_PATH"
    return 1
  fi

  local size
  size=$(stat -c '%s' "$UI_INDEX_PATH")
  if [ "$size" -lt "$UI_INDEX_MIN_BYTES" ]; then
    echo "FAIL: ui index too small bytes=$size min=$UI_INDEX_MIN_BYTES path=$UI_INDEX_PATH"
    return 1
  fi

  if ! grep -qi '</head>' "$UI_INDEX_PATH"; then
    echo "FAIL: ui index missing </head> path=$UI_INDEX_PATH"
    return 1
  fi

  if ! grep -qi '<div[^>]*id=["'"'"']root["'"'"']' "$UI_INDEX_PATH"; then
    echo "FAIL: ui index missing #root mount path=$UI_INDEX_PATH"
    return 1
  fi

  echo "OK: ui index bytes=$size path=$UI_INDEX_PATH"
  return 0
}

run_checks() {
  local failures=0
  local result

  result=$(check_api_health) || failures=$((failures + 1))
  log "$result"

  result=$(check_ui_index_file) || failures=$((failures + 1))
  log "$result"

  result=$(check_root_shell) || failures=$((failures + 1))
  log "$result"

  [ "$failures" -eq 0 ]
}

if run_checks; then
  log "OK: Paperclip API and UI shell healthy"
  exit 0
fi

log "ACTION: restarting paperclip.service"
systemctl restart paperclip.service
sleep "$RESTART_SLEEP_SECONDS"

if run_checks; then
  log "RECOVERED: Paperclip API and UI shell healthy after restart"
  exit 0
fi

log "ERROR: restart did not recover Paperclip API/UI shell health"
exit 1
