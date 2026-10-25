"""POST /v1/pair/complete —— 消耗一次性配对码并颁发设备凭据（S2b）。

流程与错误语义见 contracts/openapi.yaml 与 services/pairing.py。
本端点无需设备凭据（一次性配对码即临时凭据），但需要电脑用户在桌面端
确认；未确认/拒绝/超时分别返回 408/403/408。
"""

from __future__ import annotations

from datetime import datetime, timezone

from fastapi import APIRouter, Request

from pocketcode.security.auth import generate_device_token, hash_token
from pocketcode.server.errors import ApiError
from pocketcode.server.schemas import PairCompleteRequest, PairCompleteResponse
from pocketcode.storage.settings_store import PairedDevice, new_id

router = APIRouter(prefix="/v1")


def _utc_now_iso() -> str:
    return datetime.now(tz=timezone.utc).strftime("%Y-%m-%dT%H:%M:%SZ")


@router.post(
    "/pair/complete",
    response_model=PairCompleteResponse,
    status_code=200,
    summary="消耗一次性配对票据并颁发设备凭据",
    responses={
        400: {"description": "请求体不符合合同"},
        401: {"description": "配对码无效或已过期"},
        403: {"description": "电脑用户拒绝配对"},
        408: {"description": "等待电脑用户确认超时"},
        409: {"description": "配对码已被使用"},
    },
)
def complete_pairing(body: PairCompleteRequest, request: Request) -> PairCompleteResponse:
    pairing = request.app.state.pairing
    store = request.app.state.store
    if pairing is None or store is None:
        raise ApiError("PAIRING_CODE_INVALID", "本实例未启用配对")

    if pairing.is_known_used(body.pairing_code):
        raise ApiError("PAIRING_CODE_USED", "配对码已被使用，请在电脑端重新生成")
    if not pairing.begin_confirmation(body.pairing_code):
        raise ApiError("PAIRING_CODE_INVALID", "配对码无效或已过期，请在电脑端重新生成")

    outcome = pairing.request_confirmation(body.device_name, body.device_platform)
    if outcome == "rejected":
        raise ApiError("PAIRING_REJECTED", "电脑用户拒绝了本次配对请求")
    if outcome == "timeout":
        raise ApiError("PAIRING_TIMEOUT", "电脑用户未在限时内确认")

    token = generate_device_token()
    device_id = new_id()
    store.add_paired_device(
        PairedDevice(
            id=device_id,
            name=body.device_name,
            paired_at=_utc_now_iso(),
            token_hash=hash_token(token),
        )
    )
    settings = store.load()
    return PairCompleteResponse(
        device_id=device_id,
        device_token=token,
        server_id=settings.server_id,
        server_name=settings.server_name or "PocketCode",
    )
