#!/usr/bin/env bash
# Re-apply local patches to third-party plugins installed under ~/.paperclip/plugins/.
# Runs on every paperclip service start (ExecStartPre) and inside self-update.sh
# so the patches survive plugin re-installs / upgrades from the UI.
#
# Idempotent: checks for marker strings before touching each file.

set -u

LOG_DIR="/home/ubuntu/.paperclip/instances/default/logs"
LOG_FILE="$LOG_DIR/plugin-patches.log"
mkdir -p "$LOG_DIR"

log() {
  echo "[$(date '+%Y-%m-%d %H:%M:%S')] $*" | tee -a "$LOG_FILE"
}

patch_chat_plugin() {
  local f="/home/ubuntu/.paperclip/plugins/node_modules/@lucitra/paperclip-plugin-chat/dist/worker.js"
  if [ ! -f "$f" ]; then
    log "SKIP chat plugin: $f not found"
    return 0
  fi

  local changed=0

  if grep -q '"--max-turns", "10"' "$f"; then
    sed -i 's/"--max-turns", "10"/"--max-turns", "40"/' "$f"
    log "chat: bumped --max-turns 10 -> 40"
    changed=1
  fi

  if grep -q 'Chat timed out after 5 minutes' "$f"; then
    sed -i 's/Chat timed out after 5 minutes/Chat timed out after 30 minutes/' "$f"
    sed -i 's/}, 300_000);/}, 1_800_000);/' "$f"
    log "chat: bumped timeout 5min -> 30min"
    changed=1
  fi

  if [ $changed -eq 0 ]; then
    log "chat: already patched"
  fi
}

log "apply-plugin-patches start"
patch_chat_plugin
log "apply-plugin-patches done"
exit 0
