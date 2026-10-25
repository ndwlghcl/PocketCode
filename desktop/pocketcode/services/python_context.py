"""有界的 Python 静态关联：只解析源码，不执行、不 import 项目代码。

resolved 只表示导入/词法绑定可以静态定位；无法确定的同名符号始终是候选。
请求内建立小型索引，避免为个人项目引入常驻语言服务器或后台扫描。
"""
from __future__ import annotations

import ast
import hashlib
import os
import time
from dataclasses import dataclass
from datetime import datetime, timezone
from pathlib import Path

from pocketcode.security.path_guard import (
    PathGuardError, scan_entry_under_root, validate_relative_path,
)
from pocketcode.services.files import (
    FileServiceError, _decode, _should_ignore_dir, _should_ignore_file, read_text_file,
)

MAX_FILES = 500
MAX_ENTRIES = 10_000
MAX_FILE_BYTES = 1024 * 1024
MAX_TOTAL_BYTES = 8 * 1024 * 1024
MAX_SECONDS = 3.0
MAX_NODES = 50_000


@dataclass(frozen=True)
class Symbol:
    path: str
    scope: tuple[str, ...]
    name: str
    line: int
    end: int
    kind: str


@dataclass(frozen=True)
class Import:
    module: str
    member: str = ''


@dataclass
class Use:
    parts: tuple[str, ...]
    line: int
    scope: tuple[str, ...]


class AnalysisLimit(Exception):
    pass


def _module_names(path: str) -> list[str]:
    parts = path.removesuffix('.py').split('/')
    if parts[-1] == '__init__':
        parts.pop()
    names = ['.'.join(parts)]
    if parts and parts[0] == 'src':
        names.insert(0, '.'.join(parts[1:]))
    return [name for name in names if name]


class Module(ast.NodeVisitor):
    def __init__(self, path: str, text: str, version: str):
        self.path, self.text, self.version = path, text, version
        self.lines = text.splitlines()
        self.names = _module_names(path)
        self.scope: tuple[str, ...] = ()
        self.bindings: dict[tuple[str, ...], dict[str, Symbol | Import | None]] = {(): {}}
        self.kinds: dict[tuple[str, ...], str] = {(): 'module'}
        self.symbols: list[Symbol] = []
        self.uses: list[Use] = []
        self.imports: list[Import] = []
        self.warnings: list[str] = []
        self.nodes = 0

    def visit(self, node):
        self.nodes += 1
        if self.nodes > MAX_NODES:
            raise AnalysisLimit()
        return super().visit(node)

    def bind(self, name: str, value: Symbol | Import | None):
        bindings = self.bindings.setdefault(self.scope, {})
        # 重绑定/条件分支/同名定义都不做确定跳转。
        if name in bindings and bindings[name] != value:
            bindings[name] = None
        else:
            bindings[name] = value

    def definition(self, node, kind: str):
        item = Symbol(self.path, self.scope, node.name, node.lineno,
                      node.end_lineno or node.lineno, kind)
        self.symbols.append(item)
        self.bind(node.name, item)
        for decorator in node.decorator_list:
            self.visit(decorator)
        if isinstance(node, ast.ClassDef):
            for base in node.bases:
                self.visit(base)
        else:
            for value in [*node.args.defaults, *node.args.kw_defaults]:
                if value is not None:
                    self.visit(value)
        parent = self.scope
        self.scope = (*parent, node.name)
        self.bindings.setdefault(self.scope, {})
        self.kinds[self.scope] = 'class' if kind == 'class' else 'function'
        if not isinstance(node, ast.ClassDef):
            args = node.args
            for arg in [*args.posonlyargs, *args.args, *args.kwonlyargs, args.vararg, args.kwarg]:
                if arg is not None:
                    self.bind(arg.arg, None)
        for statement in node.body:
            self.visit(statement)
        self.scope = parent

    def visit_FunctionDef(self, node):
        self.definition(node, 'method' if self.kinds[self.scope] == 'class' else 'function')

    visit_AsyncFunctionDef = visit_FunctionDef

    def visit_ClassDef(self, node):
        self.definition(node, 'class')

    def visit_Import(self, node):
        for alias in node.names:
            binding = Import(alias.name if alias.asname else alias.name.split('.')[0])
            self.bind(alias.asname or alias.name.split('.')[0], binding)
            self.imports.append(Import(alias.name))

    def visit_ImportFrom(self, node):
        module = node.module or ''
        if node.level:
            primary = self.names[0] if self.names else ''
            package = primary.split('.') if self.path.endswith('/__init__.py') else primary.split('.')[:-1]
            if node.level > len(package):
                self.warnings.append('相对导入超出当前项目可识别的包边界')
                return
            module = '.'.join([*package[:len(package) - node.level + 1], *module.split('.')]).strip('.')
        for alias in node.names:
            if alias.name == '*':
                self.warnings.append(f'星号导入 {module} 不能精确解析')
                continue
            binding = Import(module, alias.name)
            self.bind(alias.asname or alias.name, binding)
            self.imports.append(binding)

    def visit_Name(self, node):
        if isinstance(node.ctx, ast.Load):
            self.uses.append(Use((node.id,), node.lineno, self.scope))
        elif isinstance(node.ctx, (ast.Store, ast.Del)):
            self.bind(node.id, None)

    def visit_Attribute(self, node):
        if isinstance(node.ctx, ast.Load):
            parts = [node.attr]
            cursor = node.value
            while isinstance(cursor, ast.Attribute):
                parts.insert(0, cursor.attr)
                cursor = cursor.value
            if isinstance(cursor, ast.Name):
                parts.insert(0, cursor.id)
            else:
                # factory().build() / items[0].build() 不能绑定到模块级 build。
                parts.insert(0, '<dynamic>')
            self.uses.append(Use(tuple(parts), node.lineno, self.scope))
        self.generic_visit(node)

    def visit_Lambda(self, node):
        # 不把 lambda 参数误当作外层导入；这版不提供 lambda 内语义定位。
        self.warnings.append('lambda 内的引用未做语义解析')

    def visit_Global(self, node):
        for name in node.names:
            self.bind(name, None)

    visit_Nonlocal = visit_Global

    def visit_ExceptHandler(self, node):
        if node.name:
            self.bind(node.name, None)
        self.generic_visit(node)

    def visit_MatchAs(self, node):
        if node.name:
            self.bind(node.name, None)
        self.generic_visit(node)

    visit_MatchStar = visit_MatchAs

    def visit_MatchMapping(self, node):
        if node.rest:
            self.bind(node.rest, None)
        self.generic_visit(node)


class Index:
    def __init__(self):
        self.modules: dict[str, Module] = {}
        self.by_name: dict[str, list[Module]] = {}
        self.warnings: list[str] = []
        self.truncated = False

    def warn(self, message: str):
        if message not in self.warnings and len(self.warnings) < 29:
            self.warnings.append(message)

    def add(self, path: str, text: str, version: str) -> Module | None:
        try:
            tree = ast.parse(text, filename=path)
            module = Module(path, text, version)
            module.visit(tree)
        except SyntaxError as exc:
            self.warn(f'{path}:{exc.lineno or 1} 存在语法错误，未参与关联')
            return None
        except (ValueError, RecursionError, AnalysisLimit):
            self.truncated = True
            self.warn(f'{path} 超出静态分析复杂度，已跳过')
            return None
        self.modules[path] = module
        for name in module.names:
            self.by_name.setdefault(name, []).append(module)
        for warning in module.warnings:
            self.warn(f'{path}：{warning}')
        return module

    def register_package_roots(self):
        # monorepo 子项目：desktop/pkg/... 也可通过 pkg... 导入。
        packages = {path.removesuffix('/__init__.py') for path in self.modules
                    if path.endswith('/__init__.py')}
        for module in self.modules.values():
            parent = module.path.rsplit('/', 1)[0] if '/' in module.path else ''
            if parent not in packages:
                continue
            parts = module.path.removesuffix('.py').split('/')
            init = parts[-1] == '__init__'
            if init:
                parts.pop()
            start = len(parts) - (1 if init else 2)
            while start > 0 and '/'.join(parts[:start]) in packages:
                start -= 1
            alias = '.'.join(parts[max(0, start):])
            if alias and alias not in module.names:
                module.names.append(alias)
                self.by_name.setdefault(alias, []).append(module)

    def resolve(self, module: Module, parts: tuple[str, ...], scope=(), seen=frozenset(), members=False) -> set[Symbol]:
        key = (module.path, parts, scope, members)
        if not parts or key in seen or len(seen) >= 8:
            return set()
        seen = seen | {key}
        binding = None
        for depth in ([len(scope)] if members else range(len(scope), -1, -1)):
            parent = scope[:depth]
            # 函数体里的普通名称不会通过类命名空间查找。
            if depth < len(scope) and module.kinds.get(parent) == 'class':
                continue
            if parts[0] in module.bindings.get(parent, {}):
                binding = module.bindings[parent][parts[0]]
                break
        if isinstance(binding, Symbol):
            if len(parts) == 1:
                return {binding}
            if binding.kind == 'class':
                return self.resolve(module, parts[1:], (*binding.scope, binding.name), seen, members=True)
        if isinstance(binding, Import):
            names = tuple(filter(None, (*binding.module.split('.'), binding.member, *parts[1:])))
            return self.export(names, seen)
        return set()

    def export(self, parts: tuple[str, ...], seen=frozenset()) -> set[Symbol]:
        for depth in range(len(parts) - 1, 0, -1):
            modules = self.by_name.get('.'.join(parts[:depth]), [])
            if len(modules) > 1:
                return set()  # 多个源码根导出同一模块名时，必须降为候选。
            if len(modules) == 1:
                return self.resolve(modules[0], parts[depth:], (), seen)
        return set()

    def import_paths(self, binding: Import) -> list[str]:
        name = '.'.join(filter(None, (binding.module, binding.member)))
        matches = self.by_name.get(name) or self.by_name.get(binding.module) or []
        return [module.path for module in matches]


def _scan(root: Path, index: Index, source_path: str, source_size: int):
    started = time.monotonic()
    entries_seen, files_seen, total_bytes = 0, 1, source_size

    def walk(directory: Path, depth: int):
        nonlocal entries_seen, files_seen, total_bytes
        if depth > 64:
            index.truncated = True
            return
        try:
            with os.scandir(directory) as stream:
                # 大型目录只收集剩余预算，不先无界创建列表。
                entries = []
                for entry in stream:
                    entries_seen += 1
                    if entries_seen > MAX_ENTRIES:
                        index.truncated = True
                        break
                    entries.append(entry)
        except OSError:
            index.warn('存在不可读目录，分析范围不完整')
            return
        for entry in sorted(entries, key=lambda item: item.name.casefold()):
            if files_seen >= MAX_FILES or total_bytes >= MAX_TOTAL_BYTES or time.monotonic() - started > MAX_SECONDS:
                index.truncated = True
                return
            safe_path = scan_entry_under_root(root, entry)
            if safe_path is None:
                continue
            if entry.is_dir(follow_symlinks=False):
                if not _should_ignore_dir(entry.name):
                    walk(safe_path, depth + 1)
                continue
            if _should_ignore_file(entry.name) or not entry.name.endswith('.py'):
                continue
            relative = safe_path.relative_to(root).as_posix()
            if relative == source_path:
                continue
            try:
                validate_relative_path(relative)
                files_seen += 1
                remaining = min(MAX_FILE_BYTES, MAX_TOTAL_BYTES - total_bytes)
                with safe_path.open('rb') as handle:
                    raw = handle.read(remaining + 1)
                if len(raw) > remaining:
                    index.truncated = True
                    index.warn(f'{relative} 超出分析大小预算，已跳过')
                    continue
                total_bytes += len(raw)
                _, text = _decode(raw)
                index.add(relative, text, 'sha256:' + hashlib.sha256(raw).hexdigest())
            except (OSError, FileServiceError, PathGuardError):
                index.warn(f'{relative} 无法安全读取，已跳过')
    walk(root, 0)


def analyze_context(root: Path, path: str, symbol: str | None = None, line: int | None = None,
                    content: str | None = None, source: str = 'draft') -> dict:
    validate_relative_path(path)
    if not path.endswith('.py'):
        raise FileServiceError('UNSUPPORTED_FORMAT', '智能关联目前只支持 Python .py 文件')
    if any(_should_ignore_dir(part) for part in path.split('/')[:-1]) or _should_ignore_file(path.split('/')[-1]):
        raise FileServiceError('PATH_FORBIDDEN', '该文件位于默认排除的分析范围内')
    if symbol is not None and not all(part.isidentifier() for part in symbol.split('.')):
        raise FileServiceError('INVALID_REQUEST', '符号必须是标识符或点分名称')
    # 即使使用草稿覆盖，也要确认其对应路径可安全读取，不能借草稿绕过授权边界。
    disk = read_text_file(root, path)
    text = disk['content'] if content is None else content
    raw = text.encode('utf-8')
    if len(raw) > MAX_FILE_BYTES:
        raise FileServiceError('FILE_TOO_LARGE', 'Python 分析正文不能超过 1 MiB')
    source_version = disk['version'] if content is None else 'sha256:' + hashlib.sha256(raw).hexdigest()
    index = Index()
    deadline = time.monotonic() + MAX_SECONDS
    current = index.add(path, text, source_version)
    _scan(root.resolve(strict=True), index, path, len(raw))
    index.register_package_roots()
    definitions: list[dict] = []
    references: list[dict] = []
    related: dict[str, dict] = {}

    def location(item: Symbol, confidence: str, reason: str) -> dict:
        module = index.modules[item.path]
        return dict(path=item.path, line=item.line, name=item.name, kind=item.kind,
                    text=module.lines[item.line - 1].strip()[:300], confidence=confidence,
                    reason=reason, version=module.version)

    def relate(target: str, reason: str, confidence='resolved', at=1):
        if target == path or target not in index.modules:
            return
        entry = related.setdefault(target, dict(path=target, line=at, confidence=confidence,
                                                reasons=[], version=index.modules[target].version))
        if reason not in entry['reasons'] and len(entry['reasons']) < 5:
            entry['reasons'].append(reason)
        if confidence == 'resolved':
            entry['confidence'] = 'resolved'

    targets: set[Symbol] = set()
    certain = False
    if current and symbol:
        local = [item for item in current.symbols if item.name == symbol.split('.')[-1]
                 and item.line == line]
        if local:
            targets.update(local)
        else:
            uses = [use for use in current.uses if use.line == line
                    and ('.'.join(use.parts) == symbol or use.parts[-1] == symbol)]
            if uses:
                bindings = [index.resolve(current, use.parts, use.scope) for use in uses]
                # 请求只有行号，没有列号；同一行同名但绑定不同，无法确定点中了哪一个。
                if all(binding == bindings[0] for binding in bindings):
                    targets.update(bindings[0])
            else:
                containing = [item for item in current.symbols if line and item.line <= line <= item.end]
                scope = (*containing[-1].scope, containing[-1].name) if containing else ()
                targets.update(index.resolve(current, tuple(symbol.split('.')), scope))
        certain = bool(targets)
        if not targets:
            targets = {item for module in index.modules.values() for item in module.symbols
                       if item.name == symbol.split('.')[-1]}
            index.warn('当前符号无法静态绑定；同名候选不代表相同定义，也不是完整调用图')
        if len(targets) > 30:
            index.truncated = True
            targets = set(sorted(targets, key=lambda item: (item.path, item.line))[:30])
        for item in sorted(targets, key=lambda item: (item.path, item.line)):
            confidence = 'resolved' if certain else 'candidate'
            definitions.append(location(item, confidence, '词法定义或显式导入可静态定位' if certain else '仅名称相同，请手动核对'))
            relate(item.path, f'{symbol} 的定义' if certain else f'{symbol} 的同名定义候选', confidence, item.line)

    if current:
        if not symbol:
            for binding in current.imports:
                paths = index.import_paths(binding)
                if not paths:
                    index.warn(f'导入 {binding.module} {binding.member} 未定位到项目源码（可能为第三方模块或动态路径）')
                for imported in paths:
                    relate(imported, f'当前文件显式导入 {binding.module} {binding.member}'.strip(),
                           'resolved' if len(paths) == 1 else 'candidate')
        # 选中本地函数时，只推荐该函数体中可定位的依赖；文件模式看全部用法。
        ranges = [(item.line, item.end) for item in targets if certain and item.path == path]
        if not symbol or certain:
            for use in current.uses:
                if time.monotonic() > deadline:
                    index.truncated = True
                    break
                if symbol and (not ranges or not any(start <= use.line <= end for start, end in ranges)):
                    continue
                for dependency in index.resolve(current, use.parts, use.scope):
                    relate(dependency.path, f'第 {use.line} 行使用 {".".join(use.parts)}', at=dependency.line)

    reference_targets = targets if symbol else set(current.symbols if current else [])
    seen_references = set()
    stop = False
    for module in index.modules.values():
        for use in module.uses:
            if time.monotonic() > deadline or (symbol and len(references) >= 100):
                index.truncated = True
                stop = True
                break
            resolved = index.resolve(module, use.parts, use.scope)
            matched = bool(resolved & reference_targets)
            candidate = bool(symbol and not certain and use.parts[-1] == symbol.split('.')[-1])
            if not matched and not candidate:
                continue
            key = (module.path, use.line, use.parts)
            if key in seen_references:
                continue
            seen_references.add(key)
            confidence = 'resolved' if matched and (certain or not symbol) else 'candidate'
            if symbol:
                references.append(dict(path=module.path, line=use.line, name='.'.join(use.parts),
                    kind='reference', text=module.lines[use.line - 1].strip()[:300], confidence=confidence,
                    reason='静态绑定到所选定义' if confidence == 'resolved' else '同名出现，无法确认语义关联',
                    version=module.version))
            relate(module.path, f'第 {use.line} 行引用 {".".join(use.parts)}', confidence, use.line)
        if stop:
            break

    related_files = sorted(related.values(), key=lambda item: (item['confidence'] != 'resolved', item['path']))
    if len(definitions) > 30 or len(references) > 100 or len(related_files) > 20:
        index.truncated = True
    if index.truncated:
        index.warn('已达到扫描或结果限额，以下分析范围不完整')
    index.warn('静态分析不执行代码；不推断任意对象类型、动态导入或完整运行时调用关系')
    return dict(path=path, source='pc' if content is None else source, source_version=source_version,
                generated_at=datetime.now(timezone.utc).strftime('%Y-%m-%dT%H:%M:%SZ'),
                analyzer='python-ast-v1', scanned_files=len(index.modules), truncated=index.truncated,
                definitions=definitions[:30], references=references[:100], related_files=related_files[:20],
                warnings=index.warnings)
