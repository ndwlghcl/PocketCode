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


def test_server_identity_auto_generated(settings_path):
    store = SettingsStore(settings_path)
    server_id, server_name = store.ensure_server_identity()
    assert len(server_id) == 36
    assert server_name  # 默认取主机名
    # 第二次调用幂等
    assert store.ensure_server_identity() == (server_id, server_name)


def test_add_and_remove_paired_device(settings_path):
    store = SettingsStore(settings_path)
    from pocketcode.storage.settings_store import PairedDevice, new_id

    device = PairedDevice(id=new_id(), name="手机", paired_at="2026-10-25T00:00:00Z",
                          token_hash="a" * 64)
    store.add_paired_device(device)
    assert [d.id for d in store.load().paired_devices] == [device.id]
    # 同 id 覆盖而不是重复
    store.add_paired_device(device)
    assert len(store.load().paired_devices) == 1
    assert store.remove_paired_device(device.id) is True
    assert store.load().paired_devices == []
    assert store.remove_paired_device(device.id) is False


def test_add_and_remove_authorized_project(settings_path):
    store = SettingsStore(settings_path)
    from pocketcode.storage.settings_store import AuthorizedProject, new_id

    project = AuthorizedProject(id=new_id(), name="demo", root_path=r"D:\code\demo")
    store.add_authorized_project(project)
    assert store.load().authorized_projects[0].name == "demo"
    # 重复目录被拒
    import pytest

    with pytest.raises(ValueError):
        store.add_authorized_project(project)
    assert store.remove_authorized_project(project.id) is True
    assert store.load().authorized_projects == []


def test_old_settings_file_without_new_fields_loads(settings_path):
    """S0 时代的设置文件（无 server_id/token_hash/revision）必须能继续加载。"""
    settings_path.write_text(
        '{"port": 8765, "authorized_projects": [{"id": "x", "name": "n", "root_path": "D:\\\\x"}],'
        ' "paired_devices": [{"id": "d", "name": "phone", "paired_at": "2026-10-24T00:00:00Z"}],'
        ' "autostart": false, "schema_version": 1}',
        encoding="utf-8",
    )
    settings = SettingsStore(settings_path).load()
    assert settings.server_id == ""
    assert settings.authorized_projects[0].revision == 0
    assert settings.paired_devices[0].token_hash == ""
