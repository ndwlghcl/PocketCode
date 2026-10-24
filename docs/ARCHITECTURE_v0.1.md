# PocketCode 技术架构设计 v0.1

**日期**：2026-10-24  
**性质**：工程设计建议（不是用户新增的产品要求）；需求依据《PocketCode 产品需求文档 v1.1》。  
**核心目标**：Windows 11 + Android 手机上离线/局域网访问电脑本地项目，先读取再编辑，交付独立 Windows 程序和可安装 APK。

## 0. 一页决策

| 维度 | 选型/边界 | 为什么这样做 |
|---|---|---|
| 仓库 | 单一 monorepo，desktop / mobile / contracts / docs | API、移动端和服务端同步演进，减少 GLM 多对话写散 |
| Windows 形态 | PySide6（Qt Widgets）管理窗口 + 托盘；同一用户进程承载 FastAPI 服务 | 用户要求独立窗口、无需浏览器；不急于引入 Windows NT Service |
| Windows 服务端 | Python、FastAPI、Pydantic，Uvicorn | 用户已经了解 FastAPI；文件与项目处理适合 Python |
| Android 形态 | React + TypeScript + Capacitor，打包 APK；CodeMirror 6 | 手机界面、触摸代码编辑、折行和 Android 原生能力可兼顾 |
| 移动存储 | SQLite 适配器 + App 私有文件目录；草稿事务写入 | 目录元数据、草稿索引和离线文本应持久化，不能仅依赖 React 状态 |
| 服务端存储 | SQLite（授权项目、配对设备、配置）+ 专用回收区 | 本地单机系统，无需 Redis / 云数据库 |
| 通讯 | 局域网 HTTPS/JSON REST；后续按需增加 WebSocket/SSE | 文件浏览编辑以请求/响应为主；实时推送是增强项 |
| 自动发现 | Android 原生 NSD/mDNS + 上次成功地址 + 电脑二维码/手动连接兜底 | 兼顾热点 IP 变化和部分设备不支持组播的情况 |
| 分发 | Windows 打包安装程序 + 本地签名 Debug APK（以后再优化发布） | 最早阶段就以真机软件而非网页作为验收 |

**明确不做**：电脑端代码编辑器、远程公网穿透、GitHub 中转、云端账号、RAG/AI 服务接入、复杂 IDE 重构、默认自动写回草稿。

## 1. 逻辑结构

```text
Android APK
  React UI
    ├─ 项目/固定排序目录浏览/最近阅读标记
    ├─ CodeMirror 阅读与编辑
    ├─ 草稿箱、离线缓存、本地搜索
    └─ 分享、Diff（按阶段交付）
  Application Services
    ├─ ConnectionManager（自动发现、连接状态、重连）
    ├─ PocketCodeApi（统一网络调用，类型由合同生成）
    ├─ LocalRepository（SQLite / 应用私有目录）
    └─ NativeBridge（扫码、原生网络、安全存储、分享）
               │ 局域网 TLS + token，HTTPS REST
               ▼
Windows PocketCode（桌面单进程）
  PySide6 管理窗口 + 系统托盘  ←→  App Controller / Settings
                                       │
  FastAPI 路由 /v1/* ─→ Auth/Pairing ─→ WorkspaceService
                                       ├─ FileService
                                       ├─ Version/ConflictService
                                       ├─ Trash/SnapshotService
                                       └─ Discovery/ChangeNotifier
                                            │
                                      仅授权的项目根目录
```

桌面 UI 只调用 **应用服务层** 管理项目与设备；不要让 PySide6 组件被 FastAPI 路由直接引用。FastAPI 在后台线程/独立异步循环运行，Qt UI 在主线程；共享状态走线程安全控制器、消息/信号，而不是跨线程直接改 UI。尽量避免产生第二份业务实现。

**进程规则**：默认只启动一个 Windows 用户会话实例；关闭管理窗口不退出进程，托盘「退出」才关闭服务并清理监听。用户登录后自动启动，不使用需要管理员安装的 NT Service。服务端不允许多进程 worker，以免复制设备注册/缓存状态；将来扩展时再评估。

## 2. 建议目录树（各 GLM 对话严格遵守）

```text
PocketCode/
  README.md
  docs/
    PRD_v1.1.md
    ARCHITECTURE_v0.1.md
    DEV_PLAN_v0.1.md
    decisions/                    # ADR：未来重大技术变更留痕
  contracts/
    openapi.yaml                  # 接口唯一真源，客户端类型由此生成
    errors.md                     # 通用错误码与示例
    fixtures/                     # 模拟数据 / HTTP 交互用例
  desktop/
    pyproject.toml
    pocketcode/
      main.py                     # 桌面应用入口/唯一实例
      gui/                        # PySide6 页面 / 托盘
      server/                     # FastAPI app、routes、依赖注入
      services/                   # projects, files, trash, pairing, changes
      storage/                    # SQLite、配置仓库
      discovery/                  # Windows mDNS 广播
      security/                   # 权限、路径防护、证书、token
    tests/
  mobile/
    package.json
    capacitor.config.ts
    src/
      app/                        # 根导航、主题、状态管理
      api/                        # 生成类型、API client
      features/
        projects/
        explorer/
        editor/
        drafts/
        settings/
        sharing/
      storage/                    # SQLite 本地仓储 + 缓存
      native/                     # Android 插件适配层
    android/                      # 原生工程，由 Capacitor 管理
    tests/
  integration-tests/
    contract/
    scenarios/
```

**依赖方向**：`routes → services → storage/filesystem`，`mobile features → api/storage`。反向依赖不允许；API 响应不是直接返回 Python 文件系统 Path 对象。后端只能用 `project_id + 相对路径` 接收文件定位；路径以 `/` 标准化后验证，不能让客户端提交电脑绝对路径。

## 3. 网络发现和配对

### 3.1 两阶段连接

1. **诊断阶段（无文件访问）**：允许临时测试 IP:port 连通性与 `/v1/health`；该接口只返回最小服务状态，不泄漏项目名称、电脑用户名或路径。真机热点测通后结束此阶段。
2. **可读取真实文件阶段**：电脑为安装实例生成唯一 `server_id` 和 TLS 证书，手机通过电脑显示的配对二维码获取地址、证书指纹和一次性配对材料；验证证书指纹后完成配对，电脑弹出确认，给手机分发授权凭据。网络请求须身份认证，配对之外的目录与文件接口全部拒绝匿名访问。

**重要**：不因“只在局域网”而认为 HTTP 明文携带访问令牌和代码是安全的；使用 HTTPS + 证书指纹校验或经过评审的等效方案。Android WebView 对自签证书可能不信任，必要时由原生 Kotlin 网络桥接处理证书绑定（pinning），避免全局忽略 TLS 证书错误。证书更新需要明确的重新信任流程；配对 token 必须能在电脑端撤销。

### 3.2 自动发现/重连顺序

- 用户打开 APK → 总是显示**项目列表**（先加载上次目录快照），后台发起连接。
- 先试上次可信地址（快速超时），同时或随后由 Android NSD 发现 `_pocketcode._tcp` 广播；必须验证 `server_id` 与已信任的证书指纹，发现成功不等于认证成功。
- IP 改变后用发现结果更新连接地址；不可连接则显示「离线」，保留草稿。提供手动刷新/扫码兜底。不要默认要求每次输入 IP。
- 电脑连上手机热点后，Android 与 Windows 之间是否能接收 mDNS 需真机测试，不得假定所有网络都会工作。
- 用户一次配对后拥有该电脑全部**显式授权项目**的访问权限，包括后续授权的新项目。撤销设备立即拒绝后续请求。

**Android 系统兼容性**：检查 Android 16/17 与目标 SDK 的局域网权限和 NSD 行为；Android 17 target 37+ 需要 `ACCESS_LOCAL_NETWORK` 或合适的系统发现路径。未授权时给出权限说明，不要误报“电脑离线”。

## 4. API 合同 v1（概念冻结，精确 Schema 写入 contracts/openapi.yaml）

统一前缀 `/v1`。所有 JSON 使用 UTF-8，时间 ISO 8601，ID 是服务端稳定生成的 UUID；分页/大小上限写入合同。下列为**必须覆盖的语义**，不是要求照抄路径命名。

| 分类 | API | 语义及关键字段 |
|---|---|---|
| 健康 | `GET /v1/health` | 最小健康状态与协议版本（无敏感内容） |
| 配对 | `POST /v1/pair/complete` | 消耗一次性配对票据 + Windows 本人确认，颁发手机专属凭据 |
| 项目 | `GET /v1/projects` | 返回全部授权项目，`id, name, revision` |
| 目录 | `GET /v1/projects/{id}/manifest` | 返回完整目录元数据快照及 `revision, generated_at`，支持后续增量 |
| 文件读取 | `GET /v1/projects/{id}/file?path=...` | `content, encoding, newline, version, size, read_only`；二进制拒绝解码 |
| 文件保存 | `PUT /v1/projects/{id}/file` | `path, base_version, content, encoding, newline`；只在未冲突时写回 |
| 创建 | `POST /v1/projects/{id}/files` | 新建文件/目录，已存在时明确报错 |
| 删除 | `POST /v1/projects/{id}/trash` | 文件/目录移入专用回收区，返回 `trash_id` |
| 恢复 | `POST /v1/trash/{trash_id}/restore` | 从回收区恢复；原路径被占用时不覆盖 |
| 权限管理 | 本机 UI 内直接通过 App Controller | 添加/移除授权项目、撤销手机，不通过可被普通手机调用的管理 API |

文件返回 `version` 首版使用完整内容 `SHA-256` + 必要文件元数据计算的版本标识；至少须能判定字节变化。目录树 `revision` 是服务器快照序号，**不**代表某文件正文版本。

示例（内容仅供接口作者理解）：

```json
{
  "project_id": "sample-id",
  "path": "agents/react_agent.py",
  "base_version": "sha256:...",
  "content": "print('hello')\n",
  "encoding": "utf-8",
  "newline": "LF"
}
```

通用错误响应：

```json
{
  "error": {
    "code": "VERSION_CONFLICT",
    "message": "电脑文件已在别处修改",
    "request_id": "...",
    "details": { "current_version": "sha256:..." }
  }
}
```

**最低错误码**：`UNAUTHORIZED`、`DEVICE_REVOKED`、`PROJECT_NOT_FOUND`、`PATH_FORBIDDEN`、`FILE_NOT_FOUND`、`UNSUPPORTED_FORMAT`、`FILE_TOO_LARGE`、`VERSION_CONFLICT`、`ALREADY_EXISTS`、`OFFLINE`（客户端生成）、`IO_ERROR`。HTTP 状态码必须恰当，不能所有失败都返回 200。

## 5. 文件系统与写入安全

- Windows 用户在**桌面管理界面**显式选择根目录，系统把它存成一个授权项目或工作区；手机只看逻辑 `project_id`，不接触电脑绝对路径。
- 对 `..`、绝对路径、符号链接、Windows junction/reparse point、路径大小写和竞态进行约束；不能只用字符串 `startswith` 检查目录前缀。读写前重算并校验真实路径属于授权根目录；权限失败不暴露其他私人路径。
- 不准让客户端经 `project_id/path` 触碰未授权路径；文件大小、缓存大小、请求体大小要有上限；忽略 `.git` 的大对象、虚拟环境和密钥，过滤规则可配。
- 写入协议：`读取原始字节 → 客户端持有 base_version → 写入时后端复查 → 创建可恢复快照 → 同目录临时文件/刷盘 → 原子替换（适用时） → 返回新 version`。同项目同路径写操作用互斥机制串行化；外部 IDE 并不遵守锁，无法声称彻底消灭极短竞态，须在最终替换附近再次验证并确保有恢复快照。
- 默认不自动修改文件换行：编辑器视觉折行不修改代码；在可识别的编码/换行下尽量保留（特别是 CRLF / BOM）。无法安全回写的编码或二进制先以只读/不支持提示处理。
- **用户未点「保存到电脑」前，编辑和草稿只保存在手机**。正式保存冲突返回 HTTP 409，草稿仍在本地。覆盖需用户明确确认并先建立快照。
- 删除默认进入 PocketCode 专用回收区，支持跨会话恢复。恢复目标被占用必须报错，不能悄悄覆盖。

## 6. 手机状态模型

### 6.1 目录和内容缓存

- **目录元数据**：在线连接时默认同步完整授权项目树的快照（首版可全量+校验版本，后续增量）；离线保留文件夹/文件名，未缓存文件仍显示。
- **正文缓存**：默认只缓存用户打开过的文本文件；可选整项目源码缓存。离线内容明确标识上次更新时间，不标为电脑最新。
- **草稿**：草稿独立于缓存保存（SQLite 元信息 + 安全可靠的私有文本存储）；多个草稿允许同源文件不同名称、不同基线；任何缓存清理操作不能删草稿。
- 最近阅读项目/文件只影响标记与记录，**不影响排序**。目录默认文件夹在前、文件在后，各组名称排序；项目进入默认根目录，文件重新打开恢复阅读位置。

### 6.2 连接/编辑有限状态

- 连接：`connecting → online → reconnecting/offline`，重试有退避，用户可手动刷新；手机不在线也能从缓存启动。
- 文件：`clean → dirty (local autosaved) → saving → synced`；冲突转 `conflict`，失败转 `dirty + error` 而**不是**清空编辑器；不同文件的草稿和光标位置独立。
- 手机进入后台前 flush 草稿，防止 WebView 被系统回收造成编辑丢失；真机测试强制停止/重启恢复能力。

## 7. 测试与质量门禁

1. Windows：FastAPI 路由契约、授权路径、`..`/junction 越界、大小限制、编码、回收区、版本冲突、并发写入、模拟文件权限异常。
2. Android：APK 安装/冷启动、热点互通、真实文件缓存、关闭重开草稿保留、长行视觉折行不改字节、系统字体与中文文件名、系统分享。
3. 集成：电脑 PyCharm 保存 → 手机读取更新；手机编辑 → 电脑磁盘确实改变；电脑与手机同时编辑 → 409 不丢草稿；撤销手机 → 读写立即被拒绝。
4. 连接：电脑热点 IP 变化、热点断开重连、NSD 发现失败后的二维码/手动 fallback，系统权限被拒绝，防火墙开启时诊断。
5. 安全：除无敏感信息的 health/pair 外，所有文件/项目 API 必须认证；TLS 校验证书指纹；日志不写完整源码/密钥；设备密钥用安全存储。

**M0 完成定义**：可安装 Windows 程序和 APK；用户配对；手机读取授权真实项目；修改电脑磁盘文件后手机可刷新看到变化；无配对设备不能读取真实文件。连接阶段允许临时无文件权限的健康检查诊断，但不能把无认证开发模式当作正式交付。

## 8. 已知风险与降级策略

| 风险 | 降级/行动 |
|---|---|
| Android 热点下 mDNS 不可靠 | 使用扫码首次配对 + 最近可信地址 + 手动连接诊断；不强依赖 mDNS |
| Android 自签 HTTPS/原生桥接复杂 | 真机先验证原生 pinning；无法完成时停在仅 health 的连通性 PoC，不开放敏感文件接口 |
| SQLite / WebView 数据生命周期 | SQLite 包一层 Repository，设备上验证强杀、重启、升级与卸载前导出 |
| 目录树太大 | 分批/压缩/大小限额，排除依赖目录；“完整树”以授权且未过滤的源码范围为准 |
| PyCharm 与手机竞态 | 409、恢复快照、谨慎覆盖；不会承诺零竞态 |
| GLM 多会话接口分叉 | OpenAPI 为唯一合同，先合约测试、再合并，冲突由集成人员处理 |

## 9. 参考（官方技术文档，2026-10-24 查阅）

- Android Network Service Discovery： https://developer.android.com/reference/android/net/nsd/NsdManager
- Android 局域网权限： https://developer.android.com/privacy-and-security/local-network-permission
- Capacitor 安全指南： https://capacitorjs.com/docs/guides/security
- Capacitor App 配置： https://capacitorjs.com/docs/config
- Qt `QSystemTrayIcon`： https://doc.qt.io/qtforpython-6.10/PySide6/QtWidgets/QSystemTrayIcon.html
- FastAPI lifespan： https://fastapi.tiangolo.com/advanced/events/
