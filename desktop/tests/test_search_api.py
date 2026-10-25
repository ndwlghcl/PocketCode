"""S4b 全文搜索接口：命中/大小写/范围过滤/限额/错误码。"""

from __future__ import annotations

import hashlib

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
    """已配对 + 已授权一个含多文件的项目目录。"""
    project_dir = tmp_path / "project"
    (project_dir / "agents").mkdir(parents=True)
    (project_dir / "agents" / "search.py").write_bytes(
        b"from serpapi import SerpApiClient\n"
        b"def search(query):\n"
        b"    return SERPAPI_KEY\n"
    )
    (project_dir / "notes.md").write_bytes(b"# Notes\nSerpApi \xe7\xbd\x91\xe9\xa1\xb5\xe6\x90\x9c\xe7\xb4\xa2\n")
    (project_dir / "skip.bin").write_bytes(b"\x00\x01\x02serpapi\x03")  # 二进制：跳过
    (project_dir / "node_modules").mkdir()
    (project_dir / "node_modules" / "x.js").write_bytes(b"var serpapi = 1\n")  # 排除目录
    (project_dir / ".env").write_bytes(b"SERPAPI_KEY=secret\n")  # 隐藏文件：排除

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


def test_search_hits_across_files_case_insensitive(env):
    resp = env.get(f"/v1/projects/{env.project_id}/search", params={"q": "serpapi"})
    assert resp.status_code == 200
    body = resp.json()
    assert body["query"] == "serpapi"
    assert body["truncated"] is False
    paths = {entry["path"] for entry in body["matches"]}
    # 命中大小写不敏感：SerpApiClient / SERPAPI_KEY / SerpApi（md）
    assert "agents/search.py" in paths
    assert "notes.md" in paths
    # 范围过滤：二进制与 node_modules / 隐藏文件不出现
    assert "skip.bin" not in paths
    assert "node_modules/x.js" not in paths
    assert ".env" not in paths
    # 行号与文本（search.py 命中 2 行 + notes.md 1 行）
    py = next(e for e in body["matches"] if e["path"] == "agents/search.py")
    assert py["lines"][0] == {"line": 1, "text": "from serpapi import SerpApiClient"}
    assert py["lines"][1] == {"line": 3, "text": "    return SERPAPI_KEY"}
    assert body["total_matches"] == sum(len(e["lines"]) for e in body["matches"]) == 3


def test_search_trim_and_no_match(env):
    resp = env.get(f"/v1/projects/{env.project_id}/search", params={"q": "  SerpApi  "})
    assert resp.status_code == 200
    assert resp.json()["query"] == "SerpApi"

    empty = env.get(f"/v1/projects/{env.project_id}/search", params={"q": "不存在的关键词xyz"})
    assert empty.status_code == 200
    body = empty.json()
    assert body["matches"] == [] and body["total_matches"] == 0 and body["truncated"] is False


def test_search_blank_query_400(env):
    resp = env.get(f"/v1/projects/{env.project_id}/search", params={"q": "   "})
    assert resp.status_code == 400
    assert resp.json()["error"]["code"] == "INVALID_REQUEST"


def test_search_unknown_project_404(env):
    resp = env.get(f"/v1/projects/{new_id()}/search", params={"q": "x"})
    assert resp.status_code == 404
    assert resp.json()["error"]["code"] == "PROJECT_NOT_FOUND"


def test_search_requires_auth(env):
    token = env.headers["Authorization"]
    env.headers.pop("Authorization")
    resp = env.get(f"/v1/projects/{env.project_id}/search", params={"q": "x"})
    assert resp.status_code == 401
    env.headers["Authorization"] = token


def test_search_truncates_per_file_and_total(env, tmp_path):
    """单文件 >20 条命中触发 truncated；项目不可访问时 404 语义不变。"""
    big = tmp_path / "big"
    big.mkdir()
    lines = "".join(f"needle line {i}\n" for i in range(50))
    (big / "many.py").write_text(lines, encoding="utf-8")
    store = SettingsStore(tmp_path / "settings.json")
    project_id = new_id()
    token = generate_device_token()
    store.save(
        Settings(
            authorized_projects=[
                AuthorizedProject(id=project_id, name="big", root_path=str(big))
            ],
            paired_devices=[
                PairedDevice(id=new_id(), name="手机", paired_at="2026-10-25T00:00:00Z",
                             token_hash=hash_token(token))
            ],
        )
    )
    client = TestClient(create_app(store=store))
    client.headers["Authorization"] = f"Bearer {token}"
    resp = client.get(f"/v1/projects/{project_id}/search", params={"q": "needle"})
    assert resp.status_code == 200
    body = resp.json()
    assert len(body["matches"][0]["lines"]) == 20
    assert body["total_matches"] == 20
    assert body["truncated"] is True
