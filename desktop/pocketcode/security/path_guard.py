"""相对路径与真实路径防护（架构文档 §5）。

两层校验，缺一不可：
1. `validate_relative_path`：合同语法规则（拒绝 `..`、反斜杠、控制字符、
   Windows 保留名等）；
2. `resolve_under_root`：真实路径包含校验 —— 对候选路径和授权根目录都做
   `resolve()`（展开符号链接 / junction），再做包含判断。禁止字符串
   startswith 式判断。
"""

from __future__ import annotations

import re
from pathlib import Path, PureWindowsPath

MAX_PATH_CHARS = 512
MAX_SEGMENT_CHARS = 255

_WINDOWS_RESERVED = {"con", "prn", "aux", "nul", *(f"com{i}" for i in range(1, 10)),
                     *(f"lpt{i}" for i in range(1, 10))}

_DRIVE_RE = re.compile(r"^[A-Za-z]:")


class PathGuardError(Exception):
    """code: PATH_INVALID（语法不符合合同）或 PATH_FORBIDDEN（越出授权根目录）。"""

    def __init__(self, code: str, message: str) -> None:
        if code not in ("PATH_INVALID", "PATH_FORBIDDEN"):
            raise ValueError(f"unexpected code: {code}")
        self.code = code
        self.message = message
        super().__init__(f"[{code}] {message}")


def validate_relative_path(path: str) -> str:
    """校验合同 RelativePath 规则；通过时原样返回，失败抛 PATH_INVALID。"""
    if not isinstance(path, str) or not path.strip():
        raise PathGuardError("PATH_INVALID", "路径不能为空")
    if len(path) > MAX_PATH_CHARS:
        raise PathGuardError("PATH_INVALID", f"路径超过 {MAX_PATH_CHARS} 字符")
    if path.startswith("/") or path.endswith("/"):
        raise PathGuardError("PATH_INVALID", "路径不能以 / 开头或结尾")
    if "\\" in path:
        raise PathGuardError("PATH_INVALID", "路径必须使用 / 分隔")
    if _DRIVE_RE.match(path) or PureWindowsPath(path).drive:
        raise PathGuardError("PATH_INVALID", "不允许绝对路径")

    for segment in path.split("/"):
        if segment in ("", ".", ".."):
            raise PathGuardError("PATH_INVALID", "路径不允许空段、. 或 ..")
        if len(segment) > MAX_SEGMENT_CHARS:
            raise PathGuardError("PATH_INVALID", "单个路径段超过 255 字符")
        if any(ord(ch) < 0x20 or ch == "\x7f" for ch in segment):
            raise PathGuardError("PATH_INVALID", "路径不允许控制字符")
        if segment.lower() in _WINDOWS_RESERVED:
            raise PathGuardError("PATH_INVALID", f"不允许 Windows 保留名：{segment}")
        if segment.endswith(".") or segment.endswith(" "):
            raise PathGuardError("PATH_INVALID", "路径段不能以点或空格结尾")
    return path


def resolve_under_root(root: Path, relative_path: str) -> Path:
    """把已授权根目录下的相对路径解析为真实绝对路径；越界抛 PATH_FORBIDDEN。

    resolve() 会展开符号链接与 Windows junction：只要最终真实位置不在
    授权根目录（解析后）之内，一律拒绝——无论链接是在项目里哪个位置。
    """
    rel = validate_relative_path(relative_path)
    try:
        resolved_root = root.resolve(strict=True)
    except OSError as exc:
        raise PathGuardError("PATH_FORBIDDEN", "授权项目根目录不可访问") from exc

    candidate = (root / Path(*rel.split("/"))).resolve()
    if not candidate.is_relative_to(resolved_root):
        raise PathGuardError("PATH_FORBIDDEN", "路径越出授权项目根目录")
    return candidate
