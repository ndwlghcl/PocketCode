"""发现层占位包（S2 实现）。

将承载 Windows 端 `_pocketcode._tcp` mDNS 广播，供 Android NSD 自动发现。
架构文档 §3.2 明确：mDNS 在手机热点下不可视为确定可用，必须保留
二维码/手动连接兜底。文件所有权归「Windows 后端 GLM」。
"""
