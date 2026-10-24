"""统一错误包裹：任何失败都必须是 {"error": {...}}，且状态码恰当。"""

from __future__ import annotations

import uuid

from fastapi.testclient import TestClient

from pocketcode.server.app import create_app


def _error(resp) -> dict:
    body = resp.json()
    assert set(body.keys()) == {"error"}, f"unexpected envelope: {body}"
    return body["error"]


def test_unknown_route_returns_unified_404():
    client = TestClient(create_app())
    resp = client.get("/v1/does-not-exist")
    assert resp.status_code == 404
    err = _error(resp)
    assert err["code"] == "NOT_FOUND"
    uuid.UUID(err["request_id"])
    assert err["message"]


def test_unknown_root_route_unified_too():
    client = TestClient(create_app())
    resp = client.get("/")
    assert resp.status_code == 404
    assert _error(resp)["code"] == "NOT_FOUND"


def test_method_not_allowed():
    client = TestClient(create_app())
    resp = client.delete("/v1/health")
    assert resp.status_code == 405
    assert _error(resp)["code"] == "METHOD_NOT_ALLOWED"


def test_validation_error_is_400_invalid_request():
    """合同约定：请求不符合 Schema 返回 400 INVALID_REQUEST（覆盖 FastAPI 默认 422）。"""
    from fastapi import FastAPI
    from pydantic import BaseModel

    from pocketcode.server.app import register_error_handlers
    from pocketcode.server.schemas import HealthResponse

    probe = FastAPI()
    register_error_handlers(probe)

    class Echo(BaseModel):
        required_field: int

    @probe.post("/v1/probe")
    def probe_endpoint(model: Echo) -> HealthResponse:
        return HealthResponse()

    client = TestClient(probe)
    resp = client.post("/v1/probe", json={"required_field": "not-an-int"})
    assert resp.status_code == 400
    assert _error(resp)["code"] == "INVALID_REQUEST"


def test_openapi_introspection_disabled():
    """contracts/openapi.yaml 是唯一合同，应用不提供第二份 Schema。"""
    client = TestClient(create_app())
    assert client.get("/openapi.json").status_code == 404
    assert client.get("/docs").status_code == 404
