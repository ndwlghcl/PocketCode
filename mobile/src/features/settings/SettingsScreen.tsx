import { useEffect, useId, useRef, useState } from 'react';
import { Capacitor } from '@capacitor/core';
import { App as CapApp } from '@capacitor/app';
import { useAppearance } from '../../app/Appearance';
import { APP_BUILD, APP_VERSION, APP_VERSION_CODE } from '../../app/version';
import { Icon } from '../../ui/Icon';
import { Toggle } from '../../ui/Controls';

function Slider({ label, value, onChange, min = 0, max = 100, suffix = '%' }: { label: string; value: number; onChange: (n: number) => void; min?: number; max?: number; suffix?: string }) {
  const id = useId();
  return <div className="settings-slider"><div><label htmlFor={id}>{label}</label><output htmlFor={id}>{Math.round(value)}{suffix}</output></div><input id={id} type="range" min={min} max={max} value={value} onChange={(event) => onChange(Number(event.target.value))} /></div>;
}
export function SettingsScreen({ connectionText, onOpenConnection }: { connectionText: string; onOpenConnection: () => void }) {
  const { prefs, update, image, chooseImage, clearImage, storageError } = useAppearance();
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [version, setVersion] = useState({ version: APP_VERSION, build: APP_VERSION_CODE });
  useEffect(() => { if (Capacitor.isNativePlatform()) void CapApp.getInfo().then((info) => setVersion(info)).catch(() => undefined); }, []);
  const input = useRef<HTMLInputElement>(null);
  const run = async (operation: () => Promise<void>) => { if (busy) return; setBusy(true); setError(null); try { await operation(); } catch (cause) { setError(cause instanceof Error ? cause.message : '背景处理失败，请重试'); } finally { setBusy(false); } };
  return <section className="settings-screen"><header className="page-intro"><p className="eyebrow">MAKE IT YOURS</p><h1>你的 PocketCode<span>.</span></h1><p>让每一次打开，都合你心意。</p></header>
    <div className="appearance-preview"><Icon name="code" size={24} /><div><strong>属于你的阅读空间</strong><span>外观实时预览 · 调整即刻生效</span></div><i /></div>
    {(error || storageError) && <p role="alert" className="hint hint--error">{error || storageError}</p>}
    <h2 className="settings-label">外观</h2><div className="settings-group"><div className="setting-title"><Icon name="sun" size={18} />显示模式</div><div className="theme-picker">{([{ id: 'light', name: '浅色', icon: 'sun' }, { id: 'dark', name: '深色', icon: 'moon' }, { id: 'system', name: '系统', icon: 'system' }] as const).map((mode) => <button type="button" aria-pressed={prefs.theme === mode.id} key={mode.id} onClick={() => update({ theme: mode.id })}><Icon name={mode.icon} size={18} />{mode.name}</button>)}</div>
      <div className="setting-row"><span><Icon name="image" size={18} />背景图片</span><div className="setting-actions"><button type="button" disabled={busy} onClick={() => Capacitor.isNativePlatform() ? void run(() => chooseImage()) : input.current?.click()}>{busy ? '处理中…' : image ? '更换' : '选择图片'}</button>{image && <button type="button" disabled={busy} onClick={() => void run(clearImage)}>清除</button>}</div></div>
      <input ref={input} className="visually-hidden" type="file" aria-label="选择背景图片" accept="image/jpeg,image/png,image/webp" onChange={(event) => { const file = event.target.files?.[0]; if (file) void run(() => chooseImage(file)); event.target.value = ''; }} />
      <Slider label="图片透明度" value={prefs.imageOpacity * 100} onChange={(n) => update({ imageOpacity: n / 100 })} />
      <Slider label="遮罩强度" value={prefs.maskOpacity * 100} onChange={(n) => update({ maskOpacity: n / 100 })} />
      <Slider label="背景模糊" value={prefs.blur} max={20} suffix=" px" onChange={(n) => update({ blur: n })} />
      <button className="settings-reset" type="button" disabled={busy} onClick={() => void run(async () => { await clearImage(); update({ imageOpacity: .55, maskOpacity: .7, blur: 0 }); })}>恢复默认背景</button>
    </div><p className="settings-footnote">背景只保存在这台设备。文字和代码使用独立的阅读底色。</p>
    <h2 className="settings-label">代码显示</h2><div className="settings-group"><Slider label="字体大小" value={prefs.fontSize} min={11} max={24} suffix=" px" onChange={(n) => update({ fontSize: n })} /><pre className="font-preview"><span className="tok-keyword">def</span> <span className="tok-def">make_something</span>():{'\n'}    <span className="tok-keyword">return</span> <span className="tok-string">"a little better"</span></pre><div className="setting-row"><span>自动折行</span><Toggle checked={prefs.wrap} label="自动折行" onChange={(wrap) => update({ wrap })} /></div><div className="setting-row"><span>显示行号</span><Toggle checked={prefs.lineNumbers} label="显示行号" onChange={(lineNumbers) => update({ lineNumbers })} /></div></div>
    <h2 className="settings-label">应用</h2><div className="settings-group"><button type="button" className="setting-row setting-link" onClick={onOpenConnection}><span><Icon name="system" size={18} />连接管理</span><Icon name="chevron" size={18} /></button><p className="settings-connection">{connectionText}</p><div className="settings-version"><span>PocketCode · {version.version} · 构建号 {version.build}</span><small>{APP_BUILD}</small></div></div><p className="settings-signature">YOUR CODE. YOUR CORNER.</p>
  </section>;
}
