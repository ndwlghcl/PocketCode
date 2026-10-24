"""服务端 Pydantic 模型：与 contracts/openapi.yaml 严格对齐。

规则：本文件只允许定义合同中已存在的字段；新增字段必须先改合同。
"""

from __future__ import annotations

from typing import Literal

from pydantic import BaseModel


class HealthResponse(BaseModel):
    """GET /v1/health 响应。字段与 fixtures/health_ok.json 一致。"""

    status: Literal["ok", "degraded"] = "ok"
    protocol_version: str = "1.0"
    service: str = "pocketcode"


class ErrorBody(BaseModel):
    """统一错误体。详见 contracts/errors.md。"""

    code: str
    message: str
    request_id: str
    details: dict[str, object] | None = None


class ErrorResponse(BaseModel):
    error: ErrorBody
