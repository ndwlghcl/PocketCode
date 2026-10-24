"""PocketCode Windows 桌面端包。

分层规则（架构文档 §1）：routes → services → storage/filesystem；
GUI 只调用 AppController，不得被 FastAPI 路由引用。
"""

__version__ = "0.1.0"
