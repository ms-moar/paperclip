#!/usr/bin/env python3
from __future__ import annotations

import importlib.util
import os
import socket
import sys
import tempfile
import time
import unittest
from pathlib import Path

MODULE_PATH = Path(__file__).resolve().parents[1] / "tmp_cleanup.py"
SPEC = importlib.util.spec_from_file_location("tmp_cleanup", MODULE_PATH)
assert SPEC and SPEC.loader
cleanup = importlib.util.module_from_spec(SPEC)
sys.modules[SPEC.name] = cleanup
SPEC.loader.exec_module(cleanup)

DAY_NS = 86_400 * 1_000_000_000


def age_tree(path: Path, days: int) -> None:
    timestamp = time.time() - days * 86_400
    for current_root, dirs, files in os.walk(path, topdown=False):
        for name in files:
            os.utime(Path(current_root) / name, (timestamp, timestamp), follow_symlinks=False)
        for name in dirs:
            os.utime(Path(current_root) / name, (timestamp, timestamp), follow_symlinks=False)
    os.utime(path, (timestamp, timestamp), follow_symlinks=False)


class TmpCleanupTests(unittest.TestCase):
    def setUp(self) -> None:
        self.temp = tempfile.TemporaryDirectory()
        self.root = Path(self.temp.name)
        self.uid = os.getuid()

    def tearDown(self) -> None:
        self.temp.cleanup()

    def scan(self, *, max_count: int = 100, max_bytes: int = 1024**3):
        records = cleanup.inventory(
            self.root,
            now_ns=time.time_ns(),
            uid=self.uid,
            live_references=(),
            liveness_complete=True,
        )
        manifest = cleanup.select_manifest(records, max_count=max_count, max_bytes=max_bytes)
        return records, manifest

    def make_old(self, name: str, content: bytes = b"old") -> Path:
        path = self.root / name
        path.mkdir()
        (path / "payload").write_bytes(content)
        age_tree(path, 5)
        return path

    def test_unknown_path_is_retained(self) -> None:
        path = self.make_old("task-clone-unknown")
        records, manifest = self.scan()
        record = next(row for row in records if row.path == str(path))
        self.assertFalse(record.eligible)
        self.assertEqual(record.reason, "unknown-rule")
        self.assertEqual(manifest, ())

    def test_newest_descendant_controls_retention(self) -> None:
        path = self.make_old("od-daemon-vitest-old")
        recent = path / "recent"
        recent.write_text("active")
        records, manifest = self.scan()
        record = next(row for row in records if row.path == str(path))
        self.assertFalse(record.eligible)
        self.assertEqual(record.reason, "too-new")
        self.assertEqual(manifest, ())

    def test_symlink_socket_and_hardlink_are_retained(self) -> None:
        symlink_dir = self.make_old("od-daemon-vitest-symlink")
        (symlink_dir / "link").symlink_to("payload")
        age_tree(symlink_dir, 5)

        socket_dir = self.make_old("od-daemon-vitest-socket")
        sock = socket.socket(socket.AF_UNIX)
        sock.bind(str(socket_dir / "live.sock"))
        age_tree(socket_dir, 5)

        hardlink_dir = self.make_old("od-daemon-vitest-hardlink")
        os.link(hardlink_dir / "payload", hardlink_dir / "payload-2")
        age_tree(hardlink_dir, 5)
        try:
            records, manifest = self.scan()
        finally:
            sock.close()

        reasons = {Path(row.path).name: row.reason for row in records}
        self.assertEqual(reasons[symlink_dir.name], "contains-symlink")
        self.assertEqual(reasons[socket_dir.name], "contains-special-file")
        self.assertEqual(reasons[hardlink_dir.name], "contains-hardlink")
        self.assertEqual(manifest, ())

    def test_live_reference_and_incomplete_liveness_are_retained(self) -> None:
        path = self.make_old("od-daemon-vitest-live")
        records = cleanup.inventory(
            self.root,
            now_ns=time.time_ns(),
            uid=self.uid,
            live_references=(path / "payload",),
            liveness_complete=True,
        )
        self.assertEqual(records[0].reason, "live-reference")

        records = cleanup.inventory(
            self.root,
            now_ns=time.time_ns(),
            uid=self.uid,
            live_references=(),
            liveness_complete=False,
        )
        self.assertEqual(records[0].reason, "liveness-incomplete")

    def test_container_cgroup_is_not_treated_as_host_process(self) -> None:
        proc = self.root / "123"
        proc.mkdir()
        (proc / "cgroup").write_text("0::/system.slice/docker-deadbeef.scope/uid_1000/pid_1\n")
        self.assertFalse(cleanup._host_process(proc))
        (proc / "cgroup").write_text("0::/system.slice/ssh.service\n")
        self.assertTrue(cleanup._host_process(proc))

    def test_read_only_descendant_directory_is_retained_without_chmod(self) -> None:
        path = self.make_old("od-daemon-vitest-readonly")
        readonly = path / "readonly"
        readonly.mkdir()
        readonly.chmod(0o500)
        age_tree(path, 5)
        try:
            records, manifest = self.scan()
            record = next(row for row in records if row.path == str(path))
            self.assertFalse(record.eligible)
            self.assertEqual(record.reason, "owner-directory-not-writable")
            self.assertEqual(manifest, ())
            self.assertEqual(readonly.stat().st_mode & 0o777, 0o500)
        finally:
            readonly.chmod(0o700)

    def test_dry_run_inventory_does_not_mutate(self) -> None:
        path = self.make_old("od-daemon-vitest-dry")
        before = sorted((item.relative_to(self.root).as_posix(), item.lstat().st_ino) for item in self.root.rglob("*"))
        records, manifest = self.scan()
        after = sorted((item.relative_to(self.root).as_posix(), item.lstat().st_ino) for item in self.root.rglob("*"))
        self.assertEqual(before, after)
        self.assertTrue(records[0].eligible)
        self.assertEqual(len(manifest), 1)
        self.assertTrue(path.exists())

    def test_apply_deletes_exact_manifest_and_is_idempotent(self) -> None:
        selected = self.make_old("od-daemon-vitest-delete")
        unknown = self.make_old("task-clone-retain")
        _, manifest = self.scan()
        results = cleanup.apply_manifest(
            manifest,
            uid=self.uid,
            live_references=(),
            liveness_complete=True,
        )
        self.assertEqual([(row.deleted, row.reason) for row in results], [(True, "deleted")])
        self.assertFalse(selected.exists())
        self.assertTrue(unknown.exists())

        second = cleanup.apply_manifest(
            manifest,
            uid=self.uid,
            live_references=(),
            liveness_complete=True,
        )
        self.assertEqual(second[0].reason, "missing")

    def test_tree_change_between_scan_and_apply_is_refused(self) -> None:
        path = self.make_old("od-daemon-vitest-race")
        _, manifest = self.scan()

        def mutate(_record) -> None:
            (path / "new").write_text("changed")

        results = cleanup.apply_manifest(
            manifest,
            uid=self.uid,
            live_references=(),
            liveness_complete=True,
            before_delete=mutate,
        )
        self.assertFalse(results[0].deleted)
        self.assertEqual(results[0].reason, "tree-changed")
        self.assertTrue(path.exists())

    def test_count_and_byte_caps_are_fail_closed(self) -> None:
        first = self.make_old("od-daemon-vitest-a", b"a" * 8192)
        second = self.make_old("od-daemon-vitest-b", b"b" * 8192)
        records, manifest = self.scan(max_count=1, max_bytes=1024**3)
        self.assertEqual(manifest, ())

        smallest = min(row.bytes_allocated for row in records if row.eligible)
        manifest = cleanup.select_manifest(records, max_count=100, max_bytes=smallest - 1)
        self.assertEqual(manifest, ())
        self.assertTrue(first.exists())
        self.assertTrue(second.exists())


if __name__ == "__main__":
    unittest.main(verbosity=2)
