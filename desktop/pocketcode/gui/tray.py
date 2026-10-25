"""系统托盘：打开管理窗口 / 暂停恢复服务 / 退出。

架构文档 §1：关闭管理窗口不退出进程；托盘「退出」才关闭服务并清理监听。
"""

from __future__ import annotations

from PySide6.QtGui import QAction
from PySide6.QtWidgets import QApplication, QMenu, QSystemTrayIcon

from pocketcode.app_controller import AppController, ServiceState
from pocketcode.gui.icons import make_app_icon


class TrayIcon(QSystemTrayIcon):
    def __init__(self, controller: AppController, window) -> None:
        super().__init__(make_app_icon())
        self._controller = controller
        self._window = window
        self.setToolTip("PocketCode 服务")

        menu = QMenu()
        # 菜单和所有动作都挂到 self 上，防止 PySide6 把无引用的 QObject 回收
        # （回收后菜单项会消失）。
        self._menu = menu

        self._open_action = QAction("打开管理窗口", menu)
        self._open_action.triggered.connect(self._show_window)
        menu.addAction(self._open_action)

        menu.addSeparator()

        self._toggle_action = QAction("暂停服务", menu)
        self._toggle_action.triggered.connect(self._toggle_service)
        menu.addAction(self._toggle_action)

        menu.addSeparator()

        self._quit_action = QAction("退出", menu)
        self._quit_action.triggered.connect(self._quit)
        menu.addAction(self._quit_action)

        self.setContextMenu(menu)
        self.activated.connect(self._on_activated)

        controller.add_listener(lambda _state: self._refresh_toggle_text())
        self._refresh_toggle_text()

    # ------------------------------------------------------------------
    def _show_window(self) -> None:
        self._window.show()
        self._window.raise_()
        self._window.activateWindow()

    def _toggle_service(self) -> None:
        if self._controller.state is ServiceState.RUNNING:
            self._controller.pause()
        elif self._controller.state in (ServiceState.PAUSED, ServiceState.STOPPED, ServiceState.ERROR):
            self._controller.start()
        self._refresh_toggle_text()

    def _refresh_toggle_text(self) -> None:
        if self._controller.state is ServiceState.RUNNING:
            self._toggle_action.setText("暂停服务")
        else:
            self._toggle_action.setText("恢复服务")

    def _on_activated(self, reason: QSystemTrayIcon.ActivationReason) -> None:
        if reason == QSystemTrayIcon.ActivationReason.DoubleClick:
            self._show_window()

    def _quit(self) -> None:
        self.hide()
        self._window.allow_close = True
        self._controller.shutdown()
        QApplication.quit()
