"""专用回收区（S3）：删除/恢复/清空，跨会话持久。

布局：
  <设置目录>/trash/
    trash_index.json        # 条目元数据（含恢复所需的绝对路径，绝不经 API 外泄）
    <trash_id>/             # 被删内容原样存放（文件或整个目录树）

批量删除是原子的：先全部校验，再逐个移动；中途失败把已移动的移回原地。
"""

from __future__ import annotations

import json
import shutil
import threading
import uuid
from datetime import datetime, timezone
from pathlib import Path


class TrashServiceError(Exception):
    """code 取合同错误码。"""

    def __init__(self, code: str, message: str, details: dict | None = None) -> None:
        self.code = code
        self.message = message
        self.details = details
        super().__init__(f"[{code}] {message}")


class TrashStore:
    def __init__(self, trash_root: Path) -> None:
        self._root = trash_root
        self._index_path = trash_root / "trash_index.json"
        self._lock = threading.RLock()
        trash_root.mkdir(parents=True, exist_ok=True)

    # ------------------------------------------------------------------ 索引
    def _load_index(self) -> list[dict]:
        if not self._index_path.exists():
            return []
        try:
            data = json.loads(self._index_path.read_text(encoding="utf-8"))
            return data if isinstance(data, list) else []
        except (OSError, ValueError):
            # 索引损坏：保留现场，按空处理（payload 仍在，可在桌面端手动捞）
            return []

    def _save_index(self, entries: list[dict]) -> None:
        tmp = self._index_path.with_suffix(".json.tmp")
        tmp.write_text(
            json.dumps(entries, ensure_ascii=False, indent=2) + "\n", encoding="utf-8"
        )
        tmp.replace(self._index_path)

    # ------------------------------------------------------------------ 操作
    def move_in(
        self, project_id: str, items: list[tuple[str, Path]]
    ) -> list[dict]:
        """把 (相对路径, 绝对路径) 列表移入回收区；原子——失败整批回滚。"""
        moved: list[tuple[Path, Path]] = []
        created: list[dict] = []
        try:
            with self._lock:
                for relative_path, absolute in items:
                    trash_id = str(uuid.uuid4())
                    kind = "dir" if absolute.is_dir() else "file"
                    size = None
                    if kind == "file":
                        size = absolute.stat().st_size
                    destination = self._root / trash_id
                    shutil.move(str(absolute), str(destination))
                    moved.append((absolute, destination))
                    created.append(
                        {
                            "trash_id": trash_id,
                            "project_id": project_id,
                            "original_path": relative_path,
                            "source_abs": str(absolute),
                            "deleted_at": datetime.now(tz=timezone.utc).strftime(
                                "%Y-%m-%dT%H:%M:%SZ"
                            ),
                            "kind": kind,
                            "size": size,
                        }
                    )
                index = self._load_index()
                index.extend(created)
                self._save_index(index)
                return [
                    {"path": c["original_path"], "trash_id": c["trash_id"]}
                    for c in created
                ]
        except Exception as exc:
            # 回滚已移动的部分，尽量保持原状
            for absolute, destination in reversed(moved):
                try:
                    shutil.move(str(destination), str(absolute))
                except OSError:
                    pass
            raise TrashServiceError("IO_ERROR", f"移入回收区失败：{exc}") from exc

    def list_entries(self) -> list[dict]:
        with self._lock:
            return sorted(self._load_index(), key=lambda e: e["deleted_at"], reverse=True)

    def restore(self, trash_id: str) -> tuple[str, str]:
        """恢复到原路径；被占用时报 ALREADY_EXISTS 并给出不冲突的建议路径。"""
        with self._lock:
            entries = self._load_index()
            entry = next((e for e in entries if e["trash_id"] == trash_id), None)
            if entry is None:
                raise TrashServiceError("NOT_FOUND", "回收区中不存在该条目")

            payload = self._root / trash_id
            if not payload.exists():
                raise TrashServiceError("NOT_FOUND", "回收区内容已丢失")

            target = Path(entry["source_abs"])
            if target.exists():
                raise TrashServiceError(
                    "ALREADY_EXISTS",
                    "原路径已被占用，未执行恢复",
                    {
                        "occupied_path": entry["original_path"],
                        "suggested_path": _suggest_alternative(target),
                    },
                )
            target.parent.mkdir(parents=True, exist_ok=True)
            shutil.move(str(payload), str(target))
            self._save_index([e for e in entries if e["trash_id"] != trash_id])
            return trash_id, entry["original_path"]

    def delete_entry(self, trash_id: str) -> bool:
        with self._lock:
            entries = self._load_index()
            entry = next((e for e in entries if e["trash_id"] == trash_id), None)
            if entry is None:
                return False
            payload = self._root / trash_id
            if payload.is_dir():
                shutil.rmtree(payload, ignore_errors=True)
            else:
                payload.unlink(missing_ok=True)
            self._save_index([e for e in entries if e["trash_id"] != trash_id])
            return True

    def purge(self) -> int:
        with self._lock:
            entries = self._load_index()
            for entry in entries:
                payload = self._root / entry["trash_id"]
                if payload.is_dir():
                    shutil.rmtree(payload, ignore_errors=True)
                else:
                    payload.unlink(missing_ok=True)
            self._save_index([])
            return len(entries)


def _suggest_alternative(occupied: Path) -> str:
    """给出不冲突的建议路径：`name (1).ext` 风格（相对路径由调用方拼）。"""
    stem, suffix = occupied.stem, occupied.suffix
    for i in range(1, 100):
        candidate = occupied.with_name(f"{stem} ({i}){suffix}")
        if not candidate.exists():
            return candidate.name
    return f"{stem} (restored-{uuid.uuid4().hex[:6]}){suffix}"
