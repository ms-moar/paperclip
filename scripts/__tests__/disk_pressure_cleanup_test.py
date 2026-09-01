#!/usr/bin/env python3
from __future__ import annotations

import hashlib
import os
import subprocess
import tempfile
import time
import unittest
from pathlib import Path

SCRIPT = Path(__file__).resolve().parents[1] / "disk-pressure-cleanup.sh"


class DiskPressureCleanupTests(unittest.TestCase):
    def setUp(self) -> None:
        # The production script requires an executable tmp cleanup helper.
        # /tmp is mounted noexec on this host, so keep the entire sandbox under
        # the repository parent's executable filesystem.
        self.temp = tempfile.TemporaryDirectory(dir=Path(__file__).resolve().parents[2])
        self.root = Path(self.temp.name)
        self.backup = self.root / "data/backups/preserved.sql.gz"
        self.run_log = self.root / "data/run-logs/run/old.ndjson"
        self.backup.parent.mkdir(parents=True)
        self.run_log.parent.mkdir(parents=True)
        self.backup.write_bytes(b"preserve-me")
        self.run_log.write_bytes(b"expire-me")
        old = time.time() - 10 * 86_400
        os.utime(self.backup, (old, old))
        os.utime(self.run_log, (old, old))

        self.tmp_calls = self.root / "tmp-cleanup-calls"
        self.tmp_helper = self.root / "tmp-cleanup"
        self.tmp_helper.write_text(
            "#!/usr/bin/env bash\n"
            "set -euo pipefail\n"
            f"printf '%s\\n' \"$1\" >> {self.tmp_calls!s}\n"
            "printf '%s\\n' '{\"type\":\"summary\",\"mode\":\"'$1'\",\"inventory_count\":0,\"eligible_count\":0,\"manifest_count\":0,\"manifest_bytes\":0,\"caps_refused\":false,\"deleted_count\":0,\"deleted_bytes\":0,\"unknown_count\":0,\"liveness_complete\":true}'\n",
            encoding="utf-8",
        )
        self.tmp_helper.chmod(0o700)

    def tearDown(self) -> None:
        self.temp.cleanup()

    def backup_snapshot(self) -> tuple[str, int, str, int]:
        stat = self.backup.stat()
        return (
            self.backup.name,
            stat.st_size,
            hashlib.sha256(self.backup.read_bytes()).hexdigest(),
            stat.st_ino,
        )

    def run_cleanup(self, mode: str) -> subprocess.CompletedProcess[str]:
        env = os.environ.copy()
        env.update(
            {
                "PAPERCLIP_INSTANCE_ROOT": str(self.root),
                "PAPERCLIP_DISK_CLEANUP_LOG_FILE": str(self.root / "cleanup.log"),
                "PAPERCLIP_RUN_LOG_RETENTION_DAYS": "1",
                "PAPERCLIP_TMP_CLEANUP_SCRIPT": str(self.tmp_helper),
            }
        )
        return subprocess.run(
            [str(SCRIPT), mode],
            env=env,
            check=True,
            capture_output=True,
            text=True,
        )

    def test_backup_archives_are_never_cleanup_candidates(self) -> None:
        before = self.backup_snapshot()
        dry_run = self.run_cleanup("--dry-run")
        self.assertEqual(self.backup_snapshot(), before)
        self.assertTrue(self.run_log.exists())
        self.assertNotIn("paperclip-backups", dry_run.stdout)
        self.assertIn("--dry-run: paperclip-run-logs candidates count=1", dry_run.stdout)

        apply = self.run_cleanup("--apply")
        self.assertEqual(self.backup_snapshot(), before)
        self.assertFalse(self.run_log.exists())
        self.assertNotIn("paperclip-backups", apply.stdout)
        self.assertIn("--apply: paperclip-run-logs candidates count=1", apply.stdout)
        self.assertEqual(self.tmp_calls.read_text(encoding="utf-8").splitlines(), ["--dry-run", "--apply"])


if __name__ == "__main__":
    unittest.main(verbosity=2)
