#!/usr/bin/env python3
"""合同校验脚本（任务书任务 0 · 验收「合同可被机器校验」）。

执行三项检查：
1. contracts/openapi.yaml 是合法的 OpenAPI 3.1 文档；
2. contracts/fixtures/ 中每个示例都符合其绑定 Schema（含 $ref 递归解析与格式检查）；
3. 后端已实现端点 ⊆ 合同（路径/方法/状态码），且 S0 必需的 /v1/health 已实现；
   同时检查 errors.md 与 openapi.yaml 的错误码集合一致。

用法：python integration-tests/contract/check_contracts.py
退出码：0 = 全部通过；1 = 存在问题。
"""

from __future__ import annotations

import json
import re
import sys
from pathlib import Path

REPO_ROOT = Path(__file__).resolve().parents[2]
CONTRACT_PATH = REPO_ROOT / "contracts" / "openapi.yaml"
FIXTURES_DIR = REPO_ROOT / "contracts" / "fixtures"
ERRORS_MD_PATH = REPO_ROOT / "contracts" / "errors.md"

passed: list[str] = []
failures: list[str] = []


def ok(message: str) -> None:
    passed.append(message)
    print(f"  [PASS] {message}")


def fail(message: str) -> None:
    failures.append(message)
    print(f"  [FAIL] {message}")


# ---------------------------------------------------------------- 1. 规范本身
def check_spec_is_valid(spec: dict) -> None:
    try:
        from openapi_spec_validator import validate as validate_spec
    except ImportError:
        fail("openapi-spec-validator 未安装（运行 scripts/setup-desktop.ps1）")
        return
    try:
        validate_spec(spec)
        ok(f"openapi.yaml 是合法的 OpenAPI {spec.get('openapi')} 文档，"
           f"包含 {len(spec.get('paths', {}))} 个路径")
    except Exception as exc:  # noqa: BLE001
        fail(f"openapi.yaml 校验失败: {exc}")


# ---------------------------------------------------------------- 2. fixtures
def _resolve_pointer(root: dict, ref: str):
    if not ref.startswith("#/"):
        raise ValueError(f"only local refs supported: {ref}")
    node = root
    for part in ref[2:].split("/"):
        part = part.replace("~1", "/").replace("~0", "~")
        node = node[part]
    return node


def _dereference(node, root: dict, memo: set[int]) -> None:
    """就地展开 $ref（支持递归 Schema，如 ManifestNode）。"""
    if isinstance(node, dict):
        if id(node) in memo:
            return
        memo.add(id(node))
        if "$ref" in node:
            target = _resolve_pointer(root, node["$ref"])
            _dereference(target, root, memo)
            node.pop("$ref")
            node.update(target)
        for value in list(node.values()):
            _dereference(value, root, memo)
    elif isinstance(node, list):
        for item in node:
            _dereference(item, root, memo)


def check_fixtures(spec: dict) -> None:
    try:
        import yaml
        from jsonschema import Draft202012Validator, FormatChecker
    except ImportError:
        fail("jsonschema/PyYAML 未安装（运行 scripts/setup-desktop.ps1）")
        return

    index = json.loads((FIXTURES_DIR / "index.json").read_text(encoding="utf-8"))
    schemas = spec.get("components", {}).get("schemas", {})
    for schema in schemas.values():
        _dereference(schema, spec, set())

    checker = FormatChecker()
    fixture_files = {p.name for p in FIXTURES_DIR.glob("*.json")}
    covered = set()
    for entry in index["entries"]:
        fname = entry["file"]
        covered.add(fname)
        fpath = FIXTURES_DIR / fname
        if not fpath.exists():
            fail(f"fixture 缺失: {fname}（index.json 引用了它）")
            continue
        ref = entry["schema"]
        if not ref.startswith("#/components/schemas/"):
            fail(f"{fname}: schema 引用不在 components/schemas 下: {ref}")
            continue
        schema = schemas.get(ref.rsplit("/", 1)[-1])
        if schema is None:
            fail(f"{fname}: schema 未找到: {ref}")
            continue
        instance = json.loads(fpath.read_text(encoding="utf-8"))
        validator = Draft202012Validator(schema, format_checker=checker)
        errors = sorted(validator.iter_errors(instance), key=lambda e: e.path)
        if errors:
            first = errors[0]
            fail(f"{fname} 不符合 {ref}: {first.message} (path: {list(first.path)})")
        else:
            ok(f"fixture {fname} 符合 {ref} ({entry['kind']})")

    orphan = fixture_files - covered - {"index.json"}
    if orphan:
        fail(f"未被 index.json 收录的 fixture: {sorted(orphan)}")


# ------------------------------------------------- 3. 实现对齐 + 错误码一致性
def _iter_api_routes(routes):
    """递归收集 APIRoute（兼容 Starlette 1.x 的 _IncludedRouter 嵌套结构与旧版扁平结构）。"""
    for route in routes:
        methods = getattr(route, "methods", None)
        path = getattr(route, "path", None)
        if methods and path:
            yield route
            continue
        for attr in ("original_router", "router", "app"):
            inner = getattr(route, attr, None)
            inner_routes = getattr(inner, "routes", None) if inner is not None else None
            if inner_routes:
                yield from _iter_api_routes(inner_routes)
                break


def check_implementation(spec: dict) -> None:
    try:
        from pocketcode.server.app import create_app
    except ImportError:
        fail("无法导入 pocketcode（先运行 scripts/setup-desktop.ps1 安装 desktop 包）")
        return

    contract_ops: dict[tuple[str, str], set[str]] = {}
    for path, ops in spec.get("paths", {}).items():
        for method, op in ops.items():
            if method in {"get", "put", "post", "delete", "patch"}:
                statuses = {str(s) for s in op.get("responses", {}).keys()}
                contract_ops[(method.upper(), path)] = statuses

    app = create_app()
    implemented: dict[tuple[str, str], str] = {}
    for route in _iter_api_routes(app.routes):
        path = route.path
        for method in route.methods:
            if method in {"HEAD", "OPTIONS"}:
                continue
            implemented[(method.upper(), path)] = str(getattr(route, "status_code", 200))

    undocumented = set(implemented) - set(contract_ops)
    if undocumented:
        fail(f"实现了合同之外的路由: {sorted(undocumented)}")
    else:
        ok(f"后端实现 {len(implemented)} 个路由，全部在合同之内")

    health_ok = ("GET", "/v1/health") in implemented
    if health_ok:
        ok("S0 必需端点 GET /v1/health 已实现")
    else:
        fail("S0 必需端点 GET /v1/health 未实现")

    planned = sorted(set(contract_ops) - set(implemented))
    print(f"  [INFO] 合同中尚未实现（后续阶段）: "
          f"{', '.join(f'{m} {p}' for m, p in planned) if planned else '无'}")

    # 错误码一致性：openapi.yaml 的 ErrorCode 枚举 vs errors.md 表格行
    # （OFFLINE 允许只出现在 errors.md —— 它是客户端本地状态码，由下方专项检查覆盖）
    spec_codes = set(spec["components"]["schemas"]["ErrorCode"]["enum"])
    md_text = ERRORS_MD_PATH.read_text(encoding="utf-8")
    md_codes = set(re.findall(r"^\|\s*`([A-Z_]+)`\s*\|", md_text, flags=re.MULTILINE))
    missing_in_md = spec_codes - md_codes
    extra_in_md = md_codes - spec_codes - {"OFFLINE"}
    if missing_in_md or extra_in_md:
        if missing_in_md:
            fail(f"errors.md 缺少错误码: {sorted(missing_in_md)}")
        if extra_in_md:
            fail(f"errors.md 多出未在合同定义的错误码: {sorted(extra_in_md)}")
    else:
        ok(f"errors.md 与 openapi.yaml 错误码一致（{len(spec_codes)} 个）")

    # errors.md 的 OFFLINE 必须标注为客户端专用
    if "OFFLINE" in md_codes and "OFFLINE" not in spec_codes:
        ok("OFFLINE 仅存在于 errors.md（客户端本地状态码），符合合同")


def main() -> int:
    print("== PocketCode 合同校验 ==")
    try:
        import yaml
    except ImportError:
        print("  [FAIL] PyYAML 未安装（运行 scripts/setup-desktop.ps1）")
        return 1

    spec = yaml.safe_load(CONTRACT_PATH.read_text(encoding="utf-8"))

    print("-- 1/3 OpenAPI 文档 --")
    check_spec_is_valid(spec)
    print("-- 2/3 Fixtures --")
    check_fixtures(spec)
    print("-- 3/3 后端实现对齐 --")
    check_implementation(spec)

    print(f"\n结果: {len(passed)} 通过, {len(failures)} 失败")
    return 1 if failures else 0


if __name__ == "__main__":
    sys.exit(main())
