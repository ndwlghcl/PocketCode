# 构建环境与依赖版本（任务书任务 0 · 第 5 项）

## 本仓库已验证的开发环境

以下版本在开发机（Windows 11，10.240.24）上实际通过验证：

| 工具 | 已验证版本 | 最低要求 | 用途 |
|---|---|---|---|
| Python | 3.11 / 3.13 | ≥ 3.11 | 桌面端（FastAPI + PySide6） |
| Node.js | 24.x | ≥ 20 | 移动端构建、Capacitor |
| npm | 11.x | ≥ 10 | 移动端包管理 |
| JDK | 21.0.5 | ≥ 17 | Android APK 构建（Gradle） |
| Android SDK | platforms 34/35/36, build-tools 35/36 | platform 35 | Android APK 构建 |
| Gradle | 8.13（系统安装；Capacitor 亦自带 wrapper） | 8.9 | Android 构建 |

## 一键安装命令

```powershell
# 桌面端（在仓库根目录）
powershell -ExecutionPolicy Bypass -File scripts\setup-desktop.ps1

# 移动端
powershell -ExecutionPolicy Bypass -File scripts\setup-mobile.ps1
```

## 主要依赖与许可证

### 桌面端（desktop/pyproject.toml）

| 依赖 | 版本下限 | 许可证 | 说明 |
|---|---|---|---|
| fastapi | 0.115 | BSD-3-Clause | HTTP 服务框架 |
| uvicorn | 0.30 | BSD-3-Clause | ASGI 服务器 |
| pydantic | 2.7 | MIT | 请求/响应模型 |
| PySide6 | 6.7 | LGPL-3.0 / GPL / 商业双许可 | Qt 官方 Python 绑定 |

> **PySide6 许可提示**：LGPL-3.0 允许内部工具免费使用（动态链接官方 wheel 即满足）。
> 若将来以闭源形式对外分发安装包，需要评估 LGPL 合规（允许用户替换 Qt 库）或购买商业许可。
> 本项目当前为个人局域网工具，不触发该问题。

开发依赖（dev extra）：pytest（MIT）、httpx（BSD-3）、openapi-spec-validator（Apache-2.0）、
jsonschema（MIT）、PyYAML（MIT）。

### 移动端（mobile/package.json）

| 依赖 | 版本 | 许可证 | 说明 |
|---|---|---|---|
| react / react-dom | 18.3.x | MIT | UI 框架 |
| @capacitor/core / cli / android | 7.x | MIT | 原生壳与 Android 打包 |
| vite | 6.x | MIT | 构建工具 |
| vitest | 2.x | MIT | 单元测试 |
| typescript | 5.6.x | Apache-2.0 | 类型检查 |

后续阶段将引入：CodeMirror 6（MIT，S2）、@capacitor/share 等 Capacitor 插件（MIT，S3/S4）。

## Debug APK 构建环境说明

1. 安装 Android Studio（或仅命令行工具）并勾选「Android SDK Platform 35」；
2. 设置环境变量 `JAVA_HOME`（JDK 17+）与 `ANDROID_HOME`（SDK 根目录）；
   默认会自动探测 `%LOCALAPPDATA%\Android\Sdk`；
3. 运行 `scripts\setup-mobile.ps1`（生成 `mobile/android` 工程并同步 web 资源）；
4. 运行 `scripts\build-apk.ps1`，产物在
   `mobile\android\app\build\outputs\apk\debug\app-debug.apk`；
5. 把 APK 传到手机安装（允许「未知来源」）。

首次构建会从 `dl.google.com` 下载 Gradle 插件依赖，可能较慢；国内网络可配置
镜像仓库（修改 `mobile/android/build.gradle` 的 repositories），属于本机环境调整，
不建议提交到仓库。

## 正式分发（后续阶段）

Windows 安装程序（PyInstaller/Inno Setup）与 APK 签名发布不在 S0 范围（任务书任务 0：
「将来再做正式安装包签名/分发」）。
