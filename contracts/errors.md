# PocketCode 通用错误码 v1（S0 冻结）

## 错误响应统一格式

所有失败响应（除 204）返回统一包裹，HTTP 状态码必须与语义匹配，禁止全部返回 200：

```json
{
  "error": {
    "code": "VERSION_CONFLICT",
    "message": "电脑文件已在别处修改",
    "request_id": "c9bf9e57-1685-4c89-bafb-ff5af830be8a",
    "details": { "current_version": "sha256:3a6e..." }
  }
}
```

- `code`：机器可读错误码，枚举见下表，与 `contracts/openapi.yaml` 的 `ErrorCode` 一致。
- `message`：面向用户的简短中文说明，可直接展示。
- `request_id`：本次请求的服务端 UUID；响应头 `X-Request-Id` 与之相同，用于日志排查。
- `details`：可选结构化补充字段（如 `current_version`、`path`），不得携带文件正文、凭据或电脑绝对路径。

## 错误码 → HTTP 状态对照表

| 错误码 | HTTP | 语义 | 客户端建议处理 |
|---|---|---|---|
| `UNAUTHORIZED` | 401 | 缺少 `Authorization: Bearer` 或凭据无效 | 引导重新配对 |
| `DEVICE_REVOKED` | 401 | 设备已被电脑端撤销 | 清除本地凭据，提示已撤销 |
| `PAIRING_CODE_INVALID` | 401 | 一次性配对码无效或过期 | 提示重新扫码 |
| `PAIRING_CODE_USED` | 409 | 配对码已被使用 | 提示重新扫码 |
| `PAIRING_REJECTED` | 403 | 电脑用户在确认框中拒绝了配对 | 如实提示，可重试 |
| `PAIRING_TIMEOUT` | 408 | 等待电脑用户确认超时 | 提示电脑端确认或重试 |
| `INVALID_REQUEST` | 400 | 请求体缺失、JSON 非法或字段不符合合同 | 客户端缺陷或版本不匹配，记录日志 |
| `NOT_FOUND` | 404 | 通用资源不存在（未知路由、trash_id 无效等） | 按界面语境提示 |
| `METHOD_NOT_ALLOWED` | 405 | 对该路径使用了不支持的方法 | 客户端缺陷，记录日志 |
| `PROJECT_NOT_FOUND` | 404 | project_id 不存在或未授权 | 刷新项目列表 |
| `PATH_INVALID` | 400 | 相对路径语法不符合合同规则 | 客户端缺陷，记录日志 |
| `PATH_FORBIDDEN` | 403 | 路径越出授权根目录（含符号链接/junction 绕过） | 提示无权限，不得重试 |
| `FILE_NOT_FOUND` | 404 | 文件/目录不存在（可能在电脑端被删除） | 刷新目录；保留草稿 |
| `UNSUPPORTED_FORMAT` | 415 | 二进制或无法安全解码/回写的编码 | 提示只读/不支持，不得尝试编辑 |
| `FILE_TOO_LARGE` | 413 | 超出大小上限（默认 4 MiB） | 提示文件过大 |
| `VERSION_CONFLICT` | 409 | 保存时 `base_version` 已过期 | 进入冲突流程：展示 Diff，不得覆盖 |
| `ALREADY_EXISTS` | 409 | 新建时目标已存在；恢复时原路径被占用 | 提示改名/选择其他路径 |
| `IO_ERROR` | 500 | 磁盘、权限等 IO 失败 | 提示稍后重试；保留草稿 |

### 客户端本地状态码

| 错误码 | 语义 |
|---|---|
| `OFFLINE` | **仅客户端本地生成**：无法连接电脑（超时、拒绝连接、无网络）。不是服务端错误码，不出现在任何 HTTP 响应中。 |

## 认证与安全约定

- 除 `GET /v1/health` 与 `POST /v1/pair/complete` 外，所有端点必须携带
  `Authorization: Bearer <device_token>`。
- `device_token` 仅在配对成功响应中出现一次；客户端存储于安全存储，不得写入日志或随代码分享。
- 电脑端撤销设备后，所有请求返回 401 `DEVICE_REVOKED`。
- 错误 `details` 与日志不得包含电脑绝对路径、文件正文、密钥或完整代码。

## 大小限制（服务端默认）

| 项 | 限制 | 超限错误 |
|---|---|---|
| 单文件读取/写入 | 4 MiB | 413 `FILE_TOO_LARGE` |
| 请求体总大小 | 8 MiB | 413 `FILE_TOO_LARGE` |
| manifest 条目数 | 100,000（超出时 `truncated: true`，不报错） | — |
| 回收批量路径数 | 100 | 400 `INVALID_REQUEST` |
| 相对路径长度 | 512 字符（单段 255） | 400 `PATH_INVALID` |
| Python 关联单文件/入口正文 | 1 MiB | 入口超限返回 413 `FILE_TOO_LARGE`；其他文件跳过并警告 |

Python 关联接口复用现有错误码：非 `.py` 文件返回 415 `UNSUPPORTED_FORMAT`，
非法符号或行号返回 400 `INVALID_REQUEST`。语法错误、无法解析的导入、扫描预算
或结果限额返回 200，在 `warnings` 中说明；预算超限还会设置 `truncated: true`。

## 变更规则

凡新增/修改错误码、字段或状态码：必须同步更新 `contracts/openapi.yaml`、
`contracts/errors.md`、`contracts/fixtures/`、后端实现与测试、移动端类型，
并在 `docs/decisions/` 记录 ADR。
