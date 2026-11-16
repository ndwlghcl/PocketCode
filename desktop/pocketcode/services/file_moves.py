"""由文件系统保证目标不存在的移动；禁止回退到覆盖操作。"""

from __future__ import annotations

import errno
import os
import sys
from pathlib import Path


def rename_exclusive(source: Path, target: Path) -> None:
    """同文件系统原子移动文件或目录；目标已存在时失败。"""
    if os.name == "nt":
        os.rename(source, target)
        return

    if sys.platform != "linux":
        raise OSError(errno.ENOTSUP, "当前系统不支持安全的不覆盖移动")
    import ctypes

    libc = ctypes.CDLL(None, use_errno=True)
    rename = getattr(libc, "renameat2", None)
    if rename is None:
        raise OSError(errno.ENOTSUP, "当前文件系统不支持安全的不覆盖移动")
    rename.argtypes = [ctypes.c_int, ctypes.c_char_p, ctypes.c_int, ctypes.c_char_p, ctypes.c_uint]
    rename.restype = ctypes.c_int
    if rename(-100, os.fsencode(source), -100, os.fsencode(target), 1) != 0:
        code = ctypes.get_errno()
        raise OSError(code, os.strerror(code), str(target))
