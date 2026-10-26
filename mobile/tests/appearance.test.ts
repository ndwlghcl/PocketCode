import { expect, test } from 'vitest';
import { DEFAULT_APPEARANCE, loadAppearance, loadWrapPref, normalizeAppearance, saveAppearance, saveWrapPref } from '../src/storage/uiPrefs';
import type { KVStorage } from '../src/native';

function memory() {
  const values = new Map<string, string>();
  const storage: KVStorage = { async get(k) { return values.get(k) ?? null; }, async set(k, v) { values.set(k, v); }, async remove(k) { values.delete(k); }, async keys(prefix) { return [...values.keys()].filter((k) => k.startsWith(prefix)); } };
  return { values, storage };
}
test('旧版折行设置升级后继续生效，新设置和旧读取接口共用同一个键', async () => {
  const { storage } = memory();
  await saveWrapPref(false, storage);
  expect((await loadAppearance(storage)).wrap).toBe(false);
  await saveAppearance({ ...DEFAULT_APPEARANCE, wrap: true, fontSize: 18 }, storage);
  expect(await loadWrapPref(storage)).toBe(true);
  expect((await loadAppearance(storage)).fontSize).toBe(18);
});
test('主题、三个独立背景参数和代码显示设置可在新读取时恢复', async () => {
  const { storage } = memory();
  const saved = { ...DEFAULT_APPEARANCE, theme: 'system' as const, imageOpacity: .31, maskOpacity: .83, blur: 9, lineNumbers: false, fontSize: 20 };
  await saveAppearance(saved, storage);
  expect(await loadAppearance(storage)).toEqual(saved);
});
test('损坏的 JSON 使用默认外观，仍保留旧版的折行偏好', async () => {
  const { storage, values } = memory();
  values.set('pc.ui.appearance', '{ broken');
  await saveWrapPref(false, storage);
  expect(await loadAppearance(storage)).toEqual({ ...DEFAULT_APPEARANCE, wrap: false });
});
test('来自旧版本或异常数据的数值被限制在安全范围', () => {
  expect(normalizeAppearance({ fontSize: 999, imageOpacity: -5, maskOpacity: 5, blur: Infinity, lineNumbers: 'no', theme: '<script>' })).toMatchObject({ fontSize: 24, imageOpacity: 0, maskOpacity: 1, blur: 0, lineNumbers: true, theme: 'dark' });
});
test('设置落盘失败会抛错，让界面报告未保存', async () => {
  const { storage } = memory();
  storage.set = async () => { throw new Error('disk full'); };
  await expect(saveAppearance(DEFAULT_APPEARANCE, storage)).rejects.toThrow('disk full');
});
