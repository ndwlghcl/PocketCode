"""FastAPI 应用工厂。

S0 只挂载 /v1/health；S1 起按合同逐步增加路由。
OpenAPI 自省接口（/docs、/openapi.json）已关闭：contracts/openapi.yaml 是唯一合同，
避免出现第二份可漂移的 Schema（任务书 D 节）。
"""

from __future__ import annotations

import logging
import uuid
from typing import Any

from fastapi import FastAPI, Request
from fastapi.exceptions import RequestValidationError
from fastapi.responses import JSONResponse
from starlette.exceptions import HTTPException as StarletteHTTPException

from pocketcode.server.errors import STATUS_TO_GENERIC_CODE, ApiError
from pocketcode.server.routes.health import router as health_router
from pocketcode.server.schemas import ErrorBody, ErrorResponse
from pocketcode.storage.settings_store import Settings

logger = logging.getLogger("pocketcode.server")


def _error_response(request: Request, code: str, message: str, status: int,
                    details: dict[str, Any] | None = None) -> JSONResponse:
    request_id = getattr(request.state, "request_id", None) or str(uuid.uuid4())
    body = ErrorResponse(
        error=ErrorBody(code=code, message=message, request_id=request_id, details=details)
    )
    return JSONResponse(status_code=status, content=body.model_dump(exclude_none=True))


def register_error_handlers(app: FastAPI) -> None:
    """注册统一错误包裹处理器（供 create_app 与测试探针应用共用）。"""

    @app.exception_handler(ApiError)
    async def api_error_handler(request: Request, exc: ApiError) -> JSONResponse:
        return _error_response(request, exc.code, exc.message, exc.status, exc.details)

    @app.exception_handler(StarletteHTTPException)
    async def http_exception_handler(request: Request, exc: StarletteHTTPException) -> JSONResponse:
        code = STATUS_TO_GENERIC_CODE.get(exc.status_code, "IO_ERROR")
        message = str(exc.detail) if exc.detail else code
        return _error_response(request, code, message, exc.status_code)

    @app.exception_handler(RequestValidationError)
    async def validation_error_handler(request: Request, exc: RequestValidationError) -> JSONResponse:
        # 合同约定：请求不符合 Schema 统一返回 400 INVALID_REQUEST（不是 FastAPI 默认 422）。
        return _error_response(request, "INVALID_REQUEST", "请求不符合接口合同", 400)

    @app.exception_handler(Exception)
    async def unhandled_error_handler(request: Request, exc: Exception) -> JSONResponse:
        logger.exception("unhandled server error")
        return _error_response(request, "IO_ERROR", "服务内部错误", 500)


def create_app(settings: Settings | None = None) -> FastAPI:
    """构建 FastAPI 应用。settings 当前仅保留备用（路由未使用任何可变配置）。"""
    app = FastAPI(
        title="PocketCode Server",
        version="1.0.0-s0",
        docs_url=None,
        redoc_url=None,
        openapi_url=None,
    )
    app.state.settings = settings

    app.include_router(health_router)

    @app.middleware("http")
    async def request_id_middleware(request: Request, call_next):
        request.state.request_id = str(uuid.uuid4())
        response = await call_next(request)
        response.headers["X-Request-Id"] = request.state.request_id
        return response

    register_error_handlers(app)

    return app
