# Branch consolidation archive - 0606

This checkout was consolidated back to the local `custom` branch after preserving all local branch, stash, and WIP state.

Archive bundle and patches:

- `/home/ubuntu/backups/paperclip-consolidation-20260606-203922/all-refs-after-stash.bundle`
- `/home/ubuntu/backups/paperclip-consolidation-20260606-203922/`

The merge commit uses the `ours` strategy intentionally: branch histories are reachable from `custom`, while the live tree stays on the custom production line. Recover individual work with `git log --parents` / `git cherry-pick` from the archived parent history or with `git clone all-refs-after-stash.bundle`.
