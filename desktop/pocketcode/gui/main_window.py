"""管理主窗口：连接状态 / 已授权项目 / 配对手机 / 服务设置 / 诊断 五个区块。

S0 为骨架：项目与配对列表展示持久化数据（当前为空），添加/移除能力在 S2
由「Windows UI GLM」补齐（任务书任务 2）；本窗口绝不做代码编辑器（PRD §3.1）。
"""

from __future__ import annotations

import json
import threading
import urllib.error
import urllib.request

from PySide6.QtCore import Qt
from PySide6.QtWidgets import (
    QCheckBox,
    QFormLayout,
    QGroupBox,
    QHBoxLayout,
    QLabel,
    QLineEdit,
    QListWidget,
    QMainWindow,
    QMessageBox,
    QPushButton,
    QSpinBox,
    QVBoxLayout,
    QWidget,
)

from pocketcode.app_controller import AppController, ServiceState
from pocketcode.gui.bridge import GuiBridge

_STATE_TEXT = {
    ServiceState.STOPPED: "已停止",
    ServiceState.STARTING: "启动中…",
    ServiceState.RUNNING: "运行中",
    ServiceState.PAUSED: "已暂停",
    ServiceState.ERROR: "启动失败（端口被占用？）",
}


class MainWindow(QMainWindow):
    def __init__(self, controller: AppController) -> None:
        super().__init__()
        self._controller = controller
        self._bridge = GuiBridge()
        self._bridge.service_state_changed.connect(self._on_state_changed)
        self._bridge.diagnostic_finished.connect(self._on_diagnostic_finished)
        self._first_hide_hint_shown = False

        self.setWindowTitle("PocketCode 管理窗口")
        self.resize(520, 720)
        self._build_ui()

        controller.add_listener(self._bridge.service_state_changed.emit)
        self._on_state_changed(controller.state)

    # ------------------------------------------------------------------ UI
    def _build_ui(self) -> None:
        central = QWidget()
        layout = QVBoxLayout(central)

        layout.addWidget(self._build_connection_group())
        layout.addWidget(self._build_projects_group())
        layout.addWidget(self._build_devices_group())
        layout.addWidget(self._build_settings_group())
        layout.addWidget(self._build_diagnostics_group())
        layout.addStretch(1)

        self.setCentralWidget(central)

    def _build_connection_group(self) -> QGroupBox:
        group = QGroupBox("连接状态")
        form = QFormLayout(group)
        self._service_state_label = QLabel()
        self._address_label = QLabel()
        self._address_label.setTextInteractionFlags(Qt.TextInteractionFlag.TextSelectableByMouse)
        hint = QLabel("局域网地址将在 S1 热点连通性实验中用于手机手动连接。")
        hint.setWordWrap(True)
        form.addRow("服务：", self._service_state_label)
        form.addRow("地址：", self._address_label)
        form.addRow(hint)
        return group

    def _build_projects_group(self) -> QGroupBox:
        group = QGroupBox("已授权项目")
        layout = QVBoxLayout(group)
        self._project_list = QListWidget()
        layout.addWidget(self._project_list)
        buttons = QHBoxLayout()
        add_btn = QPushButton("添加项目…")
        remove_btn = QPushButton("移除所选")
        add_btn.setEnabled(False)
        remove_btn.setEnabled(False)
        add_btn.setToolTip("S2 阶段提供：通过文件夹选择器授权项目目录")
        remove_btn.setToolTip("S2 阶段提供")
        buttons.addWidget(add_btn)
        buttons.addWidget(remove_btn)
        layout.addLayout(buttons)
        self._refresh_project_list()
        return group

    def _build_devices_group(self) -> QGroupBox:
        group = QGroupBox("已配对手机")
        layout = QVBoxLayout(group)
        self._device_list = QListWidget()
        layout.addWidget(self._device_list)
        buttons = QHBoxLayout()
        revoke_btn = QPushButton("撤销所选设备授权")
        revoke_btn.setEnabled(False)
        revoke_btn.setToolTip("S2 阶段提供：撤销后该手机立即失去访问权")
        buttons.addWidget(revoke_btn)
        layout.addLayout(buttons)
        self._refresh_device_list()
        return group

    def _build_settings_group(self) -> QGroupBox:
        group = QGroupBox("服务设置")
        form = QFormLayout(group)
        self._port_spin = QSpinBox()
        self._port_spin.setRange(1024, 65535)
        self._port_spin.setValue(self._controller.port)
        self._apply_btn = QPushButton("保存并重启服务")
        self._apply_btn.clicked.connect(self._on_apply_settings)
        self._autostart_check = QCheckBox("开机自动启动（登录后）")
        self._autostart_check.setEnabled(False)
        self._autostart_check.setToolTip("S2/S3 阶段提供")
        form.addRow("监听端口：", self._port_spin)
        form.addRow("", self._apply_btn)
        form.addRow("", self._autostart_check)
        return group

    def _build_diagnostics_group(self) -> QGroupBox:
        group = QGroupBox("诊断")
        layout = QVBoxLayout(group)
        self._diag_button = QPushButton("检查本机服务（GET /v1/health）")
        self._diag_button.clicked.connect(self._on_run_diagnostic)
        self._diag_result = QLabel("尚未检查。")
        self._diag_result.setWordWrap(True)
        self._diag_result.setTextInteractionFlags(Qt.TextInteractionFlag.TextSelectableByMouse)
        layout.addWidget(self._diag_button)
        layout.addWidget(self._diag_result)
        return group

    # -------------------------------------------------------------- 状态
    def _on_state_changed(self, state: ServiceState) -> None:
        self._service_state_label.setText(_STATE_TEXT.get(state, state.value))
        if state is ServiceState.RUNNING:
            self._address_label.setText("、".join(self._controller.lan_addresses()))
        elif state is ServiceState.ERROR:
            self._address_label.setText("—")
        else:
            self._address_label.setText("—")

    def _refresh_project_list(self) -> None:
        self._project_list.clear()
        for project in self._controller.settings.authorized_projects:
            self._project_list.addItem(f"{project.name}（{project.root_path}）")
        if not self._controller.settings.authorized_projects:
            self._project_list.addItem("（暂无授权项目，S2 阶段添加）")

    def _refresh_device_list(self) -> None:
        self._device_list.clear()
        for device in self._controller.settings.paired_devices:
            self._device_list.addItem(f"{device.name}（配对于 {device.paired_at}）")
        if not self._controller.settings.paired_devices:
            self._device_list.addItem("（暂无已配对手机，S2 阶段配对）")

    # -------------------------------------------------------------- 动作
    def _on_apply_settings(self) -> None:
        from dataclasses import replace

        settings = replace(self._controller.settings, port=self._port_spin.value())
        self._controller.apply_settings(settings)

    def _on_run_diagnostic(self) -> None:
        self._diag_button.setEnabled(False)
        self._diag_result.setText("正在请求…")

        def worker() -> None:
            url = f"http://127.0.0.1:{self._controller.port}/v1/health"
            try:
                with urllib.request.urlopen(url, timeout=3.0) as resp:  # noqa: S310 - 本机回环
                    body = resp.read().decode("utf-8", errors="replace")
                    pretty = json.dumps(json.loads(body), ensure_ascii=False)
                    self._bridge.diagnostic_finished.emit(True, f"HTTP {resp.status} — {pretty}")
            except urllib.error.HTTPError as exc:
                self._bridge.diagnostic_finished.emit(False, f"HTTP {exc.code}（意外状态）")
            except Exception as exc:  # noqa: BLE001 - 诊断需要展示全部失败原因
                self._bridge.diagnostic_finished.emit(False, f"请求失败：{exc}")

        threading.Thread(target=worker, name="pocketcode-diag", daemon=True).start()

    def _on_diagnostic_finished(self, ok: bool, message: str) -> None:
        self._diag_button.setEnabled(True)
        self._diag_result.setText(("✔ " if ok else "✘ ") + message)

    # -------------------------------------------------------------- 关闭
    def closeEvent(self, event) -> None:  # noqa: N802 - Qt 命名
        # PRD §3.3：关闭管理窗口不退出，托盘「退出」才结束服务。
        was_visible = self.isVisible()
        event.ignore()
        self.hide()
        if was_visible and not self._first_hide_hint_shown:
            self._first_hide_hint_shown = True
            QMessageBox.information(
                self,
                "PocketCode",
                "PocketCode 已最小化到系统托盘，服务继续运行。\n右键托盘图标可选择退出。",
            )
