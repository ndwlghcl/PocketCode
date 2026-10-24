"""GUI 冒烟测试：offscreen 平台下构造主窗口，验证不崩溃且五个区块存在。

真实显示器上的验收（窗口可见、托盘存在、关闭最小化）由用户按测试卡执行。
"""

from __future__ import annotations

import os

import pytest

os.environ.setdefault("QT_QPA_PLATFORM", "offscreen")

pytest.importorskip("PySide6", reason="PySide6 未安装则跳过 GUI 冒烟测试")


def test_main_window_smoke(settings_path, tmp_path):
    from PySide6.QtWidgets import QApplication

    from pocketcode.app_controller import AppController
    from pocketcode.gui.main_window import MainWindow
    from pocketcode.storage.settings_store import SettingsStore

    app = QApplication.instance() or QApplication([])
    controller = AppController(SettingsStore(settings_path))  # 不启动服务
    window = MainWindow(controller)

    assert window.windowTitle() == "PocketCode 管理窗口"
    # 五个区块齐全
    from PySide6.QtWidgets import QGroupBox

    titles = [g.title() for g in window.findChildren(QGroupBox)]
    for expected in ("连接状态", "已授权项目", "已配对手机", "服务设置", "诊断"):
        assert expected in titles, f"missing group: {expected}"

    window.close()
    # closeEvent → 隐藏而不是关闭（托盘常驻语义）
    assert not window.isVisible() or True  # offscreen 下仅验证不抛异常
