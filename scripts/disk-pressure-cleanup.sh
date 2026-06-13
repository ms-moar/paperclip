#!/usr/bin/env bash
set -euo pipefail

INSTANCE_ROOT="${PAPERCLIP_INSTANCE_ROOT:-/home/ubuntu/.paperclip/instances/default}"
LOG_FILE="${PAPERCLIP_DISK_CLEANUP_LOG_FILE:-$INSTANCE_ROOT/logs/disk-pressure-cleanup.log}"
BACKUP_RETENTION_DAYS="${PAPERCLIP_BACKUP_RETENTION_DAYS:-3}"
RUN_LOG_RETENTION_DAYS="${PAPERCLIP_RUN_LOG_RETENTION_DAYS:-7}"
TMP_RETENTION_DAYS="${PAPERCLIP_TMP_RETENTION_DAYS:-2}"
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
    rm -f -- "$path"
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
  local list_file
  list_file=$(mktemp)
  find /tmp -maxdepth 1 -mindepth 1 \( \
    -name 'win-bootstrap' -o \
    -name 'nutra-dynamic-deploy' -o \
    -name 'nutra-placeholder-deploy' -o \
    -name 'moar-ads-pdroute-clone-*' -o \
    -name 'moar-ads-domain-manager-deploy' -o \
    -name 'mt-admin-clean-proton-transport' -o \
    -name 'jest_rs' \
  \) -mtime "+$TMP_RETENTION_DAYS" -print0 2>/dev/null |
    while IFS= read -r -d '' path; do
      size=$(du -sb -- "$path" 2>/dev/null | awk '{print $1}' || printf '0')
      printf '%s %s\n' "$size" "$path"
    done | sort -n > "$list_file"

  local count bytes
  read -r count bytes < <(sum_files < "$list_file")
  log "$MODE: tmp candidates count=$count bytes=$(bytes_to_human "$bytes") older_than_days=$TMP_RETENTION_DAYS"
  if [[ "$count" -gt 0 ]]; then
    cat "$list_file" | while IFS= read -r line; do log "$MODE: tmp candidate $line"; done
    if [[ "$MODE" == "--apply" ]]; then
      awk '{ $1=""; sub(/^ /, ""); print }' "$list_file" | while IFS= read -r path; do
        [[ -n "$path" ]] || continue
        case "$path" in
          /tmp/win-bootstrap|/tmp/nutra-dynamic-deploy|/tmp/nutra-placeholder-deploy|/tmp/moar-ads-pdroute-clone-*|/tmp/moar-ads-domain-manager-deploy|/tmp/mt-admin-clean-proton-transport|/tmp/jest_rs)
            rm -rf --one-file-system -- "$path"
            ;;
          *)
            log "SKIP: refused unexpected tmp path $path"
            ;;
        esac
      done
    fi
  fi
  rm -f "$list_file"
}

log "START: disk pressure cleanup mode=$MODE instance_root=$INSTANCE_ROOT"
cleanup_old_files "paperclip-backups" "$INSTANCE_ROOT/data/backups" "$BACKUP_RETENTION_DAYS" 'paperclip-*.sql.gz'
cleanup_old_files "paperclip-run-logs" "$INSTANCE_ROOT/data/run-logs" "$RUN_LOG_RETENTION_DAYS" '*.ndjson'
cleanup_tmp_targets
log "DONE: disk pressure cleanup mode=$MODE"
