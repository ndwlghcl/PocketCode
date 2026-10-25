"""设备令牌认证 + GET /v1/projects（S2a）。"""

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
)


@pytest.fixture
def store(settings_path):
    return SettingsStore(settings_path)


def _app_with_device(store: SettingsStore, token: str | None = None):
    if token is None:
        token = generate_device_token()
    store.save(
        Settings(
            authorized_projects=[
                AuthorizedProject(id="proj-1", name="demo", root_path=r"D:\code\demo", revision=7),
                AuthorizedProject(id="proj-2", name="docs", root_path=r"D:\code\docs", revision=1),
            ],
            paired_devices=[
                PairedDevice(id="dev-1", name="测试手机", paired_at="2026-10-25T00:00:00Z",
                             token_hash=hash_token(token))
            ],
        )
    )
    return create_app(store=store), token


def test_projects_requires_auth(store):
    app, _ = _app_with_device(store)
    client = TestClient(app)
    resp = client.get("/v1/projects")
    assert resp.status_code == 401
    body = resp.json()
    assert body["error"]["code"] == "UNAUTHORIZED"
    assert "x-request-id" in {k.lower() for k in resp.headers}


def test_projects_with_valid_token(store):
    app, token = _app_with_device(store)
    client = TestClient(app)
    resp = client.get("/v1/projects", headers={"Authorization": f"Bearer {token}"})
    assert resp.status_code == 200
    data = resp.json()
    assert [p["id"] for p in data["projects"]] == ["proj-1", "proj-2"]
    assert data["projects"][0]["revision"] == 7


def test_unknown_token_is_unauthorized(store):
    app, _ = _app_with_device(store)
    client = TestClient(app)
    resp = client.get("/v1/projects", headers={"Authorization": f"Bearer {generate_device_token()}"})
    assert resp.status_code == 401
    assert resp.json()["error"]["code"] == "UNAUTHORIZED"


def test_malformed_auth_header(store):
    app, _ = _app_with_device(store)
    client = TestClient(app)
    for header in ("", "Basic abcdefgh", "Bearer short", "Bearer "):
        resp = client.get("/v1/projects", headers={"Authorization": header} if header else {})
        assert resp.status_code == 401, header


def test_no_store_means_all_business_requests_rejected():
    client = TestClient(create_app())
    resp = client.get("/v1/projects", headers={"Authorization": f"Bearer {generate_device_token()}"})
    assert resp.status_code == 401


def test_health_stays_anonymous(store):
    app, _ = _app_with_device(store)
    client = TestClient(app)
    assert client.get("/v1/health").status_code == 200
