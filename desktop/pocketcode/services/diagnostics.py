"""Python 草稿诊断（S4d）：对未保存的草稿文本做静态检查（PRD §7）。

- 语法/缩进：标准库 ast/compile，永远可用（analyzer="ast"）；
- 未定义名称/导入等：电脑端安装了 pyflakes 时追加（analyzer="pyflakes+x.y"），
  未安装则如实降级——不假装能力存在；
- 诊断坐标一律换算成 1-based（line/column），与合同一致；
- 内容上限 1 MiB；本接口不读写任何项目文件，`path` 仅作上下文。
"""

from __future__ import annotations

import ast
import io

MAX_DIAGNOSE_CHARS = 1024 * 1024

# pyflakes 可选：未安装时语法检查仍然可用
try:  # pragma: no cover - 取决于安装环境
    from pyflakes.checker import Checker as _PyflakesChecker

    import pyflakes as _pyflakes_module

    PYFLAKES_VERSION = getattr(_pyflakes_module, "__version__", "")
    HAS_PYFLAKES = True
except ImportError:  # pragma: no cover
    HAS_PYFLAKES = False
    PYFLAKES_VERSION = ""


class DiagnoseServiceError(Exception):
    """code 取合同错误码；路由层转成统一错误响应。"""

    def __init__(self, code: str, message: str) -> None:
        self.code = code
        self.message = message
        super().__init__(f"[{code}] {message}")


def diagnose_python_source(content: str) -> dict:
    """返回 DiagnoseResponse 字段（analyzer, diagnostics）。"""
    if not isinstance(content, str):
        raise DiagnoseServiceError("INVALID_REQUEST", "内容缺失")
    if len(content) > MAX_DIAGNOSE_CHARS:
        raise DiagnoseServiceError(
            "FILE_TOO_LARGE", f"草稿内容超过 {MAX_DIAGNOSE_CHARS // (1024 * 1024)} MiB 上限"
        )

    diagnostics: list[dict] = []
    tree: ast.Module | None = None
    try:
        tree = ast.parse(content)
    except SyntaxError as exc:
        diagnostics.append(
            {
                "line": exc.lineno or 1,
                # SyntaxError.offset 是 1-based；某些场景为 None
                "column": exc.offset or 1,
                "severity": "error",
                "code": type(exc).__name__,  # SyntaxError / IndentationError / TabError
                "message": exc.msg or "语法错误",
            }
        )
    except (ValueError, RecursionError) as exc:
        # 空字节串（二进制粘贴）等无法编译的输入
        diagnostics.append(
            {
                "line": 1,
                "column": 1,
                "severity": "error",
                "code": "ValueError",
                "message": str(exc) or "无法解析该内容",
            }
        )

    pyflakes_used = False
    if tree is not None and HAS_PYFLAKES:
        try:
            checker = _PyflakesChecker(tree, "<draft>")
            for warning in checker.messages:
                col = getattr(warning, "col", 0) or 0
                diagnostics.append(
                    {
                        "line": warning.lineno,
                        "column": col + 1,  # pyflakes 的 col 是 0-based
                        "severity": "warning",
                        "code": type(warning).__name__,
                        "message": warning.message % warning.message_args,
                    }
                )
            pyflakes_used = True
        except Exception:  # noqa: BLE001 - pyflakes 内部异常不拖垮语法检查结果
            pyflakes_used = False

    analyzer = f"pyflakes+{PYFLAKES_VERSION}" if pyflakes_used else "ast"
    return {"analyzer": analyzer, "diagnostics": diagnostics}
