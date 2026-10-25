"""Git 只读信息（S4e）：项目分支/未提交修改/单文件 Diff。

安全与边界：
- 只运行固定白名单的只读 git 命令（status/diff），参数全部走 argv 列表，
  绝不经过 shell、绝不拼接用户输入；
- `path` 仍走 path_guard 语法校验（不要求文件存在——被删文件的 diff 也有意义）；
- 不是 git 仓库 / git 未安装 → available=false（正常业务状态，不是错误）；
- Diff 输出上限 256 KiB，超出截断并置 truncated；
- 超时 6 秒，防止仓库过大时挂死服务线程。
"""

from __future__ import annotations

import subprocess
from pathlib import Path

MAX_DIFF_CHARS = 256 * 1024
GIT_TIMEOUT_SECONDS = 6.0

_INDEX_CODES = {
    "A": "added",
    "M": "modified",
    "D": "deleted",
    "R": "renamed",
    "C": "copied",
    "T": "typechange",
    "U": "conflicted",
}
# 工作区列额外允许 untracked（??）
_WORKTREE_CODES = {**_INDEX_CODES, "?": "untracked"}


class GitServiceError(Exception):
    """code 取合同错误码；路由层转成统一错误响应。"""

    def __init__(self, code: str, message: str) -> None:
        self.code = code
        self.message = message
        super().__init__(f"[{code}] {message}")


def _run_git(root: Path, *args: str) -> tuple[int, str, str] | None:
    """运行只读 git 命令；git 未安装返回 None。失败不抛异常，由调用方判断 rc。"""
    try:
        completed = subprocess.run(  # noqa: S603 - 参数为固定列表，无 shell
            ["git", "-C", str(root), *args],
            capture_output=True,
            text=True,
            encoding="utf-8",
            errors="replace",
            timeout=GIT_TIMEOUT_SECONDS,
        )
        return completed.returncode, completed.stdout, completed.stderr
    except FileNotFoundError:
        return None
    except subprocess.TimeoutExpired:
        raise GitServiceError("IO_ERROR", "git 命令超时") from None
    except OSError as exc:
        raise GitServiceError("IO_ERROR", f"git 命令失败：{exc}") from exc


def git_status(root: Path) -> dict:
    """返回 GitStatusResponse 字段。"""
    result = _run_git(root, "status", "--porcelain=v1", "-b", "--no-renames")
    if result is None:
        return {"available": False, "reason": "电脑上没有安装 git", "branch": None, "changes": []}
    returncode, stdout, stderr = result
    if returncode != 0:
        reason = (stderr or stdout).strip().splitlines()
        return {
            "available": False,
            "reason": reason[0] if reason else "该目录不是 git 仓库",
            "branch": None,
            "changes": [],
        }

    branch: str | None = None
    changes: list[dict] = []
    for line in stdout.splitlines():
        if line.startswith("## "):
            head = line[3:]
            # "main...origin/main [ahead 1]" → main；"HEAD (no branch)" → detached
            branch = head.split("...")[0].strip()
            if branch == "HEAD (no branch)":
                branch = "HEAD (detached)"
            continue
        if len(line) < 4:
            continue
        index_char, worktree_char, path = line[0], line[1], line[3:].strip()
        if index_char == "!" or worktree_char == "!":
            continue  # --ignored 未开启时不应出现，防御性跳过
        changes.append(
            {
                "path": path,
                "index_status": _INDEX_CODES.get(index_char, "none"),
                "worktree_status": _WORKTREE_CODES.get(worktree_char, "none"),
            }
        )
    return {"available": True, "reason": None, "branch": branch, "changes": changes}


def git_diff(root: Path, relative_path: str, staged: bool) -> dict:
    """返回 GitDiffResponse 字段。"""
    args = ["diff", "--no-color"]
    if staged:
        args.append("--cached")
    args.extend(["--", relative_path])
    result = _run_git(root, *args)
    if result is None:
        raise GitServiceError("IO_ERROR", "电脑上没有安装 git")
    returncode, stdout, stderr = result
    if returncode != 0:
        detail = (stderr or stdout).strip().splitlines()
        raise GitServiceError("IO_ERROR", detail[0] if detail else "git diff 失败")
    text = stdout
    truncated = False
    if len(text) > MAX_DIFF_CHARS:
        text = text[:MAX_DIFF_CHARS]
        truncated = True
    return {"path": relative_path, "diff": text, "truncated": truncated}
