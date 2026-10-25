"""S3 收尾：快照恢复（服务层）与桌面端「历史版本」控制方法。

覆盖：恢复往返、恢复前自动再快照、路径越界拒绝、非法快照文件拒绝、
GUI 冒烟（历史版本区块存在与接线）。
"""

from __future__ import annotations

import os
from pathlib import Path

import pytest

from pocketcode.services.snapshots import (
    list_snapshot_paths,
    list_snapshots,
    restore_snapshot,
    snapshot_previous,
)
from pocketcode.storage.settings_store import AuthorizedProject, SettingsStore, new_id


@pytest.fixture
def env(tmp_path: Path):
    """一个授权项目 + 两次覆盖保存产生的两份快照。"""
    project_dir = tmp_path / "project"
    project_dir.mkdir()
    (project_dir / "sample.py").write_bytes(b"print('v1')\n")
    snapshots_root = tmp_path / "snapshots"
    project_id = new_id()
    return {
        "project_dir": project_dir,
        "snapshots_root": snapshots_root,
        "project_id": project_id,
    }


def _two_snapshots(env) -> None:
    snapshot_previous(
        env["snapshots_root"], env["project_id"], "sample.py", b"print('v1')\n"
    )
    snapshot_previous(
        env["snapshots_root"], env["project_id"], "sample.py", b"print('v2')\n"
    )


def test_restore_roundtrip_restores_old_content(env):
    _two_snapshots(env)
    (env["project_dir"] / "sample.py").write_bytes(b"print('v3')\n")

    snapshots = list_snapshots(env["snapshots_root"], env["project_id"], "sample.py")
    assert len(snapshots) == 2

    restore_snapshot(
        env["snapshots_root"],
        env["project_dir"],
        env["project_id"],
        "sample.py",
        Path(snapshots[-1]["snapshot_file"]),  # 最旧的一份 = v1
    )
    assert (env["project_dir"] / "sample.py").read_text(encoding="utf-8") == "print('v1')\n"


def test_restore_snapshots_current_content_first(env):
    """恢复本身可回退：写回前当前内容必须自动成为一份新快照。"""
    _two_snapshots(env)
    (env["project_dir"] / "sample.py").write_bytes(b"print('v3')\n")

    snapshots = list_snapshots(env["snapshots_root"], env["project_id"], "sample.py")
    restore_snapshot(
        env["snapshots_root"],
        env["project_dir"],
        env["project_id"],
        "sample.py",
        Path(snapshots[0]["snapshot_file"]),
    )

    after = list_snapshots(env["snapshots_root"], env["project_id"], "sample.py")
    contents = {Path(s["snapshot_file"]).read_bytes() for s in after}
    assert b"print('v3')\n" in contents, "恢复前的当前内容必须先入快照"


def test_list_snapshot_paths_aggregates_by_file(env):
    _two_snapshots(env)
    snapshot_previous(
        env["snapshots_root"], env["project_id"], "other.py", b"x = 1\n"
    )

    files = list_snapshot_paths(env["snapshots_root"], env["project_id"])
    by_path = {entry["path"]: entry for entry in files}
    assert set(by_path) == {"sample.py", "other.py"}
    assert by_path["sample.py"]["count"] == 2
    assert by_path["other.py"]["count"] == 1
    # 新→旧：other.py 刚快照过，排最前
    assert files[0]["path"] == "other.py"


def test_restore_rejects_path_escape_from_meta(env, tmp_path):
    """快照元数据被篡改成越界路径时，恢复必须拒绝（path_guard 复查）。"""
    _two_snapshots(env)
    snapshots = list_snapshots(env["snapshots_root"], env["project_id"], "sample.py")

    outside = tmp_path / "outside.txt"
    outside.write_bytes(b"victim")
    with pytest.raises(Exception) as excinfo:
        restore_snapshot(
            env["snapshots_root"],
            env["project_dir"],
            env["project_id"],
            "../outside.txt",
            Path(snapshots[0]["snapshot_file"]),
        )
    assert "PATH_" in str(excinfo.value) or "越" in str(excinfo.value)
    assert outside.read_text(encoding="utf-8") == "victim", "越界文件不得被触碰"


def test_restore_missing_snapshot_file_errors(env):
    with pytest.raises(OSError):
        restore_snapshot(
            env["snapshots_root"],
            env["project_dir"],
            env["project_id"],
            "sample.py",
            env["snapshots_root"] / env["project_id"] / "nope.bin",
        )


# ---------------------------------------------------------------- 控制器层
def _controller_with_project(tmp_path: Path, env):
    from pocketcode.app_controller import AppController
    from pocketcode.storage.settings_store import Settings, SettingsStore

    settings_path = tmp_path / "settings.json"
    store = SettingsStore(settings_path)
    store.save(
        Settings(
            authorized_projects=[
                AuthorizedProject(
                    id=env["project_id"],
                    name="project",
                    root_path=str(env["project_dir"]),
                )
            ]
        )
    )
    return AppController(store), settings_path


def test_controller_snapshot_listing_and_restore(tmp_path, env):
    controller, _settings_path = _controller_with_project(tmp_path, env)
    assert controller.settings.authorized_projects[0].id == env["project_id"]

    assert controller.snapshot_projects() == []
    _two_snapshots(env)

    projects = controller.snapshot_projects()
    assert len(projects) == 1
    assert projects[0]["id"] == env["project_id"]
    assert projects[0]["file_count"] == 1

    files = controller.snapshot_files(env["project_id"])
    assert files[0]["path"] == "sample.py"

    snapshots = controller.file_snapshots(env["project_id"], "sample.py")
    assert len(snapshots) == 2

    (env["project_dir"] / "sample.py").write_bytes(b"print('v9')\n")
    controller.restore_file_snapshot(
        env["project_id"], "sample.py", snapshots[-1]["snapshot_file"]
    )
    assert (env["project_dir"] / "sample.py").read_text(encoding="utf-8") == "print('v1')\n"
    # 恢复前的 v9 内容也入快照
    assert len(controller.file_snapshots(env["project_id"], "sample.py")) == 3


def test_controller_restore_rejects_bad_snapshot_path(tmp_path, env):
    controller, _settings_path = _controller_with_project(tmp_path, env)
    _two_snapshots(env)

    with pytest.raises(ValueError):
        controller.restore_file_snapshot(
            env["project_id"], "sample.py", str(tmp_path / "evil.bin")
        )
    with pytest.raises(ValueError):
        controller.restore_file_snapshot(
            env["project_id"], "sample.py", "not-a-snapshot-path"
        )


def test_controller_restore_unknown_project(tmp_path, env):
    controller, _settings_path = _controller_with_project(tmp_path, env)
    with pytest.raises(ValueError, match="项目不存在"):
        controller.restore_file_snapshot(new_id(), "sample.py", "whatever.bin")


# ---------------------------------------------------------------- GUI 冒烟
def test_main_window_has_snapshots_group(settings_path):
    os.environ.setdefault("QT_QPA_PLATFORM", "offscreen")
    pytest.importorskip("PySide6", reason="PySide6 未安装则跳过 GUI 冒烟测试")
    from PySide6.QtWidgets import QApplication, QGroupBox

    from pocketcode.app_controller import AppController
    from pocketcode.gui.main_window import MainWindow

    app = QApplication.instance() or QApplication([])
    controller = AppController(SettingsStore(settings_path))
    window = MainWindow(controller)

    titles = [g.title() for g in window.findChildren(QGroupBox)]
    assert "历史版本（覆盖前快照）" in titles
    window.close()


def test_main_window_snapshots_flow_offscreen(tmp_path, env):
    """offscreen 驱动一遍选项目→选文件→恢复，验证 UI 与控制器接线。"""
    os.environ.setdefault("QT_QPA_PLATFORM", "offscreen")
    pytest.importorskip("PySide6", reason="PySide6 未安装则跳过 GUI 冒烟测试")
    from PySide6.QtWidgets import QApplication

    from pocketcode.app_controller import AppController
    from pocketcode.gui.main_window import MainWindow
    from pocketcode.storage.settings_store import Settings, SettingsStore

    store = SettingsStore(tmp_path / "settings.json")
    store.save(
        Settings(
            authorized_projects=[
                AuthorizedProject(
                    id=env["project_id"],
                    name="project",
                    root_path=str(env["project_dir"]),
                )
            ]
        )
    )
    _two_snapshots(env)
    app = QApplication.instance() or QApplication([])
    controller = AppController(store)
    window = MainWindow(controller)

    # 项目下拉已列出有快照的项目
    assert window._snapshot_project_combo.count() == 1
    window._snapshot_project_combo.setCurrentIndex(0)
    assert window._snapshot_file_list.count() == 1

    window._snapshot_file_list.setCurrentRow(0)
    assert window._snapshot_version_list.count() == 2

    # 选最旧的快照并恢复（跳过确认弹窗，直接走已确认的内部方法）
    (env["project_dir"] / "sample.py").write_bytes(b"print('v9')\n")
    window._snapshot_version_list.setCurrentRow(1)
    version_item = window._snapshot_version_list.currentItem()
    window._restore_snapshot_confirmed(
        env["project_id"], "sample.py", version_item
    )

    assert (
        env["project_dir"] / "sample.py"
    ).read_text(encoding="utf-8") == "print('v1')\n"
    window.close()
