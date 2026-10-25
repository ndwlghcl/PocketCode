# ADR-0004：S2c 原生 HTTP 桥与证书指纹身份

**状态**：已接受（2026-10-25）
**决策人**：主集成开发者（S2c 会话）
**关联**：架构文档 §1 NativeBridge / §3.1、ADR-0002、ADR-0003

## 背景

Android WebView 不信任自签证书，且对 IP 直连的证书主机名校验必然失败；
而架构文档 §3.1 的身份设计是"验证证书指纹而非域名"。浏览器 fetch 无法
实现该信任模型，必须走原生网络栈（架构文档 §8 风险表早有预案：
"必要时由原生 Kotlin 网络桥接处理证书绑定"）。

## 决策

1. **自定义本地 Capacitor 插件 `PocketCodeBridge`**（Java，
   `mobile/android/app/src/main/java/com/pocketcode/app/`）：
   - `request()`：HTTPS + 证书指纹绑定。TrustManager 校验链上证书的
     SHA-256 是否等于配对时核对的指纹；匹配即身份成立，同时豁免
     主机名校验（身份由指纹承担）。不匹配 → `ERR_TLS`，客户端把它与
     普通离线区分展示。
   - **诊断例外**：不带指纹时仅允许 `POST/GET /v1/health`（插件内强制），
     用于未配对时的连通性诊断；health 无凭据、无敏感数据，仍强制 TLS。
     除 health 外任何接口不带指纹一律拒绝。
   - 响应体上限 8 MiB；仅允许 `https://`（S1 的明文许可按 ADR-0002 移除）。
2. **安全存储**：插件提供 `secureSet/secureGet/secureRemove`，基于
   `androidx.security:security-crypto`（EncryptedSharedPreferences）。
   `device_token`、配对指纹只存这里，不进 localStorage（兑现 ADR-0002）。
3. **业务客户端重构**：`src/api/transport.ts` 统一传输层——原生走插件、
   浏览器开发模式走 fetch；`PocketCodeClient` 与 `probeHealth` 全部改经
   传输层，探测新增 `tls-mismatch` 分类。
4. **扫码**：`@capacitor-mlkit/barcode-scanning@7`（与 Capacitor 7 同主版本）。
   二维码载荷严格校验（版本、https 地址、指纹格式、配对码格式）后才使用。
5. **CORS（ADR-0003）保留**：桌面端继续放行 localhost 源；S2c 起手机端
   请求不再经过 WebView 网络栈，CORS 主要服务浏览器开发模式。

## 为什么安全

- 信任锚 = 配对时人工/扫码核对的证书指纹，而非系统 CA 列表；
- token 不落明文；无指纹时攻击面只剩 health（无凭据、无敏感内容）；
- 指纹不匹配 → 拒绝并明确提示，不做静默降级。

## 影响

- S3 的写接口自动获得同一保护（都走 `PocketCodeClient`）。
- iOS 将来复用同一 TS 层：原生桥需补 Swift 实现（capacitor://localhost 源
  已在 ADR-0003 的 CORS 白名单中）。
- 回归测试：移动端 29 个 vitest（transport/分类/QR 载荷/缓存）；
  指纹校验本身在真机验收（假指纹应显示"证书校验失败"）。
