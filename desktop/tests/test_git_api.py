"""S4e Git 只读接口：status/diff。需要本机 git（缺失则整文件跳过）。"""

from __future__ import annotations

import shutil
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

pytestmark = pytest.mark.skipif(shutil.which("git") is None, reason="本机没有 git")


def _git(cwd: Path, *args: str) -> None:
    subprocess.run(
        ["git", "-C", str(cwd), *args],
        check=True,
        capture_output=True,
        text=True,
    )


@pytest.fixture
def env(tmp_path):
    """一个真实的 git 仓库 + 授权项目 + 已配对设备。"""
    repo = tmp_path / "repo"
    repo.mkdir()
    _git(repo, "init")
    # 固定分支名，避免不同 git 默认名（master/main）差异
    _git(repo, "symbolic-ref", "HEAD", "refs/heads/main")
    _git(repo, "config", "user.email", "test@example.com")
    _git(repo, "config", "user.name", "test")
    _git(repo, "config", "core.autocrlf", "false")
    (repo / "a.py").write_bytes(b"print(1)\n")
    _git(repo, "add", ".")
    _git(repo, "commit", "-m", "init")

    store = SettingsStore(tmp_path / "settings.json")
    project_id = new_id()
    token = generate_device_token()
    store.save(
        Settings(
            authorized_projects=[
                AuthorizedProject(id=project_id, name="repo", root_path=str(repo))
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
    client.repo = repo  # type: ignore[attr-defined]
    return client


def test_status_clean_after_commit(env):
    resp = env.get(f"/v1/projects/{env.project_id}/git/status")
    assert resp.status_code == 200
    body = resp.json()
    assert body["available"] is True
    assert body["branch"] == "main"
    assert body["changes"] == []


def test_status_reports_staged_worktree_untracked(env):
    # 工作区修改（未暂存）
    (env.repo / "a.py").write_bytes(b"print(1)\nprint(2)\n")
    # 暂存的新文件
    (env.repo / "b.py").write_bytes(b"x = 1\n")
    _git(env.repo, "add", "b.py")
    # 未跟踪文件
    (env.repo / "c.py").write_bytes(b"new\n")

    body = env.get(f"/v1/projects/{env.project_id}/git/status").json()
    assert body["available"] is True
    by_path = {entry["path"]: entry for entry in body["changes"]}
    assert by_path["a.py"]["worktree_status"] == "modified"
    assert by_path["a.py"]["index_status"] == "none"
    assert by_path["b.py"]["index_status"] == "added"
    assert by_path["b.py"]["worktree_status"] == "none"
    assert by_path["c.py"]["worktree_status"] == "untracked"


def test_diff_unstaged_then_staged(env):
    (env.repo / "a.py").write_bytes(b"print(1)\nprint(2)\n")

    unstaged = env.get(
        f"/v1/projects/{env.project_id}/git/diff", params={"path": "a.py"}
    )
    assert unstaged.status_code == 200
    body = unstaged.json()
    assert body["truncated"] is False
    assert "+print(2)" in body["diff"]
    assert "--- a/a.py" in body["diff"] and "+++ b/a.py" in body["diff"]

    # 暂存后：工作区 diff 为空，--cached diff 包含变更
    _git(env.repo, "add", "a.py")
    worktree = env.get(
        f"/v1/projects/{env.project_id}/git/diff", params={"path": "a.py"}
    ).json()
    assert worktree["diff"] == ""
    staged = env.get(
        f"/v1/projects/{env.project_id}/git/diff",
        params={"path": "a.py", "staged": "true"},
    ).json()
    assert "+print(2)" in staged["diff"]


def test_status_not_a_repo_returns_available_false(tmp_path):
    """不是 git 仓库是正常业务状态：200 + available=false。"""
    plain = tmp_path / "plain"
    plain.mkdir()
    store = SettingsStore(tmp_path / "settings.json")
    project_id = new_id()
    token = generate_device_token()
    store.save(
        Settings(
            authorized_projects=[
                AuthorizedProject(id=project_id, name="plain", root_path=str(plain))
            ],
            paired_devices=[
                PairedDevice(id=new_id(), name="手机", paired_at="2026-10-25T00:00:00Z",
                             token_hash=hash_token(token))
            ],
        )
    )
    client = TestClient(create_app(store=store))
    client.headers["Authorization"] = f"Bearer {token}"
    resp = client.get(f"/v1/projects/{project_id}/git/status")
    assert resp.status_code == 200
    body = resp.json()
    assert body["available"] is False
    assert body["reason"]
    assert body["changes"] == []


def test_diff_invalid_path_400_and_unknown_project_404(env):
    bad = env.get(f"/v1/projects/{env.project_id}/git/diff", params={"path": "../x"})
    assert bad.status_code == 400
    assert bad.json()["error"]["code"] == "PATH_INVALID"

    unknown = env.get(f"/v1/projects/{new_id()}/git/diff", params={"path": "a.py"})
    assert unknown.status_code == 404


def test_git_endpoints_require_auth(env):
    token = env.headers["Authorization"]
    env.headers.pop("Authorization")
    assert env.get(f"/v1/projects/{env.project_id}/git/status").status_code == 401
    assert (
        env.get(f"/v1/projects/{env.project_id}/git/diff", params={"path": "a.py"}).status_code
        == 401
    )
    env.headers["Authorization"] = token
