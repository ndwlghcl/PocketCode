# ADR-0002：S1 连接诊断的明文 HTTP 与错误分类决策

**状态**：已接受（2026-10-25）
**决策人**：主集成开发者（S1 会话）
**关联**：架构文档 §0/§3.1、任务书 §E、`docs/S1_预检记录.md`

## 背景

S1 是"热点连通性实验"：手机对电脑做无文件权限的 `/v1/health` 诊断。
架构文档 §0 的终态是"局域网 HTTPS/JSON REST + 证书指纹校验"，但 TLS 证书、
配对与 pinning 属于 S2 范围；S1 若先做 TLS 会把网络实验和证书工程耦合在一起。

## 决策

1. **S1 的 health 诊断使用明文 HTTP**。依据架构文档 §3.1 的两阶段设计：
   诊断阶段（无文件访问、无敏感内容）允许先跑通网络；S2 引入配对时
   全部业务接口切 HTTPS + 证书指纹校验，届时移除明文许可。
2. **Android 侧放行明文的范围**：
   - Manifest 增加 `android:usesCleartextTraffic="true"`；
   - `capacitor.config.ts` 增加 `android.allowMixedContent: true`
     （WebView 页面运行在 https scheme 下，需要允许 http 外部请求）。
   两项在 S2 切 TLS 时一并收回，本 ADR 留痕防止遗忘。
3. **探测错误分类（诚实边界）**：
   - `timeout`（AbortController 可靠区分）、`unreachable`（拒绝连接 / IP
     不可解析 / 断网 —— WebView fetch 无法进一步区分，如实合并）、
     `http-error`（服务在但状态异常）、`unexpected-response`（200 但不是
     PocketCode，典型是端口被其他程序占用）。
   - 界面按分类给出不同排查提示；不声称能区分"拒绝连接"与"DNS 失败"。
4. **地址记忆用 localStorage**：地址不是机密；S2 的 device_token 必须用
   原生安全存储（架构文档 §1），不得沿用 localStorage。
5. **自动刷新间隔 15 秒**（探测包 < 100 字节，流量与耗电可忽略），不做
   指数退避——S1 目标是"状态可见"，退避优化留给 S2 的重连机制。

## 影响

- S2 开工时的强制清单：移除 `usesCleartextTraffic` 与 `allowMixedContent`；
  新增自签证书 + pinning；health 探测随业务接口一起走 TLS。
- 诊断提示文案中不出现"电脑绝对路径"等敏感信息。
