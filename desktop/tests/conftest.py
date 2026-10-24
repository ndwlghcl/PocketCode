"""pytest 共享夹具。"""

from __future__ import annotations

import sys
from pathlib import Path

import pytest

REPO_ROOT = Path(__file__).resolve().parents[2]

# 未安装 desktop 包（pip install -e）时也能直接跑测试。
_DESKTOP_SRC = REPO_ROOT / "desktop"
if str(_DESKTOP_SRC) not in sys.path:
    sys.path.insert(0, str(_DESKTOP_SRC))


@pytest.fixture
def repo_root() -> Path:
    return REPO_ROOT


@pytest.fixture
def settings_path(tmp_path: Path) -> Path:
    return tmp_path / "settings.json"
