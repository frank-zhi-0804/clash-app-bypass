import { uiMessage, normalizeLanguage } from './messages';
import { invoke, isTauri } from '@tauri-apps/api/core';
import type { AppEntry, Integration, Settings, OperationResult, NormalizedWebsite } from './types';
import type { RoutingSnapshot } from './routingDiagnostics';
import type { AppIconRequest } from './appIcons';
export const desktop = isTauri();
const defaults: Settings = { selected: [], websites: [], language: 'zh-CN', configDir: '', dark: false, otherTraffic: 'proxy', proxyGroup: 'GLOBAL' };
const examples: AppEntry[] = [
  { id: 'demo-wechat', name: 'WeChat / 微信', path: 'C:\\Demo\\WeChat\\WeChat.exe', running: true, processes: ['C:\\Demo\\WeChat\\WeChat.exe', 'C:\\Demo\\WeChat\\WeChatAppEx.exe'], source: '示例', sourceMessage: uiMessage('demo.source'), warnings: [] },
  { id: 'demo-steam', name: 'Steam', path: 'C:\\Demo\\Steam\\steam.exe', running: true, processes: ['C:\\Demo\\Steam\\steam.exe', 'C:\\Demo\\Steam\\bin\\steamwebhelper.exe'], source: '示例', sourceMessage: uiMessage('demo.source'), warnings: [] },
  { id: 'demo-chrome', name: 'Google Chrome', path: 'C:\\Demo\\Chrome\\chrome.exe', running: false, processes: ['C:\\Demo\\Chrome\\chrome.exe'], source: '示例', sourceMessage: uiMessage('demo.source'), warnings: [] },
];
export async function loadSettings(): Promise<Settings> {
  if (desktop) { const loaded = await invoke<Settings>('load_settings'); return { ...defaults, ...loaded, language: normalizeLanguage(loaded.language) }; }
  try { const v = JSON.parse(localStorage.getItem('clash-app-bypass-demo') || 'null'); return v && Array.isArray(v.selected) ? { ...defaults, ...v, language: normalizeLanguage(v.language) } : defaults; } catch { return defaults; }
}
export async function saveSettings(settings: Settings) {
  if (desktop) await invoke('save_settings', { settings });
  else localStorage.setItem('clash-app-bypass-demo', JSON.stringify(settings));
}
export async function scanApps(): Promise<AppEntry[]> { return desktop ? invoke('scan_apps') : examples; }
export async function inspectApp(path: string): Promise<AppEntry> { return invoke('inspect_app', { path }); }
export async function refreshSelected(apps: AppEntry[]): Promise<AppEntry[]> {
  return desktop ? invoke('refresh_selected', { apps }) : apps;
}
export async function diagnoseRouting(configDir: string): Promise<RoutingSnapshot> {
  if (!desktop) throw uiMessage('demo.diagnostics');
  return invoke('diagnose_routing', { configDir });
}
export async function integration(configDir: string): Promise<Integration> {
  return desktop ? invoke('inspect_integration', { configDir }) : { configDir: '', found: false, running: false, managed: false, message: uiMessage('demo.integration'), proxyGroups: ['GLOBAL', '示例代理组'] };
}
export async function normalizeWebsite(input: string): Promise<NormalizedWebsite> {
  if (!desktop) throw uiMessage('demo.normalize');
  return invoke('normalize_website', { input });
}
export async function applyRules(apps: AppEntry[], configDir: string, otherTraffic: Settings['otherTraffic'], proxyGroup: string, websites: string[] = []): Promise<OperationResult> {
  if (!desktop) return { message: uiMessage('demo.apply'), ruleCount: apps.reduce((n, a) => n + a.processes.length, 0) + websites.length };
  return invoke('apply_rules', { apps, configDir, otherTraffic, proxyGroup, websites });
}
export async function removeRules(configDir: string): Promise<OperationResult> {
  return desktop ? invoke('remove_rules', { configDir }) : { message: uiMessage('demo.undo'), ruleCount: 0 };
}

export type { AppIconRequest } from './appIcons';
export async function getAppIcons(requests: AppIconRequest[], refresh = false): Promise<Record<string, string | null>> {
  return desktop ? invoke('get_app_icons', { requests, refresh }) : {};
}
