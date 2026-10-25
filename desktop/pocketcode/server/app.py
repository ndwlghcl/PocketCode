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
from fastapi.middleware.cors import CORSMiddleware
from fastapi.responses import JSONResponse
from starlette.exceptions import HTTPException as StarletteHTTPException

from pocketcode.server.errors import STATUS_TO_GENERIC_CODE, ApiError
from pocketcode.server.routes.health import router as health_router
from pocketcode.server.routes.mutations import router as mutations_router
from pocketcode.server.routes.pairing import router as pairing_router
from pocketcode.server.routes.projects import router as projects_router
from pocketcode.server.schemas import ErrorBody, ErrorResponse
from pocketcode.storage.settings_store import Settings, SettingsStore
from pocketcode.services.pairing import PairingService

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


def create_app(settings: Settings | None = None,
               store: SettingsStore | None = None,
               pairing: PairingService | None = None) -> FastAPI:
    """构建 FastAPI 应用。

    store：设置仓储，鉴权依赖与项目/配对路由读取配对设备/授权项目；
    pairing：配对服务（二维码会话与确认协调）；
    任一未提供时相关能力按"未启用"处理（业务接口一律 401 / 配对码无效）。
    """
    app = FastAPI(
        title="PocketCode Server",
        version="1.0.0-s3",
        docs_url=None,
        redoc_url=None,
        openapi_url=None,
    )
    app.state.settings = settings
    app.state.store = store
    app.state.pairing = pairing

    app.include_router(health_router)
    app.include_router(projects_router)
    app.include_router(pairing_router)
    app.include_router(mutations_router)

    # 手机 App 的页面运行在 WebView 本地源（https://localhost 等）上，
    # 浏览器安全模型要求服务端显式允许该来源读取响应（CORS）。
    # 只放行 App 自身的本地源，任意外部网站仍无法读取本服务；
    # 数据安全仍由 Bearer 认证保证（S2 起），CORS 不是访问控制的替代。
    app.add_middleware(
        CORSMiddleware,
        allow_origin_regex=r"^(https?|capacitor)://localhost(:\d+)?$",
        allow_methods=["GET", "POST", "PUT", "DELETE", "OPTIONS"],
        allow_headers=["Accept", "Content-Type", "Authorization"],
        allow_credentials=False,
    )

    @app.middleware("http")
    async def request_id_middleware(request: Request, call_next):
        request.state.request_id = str(uuid.uuid4())
        response = await call_next(request)
        response.headers["X-Request-Id"] = request.state.request_id
        return response

    register_error_handlers(app)

    return app
