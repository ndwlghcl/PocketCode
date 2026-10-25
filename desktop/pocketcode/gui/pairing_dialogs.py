"""配对相关对话框与跨线程确认协调。

- PairingQrDialog：展示二维码 + 一次性码 + 核对说明（模态，用户手动关闭）。
- PairingConfirmationBroker：配对路由在服务线程里调用 callback()，本对象把
  请求转发成 Qt 信号到主线程弹窗，再携带结果唤醒等待者；限时无人处理按
  timeout 返回（对应合同的 PAIRING_TIMEOUT）。
"""

from __future__ import annotations

import threading
import uuid

from PySide6.QtCore import QObject, Qt, Signal
from PySide6.QtWidgets import (
    QDialog,
    QDialogButtonBox,
    QLabel,
    QMessageBox,
    QVBoxLayout,
)

from pocketcode.gui.qr import render_qr_pixmap


class PairingQrDialog(QDialog):
    def __init__(self, qr_payload: str, pairing_code: str, parent=None) -> None:
        super().__init__(parent)
        self.setWindowTitle("配对新手机")
        self.setMinimumWidth(360)

        layout = QVBoxLayout(self)
        qr_label = QLabel()
        qr_label.setPixmap(
            render_qr_pixmap(qr_payload).scaled(
                280, 280, Qt.AspectRatioMode.KeepAspectRatio,
                Qt.TransformationMode.SmoothTransformation,
            )
        )
        qr_label.setAlignment(Qt.AlignmentFlag.AlignCenter)
        layout.addWidget(qr_label)

        code_label = QLabel(f"配对码：{pairing_code}")
        code_label.setAlignment(Qt.AlignmentFlag.AlignCenter)
        layout.addWidget(code_label)

        hint = QLabel(
            "用手机 PocketCode App「连接」页扫码配对。\n"
            "该配对码只能使用一次；手机发起配对时，本窗口会弹出确认框，"
            "请核对设备名称后选择允许或拒绝。\n"
            "若二维码已被用过或过期，请关闭本窗口重新打开。"
        )
        hint.setWordWrap(True)
        layout.addWidget(hint)

        buttons = QDialogButtonBox(QDialogButtonBox.StandardButton.Close)
        buttons.rejected.connect(self.reject)
        buttons.clicked.connect(self.reject)
        layout.addWidget(buttons)


class PairingConfirmationBroker(QObject):
    """服务线程 callback → Qt 主线程弹窗 → 结果回填。"""

    pair_requested = Signal(str, str, str)  # request_id, device_name, platform

    def __init__(self, timeout_seconds: float = 60.0) -> None:
        super().__init__()
        self._timeout = timeout_seconds
        self._pending: dict[str, dict[str, str]] = {}
        self._events: dict[str, threading.Event] = {}

    def callback(self, device_name: str, device_platform: str) -> str:
        """在服务线程中调用（阻塞至用户决定或超时）。"""
        request_id = uuid.uuid4().hex
        holder: dict[str, str] = {"result": "timeout"}
        event = threading.Event()
        self._pending[request_id] = holder
        self._events[request_id] = event
        self.pair_requested.emit(request_id, device_name, device_platform)
        event.wait(timeout=self._timeout)
        self._pending.pop(request_id, None)
        self._events.pop(request_id, None)
        return holder["result"]

    def resolve(self, request_id: str, result: str) -> None:
        """主线程弹窗结束后调用。"""
        holder = self._pending.get(request_id)
        if holder is not None and result in ("approved", "rejected"):
            holder["result"] = result
        event = self._events.get(request_id)
        if event is not None:
            event.set()


def ask_pair_confirmation(window, request_id: str, device_name: str,
                          platform: str, broker: PairingConfirmationBroker) -> None:
    """主线程槽：弹出允许/拒绝确认框。"""
    box = QMessageBox(window)
    box.setWindowTitle("手机配对请求")
    box.setIcon(QMessageBox.Icon.Question)
    box.setText(f"设备「{device_name}」（{platform}）请求配对。")
    box.setInformativeText("允许后该手机可访问全部已授权项目。确认允许？")
    allow = box.addButton("允许", QMessageBox.ButtonRole.YesRole)
    box.addButton("拒绝", QMessageBox.ButtonRole.NoRole)
    box.exec()
    broker.resolve(request_id, "approved" if box.clickedButton() is allow else "rejected")
