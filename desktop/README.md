# PocketCode Desktop（Windows 端）

PySide6 管理窗口 + 系统托盘 + FastAPI 局域网服务，单进程运行（架构文档 §1）。

```text
pocketcode/
  main.py           # 入口：单实例锁、Qt 主线程、服务生命周期
  app_controller.py # GUI ↔ 服务唯一桥梁（Qt 无关）
  gui/              # 管理窗口、托盘、信号桥、图标（归 Windows UI 会话）
  server/           # FastAPI app、路由、Schema、运行器
  services/         # 业务服务（S1/S2 填充）
  storage/          # 设置存储（SQLite 在 S2 引入）
  discovery/        # mDNS 广播（S2）
  security/         # 鉴权、路径防护、TLS（S2）
tests/              # pytest
```

安装与运行见仓库根目录 README 与 `scripts/`。
接口以 `contracts/openapi.yaml` 为唯一合同；本包不得返回合同之外的字段。
