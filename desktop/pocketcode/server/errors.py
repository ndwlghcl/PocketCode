"""API 错误定义与错误码 → HTTP 状态映射。

错误码全集与语义以 contracts/openapi.yaml 的 ErrorCode 和 contracts/errors.md
为准；本文件只做映射，不得发明新错误码。
"""

from __future__ import annotations

from typing import Any

# 错误码 → 默认 HTTP 状态码（与 contracts/errors.md 对照表一致）
CODE_TO_STATUS: dict[str, int] = {
    "UNAUTHORIZED": 401,
    "DEVICE_REVOKED": 401,
    "PAIRING_CODE_INVALID": 401,
    "PAIRING_CODE_USED": 409,
    "PAIRING_REJECTED": 403,
    "PAIRING_TIMEOUT": 408,
    "INVALID_REQUEST": 400,
    "NOT_FOUND": 404,
    "METHOD_NOT_ALLOWED": 405,
    "PROJECT_NOT_FOUND": 404,
    "PATH_INVALID": 400,
    "PATH_FORBIDDEN": 403,
    "FILE_NOT_FOUND": 404,
    "UNSUPPORTED_FORMAT": 415,
    "FILE_TOO_LARGE": 413,
    "VERSION_CONFLICT": 409,
    "ALREADY_EXISTS": 409,
    "IO_ERROR": 500,
}

# Starlette 内建 HTTPException 状态码 → 通用错误码（用于路由不存在等情况）
STATUS_TO_GENERIC_CODE: dict[int, str] = {
    400: "INVALID_REQUEST",
    404: "NOT_FOUND",
    405: "METHOD_NOT_ALLOWED",
    413: "FILE_TOO_LARGE",
    500: "IO_ERROR",
}


class ApiError(Exception):
    """业务错误：路由层抛出，由 app.py 的异常处理器渲染为统一错误包裹。"""

    def __init__(
        self,
        code: str,
        message: str,
        details: dict[str, Any] | None = None,
        status: int | None = None,
    ) -> None:
        if code not in CODE_TO_STATUS:
            raise ValueError(f"unknown error code: {code}")
        self.code = code
        self.message = message
        self.details = details
        self.status = status if status is not None else CODE_TO_STATUS[code]
        super().__init__(f"[{code}] {message}")
