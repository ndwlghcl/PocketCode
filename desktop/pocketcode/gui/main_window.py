"""管理主窗口：连接状态 / 已授权项目 / 配对手机 / 服务设置 / 诊断 五个区块。

S0 为骨架：项目与配对列表展示持久化数据（当前为空），添加/移除能力在 S2
由「Windows UI GLM」补齐（任务书任务 2）；本窗口绝不做代码编辑器（PRD §3.1）。
"""

from __future__ import annotations

import json
import ssl
import threading
import urllib.error
import urllib.request

from PySide6.QtCore import Qt
from PySide6.QtWidgets import (
    QCheckBox,
    QFileDialog,
    QFormLayout,
    QGroupBox,
    QHBoxLayout,
    QLabel,
    QListWidgetItem,
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
from pocketcode.gui.pairing_dialogs import (
    PairingConfirmationBroker,
    PairingQrDialog,
    ask_pair_confirmation,
)

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
        # 托盘「退出」置为 True 后再 QApplication.quit()：Qt 6.5+ 的 quit()
        # 会先逐个关闭顶层窗口，closeEvent 需据此区分“用户点 ✕”和“真退出”。
        self.allow_close = False

        self.setWindowTitle("PocketCode 管理窗口")
        self.resize(520, 720)
        self._build_ui()

        controller.add_listener(self._bridge.service_state_changed.emit)
        self._on_state_changed(controller.state)

        # 配对确认：服务线程回调 → 主线程弹窗
        self._pairing_broker = PairingConfirmationBroker(
            controller.pairing.confirm_timeout_seconds
        )
        self._pairing_broker.pair_requested.connect(self._on_pair_requested)
        controller.pairing.set_confirmation_callback(self._pairing_broker.callback)

    def _on_pair_requested(self, request_id: str, device_name: str, platform: str) -> None:
        ask_pair_confirmation(
            self, request_id, device_name, platform, self._pairing_broker
        )
        self._refresh_device_list()  # 配对成败都会改变设备列表
        self.raise_()
        self.activateWindow()

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
        self._fingerprint_label = QLabel("—")
        self._fingerprint_label.setWordWrap(True)
        self._fingerprint_label.setTextInteractionFlags(Qt.TextInteractionFlag.TextSelectableByMouse)
        fingerprint_font = self._fingerprint_label.font()
        fingerprint_font.setPointSize(max(fingerprint_font.pointSize() - 2, 7))
        self._fingerprint_label.setFont(fingerprint_font)
        hint = QLabel("局域网地址将在 S2 配对时写入二维码；证书指纹供手机配对时人工核对。")
        hint.setWordWrap(True)
        form.addRow("服务：", self._service_state_label)
        form.addRow("地址：", self._address_label)
        form.addRow("证书指纹：", self._fingerprint_label)
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
        add_btn.clicked.connect(self._on_add_project)
        remove_btn.clicked.connect(self._on_remove_project)
        add_btn.setToolTip("选择一个本机目录授权给手机访问")
        remove_btn.setToolTip("移除后手机将无法再访问该目录")
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
        qr_btn = QPushButton("显示配对二维码…")
        revoke_btn = QPushButton("撤销所选设备授权")
        qr_btn.clicked.connect(self._on_show_pairing_qr)
        revoke_btn.clicked.connect(self._on_revoke_device)
        qr_btn.setToolTip("手机扫码后发起配对，本机确认后生效")
        revoke_btn.setToolTip("撤销后该手机立即失去访问权")
        buttons.addWidget(qr_btn)
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
            self._fingerprint_label.setText(self._controller.tls_fingerprint or "—")
        else:
            self._address_label.setText("—")
            if state in (ServiceState.STOPPED, ServiceState.PAUSED):
                self._fingerprint_label.setText(self._controller.tls_fingerprint or "—")

    def _refresh_project_list(self) -> None:
        self._project_list.clear()
        projects = self._controller.settings.authorized_projects
        for project in projects:
            item = QListWidgetItem(f"{project.name}（{project.root_path}）")
            item.setData(Qt.ItemDataRole.UserRole, project.id)
            self._project_list.addItem(item)
        if not projects:
            placeholder = QListWidgetItem("（暂无授权项目，点「添加项目…」选择文件夹）")
            placeholder.setFlags(Qt.ItemFlag.NoItemFlags)
            self._project_list.addItem(placeholder)

    def _refresh_device_list(self) -> None:
        self._device_list.clear()
        devices = self._controller.settings.paired_devices
        for device in devices:
            item = QListWidgetItem(f"{device.name}（配对于 {device.paired_at}）")
            item.setData(Qt.ItemDataRole.UserRole, device.id)
            self._device_list.addItem(item)
        if not devices:
            placeholder = QListWidgetItem("（暂无已配对手机，点「显示配对二维码…」）")
            placeholder.setFlags(Qt.ItemFlag.NoItemFlags)
            self._device_list.addItem(placeholder)

    # -------------------------------------------------------------- 项目与设备
    def _on_add_project(self) -> None:
        directory = QFileDialog.getExistingDirectory(
            self, "选择要授权给手机访问的项目文件夹"
        )
        if not directory:
            return
        try:
            self._controller.add_project(directory)
        except ValueError as exc:
            QMessageBox.warning(self, "添加项目失败", str(exc))
            return
        self._refresh_project_list()

    def _on_remove_project(self) -> None:
        item = self._project_list.currentItem()
        project_id = item.data(Qt.ItemDataRole.UserRole) if item else None
        if not project_id:
            QMessageBox.information(self, "移除项目", "请先选择一个项目。")
            return
        confirm = QMessageBox.question(
            self, "移除项目", "移除后手机将无法访问该项目目录。确认移除？"
        )
        if confirm is not QMessageBox.StandardButton.Yes:
            return
        self._controller.remove_project(project_id)
        self._refresh_project_list()

    def _on_revoke_device(self) -> None:
        item = self._device_list.currentItem()
        device_id = item.data(Qt.ItemDataRole.UserRole) if item else None
        if not device_id:
            QMessageBox.information(self, "撤销授权", "请先选择一台设备。")
            return
        confirm = QMessageBox.question(
            self, "撤销设备授权", "撤销后该手机将立即失去访问权。确认撤销？"
        )
        if confirm is not QMessageBox.StandardButton.Yes:
            return
        self._controller.revoke_device(device_id)
        self._refresh_device_list()

    def _on_show_pairing_qr(self) -> None:
        code = self._controller.pairing.create_session()
        payload = self._controller.pairing_qr_payload(code)
        PairingQrDialog(payload, code, parent=self).exec()

    # -------------------------------------------------------------- 动作
    def _on_apply_settings(self) -> None:
        from dataclasses import replace

        settings = replace(self._controller.settings, port=self._port_spin.value())
        self._controller.apply_settings(settings)

    def _on_run_diagnostic(self) -> None:
        self._diag_button.setEnabled(False)
        self._diag_result.setText("正在请求…")

        def worker() -> None:
            url = f"https://127.0.0.1:{self._controller.port}/v1/health"
            # 本机自检只确认服务存活；自签证书校验由手机端配对流程负责。
            context = ssl.create_default_context()
            context.check_hostname = False
            context.verify_mode = ssl.CERT_NONE
            try:
                with urllib.request.urlopen(url, timeout=3.0, context=context) as resp:  # noqa: S310 - 本机回环
                    body = resp.read().decode("utf-8", errors="replace")
                    pretty = json.dumps(json.loads(body), ensure_ascii=False)
                    self._bridge.diagnostic_finished.emit(True, f"HTTPS {resp.status} — {pretty}")
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
        if self.allow_close:
            # 托盘「退出」触发的关闭：放行，让应用正常结束。
            event.accept()
            return
        # PRD §3.3：用户点 ✕ 是“隐藏到托盘”，不是退出。
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
