"""PairingService：一次性码的生命周期与确认协调。"""

from __future__ import annotations

import re

import pytest

from pocketcode.services.pairing import PairingService, generate_pairing_code


def test_pairing_code_format():
    code = generate_pairing_code()
    assert re.fullmatch(r"^[A-Z0-9-]{9}$", code)
    assert code[4] == "-"
    # 不含易混淆字符
    assert not (set(code) & set("IO01"))


def test_create_session_and_begin_confirmation():
    service = PairingService()
    code = service.create_session()
    assert service.begin_confirmation(code) is True
    # 同一码不能再次消费
    assert service.begin_confirmation(code) is False
    assert service.is_known_used(code) is True


def test_wrong_or_expired_code_rejected():
    service = PairingService()
    code = service.create_session()
    assert service.begin_confirmation("WRONG-CODE") is False
    assert service.is_known_used("WRONG-CODE") is False

    expired = PairingService(code_ttl_seconds=0.02)
    short_code = expired.create_session()
    import time

    time.sleep(0.05)
    assert expired.begin_confirmation(short_code) is False


def test_new_session_invalidates_old_code():
    service = PairingService()
    old = service.create_session()
    new = service.create_session()
    assert old != new
    assert service.begin_confirmation(old) is False
    assert service.begin_confirmation(new) is True


def test_confirmation_outcomes():
    service = PairingService()
    for expected in ("approved", "rejected", "timeout"):
        service.set_confirmation_callback(lambda name, plat, e=expected: e)
        assert service.request_confirmation("Pixel", "android") == expected

    service.set_confirmation_callback(None)
    assert service.request_confirmation("Pixel", "android") == "timeout"

    # 回调抛异常按 timeout 处理，不炸服务线程
    def broken(name, plat):
        raise RuntimeError("boom")

    service.set_confirmation_callback(broken)
    assert service.request_confirmation("Pixel", "android") == "timeout"


def test_slow_callback_result_still_accepted():
    """超时上限由界面层 broker 的 event.wait 负责；服务层只透传回调结果。"""
    service = PairingService(confirm_timeout_seconds=0.01)
    service.set_confirmation_callback(lambda name, plat: "approved")
    assert service.request_confirmation("Pixel", "android") == "approved"


def test_confirm_timeout_seconds_property():
    assert PairingService(confirm_timeout_seconds=12).confirm_timeout_seconds == 12
