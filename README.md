# PocketCode

手机优先、局域网连接、可离线使用的电脑本地代码工作台。
电脑上写代码不必推送 GitHub；躺下打开手机就能看电脑里的最新代码、直接编辑。
**当前阶段：S0（基础骨架与接口合同）已完成，功能尚未开始。**

## 文档

| 文档 | 内容 |
|---|---|
| [docs/PRD_v1.1.md](docs/PRD_v1.1.md) | 产品需求（唯一需求真源） |
| [docs/ARCHITECTURE_v0.1.md](docs/ARCHITECTURE_v0.1.md) | 技术架构与接口语义 |
| [docs/DEV_PLAN_v0.1.md](docs/DEV_PLAN_v0.1.md) | 阶段划分与 GLM 协作制度 |
| [contracts/openapi.yaml](contracts/openapi.yaml) | **接口唯一合同**（v1 语义冻结） |
| [contracts/errors.md](contracts/errors.md) | 错误码对照表 |
| [docs/decisions/](docs/decisions/) | ADR：重大技术决策留痕 |
| [docs/BUILD_ENVIRONMENT.md](docs/BUILD_ENVIRONMENT.md) | 依赖版本、许可证、APK 构建环境 |
| [docs/S0_测试卡.md](docs/S0_测试卡.md) | 当前阶段的用户测试步骤 |

## 目录结构

```text
PocketCode/
  contracts/            # openapi.yaml（唯一真源）、errors.md、fixtures/
  desktop/              # Windows 端：PySide6 管理窗口 + FastAPI 服务
    pocketcode/
      main.py           # 入口：单实例、Qt 主线程
      gui/              # 管理窗口、托盘（归 Windows UI 会话）
      server/           # FastAPI 路由/模型/运行器
      services/         # 业务服务（S1/S2 填充）
      storage/          # 设置存储（SQLite 在 S2 引入）
      discovery/        # mDNS 广播（S2）
      security/         # 鉴权与路径防护（S2）
    tests/              # pytest
  mobile/               # Android 端：React + TS + Capacitor
    src/
      app/              # 根导航、主题
      api/              # 合同类型、统一网络客户端
      features/         # projects / explorer / editor / drafts / settings / sharing
      storage/          # 本地仓储接口（S2/S3 实现）
      native/           # 原生桥接口（扫码/分享/安全存储）
    android/            # Capacitor 原生工程（setup-mobile.ps1 生成）
  integration-tests/    # 合同校验 + 场景用例（S1 起填充）
  scripts/              # Windows PowerShell 一键脚本
  docs/                 # 上述文档
```

## 快速开始

```powershell
# 1. 桌面端（创建 .venv、安装依赖）
powershell -ExecutionPolicy Bypass -File scripts\setup-desktop.ps1

# 2. 启动管理窗口（托盘常驻）
powershell -ExecutionPolicy Bypass -File scripts\start-desktop.ps1

# 3. 跑桌面测试 / 合同校验
powershell -ExecutionPolicy Bypass -File scripts\test-desktop.ps1
powershell -ExecutionPolicy Bypass -File scripts\check-contracts.ps1

# 4. 移动端（构建 web 资源、生成 android 工程）
powershell -ExecutionPolicy Bypass -File scripts\setup-mobile.ps1

# 5. 构建 debug APK（需 JDK 17+ 与 Android SDK）
powershell -ExecutionPolicy Bypass -File scripts\build-apk.ps1
```

## 阶段状态

| 阶段 | 状态 | 说明 |
|---|---|---|
| S0 基础骨架 | ✅ 本次交付 | monorepo、合同 v1 冻结、Windows 骨架、APK 空壳、校验脚本 |
| S1 热点连通性 | ⬜ | `/v1/health` 已就绪，待真机热点实验与手动 IP 诊断 UI |
| S2 配对 + 只读闭环 | ⬜ | 合同已冻结，未实现 |
| S3 可日用编辑 | ⬜ | |
| S4 体验增强 | ⬜ | |
| S5 高阶 | ⬜ | |

## 协作规则（对后续 GLM 会话）

1. `contracts/openapi.yaml` 是接口唯一真源；改合同必须同步 fixtures、errors.md、
   两端实现与测试，并在 `docs/decisions/` 记录 ADR。
2. 文件所有权：后端只改 `desktop/pocketcode/{server,services,storage,security,discovery}`；
   Windows UI 只改 `desktop/pocketcode/gui`（`main.py` 归主集成）；手机端只改 `mobile`。
3. 依赖方向：`routes → services → storage`；`features → api/storage`；反向禁止。
4. 每个任务交付：代码 + 测试 + 运行命令 + 修改文件清单 + 已知限制 + 手动验收步骤。
