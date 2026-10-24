"""在后台线程中运行 Uvicorn 服务。

进程规则（架构文档 §1）：整个桌面应用单进程；FastAPI 在后台线程运行自己的
asyncio 事件循环，Qt UI 留在主线程。暂停服务 = 停止监听；恢复 = 新建 Server 实例。
"""

from __future__ import annotations

import threading
from typing import Callable

import uvicorn
from fastapi import FastAPI


class ServerRunner:
    """管理单个 Uvicorn 服务实例的生命周期（非线程安全：调用方须在主线程串行调用）。"""

    def __init__(
        self,
        app_factory: Callable[[], FastAPI],
        host: str = "0.0.0.0",
        port: int = 8765,
    ) -> None:
        self._app_factory = app_factory
        self._host = host
        self._port = port
        self._server: uvicorn.Server | None = None
        self._thread: threading.Thread | None = None

    @property
    def port(self) -> int:
        return self._port

    def start(self) -> None:
        """启动服务线程。是否绑定成功用 wait_started() 判断。"""
        if self._thread is not None and self._thread.is_alive():
            raise RuntimeError("server already running")
        server = uvicorn.Server(
            uvicorn.Config(
                self._app_factory(),
                host=self._host,
                port=self._port,
                log_level="info",
                access_log=False,
            )
        )
        self._server = server
        self._thread = threading.Thread(
            target=self._serve, args=(server,), name="pocketcode-server", daemon=True
        )
        self._thread.start()

    @staticmethod
    def _serve(server: uvicorn.Server) -> None:
        # 端口绑定失败时 uvicorn 以 SystemExit 结束线程，属于预期路径
        # （wait_started/占位测试通过 started 标志与线程存活判断），这里吞掉即可。
        try:
            server.run()
        except SystemExit:
            pass

    def wait_started(self, timeout: float = 10.0) -> bool:
        """等待端口开始接受连接；绑定失败或线程退出返回 False。"""
        import time

        deadline = time.monotonic() + timeout
        while time.monotonic() < deadline:
            server = self._server
            if server is not None and server.started:
                return True
            thread = self._thread
            if thread is None or not thread.is_alive():
                return False
            time.sleep(0.05)
        return False

    def stop(self, timeout: float = 10.0) -> None:
        """请求优雅关闭并等待线程退出。"""
        server = self._server
        if server is not None:
            server.should_exit = True
        thread = self._thread
        if thread is not None and thread.is_alive():
            thread.join(timeout=timeout)
        self._server = None
        self._thread = None

    def is_running(self) -> bool:
        thread = self._thread
        return thread is not None and thread.is_alive()
