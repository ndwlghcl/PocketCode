from concurrent.futures import ThreadPoolExecutor
import threading
import time

from pocketcode.services.trash import TrashStore


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
