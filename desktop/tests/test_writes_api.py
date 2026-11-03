"""S3a 写入接口：保存（冲突/编码/换行/原子）、新建、回收区全流程。"""

from __future__ import annotations

import hashlib
from pathlib import Path

import pytest
from fastapi.testclient import TestClient

from pocketcode.security.auth import generate_device_token, hash_token
from pocketcode.server.app import create_app
from pocketcode.storage.settings_store import (
    AuthorizedProject,
    PairedDevice,
    Settings,
    SettingsStore,
    new_id,
)


@pytest.fixture
def env(tmp_path):
    """已配对 + 已授权一个真实目录的完整环境。"""
    project_dir = tmp_path / "project"
    project_dir.mkdir()
    sample = project_dir / "sample.py"
    sample.write_bytes(b"print('v1')\n")  # LF
    version = "sha256:" + hashlib.sha256(b"print('v1')\n").hexdigest()

    store = SettingsStore(tmp_path / "settings.json")
    project_id = new_id()
    token = generate_device_token()
    store.save(
        Settings(
            authorized_projects=[
                AuthorizedProject(id=project_id, name="project", root_path=str(project_dir))
            ],
            paired_devices=[
                PairedDevice(id=new_id(), name="手机", paired_at="2026-10-25T00:00:00Z",
                             token_hash=hash_token(token))
            ],
        )
    )
    client = TestClient(create_app(store=store))
    client.headers["Authorization"] = f"Bearer {token}"
    client.project_id = project_id  # type: ignore[attr-defined]
    client.project_dir = project_dir  # type: ignore[attr-defined]
    client.current_version = version  # type: ignore[attr-defined]
    return client


def _save(client, path: str, content: str, base_version: str | None = None,
          encoding: str = "utf-8", newline: str = "LF"):
    return client.put(
        f"/v1/projects/{client.project_id}/file",
        json={
            "path": path,
            "base_version": base_version or client.current_version,
            "content": content,
            "encoding": encoding,
            "newline": newline,
        },
    )


# ------------------------------------------------------------------ 保存
def test_save_writes_and_returns_new_version(env):
    resp = _save(env, "sample.py", "print('v2')\n")
    assert resp.status_code == 200
    body = resp.json()
    assert body["version"] == "sha256:" + hashlib.sha256(b"print('v2')\n").hexdigest()
    assert body["size"] == 12
    # 磁盘字节确已改变
    assert (env.project_dir / "sample.py").read_bytes() == b"print('v2')\n"


def test_save_preserves_crlf_and_bom(env):
    crlf_file = env.project_dir / "win.py"
    crlf_file.write_bytes(b"print('v1')\r\n")
    crlf_version = "sha256:" + hashlib.sha256(b"print('v1')\r\n").hexdigest()

    bom_file = env.project_dir / "bom.py"
    bom_file.write_bytes("print('v1')\r\n".encode("utf-8-sig"))
    bom_version = "sha256:" + hashlib.sha256("print('v1')\r\n".encode("utf-8-sig")).hexdigest()

    resp = env.put(
        f"/v1/projects/{env.project_id}/file",
        json={
            "path": "win.py",
            "base_version": crlf_version,
            "content": "print('v2')\n",  # 手机端发送 LF 归一内容
            "encoding": "utf-8",
            "newline": "CRLF",
        },
    )
    assert resp.status_code == 200
    assert (env.project_dir / "win.py").read_bytes() == b"print('v2')\r\n"

    resp = env.put(
        f"/v1/projects/{env.project_id}/file",
        json={
            "path": "bom.py",
            "base_version": bom_version,
            "content": "print('v2')\n",
            "encoding": "utf-8-bom",
            "newline": "CRLF",
        },
    )
    assert resp.status_code == 200
    assert (env.project_dir / "bom.py").read_bytes() == "print('v2')\r\n".encode("utf-8-sig")


def test_save_conflict_409_with_current_version(env):
    env.current_version = "sha256:" + "0" * 64  # 故意过期
    resp = _save(env, "sample.py", "print('x')\n")
    assert resp.status_code == 409
    body = resp.json()
    assert body["error"]["code"] == "VERSION_CONFLICT"
    details = body["error"]["details"]
    assert details["current_version"] == (
        "sha256:" + hashlib.sha256(b"print('v1')\n").hexdigest()
    )
    # 冲突时磁盘不得被改动
    assert (env.project_dir / "sample.py").read_bytes() == b"print('v1')\n"


def test_save_missing_file_404_and_invalid_path_400(env):
    resp = _save(env, "nope.py", "x\n")
    assert resp.status_code == 404
    assert resp.json()["error"]["code"] == "FILE_NOT_FOUND"

    resp = _save(env, "../outside.py", "x\n")
    assert resp.status_code == 400
    assert resp.json()["error"]["code"] == "PATH_INVALID"


def test_save_creates_recoverable_snapshot(env):
    snapshots = env.project_dir.parent.parent / "settings-dir" / "snapshots"
    # 快照目录在 settings.json 旁边：tmp_path/settings.json → tmp_path/snapshots
    snapshots = env.project_dir.parent / "snapshots"
    resp = _save(env, "sample.py", "print('v2')\n")
    assert resp.status_code == 200
    snap_files = list(snapshots.rglob("*.bin"))
    assert len(snap_files) == 1
    assert snap_files[0].read_bytes() == b"print('v1')\n"  # 旧内容可恢复


def test_save_oversized_content_413(env):
    resp = _save(env, "sample.py", "x" * (4 * 1024 * 1024 + 1))
    assert resp.status_code == 413
    assert resp.json()["error"]["code"] == "FILE_TOO_LARGE"


# ------------------------------------------------------------------ 新建
def test_create_file_and_dir(env):
    resp = env.post(
        f"/v1/projects/{env.project_id}/files",
        json={"path": "agents/new_tool.py", "type": "file", "content": "# new\n"},
    )
    assert resp.status_code == 201
    body = resp.json()
    assert body["type"] == "file"
    assert body["manifest_revision"] >= 1
    assert (env.project_dir / "agents" / "new_tool.py").read_bytes() == b"# new\n"

    resp = env.post(
        f"/v1/projects/{env.project_id}/files",
        json={"path": "agents/sub", "type": "dir"},
    )
    assert resp.status_code == 201
    assert (env.project_dir / "agents" / "sub").is_dir()


def test_create_existing_409(env):
    resp = env.post(
        f"/v1/projects/{env.project_id}/files",
        json={"path": "sample.py", "type": "file"},
    )
    assert resp.status_code == 409
    assert resp.json()["error"]["code"] == "ALREADY_EXISTS"


def test_create_never_overwrites_file_created_by_external_program(env, monkeypatch):
    import os
    publish = os.link
    target = env.project_dir / "new.py"

    def external_create_then_publish(source, destination):
        target.write_bytes(b"EXTERNAL IDE CONTENT")
        return publish(source, destination)

    monkeypatch.setattr(os, "link", external_create_then_publish)
    response = env.post(f"/v1/projects/{env.project_id}/files",
                        json={"path": "new.py", "type": "file", "content": "PHONE"})
    assert response.status_code == 409
    assert response.json()["error"]["code"] == "ALREADY_EXISTS"
    assert target.read_bytes() == b"EXTERNAL IDE CONTENT"
    assert list(env.project_dir.glob(".pocketcode-tmp-*")) == []


def test_concurrent_service_creates_have_one_winner(tmp_path):
    from concurrent.futures import ThreadPoolExecutor
    from pocketcode.services.writes import create_entry, WriteServiceError

    def create(number):
        try:
            create_entry(tmp_path, "same.py", "file", content=str(number))
            return number
        except WriteServiceError as error:
            assert error.code == "ALREADY_EXISTS"
            return None

    with ThreadPoolExecutor(max_workers=8) as pool:
        results = list(pool.map(create, range(8)))
    winners = [number for number in results if number is not None]
    assert len(winners) == 1
    assert (tmp_path / "same.py").read_text() == str(winners[0])
    assert list(tmp_path.glob(".pocketcode-tmp-*")) == []


# ------------------------------------------------------------------ 回收区
def _trash(env, *paths: str):
    return env.post(f"/v1/projects/{env.project_id}/trash", json={"paths": list(paths)})


def test_trash_move_list_restore(env):
    (env.project_dir / "old").mkdir()
    (env.project_dir / "old" / "keep.txt").write_bytes(b"k")

    resp = _trash(env, "sample.py", "old")
    assert resp.status_code == 200
    items = resp.json()["items"]
    assert [i["path"] for i in items] == ["sample.py", "old"]
    assert not (env.project_dir / "sample.py").exists()
    assert not (env.project_dir / "old").exists()

    listing = env.get("/v1/trash")
    assert listing.status_code == 200
    entries = listing.json()["items"]
    assert {e["original_path"] for e in entries} == {"sample.py", "old"}
    assert all("/" not in e["original_path"] or not e["original_path"].startswith("/") for e in entries)

    # 恢复 sample.py
    sample_entry = next(e for e in entries if e["original_path"] == "sample.py")
    resp = env.post(f"/v1/trash/{sample_entry['trash_id']}/restore")
    assert resp.status_code == 200
    assert resp.json()["restored_path"] == "sample.py"
    assert (env.project_dir / "sample.py").read_bytes() == b"print('v1')\n"


def test_trash_batch_is_atomic_on_missing_path(env):
    resp = _trash(env, "sample.py", "ghost.py")
    assert resp.status_code == 404
    assert resp.json()["error"]["details"]["path"] == "ghost.py"
    # 整批未执行：sample.py 仍在
    assert (env.project_dir / "sample.py").exists()


def test_restore_into_occupied_409_with_suggestion(env):
    assert _trash(env, "sample.py").status_code == 200
    # 原路径重新被占用
    (env.project_dir / "sample.py").write_bytes(b"occupied")
    listing = env.get("/v1/trash").json()["items"]
    trash_id = listing[0]["trash_id"]
    resp = env.post(f"/v1/trash/{trash_id}/restore")
    assert resp.status_code == 409
    body = resp.json()
    assert body["error"]["code"] == "ALREADY_EXISTS"
    assert body["error"]["details"]["suggested_path"].startswith("sample (1)")


def test_trash_purge_and_single_delete(env):
    assert _trash(env, "sample.py").status_code == 200
    trash_id = env.get("/v1/trash").json()["items"][0]["trash_id"]

    resp = env.delete(f"/v1/trash/{trash_id}")
    assert resp.status_code == 204
    assert env.get("/v1/trash").json()["items"] == []

    # 清空空回收区也返回 204
    assert env.delete("/v1/trash").status_code == 204
    assert env.post(f"/v1/trash/{trash_id}/restore").status_code == 404


def test_write_endpoints_require_auth(env):
    anonymous = TestClient(env.app)
    resp = anonymous.put(
        f"/v1/projects/{env.project_id}/file",
        json={"path": "a.py", "base_version": "sha256:" + "0" * 64,
              "content": "x", "encoding": "utf-8", "newline": "LF"},
    )
    assert resp.status_code == 401


def _move(client, target="renamed.py", path="sample.py", version=None):
    return client.post(f"/v1/projects/{client.project_id}/files/move", json={
        "path": path, "target_path": target, "base_version": version or client.current_version,
    })


def test_move_file_preserves_bytes_and_rejects_conflicts(env):
    folder = env.project_dir / "folder"
    folder.mkdir()
    before = (env.project_dir / "sample.py").read_bytes()
    response = _move(env, "folder/中文.py")
    assert response.status_code == 200
    assert response.json()["target_path"] == "folder/中文.py"
    assert response.json()["version"] == env.current_version
    assert not (env.project_dir / "sample.py").exists()
    assert (folder / "中文.py").read_bytes() == before
    (env.project_dir / "occupied.py").write_bytes(b"keep")
    response = _move(env, "occupied.py", "folder/中文.py")
    assert response.status_code == 409
    assert response.json()["error"]["code"] == "ALREADY_EXISTS"
    assert (env.project_dir / "occupied.py").read_bytes() == b"keep"
    assert (folder / "中文.py").read_bytes() == before


def test_move_checks_source_version_paths_and_auth(env):
    assert _move(env, version="sha256:" + "0" * 64).json()["error"]["code"] == "VERSION_CONFLICT"
    assert _move(env, "../escape.py").status_code == 400
    assert _move(env, "sample.py:stream").status_code == 400
    assert _move(env, "missing/name.py").status_code == 404
    assert _move(env, path="missing.py").status_code == 404
    anonymous = TestClient(env.app)
    assert anonymous.post(f"/v1/projects/{env.project_id}/files/move", json={"path": "sample.py", "target_path": "b.py", "base_version": env.current_version}).status_code == 401
    assert (env.project_dir / "sample.py").exists()
    env.app.state.store.remove_authorized_project(env.project_id)
    assert _move(env).json()["error"]["code"] == "PROJECT_NOT_FOUND"


def test_move_external_target_creation_is_not_overwritten(env, monkeypatch):
    from pocketcode.services import writes
    original = writes._rename_exclusive

    def race(source, target):
        target.write_bytes(b"external IDE")
        return original(source, target)

    monkeypatch.setattr(writes, "_rename_exclusive", race)
    response = _move(env)
    assert response.status_code == 409
    assert response.json()["error"]["code"] == "ALREADY_EXISTS"
    assert (env.project_dir / "renamed.py").read_bytes() == b"external IDE"
    assert (env.project_dir / "sample.py").read_bytes() == b"print('v1')\n"


def test_move_rejects_directory_and_oversized_source(env):
    (env.project_dir / "dir").mkdir()
    assert _move(env, "elsewhere", "dir").status_code == 404
    (env.project_dir / "big.bin").write_bytes(b"x" * (4 * 1024 * 1024 + 1))
    assert _move(env, "other.bin", "big.bin").status_code == 413


def test_move_rejects_symbolic_links_even_inside_project(env):
    linked = env.project_dir / "linked.py"
    try:
        linked.symlink_to(env.project_dir / "sample.py")
    except OSError:
        pytest.skip("Windows symlink privilege unavailable")
    assert _move(env, "new.py", "linked.py").status_code == 403
    assert _move(env, "linked.py").status_code == 403
    assert (env.project_dir / "sample.py").exists()


def test_restore_rechecks_project_authorization(env):
    assert _trash(env, 'sample.py').status_code == 200
    trash_id = env.get('/v1/trash').json()['items'][0]['trash_id']
    env.app.state.store.remove_authorized_project(env.project_id)
    response = env.post(f'/v1/trash/{trash_id}/restore')
    assert response.status_code == 404
    assert response.json()['error']['code'] == 'PROJECT_NOT_FOUND'
    assert not (env.project_dir / 'sample.py').exists()
    assert len(env.get('/v1/trash').json()['items']) == 1


def test_restore_rechecks_changed_directory_boundary(env):
    import subprocess
    folder = env.project_dir / 'folder'
    folder.mkdir()
    (folder / 'keep.txt').write_bytes(b'keep')
    assert _trash(env, 'folder/keep.txt').status_code == 200
    trash_id = env.get('/v1/trash').json()['items'][0]['trash_id']
    folder.rmdir()
    outside = env.project_dir.parent / 'outside'
    outside.mkdir()
    result = subprocess.run(['cmd', '/c', 'mklink', '/J', str(folder), str(outside)],
                            capture_output=True)
    if result.returncode:
        pytest.skip('无法创建 junction')
    try:
        response = env.post(f'/v1/trash/{trash_id}/restore')
        assert response.status_code == 403
        assert response.json()['error']['code'] == 'PATH_FORBIDDEN'
        assert not (outside / 'keep.txt').exists()
    finally:
        folder.rmdir()


def test_linked_write_paths_return_forbidden_without_touching_outside(env):
    import subprocess
    outside = env.project_dir.parent / 'outside-write'
    outside.mkdir()
    (outside / 'keep.py').write_bytes(b'keep\n')
    link = env.project_dir / 'linked'
    result = subprocess.run(['cmd', '/c', 'mklink', '/J', str(link), str(outside)],
                            capture_output=True)
    if result.returncode:
        pytest.skip('无法创建 junction')
    try:
        saved = _save(env, 'linked/keep.py', 'changed\n')
        created = env.post(f'/v1/projects/{env.project_id}/files',
                           json={'path': 'linked/new.py', 'type': 'file'})
        assert saved.status_code == created.status_code == 403
        assert saved.json()['error']['code'] == 'PATH_FORBIDDEN'
        assert (outside / 'keep.py').read_bytes() == b'keep\n'
        assert not (outside / 'new.py').exists()
    finally:
        link.rmdir()
