"""设置存储：授权项目、配对设备、服务端口。

S0 采用单文件 JSON（%APPDATA%/PocketCode/settings.json）+ 原子写入；
数据量增大或需要事务时再引入 SQLite（架构文档 §0），届时迁移而不是扩展本文件。
"""

from __future__ import annotations

import json
import os
import socket
import threading
import uuid
from dataclasses import dataclass, field, asdict
from pathlib import Path

APP_DIR_NAME = "PocketCode"
SETTINGS_FILE_NAME = "settings.json"
SETTINGS_SCHEMA_VERSION = 1

DEFAULT_PORT = 8765


def default_settings_path() -> Path:
    """返回默认设置文件路径：%APPDATA%/PocketCode/settings.json（无 APPDATA 时退回家目录）。"""
    base = os.environ.get("APPDATA")
    root = Path(base) if base else Path.home()
    return root / APP_DIR_NAME / SETTINGS_FILE_NAME


@dataclass
class AuthorizedProject:
    """一个授权项目（电脑本地目录的逻辑映射）。"""

    id: str
    name: str
    root_path: str  # 电脑绝对路径；永不出现在任何 API 响应中
    revision: int = 0  # 最近一次生成的 manifest 快照序号
    manifest_signature: str = ""  # 最近一次快照内容签名（无变化则 revision 不递增）


@dataclass
class PairedDevice:
    """一台已配对手机。token_hash 是设备令牌的 SHA-256；明文 token 不落盘。"""

    id: str
    name: str
    paired_at: str  # ISO 8601 UTC
    token_hash: str = ""


@dataclass
class Settings:
    """可持久化的服务端设置。"""

    port: int = DEFAULT_PORT
    authorized_projects: list[AuthorizedProject] = field(default_factory=list)
    paired_devices: list[PairedDevice] = field(default_factory=list)
    autostart: bool = False
    server_id: str = ""  # 安装实例唯一 ID；首启自动生成
    server_name: str = ""  # 电脑显示名；默认取主机名
    schema_version: int = SETTINGS_SCHEMA_VERSION


class SettingsStore:
    """线程安全的设置读写；写入采用「临时文件 + 原子替换」。"""

    def __init__(self, path: Path | None = None) -> None:
        self._path = Path(path) if path else default_settings_path()
        # RLock：变更方法需要在单次加锁内完成 load→修改→save
        self._lock = threading.RLock()

    @property
    def path(self) -> Path:
        return self._path

    def load(self) -> Settings:
        """读取设置；文件缺失或损坏时返回默认值（损坏文件保留为 .corrupt 备份）。"""
        with self._lock:
            if not self._path.exists():
                return Settings()
            try:
                raw = self._path.read_text(encoding="utf-8")
                data = json.loads(raw)
                return self._parse(data)
            except (OSError, ValueError, TypeError):
                self._backup_corrupt()
                return Settings()

    def save(self, settings: Settings) -> None:
        with self._lock:
            self._path.parent.mkdir(parents=True, exist_ok=True)
            tmp = self._path.with_suffix(".json.tmp")
            payload = asdict(settings)
            tmp.write_text(
                json.dumps(payload, ensure_ascii=False, indent=2) + "\n",
                encoding="utf-8",
            )
            os.replace(tmp, self._path)

    def _backup_corrupt(self) -> None:
        try:
            backup = self._path.with_suffix(".json.corrupt")
            os.replace(self._path, backup)
        except OSError:
            pass

    @staticmethod
    def _parse(data: object) -> Settings:
        if not isinstance(data, dict):
            raise TypeError("settings root must be an object")
        projects_raw = data.get("authorized_projects", [])
        devices_raw = data.get("paired_devices", [])
        if not isinstance(projects_raw, list) or not isinstance(devices_raw, list):
            raise TypeError("authorized_projects/paired_devices must be lists")
        projects = [AuthorizedProject(**item) for item in projects_raw]
        devices = [PairedDevice(**item) for item in devices_raw]
        port = int(data.get("port", DEFAULT_PORT))
        if not 1024 <= port <= 65535:
            raise ValueError(f"port out of range: {port}")
        return Settings(
            port=port,
            authorized_projects=projects,
            paired_devices=devices,
            autostart=bool(data.get("autostart", False)),
            server_id=str(data.get("server_id", "")),
            server_name=str(data.get("server_name", "")),
            schema_version=int(data.get("schema_version", SETTINGS_SCHEMA_VERSION)),
        )

    # ------------------------------------------------------------ 变更操作
    # 以下方法各自在单次加锁内完成 load→修改→save，可被 GUI 线程与配对
    # 路由（服务线程）并发调用。

    def add_paired_device(self, device: PairedDevice) -> None:
        with self._lock:
            settings = self.load()
            settings.paired_devices = [
                d for d in settings.paired_devices if d.id != device.id
            ]
            settings.paired_devices.append(device)
            self.save(settings)

    def remove_paired_device(self, device_id: str) -> bool:
        with self._lock:
            settings = self.load()
            before = len(settings.paired_devices)
            settings.paired_devices = [
                d for d in settings.paired_devices if d.id != device_id
            ]
            if len(settings.paired_devices) != before:
                self.save(settings)
                return True
            return False

    def add_authorized_project(self, project: AuthorizedProject) -> None:
        with self._lock:
            settings = self.load()
            if any(p.root_path == project.root_path for p in settings.authorized_projects):
                raise ValueError("该目录已在授权列表中")
            settings.authorized_projects.append(project)
            self.save(settings)

    def remove_authorized_project(self, project_id: str) -> bool:
        with self._lock:
            settings = self.load()
            before = len(settings.authorized_projects)
            settings.authorized_projects = [
                p for p in settings.authorized_projects if p.id != project_id
            ]
            if len(settings.authorized_projects) != before:
                self.save(settings)
                return True
            return False

    def record_manifest_revision(self, project_id: str, signature: str) -> int:
        """内容签名无变化 → 返回现有 revision；有变化 → 递增并持久化。"""
        with self._lock:
            settings = self.load()
            for project in settings.authorized_projects:
                if project.id == project_id:
                    if project.manifest_signature == signature:
                        return project.revision
                    project.revision += 1
                    project.manifest_signature = signature
                    self.save(settings)
                    return project.revision
            raise KeyError(project_id)

    def ensure_server_identity(self) -> tuple[str, str]:
        """保证 server_id/server_name 存在；返回 (server_id, server_name)。"""
        with self._lock:
            settings = self.load()
            changed = False
            if not settings.server_id:
                settings.server_id = str(uuid.uuid4())
                changed = True
            if not settings.server_name:
                settings.server_name = socket.gethostname() or "我的电脑"
                changed = True
            if changed:
                self.save(settings)
            return settings.server_id, settings.server_name


def new_id() -> str:
    """生成服务端稳定 ID（UUID v4）。"""
    return str(uuid.uuid4())
