"""设备令牌认证（S2a）。

配对流程（S2b 实现）颁发 `device_token`；本模块负责：
- 生成与哈希（只存 SHA-256，不存明文 token，防止设置文件泄漏即冒用）；
- FastAPI 依赖 `require_device`：校验 `Authorization: Bearer <token>`。

错误语义（与 contracts/errors.md 对齐）：
- 缺少/格式错误/无法识别的 token → 401 `UNAUTHORIZED`。
  电脑端「撤销设备」= 把设备从配对列表移除，其 token 随即无法匹配，
  同样表现为 UNAUTHORIZED；`DEVICE_REVOKED` 保留给将来的显式撤销名单。
"""

from __future__ import annotations

import hashlib
import hmac
import secrets
from typing import NamedTuple

from fastapi import Request

from pocketcode.server.errors import ApiError
from pocketcode.storage.settings_store import SettingsStore

_TOKEN_MIN_LENGTH = 16


def generate_device_token() -> str:
    """生成设备专属凭据：256 位随机数的 base64url（仅配对响应中出现一次）。"""
    return secrets.token_urlsafe(32)


def hash_token(token: str) -> str:
    """token 的 SHA-256 十六进制；存储与比对都用哈希。"""
    return hashlib.sha256(token.encode("utf-8")).hexdigest()


class DeviceIdentity(NamedTuple):
    device_id: str
    device_name: str


def require_device(request: Request) -> DeviceIdentity:
    """FastAPI 依赖：所有业务接口必须通过本鉴权（health/pair 除外）。"""
    auth_header = request.headers.get("Authorization", "")
    if not auth_header.startswith("Bearer "):
        raise ApiError("UNAUTHORIZED", "缺少设备凭据")
    token = auth_header[len("Bearer "):].strip()
    if len(token) < _TOKEN_MIN_LENGTH:
        raise ApiError("UNAUTHORIZED", "设备凭据格式无效")

    store: SettingsStore | None = getattr(request.app.state, "store", None)
    if store is None:
        raise ApiError("UNAUTHORIZED", "本实例未启用配对")

    token_hash = hash_token(token)
    for device in store.load().paired_devices:
        if device.token_hash and hmac.compare_digest(device.token_hash, token_hash):
            return DeviceIdentity(device_id=device.id, device_name=device.name)
    raise ApiError("UNAUTHORIZED", "设备凭据无效或已被撤销")
