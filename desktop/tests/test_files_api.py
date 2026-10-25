"""只读文件接口：manifest 过滤/修订号 + 文件读取的编码/限制/越界（S2c）。"""

from __future__ import annotations

import hashlib
import subprocess
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
def project_dir(tmp_path):
    root = tmp_path / "project"
    (root / "agents").mkdir(parents=True)
    (root / "agents" / "__pycache__").mkdir()
    (root / "node_modules").mkdir()
    # 注意用 write_bytes 绕开 Windows 文本模式的 \n → \r\n 翻译，保证字节可控
    (root / "agents" / "react_agent.py").write_bytes(b"print('react')\n")
    (root / "agents" / "__pycache__" / "a.pyc").write_bytes(b"\x00\x01")
    (root / "node_modules" / "x.js").write_bytes(b"// x\n")
    (root / "sample.py").write_bytes(b"print('hello')\n")
    (root / "bom_win.py").write_bytes("print('bom')\r\n".encode("utf-8-sig"))
    (root / "utf16.txt").write_bytes("中文16\r\n".encode("utf-16"))  # utf-16 自带 LE BOM
    (root / "logo.png").write_bytes(b"\x89PNG\r\n\x1a\n" + b"\x00" * 32)
    (root / "secret.pem").write_text("PRIVATE KEY", encoding="utf-8", newline="")
    (root / ".env").write_text("SECRET=1", encoding="utf-8", newline="")
    return root


@pytest.fixture
def client(tmp_path, project_dir):
    store = SettingsStore(tmp_path / "settings.json")
    project_id = new_id()
    token = generate_device_token()
    store.save(
        Settings(
            authorized_projects=[
                AuthorizedProject(
                    id=project_id, name="project", root_path=str(project_dir)
                )
            ],
            paired_devices=[
                PairedDevice(id=new_id(), name="手机", paired_at="2026-10-25T00:00:00Z",
                             token_hash=hash_token(token))
            ],
        )
    )
    app = create_app(store=store)
    client = TestClient(app)
    client.headers["Authorization"] = f"Bearer {token}"
    client.project_id = project_id  # type: ignore[attr-defined]
    client.store = store  # type: ignore[attr-defined]
    return client


def _manifest(client):
    return client.get(f"/v1/projects/{client.project_id}/manifest")


def _paths(node, prefix=""):
    """展平 manifest 为 (path, type) 集合。"""
    results = set()
    for child in node["children"]:
        results.add((child["path"], child["type"]))
        if child["type"] == "dir":
            results |= _paths(child)
    return results


def test_manifest_filters_sensitive_and_dependency_dirs(client):
    resp = _manifest(client)
    assert resp.status_code == 200
    body = resp.json()
    assert body["truncated"] is False
    assert body["project_id"] == client.project_id
    paths = _paths(body["root"])
    assert ("sample.py", "file") in paths
    assert ("agents/react_agent.py", "file") in paths
    assert ("agents", "dir") in paths
    # 过滤：依赖目录、隐藏文件、密钥
    assert ("node_modules", "dir") not in paths
    assert ("agents/__pycache__", "dir") not in paths
    assert ("secret.pem", "file") not in paths
    assert (".env", "file") not in paths
    assert ("logo.png", "file") in paths  # 二进制文件可出现在树里，读取时才拒绝


def test_manifest_revision_stable_then_bumped(client, project_dir):
    first = _manifest(client).json()
    second = _manifest(client).json()
    assert first["revision"] == second["revision"]  # 内容无变化不递增

    (project_dir / "sample.py").write_text("print('changed')\n", encoding="utf-8")
    third = _manifest(client).json()
    assert third["revision"] == first["revision"] + 1

    fourth = _manifest(client).json()
    assert fourth["revision"] == third["revision"]


def test_manifest_truncated_flag(client, monkeypatch):
    from pocketcode.services import files as files_service

    monkeypatch.setattr(files_service, "MAX_MANIFEST_ENTRIES", 3)
    body = _manifest(client).json()
    assert body["truncated"] is True
    # 即使截断，结构仍合法（root 为 dir 节点）
    assert body["root"]["type"] == "dir"


def test_read_utf8_lf_file(client):
    resp = client.get(
        f"/v1/projects/{client.project_id}/file", params={"path": "sample.py"}
    )
    assert resp.status_code == 200
    body = resp.json()
    assert body["content"] == "print('hello')\n"
    assert body["encoding"] == "utf-8"
    assert body["newline"] == "LF"
    assert body["size"] == 15
    expected = "sha256:" + hashlib.sha256(b"print('hello')\n").hexdigest()
    assert body["version"] == expected
    assert body["read_only"] is False
    assert body["mtime"].endswith("Z")


def test_read_utf8_bom_crlf_file(client):
    body = client.get(
        f"/v1/projects/{client.project_id}/file", params={"path": "bom_win.py"}
    ).json()
    assert body["encoding"] == "utf-8-bom"
    assert body["newline"] == "CRLF"
    assert body["content"] == "print('bom')\r\n"  # BOM 不在 content 里


def test_read_utf16_file(client):
    body = client.get(
        f"/v1/projects/{client.project_id}/file", params={"path": "utf16.txt"}
    ).json()
    assert body["encoding"] == "utf-16-le"
    assert body["newline"] == "CRLF"
    assert body["content"] == "中文16\r\n"


def test_binary_file_refused(client):
    resp = client.get(
        f"/v1/projects/{client.project_id}/file", params={"path": "logo.png"}
    )
    assert resp.status_code == 415
    assert resp.json()["error"]["code"] == "UNSUPPORTED_FORMAT"


def test_missing_file_404(client):
    resp = client.get(
        f"/v1/projects/{client.project_id}/file", params={"path": "nope.py"}
    )
    assert resp.status_code == 404
    assert resp.json()["error"]["code"] == "FILE_NOT_FOUND"


def test_directory_path_is_not_a_file(client):
    resp = client.get(
        f"/v1/projects/{client.project_id}/file", params={"path": "agents"}
    )
    assert resp.status_code == 404


def test_oversized_file_413(client, project_dir):
    (project_dir / "huge.bin").write_bytes(b"\x00" * (4 * 1024 * 1024 + 1))
    resp = client.get(
        f"/v1/projects/{client.project_id}/file", params={"path": "huge.bin"}
    )
    assert resp.status_code == 413
    assert resp.json()["error"]["code"] == "FILE_TOO_LARGE"


def test_syntax_invalid_path_400(client):
    for bad in ("../outside.txt", "a//b", "/lead", "agents\\x.py", "con"):
        resp = client.get(
            f"/v1/projects/{client.project_id}/file", params={"path": bad}
        )
        assert resp.status_code == 400, bad
        assert resp.json()["error"]["code"] == "PATH_INVALID", bad


def _make_junction(link: Path, target: Path) -> bool:
    result = subprocess.run(
        ["cmd", "/c", "mklink", "/J", str(link), str(target)],
        capture_output=True, text=True,
    )
    return result.returncode == 0


def test_junction_escape_403(client, project_dir, tmp_path):
    outside = tmp_path / "outside"
    outside.mkdir()
    (outside / "secret.txt").write_text("s", encoding="utf-8")
    if not _make_junction(project_dir / "agents" / "leak", outside):
        pytest.skip("无法创建 junction")
    resp = client.get(
        f"/v1/projects/{client.project_id}/file", params={"path": "agents/leak/secret.txt"}
    )
    assert resp.status_code == 403
    assert resp.json()["error"]["code"] == "PATH_FORBIDDEN"


def test_unknown_project_404(client):
    resp = client.get("/v1/projects/00000000-0000-0000-0000-000000000000/manifest")
    assert resp.status_code == 404
    assert resp.json()["error"]["code"] == "PROJECT_NOT_FOUND"


def test_anonymous_requests_still_rejected(client):
    anonymous = TestClient(client.app)
    resp = anonymous.get(f"/v1/projects/{client.project_id}/manifest")
    assert resp.status_code == 401
