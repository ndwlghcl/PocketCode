# ADR-0001：S0 合同与骨架的实现决策

**状态**：已接受（2026-10-24）  
**决策人**：主集成开发者（S0 会话）  
**关联**：架构文档 §1/§4、任务书任务 0

## 背景

任务 0 要求把「概念冻结」的 v1 接口语义落成精确 Schema 并搭建可运行的骨架。
架构文档刻意留白的部分需要主集成做具体决定并留痕。

## 决策与理由

1. **OpenAPI 3.1 作为合同格式**。FastAPI 原生兼容 3.1；JSON Schema 2020-12 方言
   支持 `const`/`oneOf` 表达目录节点判别。代价是部分旧代码生成器不支持，
   但移动端类型生成安排在 S2，可选择兼容工具。

2. **合同中包含全部 v1 语义（含写入/回收区）而非仅 S0 必需的 5 个端点**。
   架构文档 §4 明确「概念冻结，精确 Schema 写入 contracts/openapi.yaml」；
   一次冻结避免后续阶段反复改动合同造成两端漂移。S0 只实现 `/v1/health`。

3. **错误码在最低集合之外新增**：`PAIRING_CODE_INVALID/USED/REJECTED/TIMEOUT`、
   `PATH_INVALID`、`NOT_FOUND`、`METHOD_NOT_ALLOWED`。理由：配对流程需要区分
   失败原因（PRD §3.2 要求明确的诊断提示）；路径语法错误与越界（403）必须可区分；
   未实现路由返回统一包裹需要通用 `NOT_FOUND`。全部记录于 errors.md 对照表。

4. **请求校验失败返回 400 `INVALID_REQUEST`**（覆盖 FastAPI 默认 422），
   保证移动端只需处理一种校验错误形态。

5. **文件 `version` = 原始字节 SHA-256**（`sha256:<64hex>`）。满足「至少能判定
   字节变化」；不含文件名/mtime 等元数据，避免保存场景中由无关字段引发假冲突。

6. **编码枚举限定 `utf-8 / utf-8-bom / utf-16-le / utf-16-be`**。覆盖 PRD 的
   「UTF-8/常见编码 + BOM 保留」；其余编码首版直接 415 `UNSUPPORTED_FORMAT`，
   宁可拒绝也不损坏文件（PRD §10）。

7. **服务在用户进程内的后台线程运行 Uvicorn**（非独立进程、非 Windows 服务）。
   架构文档 §1 明确单进程规则；Uvicorn 在线程中自建事件循环，Qt 保持主线程。
   暂停服务 = 停止监听（可恢复）；端口默认 8765，可在管理窗口修改。

8. **设置持久化用单文件 JSON + 原子替换**（%APPDATA%/PocketCode/settings.json）。
   S0 数据量小；SQLite（授权项目/设备/回收区）在 S2 引入，届时迁移而不是扩展。

9. **单实例锁用 QLocalServer 命名锁**，跨平台且无需管理员权限。

10. **移动端构建链选型**：Vite 6 + Vitest 2 + React 18.3 + Capacitor 7（均取当前
    稳定 major）。CodeMirror 6 依赖推迟到 S2 引入，S0 不安装以保持依赖面最小。

## 影响

- 移动端 `src/api/types.ts` 在 S0 手写对齐合同，S2 改为代码生成（类型不得漂移）。
- `desktop/pocketcode/server/schemas.py` 只能定义合同已有字段。
- 后续 GLM 会话如需推翻以上任一决策，先改本 ADR 并同步合同/两端实现/测试。
