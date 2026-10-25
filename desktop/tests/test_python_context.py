from pathlib import Path
import subprocess

import pytest
from fastapi.testclient import TestClient

from pocketcode.security.auth import generate_device_token, hash_token
from pocketcode.services import python_context as analysis
from pocketcode.server.app import create_app
from pocketcode.storage.settings_store import AuthorizedProject, PairedDevice, Settings, SettingsStore, new_id


def put(root: Path, path: str, text: str):
    target = root / path
    target.parent.mkdir(parents=True, exist_ok=True)
    target.write_bytes(text.encode('utf-8'))


@pytest.fixture
def project(tmp_path):
    put(tmp_path, 'pkg/__init__.py', 'from .helpers import build\n')
    put(tmp_path, 'pkg/helpers.py', 'def build():\n    return 1\n')
    put(tmp_path, 'pkg/main.py', 'from .helpers import build as make\n\ndef run():\n    return make()\n')
    put(tmp_path, 'consumer.py', 'from pkg import build as create\nresult = create()\ntext = "build()"  # build()\n')
    return tmp_path


def test_relative_alias_resolves_definition_and_alias_references(project):
    result = analysis.analyze_context(project, 'pkg/main.py', 'make', 4)
    assert [(d['path'], d['line'], d['confidence']) for d in result['definitions']] == [
        ('pkg/helpers.py', 1, 'resolved')]
    assert {(r['path'], r['line']) for r in result['references']} == {
        ('pkg/main.py', 4), ('consumer.py', 2)}
    assert all(r['confidence'] == 'resolved' for r in result['references'])


def test_file_recommends_imports_and_real_consumers(project):
    result = analysis.analyze_context(project, 'pkg/helpers.py')
    related = {r['path'] for r in result['related_files']}
    assert {'pkg/main.py', 'consumer.py'} <= related
    main = analysis.analyze_context(project, 'pkg/main.py')
    assert 'pkg/helpers.py' in {r['path'] for r in main['related_files']}


def test_selected_local_function_recommends_its_dependencies(project):
    result = analysis.analyze_context(project, 'pkg/main.py', 'run', 3)
    assert result['definitions'][0]['path'] == 'pkg/main.py'
    assert 'pkg/helpers.py' in {r['path'] for r in result['related_files']}


def test_draft_is_analyzed_without_writing_source(project):
    before = (project / 'pkg/main.py').read_bytes()
    draft = 'from .helpers import build\nvalue = build()\n'
    result = analysis.analyze_context(project, 'pkg/main.py', 'build', 2, draft)
    assert result['source'] == 'draft'
    assert result['definitions'][0]['path'] == 'pkg/helpers.py'
    assert result['source_version'].startswith('sha256:')
    assert (project / 'pkg/main.py').read_bytes() == before


def test_shadowing_never_claims_global_import_is_local_parameter(project):
    text = 'from pkg.helpers import build\n\ndef test(build):\n    return build()\n'
    result = analysis.analyze_context(project, 'consumer.py', 'build', 4, text)
    assert result['definitions']
    assert all(d['confidence'] == 'candidate' for d in result['definitions'])


def test_unknown_object_member_is_candidate_not_inferred_type(project):
    put(project, 'objects.py', 'class Agent:\n    def run(self):\n        pass\n\nobj = factory()\nobj.run()\n')
    result = analysis.analyze_context(project, 'objects.py', 'run', 6)
    assert result['definitions'][0]['kind'] == 'method'
    assert result['definitions'][0]['confidence'] == 'candidate'


def test_missing_class_member_does_not_fall_back_to_module_function(project):
    put(project, 'objects.py', 'class Agent:\n    pass\n\ndef run():\n    pass\nAgent.run()\n')
    result = analysis.analyze_context(project, 'objects.py', 'run', 6)
    assert all(d['confidence'] == 'candidate' for d in result['definitions'])


@pytest.mark.parametrize('expression', ['factory().build()', 'items[0].build()'])
def test_dynamic_object_member_does_not_bind_module_function(project, expression):
    text = f'from pkg.helpers import build\n{expression}\n'
    result = analysis.analyze_context(project, 'consumer.py', 'build', 2, text)
    assert result['definitions']
    assert all(d['confidence'] == 'candidate' for d in result['definitions'])


def test_match_capture_shadows_import(project):
    text = 'from pkg.helpers import build\nmatch value:\n    case {"key": build}:\n        build()\n'
    result = analysis.analyze_context(project, 'consumer.py', 'build', 4, text)
    assert result['definitions']
    assert all(d['confidence'] == 'candidate' for d in result['definitions'])


def test_same_line_ambiguous_name_is_candidate(project):
    text = 'from pkg.helpers import build\nbuild(); factory().build()\n'
    result = analysis.analyze_context(project, 'consumer.py', 'build', 2, text)
    assert result['definitions']
    assert all(d['confidence'] == 'candidate' for d in result['definitions'])


def test_src_layout_and_module_alias(tmp_path):
    put(tmp_path, 'src/pkg/helpers.py', 'def build():\n    return 1\n')
    put(tmp_path, 'src/pkg/main.py', 'import pkg.helpers as h\nh.build()\n')
    result = analysis.analyze_context(tmp_path, 'src/pkg/main.py', 'build', 2)
    assert result['definitions'][0]['path'] == 'src/pkg/helpers.py'
    assert result['definitions'][0]['confidence'] == 'resolved'


def test_nested_project_package_root_and_ambiguous_module_names(tmp_path):
    put(tmp_path, 'desktop/pkg/__init__.py', '')
    put(tmp_path, 'desktop/pkg/tools.py', 'def build():\n    return 1\n')
    put(tmp_path, 'desktop/main.py', 'from pkg.tools import build\nbuild()\n')
    result = analysis.analyze_context(tmp_path, 'desktop/main.py', 'build', 2)
    assert result['definitions'][0]['path'] == 'desktop/pkg/tools.py'
    assert result['definitions'][0]['confidence'] == 'resolved'
    put(tmp_path, 'another/pkg/__init__.py', '')
    put(tmp_path, 'another/pkg/tools.py', 'def build():\n    return 2\n')
    ambiguous = analysis.analyze_context(tmp_path, 'desktop/main.py', 'build', 2)
    assert len(ambiguous['definitions']) == 2
    assert all(item['confidence'] == 'candidate' for item in ambiguous['definitions'])


def test_syntax_errors_and_external_imports_are_explained(project):
    broken = analysis.analyze_context(project, 'pkg/main.py', content='def broken(\n')
    assert broken['definitions'] == []
    assert any('语法错误' in warning for warning in broken['warnings'])
    external = analysis.analyze_context(project, 'pkg/main.py', content='import external_package\n')
    assert any('external_package' in warning for warning in external['warnings'])


def test_scan_is_bounded_and_does_not_execute_modules(project, monkeypatch):
    marker = project / 'executed.txt'
    put(project, 'trap.py', f'from pathlib import Path\nPath({str(marker)!r}).write_text("executed")\n')
    analysis.analyze_context(project, 'pkg/main.py')
    assert not marker.exists()
    monkeypatch.setattr(analysis, 'MAX_FILES', 1)
    limited = analysis.analyze_context(project, 'pkg/main.py')
    assert limited['truncated'] is True
    assert limited['scanned_files'] == 1


def test_scanner_excludes_dependency_dirs_and_junction(project, tmp_path_factory):
    put(project, 'node_modules/unwanted.py', 'def build():\n    return "no"\n')
    outside = tmp_path_factory.mktemp('outside-context')
    put(outside, 'private.py', 'def build():\n    return "private"\n')
    link = project / 'linked'
    made = subprocess.run(['cmd', '/c', 'mklink', '/J', str(link), str(outside)], capture_output=True)
    if made.returncode:
        pytest.skip('无法创建 junction')
    try:
        result = analysis.analyze_context(project, 'pkg/main.py', 'build', 1, 'build()\n')
        assert {d['path'] for d in result['definitions']} == {'pkg/helpers.py'}
        with pytest.raises(Exception) as error:
            analysis.analyze_context(project, 'linked/private.py')
        assert getattr(error.value, 'code', None) == 'PATH_FORBIDDEN'
    finally:
        link.rmdir()


def test_api_auth_validation_and_response_shape(project):
    store = SettingsStore(project / 'settings.json')
    pid, token = new_id(), generate_device_token()
    store.save(Settings(
        authorized_projects=[AuthorizedProject(pid, 'test', str(project))],
        paired_devices=[PairedDevice(new_id(), 'phone', '2026-10-26T00:00:00Z', hash_token(token))],
    ))
    client = TestClient(create_app(store=store))
    url = f'/v1/projects/{pid}/python/context'
    assert client.post(url, json={'path': 'pkg/main.py'}).status_code == 401
    client.headers['Authorization'] = f'Bearer {token}'
    response = client.post(url, json={'path': 'pkg/main.py', 'symbol': 'make', 'line': 4})
    assert response.status_code == 200
    assert response.json()['analyzer'] == 'python-ast-v1'
    assert response.json()['definitions'][0]['path'] == 'pkg/helpers.py'
    assert client.post(url, json={'path': '../bad.py'}).status_code == 400
    assert client.post(url, json={'path': 'pkg/main.py', 'symbol': 'x()'}).status_code == 400
    assert client.post(url, json={'path': 'pkg/main.py', 'line': 0}).status_code == 400
    assert client.post(url, json={'path': 'missing.py'}).status_code == 404
    put(project, 'notes.txt', 'plain')
    assert client.post(url, json={'path': 'notes.txt'}).status_code == 415


def test_api_draft_utf8_size_limit(project):
    with pytest.raises(analysis.FileServiceError) as error:
        analysis.analyze_context(project, 'pkg/main.py', content='#' + '中' * 400_000)
    assert error.value.code == 'FILE_TOO_LARGE'
