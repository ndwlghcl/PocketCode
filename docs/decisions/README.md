# ADR 目录（Architecture Decision Records）

重大技术决策（尤其是偏离架构文档时）必须在本目录记录：
`ADR-0001-<slug>.md`，内容包括背景、决策、理由、影响与迁移方案。
任务书 A 节：不让多个 GLM 会话各自选型；偏离架构先留痕。

- [ADR-0001](ADR-0001-s0-contract-and-skeleton-decisions.md) — S0 合同与骨架的实现决策
- [ADR-0002](ADR-0002-s1-cleartext-health-probe.md) — S1 明文 HTTP 诊断与探测错误分类（S2 须收回明文许可）
- [ADR-0003](ADR-0003-cors-for-capacitor-webview-origin.md) — 服务端为 App WebView 本地源开放 CORS（S1 真机缺陷）
- [ADR-0004](ADR-0004-native-bridge-tls-pinning.md) — S2c 原生 HTTP 桥与证书指纹身份（health 诊断例外）
