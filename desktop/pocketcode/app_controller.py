"""AppController：GUI 与服务端之间的唯一桥梁（Qt 无关）。

PySide6 界面只调用本控制器管理服务生命周期与设置；FastAPI 路由不得反向
引用 GUI（架构文档 §1）。状态变化通过回调列表广播；GUI 侧用信号桥转发到
主线程（见 gui/bridge.py）。
"""

from __future__ import annotations

import enum
import json
import logging
import socket
import uuid
from pathlib import Path
from typing import Callable

from pocketcode.security.tls import TlsError, ensure_server_tls
from pocketcode.security.path_guard import PathGuardError
from pocketcode.server.app import create_app
from pocketcode.server.runner import ServerRunner
from pocketcode.services.pairing import PairingService
from pocketcode.services.snapshots import list_snapshot_paths, list_snapshots, restore_snapshot
from pocketcode.storage.settings_store import (
    AuthorizedProject,
    Settings,
    SettingsStore,
    new_id,
)

logger = logging.getLogger("pocketcode.app")


class ServiceState(enum.Enum):
    STOPPED = "stopped"
    STARTING = "starting"
    RUNNING = "running"
    PAUSED = "paused"
    ERROR = "error"


def lan_address_candidates(port: int) -> list[str]:
    """尽力枚举本机局域网地址；失败时退回 127.0.0.1。仅用于界面展示。

    S2a 起服务运行 HTTPS，展示地址使用 https scheme。
    """
    addresses: list[str] = []
    try:
        with socket.socket(socket.AF_INET, socket.SOCK_DGRAM) as sock:
            # UDP connect 不会真正发包，仅让内核选出一块有路由的网卡地址。
            sock.connect(("10.255.255.255", 1))
            ip = sock.getsockname()[0]
        if ip:
            addresses.append(f"https://{ip}:{port}")
    except OSError:
        pass
    if not addresses:
        addresses.append(f"https://127.0.0.1:{port}")
    return addresses


class AppController:
    """持有设置与服务运行器；所有方法须在主线程调用（内部 Join 等待短暂阻塞可接受）。"""

    def __init__(self, store: SettingsStore, host: str = "0.0.0.0") -> None:
        self._store = store
        self._host = host
        self._settings: Settings = store.load()
        self._runner: ServerRunner | None = None
        self._state = ServiceState.STOPPED
        self._listeners: list[Callable[[ServiceState], None]] = []
        self._tls_fingerprint: str | None = None
        self.pairing = PairingService()
        self._store.ensure_server_identity()

    # ---- 状态广播 ----
    def add_listener(self, callback: Callable[[ServiceState], None]) -> None:
        self._listeners.append(callback)

    def remove_listener(self, callback: Callable[[ServiceState], None]) -> None:
        if callback in self._listeners:
            self._listeners.remove(callback)

    @property
    def state(self) -> ServiceState:
        return self._state

    @property
    def settings(self) -> Settings:
        """每次返回最新持久化设置（配对路由可能在服务线程修改它们）。"""
        self._settings = self._store.load()
        return self._settings

    @property
    def server_identity(self) -> tuple[str, str]:
        """(server_id, server_name)，二维码与配对响应使用。"""
        return self._store.ensure_server_identity()

    @property
    def port(self) -> int:
        return self._settings.port

    @property
    def tls_fingerprint(self) -> str | None:
        """当前 TLS 证书指纹（`sha256:…`）；服务未启动过时为 None。"""
        return self._tls_fingerprint

    def _set_state(self, state: ServiceState) -> None:
        if state is self._state:
            return
        self._state = state
        for callback in list(self._listeners):
            try:
                callback(state)
            except Exception:  # noqa: BLE001 - 监听器异常不拖垮控制器
                logger.exception("service state listener failed")

    # ---- 服务生命周期 ----
    def start(self) -> None:
        """启动服务并等待绑定完成（失败置为 ERROR，不抛异常）。"""
        if self._state is ServiceState.RUNNING:
            return
        self._set_state(ServiceState.STARTING)
        try:
            tls = ensure_server_tls(self._store.path.parent / "tls")
        except TlsError as exc:
            logger.error("TLS setup failed: %s", exc)
            self._runner = None
            self._set_state(ServiceState.ERROR)
            return
        self._tls_fingerprint = tls.fingerprint
        runner = ServerRunner(
            lambda: create_app(store=self._store, pairing=self.pairing),
            host=self._host,
            port=self._settings.port,
            ssl_certfile=tls.cert_path,
            ssl_keyfile=tls.key_path,
        )
        try:
            runner.start()
        except OSError as exc:
            logger.error("failed to start server on port %s: %s", self._settings.port, exc)
            self._runner = None
            self._set_state(ServiceState.ERROR)
            return
        self._runner = runner
        if runner.wait_started(timeout=10.0):
            self._set_state(ServiceState.RUNNING)
        else:
            logger.error("server did not start on port %s", self._settings.port)
            self._runner = None
            self._set_state(ServiceState.ERROR)

    def pause(self) -> None:
        if self._runner is None:
            self._set_state(ServiceState.PAUSED)
            return
        self._runner.stop()
        self._runner = None
        self._set_state(ServiceState.PAUSED)

    def resume(self) -> None:
        self.start()

    def shutdown(self) -> None:
        if self._runner is not None:
            self._runner.stop()
            self._runner = None
        self._set_state(ServiceState.STOPPED)

    # ---- 设置 ----
    def apply_settings(self, settings: Settings) -> None:
        """保存新设置；端口变化时自动重启服务。"""
        port_changed = settings.port != self._store.load().port
        self._store.save(settings)
        self._settings = settings
        if port_changed and self._state in (ServiceState.RUNNING, ServiceState.ERROR):
            self.pause()
            self.start()

    # ---- 授权项目管理（桌面 UI 调用）----
    def add_project(self, root_path: str) -> AuthorizedProject:
        """把一个本机目录注册为授权项目；重复目录报 ValueError。"""
        root = Path(root_path)
        if not root.is_dir():
            raise ValueError(f"目录不存在：{root_path}")
        name = root.name or str(root)
        project = AuthorizedProject(
            id=new_id(), name=name, root_path=str(root.resolve()), revision=0
        )
        self._store.add_authorized_project(project)
        return project

    def remove_project(self, project_id: str) -> bool:
        return self._store.remove_authorized_project(project_id)

    def revoke_device(self, device_id: str) -> bool:
        """撤销手机授权：从配对列表移除，其令牌立即失效。"""
        return self._store.remove_paired_device(device_id)

    # ---- 历史快照（S3 收尾：桌面端「历史版本」查看/恢复，PRD §6.3）----
    def _snapshots_root(self) -> Path:
        return self._store.path.parent / "snapshots"

    def snapshot_projects(self) -> list[dict]:
        """有快照的授权项目：[{id, name, file_count}]；无快照的项目不出现。"""
        result = []
        for project in self.settings.authorized_projects:
            files = list_snapshot_paths(self._snapshots_root(), project.id)
            if files:
                result.append(
                    {"id": project.id, "name": project.name, "file_count": len(files)}
                )
        return result

    def snapshot_files(self, project_id: str) -> list[dict]:
        """某项目下有快照的文件列表：[{path, count, latest}]，新→旧。"""
        return list_snapshot_paths(self._snapshots_root(), project_id)

    def file_snapshots(self, project_id: str, relative_path: str) -> list[dict]:
        """某文件的快照列表（新→旧）：[{saved_at, size, snapshot_file, …}]。"""
        return list_snapshots(self._snapshots_root(), project_id, relative_path)

    def restore_file_snapshot(
        self, project_id: str, relative_path: str, snapshot_file: str
    ) -> None:
        """把所选快照写回项目原文件；写回前当前内容自动再快照一次。

        失败抛 ValueError（消息可直接展示给用户）。
        """
        project = next(
            (
                p
                for p in self.settings.authorized_projects
                if p.id == project_id
            ),
            None,
        )
        if project is None:
            raise ValueError("项目不存在或已被移除，无法恢复")

        # 只允许写回快照区内的 .bin 文件（GUI 传回的路径仍按不可信输入对待）
        snapshots_root = self._snapshots_root()
        candidate = Path(snapshot_file).resolve()
        allowed_root = (snapshots_root / project_id).resolve()
        if (
            not candidate.is_relative_to(allowed_root)
            or candidate.suffix != ".bin"
        ):
            raise ValueError("快照文件无效")
        try:
            restore_snapshot(
                snapshots_root,
                Path(project.root_path),
                project_id,
                relative_path,
                candidate,
            )
        except PathGuardError as exc:
            raise ValueError(exc.message) from exc
        except OSError as exc:
            raise ValueError(f"恢复失败：{exc}") from exc

    # ---- 配对二维码载荷 ----
    def pairing_qr_payload(self, pairing_code: str) -> str:
        """二维码内容：地址 + 证书指纹 + 一次性码。JSON，手机端按 v 解析。"""
        server_id, server_name = self.server_identity
        fingerprint = self._tls_fingerprint
        if not fingerprint:
            # 服务未启动过也要能展示二维码（配对前决不允许无证书），现场取/生成
            fingerprint = ensure_server_tls(self._store.path.parent / "tls").fingerprint
            self._tls_fingerprint = fingerprint
        payload = {
            "v": 1,
            "addresses": self.lan_addresses(),
            "port": self._settings.port,
            "fingerprint": fingerprint,
            "server_id": server_id,
            "server_name": server_name,
            "code": pairing_code,
        }
        return json.dumps(payload, ensure_ascii=False, separators=(",", ":"))

    # ---- 界面辅助 ----
    def lan_addresses(self) -> list[str]:
        return lan_address_candidates(self._settings.port)
