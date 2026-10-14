export const MAX_ICON_BATCH = 32;
export const MAX_ICON_DATA_URL_LENGTH = 65536;
export interface AppIconSource { path: string; iconShortcut?: string; }
export interface AppIconRequest { id: string; path: string; shortcutPath?: string; }
export type AppIconLoader = (requests: AppIconRequest[], refresh?: boolean) => Promise<Record<string, string | null>>;

function normalizedPath(path: string): string {
  return path.trim().replace(/^\\\\\?\\/, '').replace(/\//g, '\\').toLowerCase();
}
export function appIconKey(source: AppIconSource): string {
  return JSON.stringify([normalizedPath(source.path), normalizedPath(source.iconShortcut ?? '')]);
}
export function validatePngIcon(value: unknown): string | null {
  if (typeof value !== 'string' || value.length > MAX_ICON_DATA_URL_LENGTH || !value.startsWith('data:image/png;base64,')) return null;
  const data = value.slice(22);
  if (data.length < 44 || data.length % 4 !== 0 || !/^[A-Za-z0-9+/]+={0,2}$/.test(data)) return null;
  try {
    const header = atob(data.slice(0, 44));
    const signature = [137, 80, 78, 71, 13, 10, 26, 10, 0, 0, 0, 13, 73, 72, 68, 82];
    if (!signature.every((byte, i) => header.charCodeAt(i) === byte)) return null;
    const bytes = Uint8Array.from(header, char => char.charCodeAt(0));
    const view = new DataView(bytes.buffer);
    return view.getUint32(16) === 64 && view.getUint32(20) === 64 ? value : null;
  } catch { return null; }
}

/** In-memory display cache; it never changes or serializes application selections. */
export class AppIconCache {
  private values = new Map<string, string | null>();
  private queue = new Map<string, AppIconSource>();
  private inFlight = new Map<string, number>();
  private listeners = new Map<string, Set<() => void>>();
  private generation = 0;
  private nextId = 0;
  private refreshPending = false;
  private timer: ReturnType<typeof setTimeout> | undefined;
  private flushing: Promise<void> | undefined;
  private loader: AppIconLoader;
  private maxEntries: number;
  constructor(loader: AppIconLoader, maxEntries = 512) { this.loader = loader; this.maxEntries = Math.max(1, maxEntries); }
  getGeneration(): number { return this.generation; }
  get(key: string): string | null | undefined { return this.values.get(key); }
  subscribe(key: string, listener: () => void): () => void {
    let listeners = this.listeners.get(key);
    if (!listeners) { listeners = new Set(); this.listeners.set(key, listeners); }
    listeners.add(listener);
    return () => { listeners!.delete(listener); if (!listeners!.size) this.listeners.delete(key); };
  }
  request(source: AppIconSource): void {
    const key = appIconKey(source);
    if (this.values.has(key) || this.queue.has(key) || this.inFlight.get(key) === this.generation) return;
    this.queue.set(key, { path: source.path, ...(source.iconShortcut ? { iconShortcut: source.iconShortcut } : {}) });
    this.schedule();
  }
  reset(): void {
    this.generation++;
    this.values.clear(); this.queue.clear(); this.inFlight.clear();
    this.refreshPending = true;
    for (const listeners of this.listeners.values()) for (const listener of listeners) listener();
    this.schedule(0);
  }
  private notify(key: string): void { for (const listener of this.listeners.get(key) ?? []) listener(); }
  private schedule(delay = 30): void {
    if (this.timer !== undefined || this.flushing) return;
    this.timer = setTimeout(() => { this.timer = undefined; void this.flush(); }, delay);
  }
  /** Deterministic tests can flush explicitly; normal rendering uses the batch timer. */
  flush(): Promise<void> {
    if (this.timer !== undefined) { clearTimeout(this.timer); this.timer = undefined; }
    if (this.flushing) return this.flushing;
    const task = this.drain();
    this.flushing = task;
    void task.then(() => {
      this.flushing = undefined;
      if (this.queue.size || this.refreshPending) this.schedule();
    }, () => {
      this.flushing = undefined;
      if (this.queue.size || this.refreshPending) this.schedule();
    });
    return task;
  }
  private async drain(): Promise<void> {
    while (this.queue.size || this.refreshPending) {
      const generation = this.generation;
      const batch = [...this.queue.entries()].slice(0, MAX_ICON_BATCH);
      const refresh = this.refreshPending;
      this.refreshPending = false;
      const requests = batch.map(([key, source]) => {
        this.queue.delete(key); this.inFlight.set(key, generation);
        return { id: `app-icon-${++this.nextId}`, path: source.path, ...(source.iconShortcut ? { shortcutPath: source.iconShortcut } : {}) };
      });
      let result: Record<string, string | null> = {};
      try { result = await this.loader(requests, refresh); } catch { /* Keep letter fallbacks on a failed batch. */ }
      if (this.generation === generation) batch.forEach(([key], index) => {
        this.values.set(key, validatePngIcon(result?.[requests[index].id]));
        while (this.values.size > this.maxEntries) this.values.delete(this.values.keys().next().value!);
        this.notify(key);
      });
      for (const [key] of batch) if (this.inFlight.get(key) === generation) this.inFlight.delete(key);
    }
  }
}