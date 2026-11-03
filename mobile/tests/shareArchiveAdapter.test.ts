import { afterEach, beforeEach, expect, test, vi } from 'vitest';
const h = vi.hoisted(() => ({ native: true, write: vi.fn(), share: vi.fn() }));
vi.mock('@capacitor/core', () => ({ Capacitor: { isNativePlatform: () => h.native } }));
vi.mock('../src/native', () => ({ PocketCodeBridge: { writeShareArchive: h.write } }));
vi.mock('@capacitor/share', () => ({ Share: { share: h.share } }));
import { shareArchive } from '../src/features/sharing/share';

beforeEach(() => { vi.resetAllMocks(); h.native = true; h.write.mockResolvedValue({ uri: 'file:///cache/test.zip' }); h.share.mockResolvedValue({}); });
afterEach(() => { vi.restoreAllMocks(); vi.unstubAllGlobals(); vi.useRealTimers(); });

test('Android 传入完整 ZIP 字节，以文件 URI 分享，失败不复制成文本', async () => {
  const bytes = new Uint8Array([80, 75, 3, 4, 255, 128, 0]);
  expect(await shareArchive('demo.zip', bytes)).toEqual({ ok: true });
  const request = h.write.mock.calls[0][0];
  expect(request.name).toBe('demo.zip');
  expect([...atob(request.base64)].map((character) => character.charCodeAt(0))).toEqual([...bytes]);
  expect(h.share).toHaveBeenCalledWith(expect.objectContaining({ files: ['file:///cache/test.zip'] }));
  h.share.mockRejectedValue(new Error('系统分享失败'));
  expect(await shareArchive('demo.zip', bytes)).toMatchObject({ ok: false, message: '系统分享失败' });
});

test('Android 用户取消与文件写入失败明确区分', async () => {
  h.share.mockRejectedValue(new Error('Share canceled'));
  expect(await shareArchive('demo.zip', new Uint8Array([80, 75, 3, 4]))).toEqual({ ok: true, cancelled: true });
  h.share.mockClear(); h.write.mockRejectedValue(new Error('存储空间不足'));
  expect(await shareArchive('demo.zip', new Uint8Array([80, 75, 3, 4]))).toMatchObject({ ok: false, message: '存储空间不足' });
  expect(h.share).not.toHaveBeenCalled();
});

test('浏览器能分享文件时发送 application/zip 的 File', async () => {
  h.native = false;
  const share = vi.fn(async (_options: any) => {});
  vi.stubGlobal('navigator', { canShare: () => true, share });
  expect(await shareArchive('demo.zip', new Uint8Array([80, 75, 3, 4]))).toEqual({ ok: true });
  const file = share.mock.calls[0][0].files[0];
  expect(file.name).toBe('demo.zip'); expect(file.type).toBe('application/zip');
  expect([...new Uint8Array(await file.arrayBuffer())]).toEqual([80, 75, 3, 4]);
});

test('浏览器不支持文件分享时下载 ZIP，并释放临时 URL', async () => {
  h.native = false; vi.useFakeTimers();
  vi.stubGlobal('navigator', { canShare: () => false });
  const anchor = { href: '', download: '', click: vi.fn(), remove: vi.fn() };
  vi.stubGlobal('document', { createElement: () => anchor, body: { appendChild: vi.fn() } });
  vi.spyOn(URL, 'createObjectURL').mockReturnValue('blob:test');
  const revoke = vi.spyOn(URL, 'revokeObjectURL').mockImplementation(() => {});
  expect(await shareArchive('demo.zip', new Uint8Array([80, 75, 3, 4]))).toEqual({ ok: true, downloaded: true });
  expect(anchor.download).toBe('demo.zip'); expect(anchor.click).toHaveBeenCalledTimes(1);
  await vi.advanceTimersByTimeAsync(60_000); expect(revoke).toHaveBeenCalledWith('blob:test');
});
