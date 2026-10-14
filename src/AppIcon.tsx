import { useEffect, useRef, useState } from 'react';
import { Avatar } from '@mui/material';
import { getAppIcons } from './api';
import { AppIconCache, appIconKey } from './appIcons';
import type { AppEntry } from './types';

const cache = new AppIconCache(getAppIcons);
export function resetAppIcons(): void { cache.reset(); }

export default function AppIcon({ app, selected }: { app: AppEntry; selected: boolean }) {
  const element = useRef<HTMLDivElement>(null);
  const [visible, setVisible] = useState(false);
  const [, update] = useState(0);
  const [failedImage, setFailedImage] = useState('');
  const key = appIconKey(app);
  const generation = cache.getGeneration();
  const icon = cache.get(key);
  const imageToken = `${generation}:${key}:${icon ?? ''}`;
  const src = icon && failedImage !== imageToken ? icon : undefined;

  useEffect(() => cache.subscribe(key, () => update(value => value + 1)), [key]);
  useEffect(() => {
    const target = element.current;
    if (!target) return;
    if (typeof IntersectionObserver === 'undefined') { setVisible(true); return; }
    const observer = new IntersectionObserver(entries => {
      setVisible(entries.some(entry => entry.isIntersecting));
    }, { rootMargin: '160px 0px', threshold: 0 });
    observer.observe(target);
    return () => observer.disconnect();
  }, []);
  useEffect(() => {
    if (visible) cache.request({ path: app.path, iconShortcut: app.iconShortcut });
  }, [key, generation, visible]);

  return <Avatar ref={element} variant="rounded" src={src} alt="" aria-hidden="true"
    data-app-icon={app.id} data-icon-state={src ? 'loaded' : 'letter'}
    slotProps={{ img: { draggable: false, onError: () => setFailedImage(imageToken) } }}
    sx={{ width: 40, height: 40, flexShrink: 0, bgcolor: selected ? 'action.selected' : 'action.hover',
      color: selected ? 'primary.main' : 'text.secondary', border: '1px solid',
      borderColor: selected ? 'primary.main' : 'divider',
      '& img': { width: '100%', height: '100%', objectFit: 'contain', padding: '4px', boxSizing: 'border-box' } }}>
    {app.name.trim().slice(0, 1).toUpperCase() || '?'}
  </Avatar>;
}