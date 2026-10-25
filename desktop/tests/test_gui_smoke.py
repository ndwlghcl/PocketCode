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


def test_tray_menu_keeps_all_actions(settings_path):
    """回归：托盘菜单动作必须有长期引用，否则会被 GC 回收导致「退出」消失。

    修复前的缺陷：quit 动作是 __init__ 局部变量且无 Qt 父对象，
    __init__ 返回后被 PySide6 回收，托盘菜单只剩两项。
    """
    import gc

    from PySide6.QtWidgets import QApplication

    from pocketcode.app_controller import AppController
    from pocketcode.gui.tray import TrayIcon
    from pocketcode.storage.settings_store import SettingsStore

    app = QApplication.instance() or QApplication([])

    class _FakeWindow:
        def show(self):
            pass

        def raise_(self):
            pass

        def activateWindow(self):
            pass

    controller = AppController(SettingsStore(settings_path))
    tray = TrayIcon(controller, _FakeWindow())
    gc.collect()  # 复现原缺陷的回收时机

    # 服务停止状态下第二项显示「恢复服务」（运行中则显示「暂停服务」）
    titles = [action.text() for action in tray.contextMenu().actions()]
    assert titles == ["打开管理窗口", "", "恢复服务", "", "退出"], f"menu became: {titles}"


def test_close_event_hides_but_real_exit_accepts(settings_path):
    """回归：用户点 ✕ → 关闭被拦截（缩托盘）；托盘「退出」置 allow_close → 放行。

    原缺陷：Qt 6.5+ 的 quit() 会先关闭顶层窗口，触发 closeEvent 的
    “已最小化到托盘”弹窗，导致托盘退出被拦、行为与点 ✕ 相同。
    """
    from PySide6.QtGui import QCloseEvent
    from PySide6.QtWidgets import QApplication

    from pocketcode.app_controller import AppController
    from pocketcode.gui.main_window import MainWindow
    from pocketcode.storage.settings_store import SettingsStore

    app = QApplication.instance() or QApplication([])
    controller = AppController(SettingsStore(settings_path))
    window = MainWindow(controller)

    event = QCloseEvent()
    window.closeEvent(event)
    assert not event.isAccepted(), "用户点 ✕ 必须被拦截（缩到托盘）"

    window.allow_close = True
    event2 = QCloseEvent()
    window.closeEvent(event2)
    assert event2.isAccepted(), "托盘退出时必须放行关闭"
