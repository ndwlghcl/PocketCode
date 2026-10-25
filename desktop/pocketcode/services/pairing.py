"""配对服务（S2b）：一次性配对码 + 用户确认协调。Qt 无关。

流程：
1. 电脑端界面调 create_session() 生成一次性配对码（随二维码展示）；
2. 手机调 POST /v1/pair/complete 携带该码；
3. 路由先 begin_confirmation() 原子地「占用」配对码（防两台手机同时
   消费同码），随后 request_confirmation() 阻塞等待电脑用户在桌面端
   弹窗中允许 / 拒绝（超时按 PAIRING_TIMEOUT 处理）。

配对码在确认开始前即被标记为已用：被拒绝或超时后同一张二维码不能重试，
用户重新生成即可 —— 用轻微的体验代价换取"一码至多配对一台设备"的确定性。
"""

from __future__ import annotations

import secrets
import threading
import time
from enum import Enum
from typing import Callable

_CODE_ALPHABET = "ABCDEFGHJKLMNPQRSTUVWXYZ23456789"  # 去掉 I/O/0/1 防误认


def generate_pairing_code() -> str:
    """形如 `ABCD-2345` 的一次性配对码（符合合同 `^[A-Z0-9-]+$`）。"""
    chars = "".join(secrets.choice(_CODE_ALPHABET) for _ in range(8))
    return f"{chars[:4]}-{chars[4:]}"


class PairingService:
    def __init__(
        self,
        code_ttl_seconds: float = 300.0,
        confirm_timeout_seconds: float = 60.0,
    ) -> None:
        self._code_ttl = code_ttl_seconds
        self._confirm_timeout = confirm_timeout_seconds
        self._lock = threading.Lock()
        self._code: str | None = None
        self._expires_at: float = 0.0
        self._used = False
        self._confirmation_callback: Callable[[str, str], str] | None = None

    # -------------------------------------------------- 桌面端（生成/展示）
    def create_session(self) -> str:
        """生成新的一次性配对码；旧码立即作废。"""
        with self._lock:
            self._code = generate_pairing_code()
            self._expires_at = time.monotonic() + self._code_ttl
            self._used = False
            return self._code

    # -------------------------------------------------- 手机端（消费）
    def is_known_used(self, code: str) -> bool:
        """该码是否是当前会话的码且已被占用（区分 409 与 401）。"""
        with self._lock:
            return self._used and code is not None and code == self._code

    def begin_confirmation(self, code: str) -> bool:
        """原子检查并占用配对码；成功后才允许弹出确认框。"""
        with self._lock:
            if (
                self._code is None
                or code != self._code
                or self._used
                or time.monotonic() > self._expires_at
            ):
                return False
            self._used = True
            return True

    def request_confirmation(self, device_name: str, device_platform: str) -> str:
        """阻塞等待电脑用户决定；返回 approved / rejected / timeout。"""
        callback = self._confirmation_callback
        if callback is None:
            return "timeout"
        try:
            outcome = callback(device_name, device_platform)
        except Exception:  # noqa: BLE001 - 回调异常按超时处理，不让服务线程崩
            return "timeout"
        return outcome if outcome in ("approved", "rejected", "timeout") else "timeout"

    @property
    def confirm_timeout_seconds(self) -> float:
        return self._confirm_timeout

    # -------------------------------------------------- 界面回调注册
    def set_confirmation_callback(self, callback: Callable[[str, str], str] | None) -> None:
        self._confirmation_callback = callback
