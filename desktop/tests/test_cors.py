"""CORS：手机 App 的 WebView 本地源必须能读取响应（S1 真机缺陷回归）。

原缺陷：App 页面源是 https://localhost，服务端未返回 CORS 许可，
fetch 在 WebView 内被拦截（浏览器地址栏直接访问不受限），手机端
表现为"浏览器能通、App 连不上"。
"""

from __future__ import annotations

from fastapi.testclient import TestClient

from pocketcode.server.app import create_app


def test_preflight_from_app_origin_is_allowed():
    client = TestClient(create_app())
    resp = client.options(
        "/v1/health",
        headers={
            "Origin": "https://localhost",
            "Access-Control-Request-Method": "GET",
        },
    )
    assert resp.status_code == 200
    assert resp.headers["access-control-allow-origin"] == "https://localhost"


def test_get_response_carries_allow_origin_for_app_origin():
    client = TestClient(create_app())
    resp = client.get("/v1/health", headers={"Origin": "https://localhost"})
    assert resp.status_code == 200
    assert resp.headers["access-control-allow-origin"] == "https://localhost"


def test_preflight_allows_authorization_header_for_s2():
    client = TestClient(create_app())
    resp = client.options(
        "/v1/projects",
        headers={
            "Origin": "https://localhost",
            "Access-Control-Request-Method": "GET",
            "Access-Control-Request-Headers": "authorization",
        },
    )
    assert resp.status_code == 200
    headers = resp.headers
    assert headers["access-control-allow-origin"] == "https://localhost"
    assert "authorization" in headers["access-control-allow-headers"].lower()


def test_unknown_origin_gets_no_allow_origin():
    client = TestClient(create_app())
    resp = client.get("/v1/health", headers={"Origin": "https://evil.example.com"})
    assert "access-control-allow-origin" not in resp.headers


def test_capacitor_ios_scheme_is_allowed():
    client = TestClient(create_app())
    resp = client.get("/v1/health", headers={"Origin": "capacitor://localhost"})
    assert resp.headers["access-control-allow-origin"] == "capacitor://localhost"
