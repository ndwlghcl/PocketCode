"""POST /v1/pair/complete 全流程 + 配对后令牌立即可用（S2b 主链路）。"""

from __future__ import annotations

from fastapi.testclient import TestClient

from pocketcode.security.auth import hash_token
from pocketcode.server.app import create_app
from pocketcode.services.pairing import PairingService
from pocketcode.storage.settings_store import SettingsStore


def _build(settings_path, callback):
    store = SettingsStore(settings_path)
    service = PairingService(confirm_timeout_seconds=1.0)
    service.set_confirmation_callback(callback)
    app = create_app(store=store, pairing=service)
    return TestClient(app), store, service


def _pair(client, code, device_name="Pixel 手机"):
    return client.post(
        "/v1/pair/complete",
        json={"pairing_code": code, "device_name": device_name, "device_platform": "android"},
    )


def test_full_pairing_flow_grants_working_token(settings_path):
    client, store, service = _build(settings_path, lambda name, plat: "approved")
    code = service.create_session()

    resp = _pair(client, code)
    assert resp.status_code == 200
    body = resp.json()
    assert set(body.keys()) == {"device_id", "device_token", "server_id", "server_name"}
    assert len(body["device_token"]) >= 20

    # 设备已持久化（只存哈希）
    devices = store.load().paired_devices
    assert len(devices) == 1
    assert devices[0].name == "Pixel 手机"
    assert devices[0].token_hash == hash_token(body["device_token"])

    # 新令牌立刻可用于业务接口
    projects = client.get("/v1/projects", headers={"Authorization": f"Bearer {body['device_token']}"})
    assert projects.status_code == 200

    # 同码复用 → 409
    again = _pair(client, code)
    assert again.status_code == 409
    assert again.json()["error"]["code"] == "PAIRING_CODE_USED"


def test_rejected_pairing_persists_nothing(settings_path):
    client, store, service = _build(settings_path, lambda name, plat: "rejected")
    code = service.create_session()
    resp = _pair(client, code)
    assert resp.status_code == 403
    assert resp.json()["error"]["code"] == "PAIRING_REJECTED"
    assert store.load().paired_devices == []


def test_unanswered_confirmation_times_out(settings_path):
    client, store, service = _build(settings_path, lambda name, plat: "timeout")
    code = service.create_session()
    resp = _pair(client, code)
    assert resp.status_code == 408
    assert resp.json()["error"]["code"] == "PAIRING_TIMEOUT"


def test_invalid_code_variants(settings_path):
    client, store, _ = _build(settings_path, lambda name, plat: "approved")

    # 没有会话
    resp = _pair(client, "ABCD-2345")
    assert resp.status_code == 401
    assert resp.json()["error"]["code"] == "PAIRING_CODE_INVALID"

    # 码格式不符合合同 → 400 INVALID_REQUEST
    resp = _pair(client, "abcd-2345")
    assert resp.status_code == 400
    assert resp.json()["error"]["code"] == "INVALID_REQUEST"

    # 过期（ttl=0.02s）
    import time

    service = PairingService(code_ttl_seconds=0.02)
    service.set_confirmation_callback(lambda name, plat: "approved")
    client.app.state.pairing = service
    dead = service.create_session()
    time.sleep(0.05)
    resp = _pair(client, dead)
    assert resp.status_code == 401


def test_body_validation_errors(settings_path):
    client, _, _ = _build(settings_path, lambda name, plat: "approved")
    resp = client.post("/v1/pair/complete", json={"pairing_code": "ABCD-2345"})
    assert resp.status_code == 400
    resp = client.post("/v1/pair/complete", json={})
    assert resp.status_code == 400


def test_second_pairing_adds_second_device(settings_path):
    client, store, service = _build(settings_path, lambda name, plat: "approved")
    first = _pair(client, service.create_session(), "手机 A")
    second = _pair(client, service.create_session(), "手机 B")
    assert first.status_code == 200 and second.status_code == 200
    assert len(store.load().paired_devices) == 2
