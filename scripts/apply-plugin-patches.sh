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

# Inject a visibilitychange / focus listener into the chat plugin UI bundle so
# that returning to the tab refreshes messages from the server. SSE events
# emitted while the tab was hidden are dropped by PluginStreamBus (no buffer),
# and EventSource does not always reconnect after Chrome's background-tab
# throttling. Pulling from the API on focus closes the gap without F5.
#
# Marker `__moarVisRefresh` makes the patch idempotent across self-updates.
# Mirrored upstream at https://github.com/webprismdevin/paperclip-plugin-chat/pull/6
patch_chat_ui_visibility() {
  local f="/home/ubuntu/.paperclip/plugins/node_modules/@lucitra/paperclip-plugin-chat/dist/ui/index.js"
  if [ ! -f "$f" ]; then
    log "SKIP chat-ui visibility: $f not found"
    return 0
  fi
  if grep -q '__moarVisRefresh' "$f"; then
    log "chat-ui visibility: already patched"
    return 0
  fi
  python3 - "$f" <<'PY' || { log "chat-ui visibility: patch FAILED"; return 1; }
import sys, pathlib
p = pathlib.Path(sys.argv[1])
src = p.read_text()
needle = "  }, [selectedThreadId]);\n  useEffect2(() => {\n    setSlashMenuIndex(0);"
inject = (
    "  }, [selectedThreadId]);\n"
    "  useEffect2(() => {\n"
    "    const __moarVisRefresh = () => {\n"
    "      if (document.visibilityState === \"visible\") {\n"
    "        refreshMessages();\n"
    "        refreshThreads();\n"
    "      }\n"
    "    };\n"
    "    document.addEventListener(\"visibilitychange\", __moarVisRefresh);\n"
    "    window.addEventListener(\"focus\", __moarVisRefresh);\n"
    "    return () => {\n"
    "      document.removeEventListener(\"visibilitychange\", __moarVisRefresh);\n"
    "      window.removeEventListener(\"focus\", __moarVisRefresh);\n"
    "    };\n"
    "  }, [refreshMessages, refreshThreads]);\n"
    "  useEffect2(() => {\n"
    "    setSlashMenuIndex(0);"
)
if needle not in src:
    sys.exit("needle not found — bundle layout changed")
p.write_text(src.replace(needle, inject, 1))
PY
  log "chat-ui visibility: injected visibilitychange/focus refresh"
}

log "apply-plugin-patches start"
patch_chat_plugin
patch_chat_ui_visibility
log "apply-plugin-patches done"
exit 0
