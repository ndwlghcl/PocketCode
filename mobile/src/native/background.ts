import { Capacitor, registerPlugin } from '@capacitor/core';

const Background = registerPlugin<{
  choose(): Promise<{ path?: string; revision?: number; cancelled?: boolean }>;
  current(): Promise<{ path?: string; revision?: number }>;
  clear(): Promise<void>;
  systemTheme(options: { light: boolean }): Promise<void>;
}>('PocketCodeBackground');
let activeUrl: string | null = null;
function imageUrl(path?: string, revision?: number): string | null {
  return path ? `${Capacitor.convertFileSrc(path)}?v=${revision ?? 0}` : null;
}
async function database(): Promise<IDBDatabase> {
  return new Promise((resolve, reject) => {
    const request = indexedDB.open('pocketcode-appearance', 1);
    request.onupgradeneeded = () => request.result.createObjectStore('images');
    request.onsuccess = () => resolve(request.result);
    request.onerror = () => reject(new Error('无法打开背景存储'));
  });
}
async function storedImage(operation: 'read' | 'write' | 'clear', blob?: Blob): Promise<Blob | null> {
  const db = await database();
  try {
    return await new Promise((resolve, reject) => {
      const tx = db.transaction('images', operation === 'read' ? 'readonly' : 'readwrite');
      const store = tx.objectStore('images');
      const request = operation === 'read' ? store.get('background') : operation === 'write' ? store.put(blob, 'background') : store.delete('background');
      tx.oncomplete = () => resolve(operation === 'read' && request.result instanceof Blob ? request.result : null);
      tx.onerror = () => reject(new Error('背景未能保存，请检查设备存储空间'));
      tx.onabort = () => reject(new Error('背景保存已中断'));
    });
  } finally { db.close(); }
}
function replaceUrl(blob: Blob | null): string | null {
  if (activeUrl) URL.revokeObjectURL(activeUrl);
  activeUrl = blob ? URL.createObjectURL(blob) : null;
  return activeUrl;
}
export async function loadBackground(): Promise<string | null> {
  if (Capacitor.isNativePlatform()) { const image = await Background.current(); return imageUrl(image.path, image.revision); }
  return replaceUrl(await storedImage('read'));
}
export async function chooseBackground(file?: File): Promise<{ cancelled: boolean; url: string | null }> {
  if (Capacitor.isNativePlatform()) {
    const image = await Background.choose();
    return { cancelled: !!image.cancelled, url: imageUrl(image.path, image.revision) };
  }
  if (!file) return { cancelled: true, url: activeUrl };
  if (!['image/jpeg', 'image/png', 'image/webp'].includes(file.type)) throw new Error('请选择 JPG、PNG 或 WebP 图片');
  if (file.size > 32 * 1024 * 1024) throw new Error('请选择小于 32 MB 的图片');
  const dimensions = await new Promise<{ width: number; height: number }>((resolve, reject) => {
    const img = new Image();
    const url = URL.createObjectURL(file);
    img.onload = () => { const width = img.naturalWidth, height = img.naturalHeight; URL.revokeObjectURL(url); img.src = ''; resolve({ width, height }); };
    img.onerror = () => { URL.revokeObjectURL(url); reject(new Error('无法读取这张图片')); };
    img.src = url;
  });
  const resizeRatio = Math.min(1, 1920 / Math.max(dimensions.width, dimensions.height));
  const bitmap = await createImageBitmap(file, { resizeWidth: Math.max(1, Math.round(dimensions.width * resizeRatio)), resizeHeight: Math.max(1, Math.round(dimensions.height * resizeRatio)), resizeQuality: 'high' });
  try {
    const ratio = Math.min(1, 1920 / Math.max(bitmap.width, bitmap.height));
    const canvas = document.createElement('canvas');
    canvas.width = Math.max(1, Math.round(bitmap.width * ratio));
    canvas.height = Math.max(1, Math.round(bitmap.height * ratio));
    const ctx = canvas.getContext('2d');
    if (!ctx) throw new Error('设备不支持处理此图片');
    ctx.fillStyle = '#ffffff'; ctx.fillRect(0, 0, canvas.width, canvas.height);
    ctx.drawImage(bitmap, 0, 0, canvas.width, canvas.height);
    const blob = await new Promise<Blob>((resolve, reject) => canvas.toBlob((result) => result ? resolve(result) : reject(new Error('图片处理失败')), 'image/jpeg', .85));
    await storedImage('write', blob);
    return { cancelled: false, url: replaceUrl(blob) };
  } finally { bitmap.close(); }
}
export async function clearBackground(): Promise<void> {
  if (Capacitor.isNativePlatform()) await Background.clear();
  else { await storedImage('clear'); replaceUrl(null); }
}
export async function applySystemTheme(light: boolean): Promise<void> {
  if (Capacitor.isNativePlatform()) await Background.systemTheme({ light });
}
