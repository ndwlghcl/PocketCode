"""跨线程信号桥：控制器回调（任意线程）→ Qt 主线程槽函数。"""

from __future__ import annotations

from PySide6.QtCore import QObject, Signal


class GuiBridge(QObject):
    """把 AppController 的回调转发为 Qt 信号（emit 线程安全，投递为队列连接）。"""

    service_state_changed = Signal(object)  # ServiceState
    diagnostic_finished = Signal(bool, str)  # (成功?, 说明文本)
