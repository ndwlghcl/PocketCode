# ADR-0003：服务端为 App 的 WebView 本地源开放 CORS

**状态**：已接受（2026-10-25）
**决策人**：主集成开发者（S1 会话）
**关联**：ADR-0002、`mobile/src/api/probe.ts`、S1 真机缺陷

## 背景

S1 真机验收发现：手机浏览器地址栏直接访问 `http://<电脑IP>:8765/v1/health`
成功，但 App 内的同等请求全部失败。原因是 App 页面运行在 Capacitor 的
WebView 本地源（Android 默认 `https://localhost`）上，浏览器安全模型
（CORS）要求服务端显式返回"允许该源读取响应"的头；地址栏导航不受此限制。
服务端（FastAPI/Starlette）默认不返回任何 CORS 头 → fetch 被拦截，
探测归类为 `unreachable`。

## 决策

服务端增加 CORS 中间件，仅放行 App 自身的本地源：

- `allow_origin_regex: ^(https?|capacitor)://localhost(:\d+)?$`
  （覆盖 Android https://localhost、iOS capacitor://localhost、
  本机浏览器开发时的 http://localhost:5173）
- 方法：GET/POST/PUT/DELETE/OPTIONS；头：Accept/Content-Type/Authorization
  （Authorization 为 S2 业务请求的预检做准备）
- `allow_credentials=False`

## 为什么安全

- CORS 只放行"App 自己的页面源"，任意外部网站（其他 origin）仍读不到
  本服务的响应；
- 数据访问控制由 Bearer 设备凭据（S2 起）承担，CORS 从来不是鉴权手段，
  开放本地源不降低安全边界；
- health 无敏感信息；后续文件接口全部要求认证。

## 影响

- S2 保持本配置即可；若将来改用 CapacitorHttp 原生通道（绕过 WebView
  网络栈），CORS 可重新评估，须先更新本 ADR。
- 回归测试：desktop/tests/test_cors.py（预检、响应头、未知源拒绝、
  capacitor:// 与 Authorization 预检）。
