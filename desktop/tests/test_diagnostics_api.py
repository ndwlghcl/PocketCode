"""S4d Python 草稿诊断接口：ast 语法 + pyflakes 静态检查（不写入文件）。"""

from __future__ import annotations

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
    project_dir = tmp_path / "project"
    project_dir.mkdir()
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
    client.headers["Authorization"] = f"Bearer {token}"  # type: ignore[attr-defined]
    client.project_id = project_id  # type: ignore[attr-defined]
    return client


def _diagnose(env, path: str, content: str):
    return env.post(
        f"/v1/projects/{env.project_id}/diagnose",
        json={"path": path, "content": content},
    )


def test_clean_code_has_no_diagnostics(env):
    resp = _diagnose(env, "agents/new.py", "x = 1\nprint(x)\n")
    assert resp.status_code == 200
    body = resp.json()
    assert body["diagnostics"] == []
    assert body["analyzer"] in ("ast", "pyflakes+3.2", "pyflakes+4.0") or body[
        "analyzer"
    ].startswith(("ast", "pyflakes"))


def test_syntax_error_reports_line_column(env):
    resp = _diagnose(env, "a.py", "def broken(:\n    pass\n")
    assert resp.status_code == 200
    body = resp.json()
    errors = [d for d in body["diagnostics"] if d["severity"] == "error"]
    assert len(errors) == 1
    assert errors[0]["line"] == 1
    assert errors[0]["column"] >= 1
    assert errors[0]["code"] in ("SyntaxError", "IndentationError", "TabError")


def test_indentation_error_detected(env):
    resp = _diagnose(env, "a.py", "def f():\nreturn 1\n")
    body = resp.json()
    assert any(d["severity"] == "error" for d in body["diagnostics"])


def test_undefined_name_warning_when_pyflakes_available(env):
    resp = _diagnose(env, "a.py", "result = definitely_not_defined\n")
    assert resp.status_code == 200
    body = resp.json()
    if body["analyzer"].startswith("pyflakes"):
        warnings = [d for d in body["diagnostics"] if d["severity"] == "warning"]
        assert any("definitely_not_defined" in d["message"] for d in warnings)
    else:
        # 未安装 pyflakes 的环境：语法没问题就无诊断，能力如实降级
        assert body["diagnostics"] == []


def test_content_over_1mib_rejected_413(env):
    resp = _diagnose(env, "a.py", "x = 1\n" * 300_000)
    assert resp.status_code == 413
    assert resp.json()["error"]["code"] == "FILE_TOO_LARGE"


def test_invalid_path_and_unknown_project(env):
    bad_path = _diagnose(env, "../escape.py", "x = 1\n")
    assert bad_path.status_code == 400
    assert bad_path.json()["error"]["code"] == "PATH_INVALID"

    unknown = env.post(
        f"/v1/projects/{new_id()}/diagnose", json={"path": "a.py", "content": "x = 1\n"}
    )
    assert unknown.status_code == 404
    assert unknown.json()["error"]["code"] == "PROJECT_NOT_FOUND"


def test_diagnose_requires_auth(env):
    token = env.headers["Authorization"]
    env.headers.pop("Authorization")
    resp = _diagnose(env, "a.py", "x = 1\n")
    assert resp.status_code == 401
    env.headers["Authorization"] = token


def test_diagnose_does_not_touch_disk(env, tmp_path):
    """诊断绝不把草稿写入电脑文件（PRD §7 的前提）。"""
    target = tmp_path / "project" / "ghost.py"
    resp = _diagnose(env, "ghost.py", "x = 1\n")
    assert resp.status_code == 200
    assert not target.exists()
