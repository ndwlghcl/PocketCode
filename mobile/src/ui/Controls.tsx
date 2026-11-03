import type { ButtonHTMLAttributes, ReactNode } from 'react';
import { useEffect, useRef } from 'react';
import { addBackLayer } from '../app/backLayers';
import { Icon, type IconName } from './Icon';

export function IconButton({ icon, label, className = '', ...props }: ButtonHTMLAttributes<HTMLButtonElement> & { icon: IconName; label: string }) {
  return <button type="button" className={`icon-button ${className}`} title={label} aria-label={label} {...props}><Icon name={icon} /></button>;
}
export function Toggle({ checked, onChange, label }: { checked: boolean; onChange: (value: boolean) => void; label: string }) {
  return <button type="button" className="toggle" role="switch" aria-checked={checked} aria-label={label} onClick={() => onChange(!checked)}><span /></button>;
}

/** 统一抽屉：关掉菜单后再处理页面返回，焦点保持在当前操作中。 */
export function ActionSheet({ title, onClose, children }: { title: string; onClose: () => void; children: ReactNode }) {
  const ref = useRef<HTMLDivElement>(null);
  const closeRef = useRef(onClose);
  closeRef.current = onClose;
  useEffect(() => {
    const previous = document.activeElement as HTMLElement | null;
    ref.current?.focus();
    const remove = addBackLayer(() => closeRef.current());
    return () => { remove(); previous?.focus(); };
  }, []);
  return <><div className="sheet-overlay" onClick={onClose} /><div ref={ref} className="sheet action-sheet" role="dialog" aria-modal="true" aria-label={title} tabIndex={-1} onKeyDown={(event) => {
    if (event.key === 'Escape') { event.stopPropagation(); onClose(); }
    if (event.key !== 'Tab') return;
    const elements = ref.current?.querySelectorAll<HTMLElement>('button:not(:disabled), input:not(:disabled), textarea:not(:disabled), select:not(:disabled), [tabindex="0"]');
    if (!elements?.length) { event.preventDefault(); return; }
    const first = elements[0], last = elements[elements.length - 1];
    if (event.shiftKey && (document.activeElement === first || document.activeElement === ref.current)) { event.preventDefault(); last.focus(); }
    else if (!event.shiftKey && (document.activeElement === last || document.activeElement === ref.current)) { event.preventDefault(); first.focus(); }
  }}><div className="sheet__handle" /><header className="sheet-heading"><h2>{title}</h2><IconButton icon="close" label="关闭菜单" onClick={onClose} /></header>{children}</div></>;
}
export function MenuItem({ icon, children, danger, ...props }: ButtonHTMLAttributes<HTMLButtonElement> & { icon: IconName; danger?: boolean }) {
  return <button type="button" className={`menu-item ${danger ? 'menu-item--danger' : ''}`} {...props}><Icon name={icon} /><span>{children}</span></button>;
}
