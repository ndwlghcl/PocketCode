"""SettingsStore：持久化、原子写、损坏回退。"""

from __future__ import annotations

from pocketcode.storage.settings_store import (
    AuthorizedProject,
    Settings,
    SettingsStore,
)


def test_roundtrip(settings_path):
    store = SettingsStore(settings_path)
    settings = Settings(
        port=9000,
        authorized_projects=[
            AuthorizedProject(id="id-1", name="demo", root_path=r"D:\code\demo")
        ],
        autostart=False,
    )
    store.save(settings)

    loaded = SettingsStore(settings_path).load()
    assert loaded.port == 9000
    assert loaded.authorized_projects[0].name == "demo"
    assert loaded.authorized_projects[0].root_path == r"D:\code\demo"


def test_missing_file_returns_defaults(settings_path):
    settings = SettingsStore(settings_path).load()
    assert settings.port == 8765
    assert settings.authorized_projects == []
    assert settings.paired_devices == []
    assert settings.autostart is False


def test_corrupt_file_falls_back_to_defaults(settings_path):
    settings_path.write_text("{ not valid json", encoding="utf-8")
    store = SettingsStore(settings_path)
    settings = store.load()
    assert settings.port == 8765
    # 损坏文件保留为备份而不是悄悄覆盖
    assert settings_path.with_suffix(".json.corrupt").exists()


def test_atomic_write_leaves_no_tmp(settings_path):
    store = SettingsStore(settings_path)
    store.save(Settings(port=1234))
    assert not settings_path.with_suffix(".json.tmp").exists()
    assert settings_path.exists()


def test_invalid_port_rejected(settings_path):
    settings_path.write_text('{"port": 80}', encoding="utf-8")
    settings = SettingsStore(settings_path).load()
    assert settings.port == 8765  # 越界端口回退默认值
