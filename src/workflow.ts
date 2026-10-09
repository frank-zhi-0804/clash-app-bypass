import type { AppEntry, Integration, Settings } from './types.ts';

// Only routing changes make a selection dirty; theme and app display metadata do not.
export function routingFingerprint(settings: Settings): string {
  const normalize = (path: string) => path.replaceAll('/', '\\').toLowerCase();
  return JSON.stringify({
    configDir: normalize(settings.configDir),
    mode: settings.otherTraffic,
    group: settings.otherTraffic === 'proxy' ? settings.proxyGroup : '',
    paths: [...new Set(settings.selected.flatMap(app => [app.path, ...app.processes]).map(normalize))].sort(),
  });
}

export function applicationStatus(settings: Settings, integration?: Integration, desktop = true) {
  if (!desktop) return { label: '浏览器演示', message: '选择会自动保存；应用操作仅模拟，不修改 Clash。' };
  const applied = settings.applied;
  const dirty = !applied || applied.fingerprint !== routingFingerprint(settings);
  if (applied?.pendingRestart) {
    return { label: '待重启 Clash', message: `${applied.hasRules ? '规则已写入' : '规则已撤销'}，请重新打开 Clash。${dirty ? '还有未应用的选择，需再次应用。' : '重启后可在 Clash 连接页面检查路线。'}` };
  }
  if (!integration?.found) return { label: '未连接 Clash', message: '请在设置中连接 Clash 配置目录；软件选择保存在本机。' };
  if (applied?.hasRules && integration.managed && !dirty) return { label: '规则已写入', message: '当前选择已写入规则；请在 Clash 中使用规则模式并检查新连接路线。' };
  if (!applied && integration.managed) return { label: '检测到已有规则', message: '已有本工具规则。重新应用可将规则更新为当前选择，或点击撤销。' };
  return { label: '未应用', message: integration.managed ? '选择已保存，点击“应用到 Clash”更新现有规则。' : '选择已保存，点击“应用到 Clash”后才会写入规则。' };
}

// Keep successful results when another startup task fails, and permit retrying all tasks.
export async function readWorkspace(load: () => Promise<Settings>, scan: () => Promise<AppEntry[]>, inspect: (settings: Settings) => Promise<Integration>) {
  const settings = await load();
  const [apps, integration] = await Promise.allSettled([scan(), inspect(settings)]);
  return { settings, apps, integration };
}
