#!/usr/bin/env python3
"""Fail-closed cleanup for high-confidence disposable directories under /tmp.

The scanner inventories every top-level entry but only makes explicit producer
rules eligible. Apply uses the exact in-memory manifest produced by the scan,
revalidates the complete tree fingerprint, and refuses unknown or live paths.
"""

from __future__ import annotations

import argparse
import fnmatch
import hashlib
import json
import os
import fcntl
import shutil
import stat
import sys
import time
from dataclasses import asdict, dataclass
from pathlib import Path
from typing import Callable, Iterable

DEFAULT_RULES: tuple[tuple[str, str, int], ...] = (
    ("od-vitest", "od-daemon-vitest-*", 3),
    ("od-test", "od-*-test-*", 3),
    ("jest-cache", "jest_rs", 3),
    ("jest-cache", "jest_*", 3),
)

LEASE_NAMES = {".cleanup-lease", ".paperclip-tmp-lease"}


@dataclass(frozen=True)
class TreeSnapshot:
    bytes_allocated: int
    newest_mtime_ns: int
    fingerprint: str
    root_dev: int
    root_ino: int
    root_uid: int


@dataclass(frozen=True)
class InventoryRecord:
    path: str
    name: str
    rule: str | None
    retention_days: int | None
    bytes_allocated: int
    newest_mtime_ns: int
    eligible: bool
    reason: str
    root_dev: int
    root_ino: int
    root_uid: int
    fingerprint: str


@dataclass(frozen=True)
class ApplyResult:
    path: str
    deleted: bool
    bytes_allocated: int
    reason: str


def emit(payload: dict) -> None:
    print(json.dumps(payload, sort_keys=True, separators=(",", ":")), flush=True)


def match_rule(name: str, rules: Iterable[tuple[str, str, int]]) -> tuple[str, int] | None:
    for rule_name, pattern, retention_days in rules:
        if fnmatch.fnmatchcase(name, pattern):
            return rule_name, retention_days
    return None


def _inside(path: Path, root: Path) -> bool:
    try:
        path.relative_to(root)
        return True
    except ValueError:
        return False


def _host_process(process_dir: Path) -> bool:
    """Exclude container PIDs whose numeric UID collides with the host user."""

    try:
        cgroup = (process_dir / "cgroup").read_text(errors="replace")
    except (FileNotFoundError, ProcessLookupError):
        return False
    except PermissionError:
        return False
    return not any(marker in cgroup for marker in ("/docker-", "/kubepods/", "/libpod-"))


def live_references_for_uid(uid: int) -> tuple[list[Path], bool]:
    """Return visible host-process cwd/exe/fd references owned by uid.

    Yama and procfs can legitimately hide peer SSH/system-service processes even
    for the same numeric UID. That does not make every candidate unsafe: the
    scanner also checks explicit leases, special files and newest descendant.
    Visible references still retain a matching candidate fail-closed.
    """

    references: list[Path] = []
    proc = Path("/proc")
    for process_dir in proc.iterdir():
        if not process_dir.name.isdigit() or not _host_process(process_dir):
            continue
        try:
            status = (process_dir / "status").read_text(errors="replace")
        except (FileNotFoundError, ProcessLookupError, PermissionError):
            continue
        owner_uid: int | None = None
        for line in status.splitlines():
            if line.startswith("Uid:"):
                owner_uid = int(line.split()[1])
                break
        if owner_uid != uid:
            continue

        for link in (process_dir / "cwd", process_dir / "exe"):
            try:
                target = os.readlink(link)
            except (FileNotFoundError, ProcessLookupError, PermissionError):
                continue
            if target.startswith("/"):
                references.append(Path(os.path.realpath(target.removesuffix(" (deleted)"))))

        fd_dir = process_dir / "fd"
        try:
            fds = list(fd_dir.iterdir())
        except (FileNotFoundError, ProcessLookupError, PermissionError):
            continue
        for fd in fds:
            try:
                target = os.readlink(fd)
            except (FileNotFoundError, ProcessLookupError, PermissionError):
                continue
            if target.startswith("/"):
                target = target.removesuffix(" (deleted)")
                references.append(Path(os.path.realpath(target)))
    return references, True


def snapshot_tree(root: Path, expected_uid: int) -> tuple[TreeSnapshot | None, str | None]:
    """Build a tree token through directory FDs without following symlinks."""

    directory_flags = os.O_RDONLY | os.O_DIRECTORY | os.O_CLOEXEC | os.O_NOFOLLOW
    open_fds: set[int] = set()
    try:
        root_fd = os.open(root, directory_flags)
        open_fds.add(root_fd)
        root_stat = os.fstat(root_fd)
    except FileNotFoundError:
        return None, "missing"
    except PermissionError:
        return None, "permission-denied"
    except OSError:
        return None, "not-directory"

    try:
        if not stat.S_ISDIR(root_stat.st_mode):
            return None, "not-directory"
        if root_stat.st_uid != expected_uid:
            return None, "owner-mismatch"

        digest = hashlib.sha256()
        total_blocks = 0
        newest_mtime_ns = root_stat.st_mtime_ns
        root_dev = root_stat.st_dev
        seen_inodes: set[tuple[int, int]] = set()
        stack: list[tuple[int, str, os.stat_result]] = [(root_fd, ".", root_stat)]

        while stack:
            directory_fd, relative, directory_stat = stack.pop()
            inode_key = (directory_stat.st_dev, directory_stat.st_ino)
            if inode_key in seen_inodes:
                return None, "duplicate-inode"
            seen_inodes.add(inode_key)
            digest.update(
                (
                    f"{relative}\0{directory_stat.st_dev}\0{directory_stat.st_ino}\0"
                    f"{directory_stat.st_mode}\0{directory_stat.st_uid}\0{directory_stat.st_size}\0"
                    f"{directory_stat.st_mtime_ns}\0{directory_stat.st_nlink}\n"
                ).encode()
            )
            total_blocks += directory_stat.st_blocks * 512
            newest_mtime_ns = max(newest_mtime_ns, directory_stat.st_mtime_ns)

            try:
                names = sorted(os.listdir(directory_fd))
            except FileNotFoundError:
                return None, "tree-changed"
            except PermissionError:
                return None, "permission-denied"

            for name in names:
                if name in LEASE_NAMES:
                    return None, "active-lease"
                try:
                    entry_stat = os.stat(name, dir_fd=directory_fd, follow_symlinks=False)
                except FileNotFoundError:
                    return None, "tree-changed"
                except PermissionError:
                    return None, "permission-denied"

                if entry_stat.st_dev != root_dev:
                    return None, "cross-device"
                if entry_stat.st_uid != expected_uid:
                    return None, "owner-mismatch"
                if stat.S_ISDIR(entry_stat.st_mode) and not (entry_stat.st_mode & stat.S_IWUSR):
                    return None, "owner-directory-not-writable"
                if stat.S_ISLNK(entry_stat.st_mode):
                    return None, "contains-symlink"
                if not (stat.S_ISDIR(entry_stat.st_mode) or stat.S_ISREG(entry_stat.st_mode)):
                    return None, "contains-special-file"
                if stat.S_ISREG(entry_stat.st_mode) and entry_stat.st_nlink > 1:
                    return None, "contains-hardlink"

                child_relative = name if relative == "." else f"{relative}/{name}"
                if stat.S_ISDIR(entry_stat.st_mode):
                    try:
                        child_fd = os.open(name, directory_flags, dir_fd=directory_fd)
                        open_fds.add(child_fd)
                        opened_stat = os.fstat(child_fd)
                    except FileNotFoundError:
                        return None, "tree-changed"
                    except PermissionError:
                        return None, "permission-denied"
                    except OSError:
                        return None, "tree-changed"
                    if (
                        opened_stat.st_dev != entry_stat.st_dev
                        or opened_stat.st_ino != entry_stat.st_ino
                        or opened_stat.st_uid != entry_stat.st_uid
                        or not stat.S_ISDIR(opened_stat.st_mode)
                    ):
                        return None, "tree-changed"
                    stack.append((child_fd, child_relative, opened_stat))
                else:
                    inode_key = (entry_stat.st_dev, entry_stat.st_ino)
                    if inode_key in seen_inodes:
                        return None, "duplicate-inode"
                    seen_inodes.add(inode_key)
                    digest.update(
                        (
                            f"{child_relative}\0{entry_stat.st_dev}\0{entry_stat.st_ino}\0"
                            f"{entry_stat.st_mode}\0{entry_stat.st_uid}\0{entry_stat.st_size}\0"
                            f"{entry_stat.st_mtime_ns}\0{entry_stat.st_nlink}\n"
                        ).encode()
                    )
                    total_blocks += entry_stat.st_blocks * 512
                    newest_mtime_ns = max(newest_mtime_ns, entry_stat.st_mtime_ns)

        return (
            TreeSnapshot(
                bytes_allocated=total_blocks,
                newest_mtime_ns=newest_mtime_ns,
                fingerprint=digest.hexdigest(),
                root_dev=root_stat.st_dev,
                root_ino=root_stat.st_ino,
                root_uid=root_stat.st_uid,
            ),
            None,
        )
    finally:
        for fd in open_fds:
            try:
                os.close(fd)
            except OSError:
                pass


def inventory(
    tmp_root: Path,
    *,
    now_ns: int,
    uid: int,
    rules: Iterable[tuple[str, str, int]] = DEFAULT_RULES,
    live_references: Iterable[Path] = (),
    liveness_complete: bool = True,
) -> list[InventoryRecord]:
    records: list[InventoryRecord] = []
    references = tuple(live_references)

    try:
        entries = sorted(tmp_root.iterdir(), key=lambda item: item.name)
    except (FileNotFoundError, PermissionError) as exc:
        raise RuntimeError(f"cannot scan tmp root {tmp_root}: {exc}") from exc

    for entry in entries:
        rule_match = match_rule(entry.name, rules)
        try:
            entry_stat = entry.lstat()
        except (FileNotFoundError, PermissionError):
            continue

        if rule_match is None:
            records.append(
                InventoryRecord(
                    path=str(entry),
                    name=entry.name,
                    rule=None,
                    retention_days=None,
                    bytes_allocated=entry_stat.st_blocks * 512,
                    newest_mtime_ns=entry_stat.st_mtime_ns,
                    eligible=False,
                    reason="unknown-rule",
                    root_dev=entry_stat.st_dev,
                    root_ino=entry_stat.st_ino,
                    root_uid=entry_stat.st_uid,
                    fingerprint="",
                )
            )
            continue

        rule_name, retention_days = rule_match
        snapshot, unsafe_reason = snapshot_tree(entry, uid)
        if snapshot is None:
            records.append(
                InventoryRecord(
                    path=str(entry),
                    name=entry.name,
                    rule=rule_name,
                    retention_days=retention_days,
                    bytes_allocated=entry_stat.st_blocks * 512,
                    newest_mtime_ns=entry_stat.st_mtime_ns,
                    eligible=False,
                    reason=unsafe_reason or "unsafe-tree",
                    root_dev=entry_stat.st_dev,
                    root_ino=entry_stat.st_ino,
                    root_uid=entry_stat.st_uid,
                    fingerprint="",
                )
            )
            continue

        reason = "eligible"
        eligible = True
        age_ns = now_ns - snapshot.newest_mtime_ns
        if age_ns < retention_days * 86_400 * 1_000_000_000:
            eligible = False
            reason = "too-new"
        elif not liveness_complete:
            eligible = False
            reason = "liveness-incomplete"
        elif any(_inside(reference, entry) for reference in references):
            eligible = False
            reason = "live-reference"

        records.append(
            InventoryRecord(
                path=str(entry),
                name=entry.name,
                rule=rule_name,
                retention_days=retention_days,
                bytes_allocated=snapshot.bytes_allocated,
                newest_mtime_ns=snapshot.newest_mtime_ns,
                eligible=eligible,
                reason=reason,
                root_dev=snapshot.root_dev,
                root_ino=snapshot.root_ino,
                root_uid=snapshot.root_uid,
                fingerprint=snapshot.fingerprint,
            )
        )
    return records


def select_manifest(
    records: Iterable[InventoryRecord], *, max_count: int, max_bytes: int
) -> tuple[InventoryRecord, ...]:
    eligible = sorted(
        (record for record in records if record.eligible),
        key=lambda record: (record.newest_mtime_ns, record.path),
    )
    total_bytes = sum(record.bytes_allocated for record in eligible)
    # Caps are admission guards, not a batch selector: exceeding either means
    # delete nothing rather than silently prioritizing an arbitrary subset.
    if len(eligible) > max_count or total_bytes > max_bytes:
        return ()
    return tuple(eligible)


def apply_manifest(
    manifest: Iterable[InventoryRecord],
    *,
    uid: int,
    live_references: Iterable[Path],
    liveness_complete: bool,
    before_delete: Callable[[InventoryRecord], None] | None = None,
) -> list[ApplyResult]:
    references = tuple(live_references)
    results: list[ApplyResult] = []
    for record in manifest:
        if before_delete is not None:
            before_delete(record)

        path = Path(record.path)
        if not liveness_complete:
            results.append(ApplyResult(record.path, False, 0, "liveness-incomplete"))
            continue
        if any(_inside(reference, path) for reference in references):
            results.append(ApplyResult(record.path, False, 0, "live-reference"))
            continue

        current, unsafe_reason = snapshot_tree(path, uid)
        if current is None:
            results.append(ApplyResult(record.path, False, 0, unsafe_reason or "unsafe-tree"))
            continue
        if (
            current.root_dev != record.root_dev
            or current.root_ino != record.root_ino
            or current.root_uid != record.root_uid
            or current.fingerprint != record.fingerprint
        ):
            results.append(ApplyResult(record.path, False, 0, "tree-changed"))
            continue

        quarantine = path.parent / f".paperclip-cleanup-{record.root_ino}"
        if quarantine.exists() or quarantine.is_symlink():
            results.append(ApplyResult(record.path, False, 0, "quarantine-exists"))
            continue
        try:
            # Atomic rename removes the producer-visible path before recursive
            # deletion and narrows the race after the final fingerprint check.
            path.rename(quarantine)
            quarantined_stat = quarantine.lstat()
            if (
                quarantined_stat.st_dev != record.root_dev
                or quarantined_stat.st_ino != record.root_ino
                or quarantined_stat.st_uid != record.root_uid
            ):
                raise RuntimeError("quarantine-inode-mismatch")
            shutil.rmtree(quarantine)
        except FileNotFoundError:
            results.append(ApplyResult(record.path, False, 0, "missing"))
        except Exception as exc:  # restore a failed quarantine when possible
            if quarantine.exists() and not path.exists():
                try:
                    quarantine.rename(path)
                except OSError:
                    pass
            errno = getattr(exc, "errno", None)
            suffix = str(errno) if errno is not None else type(exc).__name__
            results.append(ApplyResult(record.path, False, 0, f"delete-failed:{suffix}"))
        else:
            results.append(ApplyResult(record.path, True, record.bytes_allocated, "deleted"))
    return results


def parse_args(argv: list[str]) -> argparse.Namespace:
    parser = argparse.ArgumentParser(description=__doc__)
    mode = parser.add_mutually_exclusive_group(required=True)
    mode.add_argument("--dry-run", dest="mode", action="store_const", const="--dry-run")
    mode.add_argument("--apply", dest="mode", action="store_const", const="--apply")
    parser.add_argument("--root", default=os.environ.get("PAPERCLIP_TMP_ROOT", "/tmp"))
    parser.add_argument(
        "--lock-file",
        default=os.environ.get("PAPERCLIP_TMP_LOCK_FILE", "/tmp/paperclip-tmp-cleanup.lock"),
    )
    parser.add_argument(
        "--retention-days",
        type=int,
        default=int(os.environ.get("PAPERCLIP_TMP_TEST_RETENTION_DAYS", "3")),
    )
    parser.add_argument(
        "--max-count",
        type=int,
        default=int(os.environ.get("PAPERCLIP_TMP_MAX_DELETE_COUNT", "500")),
    )
    parser.add_argument(
        "--max-bytes",
        type=int,
        default=int(os.environ.get("PAPERCLIP_TMP_MAX_DELETE_BYTES", str(1024**3))),
    )
    return parser.parse_args(argv)


def main(argv: list[str] | None = None) -> int:
    args = parse_args(argv or sys.argv[1:])
    if args.retention_days < 1 or args.max_count < 1 or args.max_bytes < 1:
        raise SystemExit("retention and caps must be positive")

    lock_path = Path(args.lock_file)
    lock_path.parent.mkdir(parents=True, exist_ok=True)
    with lock_path.open("a+") as lock_handle:
        try:
            fcntl.flock(lock_handle, fcntl.LOCK_EX | fcntl.LOCK_NB)
        except BlockingIOError:
            emit({"type": "summary", "mode": args.mode, "root": args.root, "error": "already-running"})
            return 1

        rules = tuple((name, pattern, args.retention_days) for name, pattern, _ in DEFAULT_RULES)
        uid = os.getuid()
        references, liveness_complete = live_references_for_uid(uid)
        records = inventory(
            Path(args.root),
            now_ns=time.time_ns(),
            uid=uid,
            rules=rules,
            live_references=references,
            liveness_complete=liveness_complete,
        )
        manifest = select_manifest(records, max_count=args.max_count, max_bytes=args.max_bytes)

        for record in records:
            # Keep output bounded on shared hosts: unknown entries are counted in
            # the summary, while explicit-rule decisions remain inspectable.
            if record.rule is not None:
                emit({"type": "inventory", **asdict(record)})

        results: list[ApplyResult] = []
        if args.mode == "--apply":
            # Refresh process references immediately before applying the exact scan manifest.
            references, liveness_complete = live_references_for_uid(uid)
            results = apply_manifest(
                manifest,
                uid=uid,
                live_references=references,
                liveness_complete=liveness_complete,
            )
            for result in results:
                emit({"type": "apply", **asdict(result)})

        deleted_bytes = sum(result.bytes_allocated for result in results if result.deleted)
        emit(
            {
                "type": "summary",
                "mode": args.mode,
                "root": str(Path(args.root)),
                "inventory_count": len(records),
                "eligible_count": sum(record.eligible for record in records),
                "manifest_count": len(manifest),
                "manifest_bytes": sum(record.bytes_allocated for record in manifest),
                "caps_refused": sum(record.eligible for record in records) > args.max_count
                or sum(record.bytes_allocated for record in records if record.eligible) > args.max_bytes,
                "deleted_count": sum(result.deleted for result in results),
                "deleted_bytes": deleted_bytes,
                "unknown_count": sum(record.reason == "unknown-rule" for record in records),
                "retained_count": sum(not record.eligible for record in records),
                "liveness_complete": liveness_complete,
                "max_count": args.max_count,
                "max_bytes": args.max_bytes,
            }
        )
        return 0


if __name__ == "__main__":
    raise SystemExit(main())
