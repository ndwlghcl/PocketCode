"""PocketCode 桌面应用入口。

职责（架构文档 §1 进程规则）：
- 单用户会话仅一个实例（QLocalServer 命名锁）；
- 主线程跑 Qt UI，后台线程跑 FastAPI 服务；
- 关闭窗口不退出，托盘「退出」才结束。

Windows UI GLM 不得改本文件（任务书 A 节文件所有权）；需要新入口能力时
向主集成提出。
"""

from __future__ import annotations

import sys

from PySide6.QtCore import Qt
from PySide6.QtNetwork import QLocalServer, QLocalSocket
from PySide6.QtWidgets import QApplication, QMessageBox

from pocketcode.app_controller import AppController
from pocketcode.gui.icons import make_app_icon
from pocketcode.gui.main_window import MainWindow
from pocketcode.gui.tray import TrayIcon
from pocketcode.storage.settings_store import SettingsStore

SINGLE_INSTANCE_KEY = "PocketCode-SingleInstance-v1"


def _acquire_single_instance() -> QLocalServer | None:
    """返回命名锁服务器；已有实例运行时返回 None。"""
    probe = QLocalSocket()
    probe.connectToServer(SINGLE_INSTANCE_KEY)
    if probe.waitForConnected(300):
        probe.disconnectFromServer()
        return None
    QLocalServer.removeServer(SINGLE_INSTANCE_KEY)  # 清理 *nix 上的陈旧锁；Windows 无害
    server = QLocalServer()
    if not server.listen(SINGLE_INSTANCE_KEY):
        return None
    return server


def run() -> int:
    app = QApplication(sys.argv)
    app.setApplicationName("PocketCode")
    app.setOrganizationName("PocketCode")
    app.setWindowIcon(make_app_icon())
    # 关闭窗口 = 隐藏到托盘，所以最后一个窗口关闭不能触发退出。
    app.setQuitOnLastWindowClosed(False)

    lock = _acquire_single_instance()
    if lock is None:
        QMessageBox.information(None, "PocketCode", "PocketCode 已在运行（请查看系统托盘）。")
        return 0

    store = SettingsStore()
    controller = AppController(store)
    controller.start()  # 启动服务；失败时窗口显示 ERROR 状态

    window = MainWindow(controller)
    tray = TrayIcon(controller, window)
    tray.show()
    window.show()

    exit_code = app.exec()

    lock.close()
    return exit_code


if __name__ == "__main__":
    sys.exit(run())
