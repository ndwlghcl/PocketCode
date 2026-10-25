"""Run the maintained post-fix regressions. The original characterization is in BUG_REVIEW.md."""
import subprocess
import sys
from pathlib import Path

root = Path(__file__).resolve().parents[3]
raise SystemExit(subprocess.call([
    sys.executable, '-m', 'pytest',
    'desktop/tests/test_file_consistency.py',
    'desktop/tests/test_git_api.py',
    'desktop/tests/test_writes_api.py',
    'desktop/tests/test_trash_concurrency.py',
], cwd=root))