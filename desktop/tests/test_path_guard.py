"""路径防护：合同语法规则 + 真实路径包含（穿越/junction/符号链接越界）。"""

from __future__ import annotations

import subprocess
from pathlib import Path

import pytest

from pocketcode.security.path_guard import (
    PathGuardError,
    resolve_under_root,
    validate_relative_path,
)


def _make_junction(link: Path, target: Path) -> bool:
    """Windows junction 不需要管理员权限；失败（非 Windows 等）返回 False。"""
    result = subprocess.run(
        ["cmd", "/c", "mklink", "/J", str(link), str(target)],
        capture_output=True,
        text=True,
    )
    return result.returncode == 0


# ------------------------------------------------------------ 语法校验
@pytest.mark.parametrize(
    "path",
    [
        "agents/react_agent.py",
        "README.md",
        "深度/嵌套/文件 名.py",
        "a" * 255 + "/b.py",
    ],
)
def test_valid_paths_pass(path):
    assert validate_relative_path(path) == path


@pytest.mark.parametrize(
    "path",
    [
        "",                       # 空
        "   ",
        "../secrets.txt",         # 上跳
        "agents/../../etc",       # 中段上跳
        "/etc/passwd",            # 绝对（Unix 风格开头）
        "C:/Windows/system32",    # 盘符
        "agents\\react.py",       # 反斜杠
        "a//b",                   # 空段
        "a/",                     # 尾斜杠
        "/a",                     # 头斜杠
        "con",                    # 保留名
        "COM1",
        "lpt3",
        "aux",                    # 保留名（小写）
        "name.",                  # 段尾点
        "name ",                  # 段尾空格
        "a\x00b",                 # NUL
        "a\x1fb",                 # 控制字符
        "x" * 513,                # 超长
    ],
)
def test_invalid_paths_rejected(path):
    with pytest.raises(PathGuardError) as excinfo:
        validate_relative_path(path)
    assert excinfo.value.code == "PATH_INVALID"


def test_reserved_names_inside_path_also_rejected():
    with pytest.raises(PathGuardError):
        validate_relative_path("docs/con")


# ------------------------------------------------------------ 真实路径包含
def test_resolve_inside_root(tmp_path):
    (tmp_path / "agents").mkdir()
    target = (tmp_path / "agents" / "react.py")
    target.write_text("x", encoding="utf-8")
    resolved = resolve_under_root(tmp_path, "agents/react.py")
    assert resolved == target.resolve()


def test_traversal_is_rejected_by_syntax_layer(tmp_path):
    with pytest.raises(PathGuardError):
        resolve_under_root(tmp_path, "../outside.txt")


def test_junction_escape_is_forbidden(tmp_path):
    """junction 指向根目录之外时必须拒绝（架构文档 §5 的核心场景）。"""
    outside = tmp_path / "outside"
    outside.mkdir()
    (outside / "secret.txt").write_text("secret", encoding="utf-8")

    project_root = tmp_path / "project"
    (project_root / "src").mkdir(parents=True)

    if not _make_junction(project_root / "src" / "leak", outside):
        pytest.skip("无法创建 junction（非 Windows 环境）")

    with pytest.raises(PathGuardError) as excinfo:
        resolve_under_root(project_root, "src/leak/secret.txt")
    assert excinfo.value.code == "PATH_FORBIDDEN"

    # junction 指向根目录内部则允许
    inside = project_root / "data"
    inside.mkdir()
    (inside / "ok.txt").write_text("ok", encoding="utf-8")
    if _make_junction(project_root / "src" / "alias", inside):
        resolved = resolve_under_root(project_root, "src/alias/ok.txt")
        assert resolved.name == "ok.txt"


def test_symlink_escape_is_forbidden(tmp_path):
    """符号链接越界（创建可能因权限失败，此时跳过）。"""
    outside = tmp_path / "outside"
    outside.mkdir()
    (outside / "secret.txt").write_text("secret", encoding="utf-8")

    project_root = tmp_path / "project"
    project_root.mkdir()
    link = project_root / "leak"
    try:
        link.symlink_to(outside, target_is_directory=True)
    except OSError:
        pytest.skip("无法创建符号链接（需要开发者模式或管理员）")

    with pytest.raises(PathGuardError) as excinfo:
        resolve_under_root(project_root, "leak/secret.txt")
    assert excinfo.value.code == "PATH_FORBIDDEN"


def test_missing_root_is_forbidden(tmp_path):
    with pytest.raises(PathGuardError) as excinfo:
        resolve_under_root(tmp_path / "no-such-root", "a.txt")
    assert excinfo.value.code == "PATH_FORBIDDEN"
