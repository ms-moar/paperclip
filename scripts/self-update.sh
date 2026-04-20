#!/usr/bin/env bash
set -euo pipefail

# Paperclip self-update script (custom branch + rebase strategy)
#
# Maintains local customizations on a 'custom' branch and rebases
# onto upstream origin/master on each run.
# Designed to run from a systemd timer or cron.

SCRIPT_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
PROJECT_ROOT="$(cd "$SCRIPT_DIR/.." && pwd)"
LOG_FILE="/home/ubuntu/.paperclip/instances/default/logs/self-update.log"
LOCK_FILE="/tmp/paperclip-self-update.lock"
UPSTREAM_BRANCH="master"
CUSTOM_BRANCH="custom"

mkdir -p "$(dirname "$LOG_FILE")"

log() {
  echo "[$(date '+%Y-%m-%d %H:%M:%S')] $*" | tee -a "$LOG_FILE"
}

cleanup() {
  rm -f "$LOCK_FILE"
}
trap cleanup EXIT

# Prevent concurrent runs
if [ -f "$LOCK_FILE" ]; then
  pid=$(cat "$LOCK_FILE" 2>/dev/null || true)
  if [ -n "$pid" ] && kill -0 "$pid" 2>/dev/null; then
    log "SKIP: Another update is running (PID $pid)"
    exit 0
  fi
  log "WARN: Stale lock file found, removing"
  rm -f "$LOCK_FILE"
fi
echo $$ > "$LOCK_FILE"

cd "$PROJECT_ROOT"

log "Starting self-update check"

# Ensure we're on the custom branch
current_branch=$(git branch --show-current)
if [ "$current_branch" != "$CUSTOM_BRANCH" ]; then
  log "SKIP: On branch '$current_branch', expected '$CUSTOM_BRANCH'"
  exit 0
fi

# Check for uncommitted changes
if ! git diff --quiet || ! git diff --cached --quiet; then
  log "SKIP: Uncommitted changes detected on $CUSTOM_BRANCH"
  exit 0
fi

# Fetch latest upstream
git fetch origin "$UPSTREAM_BRANCH" --quiet 2>&1 | tee -a "$LOG_FILE"

# Find the rebase point: where our custom commits diverge from upstream
# Our custom commits are on top of some upstream commit
UPSTREAM_HEAD=$(git rev-parse "origin/$UPSTREAM_BRANCH")
MERGE_BASE=$(git merge-base HEAD "origin/$UPSTREAM_BRANCH")

if [ "$MERGE_BASE" = "$UPSTREAM_HEAD" ]; then
  log "OK: Already up to date with upstream ($UPSTREAM_HEAD)"
  exit 0
fi

CUSTOM_COMMITS=$(git rev-list "$MERGE_BASE..HEAD" --count)
UPSTREAM_NEW=$(git rev-list "$MERGE_BASE..$UPSTREAM_HEAD" --count)

log "UPDATE: $UPSTREAM_NEW new upstream commits, $CUSTOM_COMMITS custom commits to rebase"
log "Upstream commits:"
git log --oneline "$MERGE_BASE..$UPSTREAM_HEAD" 2>&1 | tee -a "$LOG_FILE"

# Save pre-rebase state for rollback
PRE_REBASE_HEAD=$(git rev-parse HEAD)

# Ensure toolchain on PATH (pnpm lives in ~/.local/bin), allow devDependencies
export PATH="$HOME/.local/bin:$PATH"
unset NODE_ENV

# Backup database before update
log "Backing up database..."
pnpm db:backup 2>&1 | tee -a "$LOG_FILE" || log "WARN: DB backup failed, continuing anyway"

# Rebase custom commits onto updated upstream
# -X ours: on conflict prefer our version (e.g. custom .gitignore)
log "Rebasing $CUSTOM_COMMITS custom commits onto origin/$UPSTREAM_BRANCH..."
if git rebase -X ours "origin/$UPSTREAM_BRANCH" 2>&1 | tee -a "$LOG_FILE"; then
  log "Rebase succeeded"
else
  log "ERROR: Rebase failed — conflicts detected"
  git rebase --abort 2>&1 | tee -a "$LOG_FILE"
  log "Rebase aborted. Staying on pre-update version ($PRE_REBASE_HEAD)"
  log "Conflicting files need manual resolution"
  exit 1
fi

# Check if dependencies changed in upstream
DEPS_CHANGED=false
if git diff "$MERGE_BASE..$UPSTREAM_HEAD" --name-only | grep -qE '(pnpm-lock\.yaml|package\.json)'; then
  DEPS_CHANGED=true
fi

# Install dependencies if needed
if [ "$DEPS_CHANGED" = true ]; then
  log "Dependencies changed, running pnpm install..."
  pnpm install 2>&1 | tee -a "$LOG_FILE"
else
  log "No dependency changes, skipping install"
fi

# Rebuild
log "Building..."
pnpm -r build 2>&1 | tee -a "$LOG_FILE"

# Run migrations
log "Running migrations..."
pnpm db:migrate 2>&1 | tee -a "$LOG_FILE" || log "WARN: Migration step returned non-zero"

# Restart service
log "Restarting paperclip service..."
sudo systemctl restart paperclip 2>&1 | tee -a "$LOG_FILE"

# Wait for service to come up
sleep 5
if systemctl is-active --quiet paperclip; then
  NEW_COMMIT=$(git rev-parse --short HEAD)
  UPSTREAM_SHORT=$(git rev-parse --short "origin/$UPSTREAM_BRANCH")
  log "SUCCESS: Paperclip updated — custom branch rebased onto upstream $UPSTREAM_SHORT, HEAD=$NEW_COMMIT"
else
  log "ERROR: Service failed to start after update"
  log "Rolling back to pre-rebase state..."
  git reset --hard "$PRE_REBASE_HEAD" 2>&1 | tee -a "$LOG_FILE"
  pnpm -r build 2>&1 | tee -a "$LOG_FILE"
  sudo systemctl restart paperclip 2>&1 | tee -a "$LOG_FILE"
  log "Rolled back to $PRE_REBASE_HEAD. Check: sudo journalctl -u paperclip -n 50"
  exit 1
fi
