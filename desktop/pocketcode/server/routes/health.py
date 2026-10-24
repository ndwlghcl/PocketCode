"""GET /v1/health —— 合同中唯一 S0 要求实现的端点。

最小响应，不泄漏项目名、用户名或路径（架构文档 §3.1 诊断阶段要求）。
"""

from __future__ import annotations

from fastapi import APIRouter

from pocketcode.server.schemas import HealthResponse

router = APIRouter(prefix="/v1")


@router.get(
    "/health",
    response_model=HealthResponse,
    status_code=200,
    summary="最小健康状态（无敏感信息，无需认证）",
    responses={200: {"description": "服务正常"}},
)
def get_health() -> HealthResponse:
    return HealthResponse()
