#!/usr/bin/env bash
set -euo pipefail

INSTANCE_ROOT="${PAPERCLIP_INSTANCE_ROOT:-/home/ubuntu/.paperclip/instances/default}"
LOG_FILE="${PAPERCLIP_DISK_CLEANUP_LOG_FILE:-$INSTANCE_ROOT/logs/disk-pressure-cleanup.log}"
RUN_LOG_RETENTION_DAYS="${PAPERCLIP_RUN_LOG_RETENTION_DAYS:-7}"
TMP_CLEANUP_SCRIPT="${PAPERCLIP_TMP_CLEANUP_SCRIPT:-$(dirname "$0")/tmp_cleanup.py}"
MODE="${1:---dry-run}"

if [[ "$MODE" != "--dry-run" && "$MODE" != "--apply" ]]; then
  echo "Usage: $0 [--dry-run|--apply]" >&2
  exit 2
fi

mkdir -p "$(dirname "$LOG_FILE")"

log() {
  echo "[$(date '+%Y-%m-%d %H:%M:%S')] $*" | tee -a "$LOG_FILE"
}

bytes_to_human() {
  awk -v bytes="${1:-0}" 'BEGIN {
    split("B KiB MiB GiB TiB", unit, " ");
    value = bytes + 0;
    i = 1;
    while (value >= 1024 && i < 5) { value /= 1024; i++; }
    if (i == 1) printf "%d%s", value, unit[i]; else printf "%.2f%s", value, unit[i];
  }'
}

sum_files() {
  awk '{ count += 1; bytes += $1 } END { printf "%d %d\n", count, bytes }'
}

find_old_files() {
  local root="$1"
  local days="$2"
  local pattern="$3"
  if [[ ! -d "$root" ]]; then
    return 0
  fi
  find "$root" -type f -name "$pattern" -mtime "+$days" -printf '%s %p\n' 2>/dev/null | sort -n
}

apply_delete_files_from_list() {
  local list_file="$1"
  if [[ "$MODE" == "--dry-run" ]]; then
    return 0
  fi
  awk '{ $1=""; sub(/^ /, ""); print }' "$list_file" | while IFS= read -r path; do
    [[ -n "$path" ]] || continue
    rm -f -- "$path" || log "WARN: failed to remove $path"
  done
}

cleanup_old_files() {
  local label="$1"
  local root="$2"
  local days="$3"
  local pattern="$4"
  local list_file
  list_file=$(mktemp)
  find_old_files "$root" "$days" "$pattern" > "$list_file"
  local count bytes
  read -r count bytes < <(sum_files < "$list_file")
  log "$MODE: $label candidates count=$count bytes=$(bytes_to_human "$bytes") root=$root older_than_days=$days pattern=$pattern"
  if [[ "$count" -gt 0 ]]; then
    tail -20 "$list_file" | while IFS= read -r line; do log "$MODE: $label candidate $line"; done
    apply_delete_files_from_list "$list_file"
  fi
  rm -f "$list_file"
}

cleanup_tmp_targets() {
  if [[ ! -x "$TMP_CLEANUP_SCRIPT" ]]; then
    log "ERROR: tmp cleanup helper is not executable: $TMP_CLEANUP_SCRIPT"
    return 1
  fi

  local output_file
  output_file=$(mktemp)
  if ! "$TMP_CLEANUP_SCRIPT" "$MODE" > "$output_file"; then
    log "ERROR: guarded tmp cleanup failed"
    tail -20 "$output_file" | while IFS= read -r line; do log "tmp: $line"; done
    rm -f "$output_file"
    return 1
  fi

  python3 - "$output_file" <<'PY' | while IFS= read -r line; do log "$line"; done
import json
import sys
from collections import Counter

path = sys.argv[1]
reasons = Counter()
summary = None
apply_failures = []
with open(path, encoding="utf-8") as handle:
    for raw in handle:
        row = json.loads(raw)
        if row["type"] == "inventory":
            reasons[row["reason"]] += 1
        elif row["type"] == "apply" and not row["deleted"]:
            apply_failures.append(row)
        elif row["type"] == "summary":
            summary = row

if summary is None:
    raise SystemExit("tmp cleanup helper emitted no summary")
print(
    f"{summary['mode']}: tmp inventory={summary['inventory_count']} "
    f"eligible={summary['eligible_count']} manifest={summary['manifest_count']} "
    f"manifest_bytes={summary['manifest_bytes']} caps_refused={summary['caps_refused']} "
    f"deleted={summary['deleted_count']} deleted_bytes={summary['deleted_bytes']} "
    f"unknown={summary['unknown_count']} "
    f"liveness_complete={summary['liveness_complete']}"
)
print("tmp retained reasons=" + json.dumps(dict(sorted(reasons.items())), separators=(",", ":")))
for failure in apply_failures[-20:]:
    print(f"WARN: tmp apply refused path={failure['path']} reason={failure['reason']}")
PY
  rm -f "$output_file"
}

log "START: disk pressure cleanup mode=$MODE instance_root=$INSTANCE_ROOT"
# Database backup lifecycle belongs to Paperclip's backup configuration. This
# pressure cleanup must never delete preserved/manual archives as a side effect.
cleanup_old_files "paperclip-run-logs" "$INSTANCE_ROOT/data/run-logs" "$RUN_LOG_RETENTION_DAYS" '*.ndjson'
cleanup_tmp_targets
log "DONE: disk pressure cleanup mode=$MODE"
