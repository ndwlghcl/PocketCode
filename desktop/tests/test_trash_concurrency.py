from concurrent.futures import ThreadPoolExecutor
import threading
import time
import errno
from pathlib import Path

import pytest

from pocketcode.services import trash
from pocketcode.services.trash import TrashServiceError, TrashStore
from pocketcode.storage.settings_store import AuthorizedProject, Settings, SettingsStore


def test_request_local_stores_share_transaction_lock(tmp_path, monkeypatch):
    count = 6
    barrier = threading.Barrier(count)
    load_index = TrashStore._load_index
    def slow_load(self):
        value = load_index(self)
        time.sleep(0.02)  # 原实现中的不同实例会同时持有旧索引。
        return value
    monkeypatch.setattr(TrashStore, '_load_index', slow_load)
    for i in range(count):
        (tmp_path / f'{i}.txt').write_text(str(i))
    def delete(i):
        store = TrashStore(tmp_path / 'trash')
        barrier.wait(timeout=10)
        return store.move_in('p', [(f'{i}.txt', tmp_path / f'{i}.txt')])
    with ThreadPoolExecutor(count) as pool:
        results = list(pool.map(delete, range(count)))
    assert len(results) == count
    items = TrashStore(tmp_path / 'trash').list_entries()
    assert {item['original_path'] for item in items} == {f'{i}.txt' for i in range(count)}


def _deleted_item(tmp_path, kind):
    root = tmp_path / 'project'
    root.mkdir()
    target = root / 'item'
    if kind == 'dir':
        target.mkdir()
        (target / 'original.txt').write_text('DELETED VERSION')
    else:
        target.write_text('DELETED VERSION')
    settings = SettingsStore(tmp_path / 'settings.json')
    settings.save(Settings(authorized_projects=[AuthorizedProject(id='p', name='demo', root_path=str(root))]))
    store = TrashStore(tmp_path / 'trash')
    item = store.move_in('p', [('item', target)])[0]
    return store, settings, target, tmp_path / 'trash' / item['trash_id'], item['trash_id']


@pytest.mark.parametrize('kind', ['file', 'dir'])
@pytest.mark.parametrize('cross_volume', [False, True])
def test_restore_never_overwrites_target_created_after_check(tmp_path, monkeypatch, kind, cross_volume):
    store, settings, target, payload, trash_id = _deleted_item(tmp_path, kind)
    original = trash.rename_exclusive

    def competing_create(source, destination):
        if cross_volume and source == payload:
            raise OSError(errno.EXDEV, 'simulated cross-volume rename')
        if kind == 'dir':
            destination.mkdir()  # 空目录也不能被替换或变成恢复的父目录。
        else:
            destination.write_text('NEW IMPORTANT VERSION')
        original(source, destination)

    monkeypatch.setattr(trash, 'rename_exclusive', competing_create)
    with pytest.raises(TrashServiceError) as error:
        store.restore(trash_id, settings_store=settings)
    assert error.value.code == 'ALREADY_EXISTS'
    assert error.value.details['occupied_path'] == 'item'
    if kind == 'dir':
        assert list(target.iterdir()) == []
        assert (payload / 'original.txt').read_text() == 'DELETED VERSION'
    else:
        assert target.read_text() == 'NEW IMPORTANT VERSION'
        assert payload.read_text() == 'DELETED VERSION'
    assert [entry['trash_id'] for entry in store.list_entries()] == [trash_id]
    assert not list(target.parent.glob('.pocketcode-restore-*'))


@pytest.mark.parametrize('kind', ['file', 'dir'])
@pytest.mark.parametrize('cross_volume', [False, True])
def test_restore_roundtrip_on_same_or_different_volume(tmp_path, monkeypatch, kind, cross_volume):
    store, settings, target, payload, trash_id = _deleted_item(tmp_path, kind)
    original = trash.rename_exclusive

    def rename(source, destination):
        if cross_volume and source == payload:
            raise OSError(errno.EXDEV, 'simulated cross-volume rename')
        original(source, destination)

    monkeypatch.setattr(trash, 'rename_exclusive', rename)
    assert store.restore(trash_id, settings_store=settings) == (trash_id, 'item')
    restored = target / 'original.txt' if kind == 'dir' else target
    assert restored.read_text() == 'DELETED VERSION'
    assert not payload.exists()
    assert store.list_entries() == []
    assert not list(target.parent.glob('.pocketcode-restore-*'))


def test_cross_volume_copy_failure_preserves_recoverable_original(tmp_path, monkeypatch):
    store, settings, target, payload, trash_id = _deleted_item(tmp_path, 'file')

    def different_volume(*args):
        raise OSError(errno.EXDEV, 'simulated cross-volume rename')

    def failed_copy(source, destination, **kwargs):
        Path(destination).write_text('PARTIAL COPY')
        raise OSError('disk full')

    monkeypatch.setattr(trash, 'rename_exclusive', different_volume)
    monkeypatch.setattr(trash.shutil, 'copy2', failed_copy)
    with pytest.raises(TrashServiceError) as error:
        store.restore(trash_id, settings_store=settings)
    assert error.value.code == 'IO_ERROR'
    assert payload.read_text() == 'DELETED VERSION'
    assert not target.exists()
    assert [entry['trash_id'] for entry in store.list_entries()] == [trash_id]
    assert not list(target.parent.glob('.pocketcode-restore-*'))
