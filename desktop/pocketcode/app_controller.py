"""AppController：GUI 与服务端之间的唯一桥梁（Qt 无关）。

PySide6 界面只调用本控制器管理服务生命周期与设置；FastAPI 路由不得反向
引用 GUI（架构文档 §1）。状态变化通过回调列表广播；GUI 侧用信号桥转发到
主线程（见 gui/bridge.py）。
"""

from __future__ import annotations

import enum
import logging
import socket
from typing import Callable

from pocketcode.server.app import create_app
from pocketcode.server.runner import ServerRunner
from pocketcode.storage.settings_store import Settings, SettingsStore

logger = logging.getLogger("pocketcode.app")


class ServiceState(enum.Enum):
    STOPPED = "stopped"
    STARTING = "starting"
    RUNNING = "running"
    PAUSED = "paused"
    ERROR = "error"


def lan_address_candidates(port: int) -> list[str]:
    """尽力枚举本机局域网地址；失败时退回 127.0.0.1。仅用于界面展示。"""
    addresses: list[str] = []
    try:
        with socket.socket(socket.AF_INET, socket.SOCK_DGRAM) as sock:
            # UDP connect 不会真正发包，仅让内核选出一块有路由的网卡地址。
            sock.connect(("10.255.255.255", 1))
            ip = sock.getsockname()[0]
        if ip:
            addresses.append(f"http://{ip}:{port}")
    except OSError:
        pass
    if not addresses:
        addresses.append(f"http://127.0.0.1:{port}")
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
        return self._settings

    @property
    def port(self) -> int:
        return self._settings.port

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
        runner = ServerRunner(create_app, host=self._host, port=self._settings.port)
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
        port_changed = settings.port != self._settings.port
        self._store.save(settings)
        self._settings = settings
        if port_changed and self._state in (ServiceState.RUNNING, ServiceState.ERROR):
            self.pause()
            self.start()

    # ---- 界面辅助 ----
    def lan_addresses(self) -> list[str]:
        return lan_address_candidates(self._settings.port)
