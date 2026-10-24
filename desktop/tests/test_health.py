"""GET /v1/health：实现必须与合同 fixture 完全一致。"""

from __future__ import annotations

import json

from fastapi.testclient import TestClient

from pocketcode.server.app import create_app


def _load_fixture(repo_root, name: str) -> dict:
    path = repo_root / "contracts" / "fixtures" / name
    return json.loads(path.read_text(encoding="utf-8"))


def test_health_matches_contract_fixture(repo_root):
    client = TestClient(create_app())
    resp = client.get("/v1/health")
    assert resp.status_code == 200
    assert resp.headers["content-type"].startswith("application/json")
    assert resp.json() == _load_fixture(repo_root, "health_ok.json")


def test_health_has_request_id_header():
    client = TestClient(create_app())
    resp = client.get("/v1/health")
    rid = resp.headers.get("x-request-id")
    assert rid is not None and len(rid) == 36


def test_health_does_not_leak_sensitive_fields():
    """诊断阶段要求：health 不返回项目名、用户名、路径。"""
    client = TestClient(create_app())
    body = client.get("/v1/health").text
    for forbidden in ("project", "user", "path", "token"):
        assert forbidden not in body.lower()
