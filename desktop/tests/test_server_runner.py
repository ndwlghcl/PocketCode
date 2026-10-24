"""ServerRunner：真实 socket 启动/停止生命周期（桌面验收「Windows 启动/退出」的自动化部分）。"""

from __future__ import annotations

import socket

import httpx
import pytest

from pocketcode.server.app import create_app
from pocketcode.server.runner import ServerRunner


def _free_port() -> int:
    with socket.socket(socket.AF_INET, socket.SOCK_STREAM) as sock:
        sock.bind(("127.0.0.1", 0))
        return sock.getsockname()[1]


def test_runner_serves_health_then_stops():
    port = _free_port()
    runner = ServerRunner(create_app, host="127.0.0.1", port=port)
    runner.start()
    try:
        assert runner.wait_started(timeout=15.0)
        resp = httpx.get(f"http://127.0.0.1:{port}/v1/health", timeout=5.0)
        assert resp.status_code == 200
        assert resp.json()["service"] == "pocketcode"
    finally:
        runner.stop()

    assert not runner.is_running()
    with pytest.raises(httpx.TransportError):
        httpx.get(f"http://127.0.0.1:{port}/v1/health", timeout=2.0)


def test_runner_detects_port_conflict_as_not_started():
    # 先占住一个端口
    blocker = socket.socket(socket.AF_INET, socket.SOCK_STREAM)
    blocker.bind(("127.0.0.1", 0))
    blocker.listen(1)
    port = blocker.getsockname()[1]
    try:
        runner = ServerRunner(create_app, host="127.0.0.1", port=port)
        runner.start()
        try:
            assert runner.wait_started(timeout=15.0) is False
        finally:
            runner.stop()
    finally:
        blocker.close()
