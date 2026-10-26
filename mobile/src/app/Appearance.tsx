import { createContext, useContext, useEffect, useRef, useState } from 'react';
import type { CSSProperties, ReactNode } from 'react';
import { App as CapApp } from '@capacitor/app';
import { Capacitor } from '@capacitor/core';
import { DEFAULT_APPEARANCE, loadAppearance, saveAppearance, type AppearancePrefs } from '../storage/uiPrefs';
import * as background from '../native/background';

interface AppearanceState {
  prefs: AppearancePrefs;
  update: (patch: Partial<AppearancePrefs>) => void;
  image: string | null;
  chooseImage: (file?: File) => Promise<void>;
  clearImage: () => Promise<void>;
  storageError: string | null;
}
const Context = createContext<AppearanceState>({ prefs: DEFAULT_APPEARANCE, update() {}, image: null, async chooseImage() {}, async clearImage() {}, storageError: null });
export const useAppearance = () => useContext(Context);

export function AppearanceProvider({ children }: { children: ReactNode }) {
  const [prefs, setPrefs] = useState(DEFAULT_APPEARANCE);
  const [image, setImage] = useState<string | null>(null);
  const [ready, setReady] = useState(false);
  const [storageError, setStorageError] = useState<string | null>(null);
  const [systemDark, setSystemDark] = useState(() => matchMedia('(prefers-color-scheme: dark)').matches);
  const latest = useRef(prefs);
  const saveQueue = useRef(Promise.resolve());
  const changed = useRef(false);
  const initialization = useRef<Promise<[AppearancePrefs, { url: string | null; error: string | null }]> | null>(null);
  const persist = () => {
    if (!changed.current) return;
    changed.current = false;
    const snapshot = latest.current;
    saveQueue.current = saveQueue.current.then(() => saveAppearance(snapshot)).then(() => setStorageError(null)).catch(() => {
      changed.current = true;
      setStorageError('外观设置暂未保存，请检查存储空间；当前显示仍有效。');
    });
  };
  useEffect(() => {
    let cancelled = false;
    // StrictMode 重挂载 effect 时复用同一次读取，避免并发 object URL 相互撤销。
    initialization.current ??= Promise.all([loadAppearance(), background.loadBackground()
      .then((url) => ({ url, error: null }))
      .catch(() => ({ url: null, error: '背景读取失败，可重新选择图片。' }))]);
    void initialization.current.then(([saved, storedImage]) => {
      if (cancelled) return;
      latest.current = saved; setPrefs(saved); setImage(storedImage.url); setStorageError(storedImage.error); setReady(true);
    });
    const media = matchMedia('(prefers-color-scheme: dark)');
    const onTheme = () => setSystemDark(media.matches);
    media.addEventListener('change', onTheme);
    const onHide = () => { if (document.visibilityState === 'hidden') persist(); };
    document.addEventListener('visibilitychange', onHide);
    window.addEventListener('pagehide', persist);
    const listener = Capacitor.isNativePlatform() ? CapApp.addListener('appStateChange', ({ isActive }) => { if (!isActive) persist(); }) : null;
    return () => { cancelled = true; media.removeEventListener('change', onTheme); document.removeEventListener('visibilitychange', onHide); window.removeEventListener('pagehide', persist); void listener?.then((handle) => handle.remove()); };
  }, []);
  useEffect(() => { if (!ready) return; const timer = setTimeout(persist, 160); return () => clearTimeout(timer); }, [prefs, ready]);
  const theme = prefs.theme === 'system' ? systemDark ? 'dark' : 'light' : prefs.theme;
  useEffect(() => {
    document.querySelector('meta[name="theme-color"]')?.setAttribute('content', theme === 'light' ? '#f6f3ec' : '#23262a');
    void background.applySystemTheme(theme === 'light').catch(() => undefined);
  }, [theme]);
  return <Context.Provider value={{ prefs, image, storageError,
    update(patch) { const next = { ...latest.current, ...patch }; latest.current = next; changed.current = true; setPrefs(next); },
    async chooseImage(file) { const result = await background.chooseBackground(file); if (!result.cancelled) setImage(result.url); },
    async clearImage() { await background.clearBackground(); setImage(null); },
  }}><div className="appearance-root" data-theme={theme} style={{ '--code-font-size': `${prefs.fontSize}px`, '--image-opacity': prefs.imageOpacity, '--image-mask': prefs.maskOpacity, '--image-blur': `${prefs.blur}px` } as CSSProperties}>
    {image && <div className="app-background" aria-hidden="true"><img src={image} alt="" /><div /></div>}
    {ready ? children : <div className="app-loading">PocketCode<span>正在打开你的工作空间…</span></div>}
  </div></Context.Provider>;
}
