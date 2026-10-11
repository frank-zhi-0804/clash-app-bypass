import { invoke, isTauri } from '@tauri-apps/api/core';
import type { AppEntry, Integration, Settings, OperationResult, NormalizedWebsite } from './types';
import type { RoutingSnapshot } from './routingDiagnostics';
export const desktop = isTauri();
const defaults: Settings = { selected: [], websites: [], configDir: '', dark: false, otherTraffic: 'proxy', proxyGroup: 'GLOBAL' };
const examples: AppEntry[] = [
  { id: 'demo-wechat', name: '微信', path: 'C:\\Demo\\WeChat\\WeChat.exe', running: true, processes: ['C:\\Demo\\WeChat\\WeChat.exe', 'C:\\Demo\\WeChat\\WeChatAppEx.exe'], source: '示例', warnings: [] },
  { id: 'demo-steam', name: 'Steam', path: 'C:\\Demo\\Steam\\steam.exe', running: true, processes: ['C:\\Demo\\Steam\\steam.exe', 'C:\\Demo\\Steam\\bin\\steamwebhelper.exe'], source: '示例', warnings: [] },
  { id: 'demo-chrome', name: 'Google Chrome', path: 'C:\\Demo\\Chrome\\chrome.exe', running: false, processes: ['C:\\Demo\\Chrome\\chrome.exe'], source: '示例', warnings: [] },
];
export async function loadSettings(): Promise<Settings> {
  if (desktop) return { ...defaults, ...await invoke<Settings>('load_settings') };
  try { const v = JSON.parse(localStorage.getItem('clash-app-bypass-demo') || 'null'); return v && Array.isArray(v.selected) ? { ...defaults, ...v } : defaults; } catch { return defaults; }
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
  if (!desktop) throw new Error('实际连接检查仅在桌面版中可用');
  return invoke('diagnose_routing', { configDir });
}
export async function integration(configDir: string): Promise<Integration> {
  return desktop ? invoke('inspect_integration', { configDir }) : { configDir: '', found: false, running: false, managed: false, message: '浏览器演示，未连接 Clash', proxyGroups: ['GLOBAL', '示例代理组'] };
}
export async function normalizeWebsite(input: string): Promise<NormalizedWebsite> {
  if (!desktop) throw new Error('请使用桌面版整理网站网址');
  return invoke('normalize_website', { input });
}
export async function applyRules(apps: AppEntry[], configDir: string, otherTraffic: Settings['otherTraffic'], proxyGroup: string, websites: string[] = []): Promise<OperationResult> {
  if (!desktop) return { message: '已模拟应用，未修改 Clash 配置', ruleCount: apps.reduce((n, a) => n + a.processes.length, 0) + websites.length };
  return invoke('apply_rules', { apps, configDir, otherTraffic, proxyGroup, websites });
}
export async function removeRules(configDir: string): Promise<OperationResult> {
  return desktop ? invoke('remove_rules', { configDir }) : { message: '已模拟撤销，未修改 Clash 配置', ruleCount: 0 };
}
