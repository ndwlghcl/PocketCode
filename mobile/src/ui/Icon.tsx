import type { CSSProperties } from 'react';

const paths = {
  folder: 'M3 7a2 2 0 0 1 2-2h5l2 2h7a2 2 0 0 1 2 2v10H3Z',
  file: 'M13 3H6a2 2 0 0 0-2 2v14a2 2 0 0 0 2 2h12a2 2 0 0 0 2-2V10Zm0 0v7h7M8 14h8M8 17h5',
  code: 'm8 8-4 4 4 4m8-8 4 4-4 4m-3-12-2 16',
  back: 'm14 6-6 6 6 6',
  chevron: 'm9 6 6 6-6 6',
  down: 'm6 9 6 6 6-6',
  search: 'M20 20l-5-5M17 10a7 7 0 1 1-14 0 7 7 0 0 1 14 0',
  more: 'M5 11v2m7-2v2m7-2v2',
  plus: 'M12 5v14M5 12h14',
  refresh: 'M20 8a8 8 0 1 0 0 8M20 3v5h-5',
  git: 'M6 3v12a3 3 0 1 0 3 3M6 6a3 3 0 1 0 0-1m12 1a3 3 0 1 0 0 1M18 9v3a6 6 0 0 1-6 6H9',
  share: 'M12 16V3m-5 5 5-5 5 5M5 12v8h14v-8',
  edit: 'm15 4 5 5M4 20l5-1L21 7l-5-5L4 14Z',
  drafts: 'M14 3H5v17h14v-8M9 16l4-1 9-9-4-4-9 9Z',
  settings: 'M4 7h16M4 17h16M8 4v6m8 4v6',
  check: 'm5 12 4 4L19 6',
  close: 'm6 6 12 12M6 18 18 6',
  sun: 'M12 2v2m0 16v2M2 12h2m16 0h2M5 5l1 1m12 12 1 1M5 19l1-1M18 6l1-1M16 12a4 4 0 1 1-8 0 4 4 0 0 1 8 0',
  moon: 'M20 14A8 8 0 0 1 10 4a8 8 0 1 0 10 10Z',
  system: 'M3 4h18v13H3ZM8 21h8m-4-4v4',
  image: 'M3 3h18v18H3Zm0 13 6-6 5 5 3-3 4 4M16 7h.01',
  link: 'm9 15 6-6M8 16l-2 2a4 4 0 0 1-5-5l5-5a4 4 0 0 1 5 0m2 0 2-2a4 4 0 0 1 5 5l-5 5a4 4 0 0 1-5 0',
  outline: 'M9 5h12M9 12h12M9 19h12M3 5h1M3 12h1M3 19h1',
  shield: 'm12 3 8 3v6c0 5-8 9-8 9s-8-4-8-9V6Zm-4 9 3 3 5-6',
  trash: 'M3 6h18M9 6V3h6v3M5 6l1 15h12l1-15M10 10v7m4-7v7',
  wifi: 'M3 8a15 15 0 0 1 18 0M6 12a10 10 0 0 1 12 0m-9 4a5 5 0 0 1 6 0m-3 4h.01',
  battery: 'M2 7h18v10H2Zm20 3v4M5 10v4m3-4v4m3-4v4m3-4v4',
  save: 'M4 3h13l4 4v14H3V3Zm3 0v6h10V3M7 21v-8h10v8',
  download: 'M12 3v12m-5-5 5 5 5-5M4 16v5h16v-5',
  expand: 'M8 3H3v5m13-5h5v5M3 16v5h5m13-5v5h-5',
  copy: 'M9 9h12v12H9ZM15 9V3H3v12h6',
  eye: 'M2 12s4-7 10-7 10 7 10 7-4 7-10 7S2 12 2 12Zm13 0a3 3 0 1 1-6 0 3 3 0 0 1 6 0',
} as const;

export type IconName = keyof typeof paths;
export function Icon({ name, size = 20, style }: { name: IconName; size?: number; style?: CSSProperties }) {
  return <svg width={size} height={size} viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="1.65" strokeLinecap="round" strokeLinejoin="round" aria-hidden="true" style={style}><path d={paths[name]} /></svg>;
}
