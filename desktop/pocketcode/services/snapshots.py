"""覆盖前快照（S3）：每次成功写入前把旧内容存入专用快照区。

设计（PRD §6.3"覆盖前必须提供可恢复的快照"）：
- 服务端无法区分"用户合并后保存"与"盲目覆盖"，因此**每次成功保存都先快照**
  旧字节，才能保证任何覆盖都可恢复；
- 快照按 项目/文件路径哈希 分目录，保留最近 KEEP_PER_PATH 份，自动清理更老的；
- 快照区在设置目录旁（snapshots/），不属于任何授权项目，手机不可见。
"""

from __future__ import annotations

import hashlib
import json
import time
from pathlib import Path

KEEP_PER_PATH = 20


def snapshot_previous(
    snapshots_root: Path,
    project_id: str,
    relative_path: str,
    previous_bytes: bytes,
) -> Path | None:
    """保存旧内容；返回快照文件路径。previous_bytes 为空时跳过（新文件无旧内容）。"""
    if not previous_bytes:
        return None
    path_dir = snapshots_root / project_id / _path_hash(relative_path)
    path_dir.mkdir(parents=True, exist_ok=True)
    stamp = time.strftime("%Y%m%dT%H%M%S", time.gmtime()) + f"-{time.time_ns() % 1_000_000:06d}"
    snap_file = path_dir / f"{stamp}.bin"
    meta_file = path_dir / f"{stamp}.json"
    snap_file.write_bytes(previous_bytes)
    meta_file.write_text(
        json.dumps(
            {
                "project_id": project_id,
                "path": relative_path,
                "saved_at": time.strftime("%Y-%m-%dT%H:%M:%SZ", time.gmtime()),
                "size": len(previous_bytes),
            },
            ensure_ascii=False,
        ),
        encoding="utf-8",
    )
    _prune(path_dir)
    return snap_file


def list_snapshots(snapshots_root: Path, project_id: str, relative_path: str) -> list[dict]:
    """列出某文件的快照（新→旧），供桌面端恢复界面使用。"""
    path_dir = snapshots_root / project_id / _path_hash(relative_path)
    if not path_dir.is_dir():
        return []
    snapshots = []
    for meta_path in sorted(path_dir.glob("*.json"), reverse=True):
        try:
            meta = json.loads(meta_path.read_text(encoding="utf-8"))
            bin_path = meta_path.with_suffix(".bin")
            if bin_path.exists():
                snapshots.append({**meta, "snapshot_file": str(bin_path)})
        except (OSError, ValueError):
            continue
    return snapshots


def _path_hash(relative_path: str) -> str:
    return hashlib.sha256(relative_path.encode("utf-8")).hexdigest()[:32]


def _prune(path_dir: Path) -> None:
    bins = sorted(path_dir.glob("*.bin"), reverse=True)
    for old in bins[KEEP_PER_PATH:]:
        old.unlink(missing_ok=True)
        old.with_suffix(".json").unlink(missing_ok=True)
