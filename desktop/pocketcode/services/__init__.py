"""服务层占位包（S1/S2 实现）。

按架构文档 §1，本包将承载：
- projects：授权项目注册、project_id ↔ 根目录映射、manifest 生成
- files：只读/写入文件服务、编码与换行处理、内容 hash 版本
- trash：专用回收区与恢复
- pairing：二维码配对、一次性票据、设备凭据颁发与撤销
- changes：项目变化发现与通知

S0 阶段仅占位；文件所有权归「Windows 后端 GLM」（任务书 A 节）。
"""
