"""真实文件上的回归：正文版本一致、保存途中修改、扫描边界与文本格式。"""
from __future__ import annotations

import hashlib
import subprocess
import sys

import pytest

from pocketcode.services import files, writes
from pocketcode.services.search import search_project


def version(raw: bytes) -> str:
    return 'sha256:' + hashlib.sha256(raw).hexdigest()


def test_read_version_always_describes_returned_bytes(tmp_path, monkeypatch):
    target = tmp_path / 'code.py'
    original = b'old content\n'
    target.write_bytes(original)
    decode = files._decode

    def edit_between_decode_and_version(raw):
        result = decode(raw)
        target.write_bytes(b'IDE newer content\n')
        return result

    monkeypatch.setattr(files, '_decode', edit_between_decode_and_version)
    result = files.read_text_file(tmp_path, 'code.py')
    assert result['content'] == original.decode()
    assert result['size'] == len(original)
    assert result['version'] == version(original)


@pytest.mark.parametrize('edit_stage', ['snapshot', 'fsync'])
def test_ide_edit_during_save_is_not_overwritten(tmp_path, monkeypatch, edit_stage):
    target = tmp_path / 'code.py'
    target.write_bytes(b'old\n')
    newer = b'newer IDE text\n'
    snapshots = tmp_path / 'snapshots'
    if edit_stage == 'snapshot':
        original = writes.snapshot_previous
        def interrupt(*args, **kwargs):
            result = original(*args, **kwargs)
            target.write_bytes(newer)
            return result
        monkeypatch.setattr(writes, 'snapshot_previous', interrupt)
    else:
        original = writes.os.fsync
        def interrupt(fd):
            original(fd)
            target.write_bytes(newer)
        monkeypatch.setattr(writes.os, 'fsync', interrupt)
    with pytest.raises(writes.WriteServiceError) as error:
        writes.save_file(tmp_path, 'code.py', version(b'old\n'), 'phone\n', 'utf-8', 'LF',
                         project_id='p', snapshots_root=snapshots)
    assert error.value.code == 'VERSION_CONFLICT'
    assert target.read_bytes() == newer
    assert not list(tmp_path.glob('.pocketcode-tmp-*'))


@pytest.mark.parametrize('raw', [b'\x00\x01\x02\r\x03', b'\xef\xbb\xbf\xff', b'\xff\xfe\x00'])
def test_binary_or_malformed_bom_rejected(tmp_path, raw):
    (tmp_path / 'bad.bin').write_bytes(raw)
    with pytest.raises(files.FileServiceError) as error:
        files.read_text_file(tmp_path, 'bad.bin')
    assert error.value.code == 'UNSUPPORTED_FORMAT'


def test_utf16_is_text_in_reader_and_search(tmp_path):
    text = 'hello 中文\r\n'
    (tmp_path / 'good.txt').write_bytes(text.encode('utf-16'))
    assert files.read_text_file(tmp_path, 'good.txt')['content'] == text
    assert search_project(tmp_path, '中文')['total_matches'] == 1


@pytest.mark.skipif(sys.platform != 'win32', reason='Windows junction regression')
def test_manifest_and_search_skip_junctions_and_loops(tmp_path):
    project = tmp_path / 'project'
    outside = tmp_path / 'outside'
    project.mkdir(); outside.mkdir()
    (project / 'normal.py').write_text('normal', encoding='utf-8')
    (outside / 'private.txt').write_text('PRIVATE_SENTINEL', encoding='utf-8')
    links = [project / 'linked', project / 'loop']
    try:
        for link, target in zip(links, [outside, project]):
            subprocess.run(['cmd', '/c', 'mklink', '/J', str(link), str(target)],
                           check=True, capture_output=True)
        manifest, truncated = files.generate_manifest(project)
        assert not truncated
        assert [child['path'] for child in manifest['children']] == ['normal.py']
        assert search_project(project, 'PRIVATE_SENTINEL')['matches'] == []
    finally:
        for link in links:
            if link.exists():
                link.rmdir()  # 只移除联接本身，不递归删除目标目录。
