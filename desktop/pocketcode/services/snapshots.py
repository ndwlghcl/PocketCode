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
import os
import time
import uuid
from pathlib import Path

from pocketcode.security.path_guard import PathGuardError, resolve_under_root

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
    # 秒内用完整 9 位纳秒：旧实现取 ns%1e6（毫秒内循环），同一秒内相隔
    # 整毫秒的两次快速保存会生成同名快照互相覆盖。
    stamp = time.strftime("%Y%m%dT%H%M%S", time.gmtime()) + (
        f"-{time.time_ns() % 1_000_000_000:09d}"
    )
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


def list_snapshot_paths(snapshots_root: Path, project_id: str) -> list[dict]:
    """汇总某项目有快照的文件（相对路径、快照数、最近快照时间），新→旧。

    桌面端「历史版本」区块的第一级列表：先选文件，再列该文件的快照。
    """
    project_dir = snapshots_root / project_id
    if not project_dir.is_dir():
        return []
    by_path: dict[str, dict] = {}
    for meta_path in project_dir.rglob("*.json"):
        try:
            meta = json.loads(meta_path.read_text(encoding="utf-8"))
        except (OSError, ValueError):
            continue
        if not meta_path.with_suffix(".bin").exists():
            continue
        relative = str(meta.get("path", ""))
        if not relative:
            continue
        entry = by_path.setdefault(
            relative, {"path": relative, "count": 0, "latest": ""}
        )
        entry["count"] += 1
        saved_at = str(meta.get("saved_at", ""))
        if saved_at > entry["latest"]:
            entry["latest"] = saved_at
    return sorted(by_path.values(), key=lambda e: e["latest"], reverse=True)


def restore_snapshot(
    snapshots_root: Path,
    project_root: Path,
    project_id: str,
    relative_path: str,
    snapshot_file: Path,
) -> Path:
    """把一份快照写回项目原文件；返回写回的目标路径。

    恢复语义（PRD §6.3）：
    - 相对路径重新走 path_guard：快照元数据即使被篡改也不能变成越界写；
    - 写回前先把**当前**文件内容另存为新快照——恢复操作本身可再次回退；
    - 与保存相同的「临时文件 + 原子替换」写法，不产生半写状态。
    """
    target = resolve_under_root(project_root, relative_path)
    payload = Path(snapshot_file)
    if not payload.is_file():
        raise FileNotFoundError(f"快照文件不存在：{snapshot_file}")
    new_bytes = payload.read_bytes()

    if target.exists() and target.is_file():
        snapshot_previous(
            snapshots_root, project_id, relative_path, target.read_bytes()
        )

    target.parent.mkdir(parents=True, exist_ok=True)
    tmp = target.with_name(f".pocketcode-restore-{uuid.uuid4().hex[:12]}")
    try:
        with tmp.open("wb") as handle:
            handle.write(new_bytes)
            handle.flush()
            os.fsync(handle.fileno())
        os.replace(tmp, target)
    finally:
        if tmp.exists():
            tmp.unlink(missing_ok=True)
    return target


def _path_hash(relative_path: str) -> str:
    return hashlib.sha256(relative_path.encode("utf-8")).hexdigest()[:32]


def _prune(path_dir: Path) -> None:
    bins = sorted(path_dir.glob("*.bin"), reverse=True)
    for old in bins[KEEP_PER_PATH:]:
        old.unlink(missing_ok=True)
        old.with_suffix(".json").unlink(missing_ok=True)
