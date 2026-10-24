"""本地存储层。

S0 仅包含设置存储（授权项目/配对设备/端口）。SQLite 仓储在 S2/S3 引入。
文件所有权归「Windows 后端 GLM」。
"""

from pocketcode.storage.settings_store import (
    AuthorizedProject,
    PairedDevice,
    Settings,
    SettingsStore,
    default_settings_path,
)

__all__ = [
    "AuthorizedProject",
    "PairedDevice",
    "Settings",
    "SettingsStore",
    "default_settings_path",
]
