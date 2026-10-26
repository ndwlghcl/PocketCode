import { expect, test, vi } from 'vitest';
import { addBackLayer, closeTopLayer } from '../src/app/backLayers';

test('返回键只关闭最上层菜单；卸载后才交还页面返回', () => {
  const first = vi.fn(), second = vi.fn();
  const removeFirst = addBackLayer(first), removeSecond = addBackLayer(second);
  try {
    expect(closeTopLayer()).toBe(true);
    expect(second).toHaveBeenCalledOnce();
    expect(first).not.toHaveBeenCalled();
    removeSecond(); expect(closeTopLayer()).toBe(true); expect(first).toHaveBeenCalledOnce();
    removeFirst(); expect(closeTopLayer()).toBe(false);
  } finally { removeFirst(); removeSecond(); }
});
