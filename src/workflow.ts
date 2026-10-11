import type { AppEntry, Integration, Settings } from './types.ts';
import { websiteDomains } from './websites.ts';

// Only routing changes make a selection dirty; theme and app display metadata do not.
export function routingFingerprint(settings: Settings): string {
  const normalize = (path: string) => path.replaceAll('/', '\\').toLowerCase();
  const websites = websiteDomains(settings.websites).sort();
  return JSON.stringify({
    configDir: normalize(settings.configDir),
    mode: settings.otherTraffic,
    group: settings.otherTraffic === 'proxy' ? settings.proxyGroup : '',
    paths: [...new Set(settings.selected.flatMap(app => [app.path, ...app.processes]).map(normalize))].sort(),
    ...(websites.length ? { websites } : {}),
  });
}

export function resumeAfterRoutingChange(previous: Settings, next: Settings): Settings {
  return next.applied?.hasRules === false && routingFingerprint(previous) !== routingFingerprint(next)
    ? { ...next, applied: null } : next;
}

export function settingsAfterConnection(settings: Settings, detected: Integration, draftDir: string, previous?: Integration): Settings {
  const normalize = (path: string) => path.replaceAll('/', '\\').toLowerCase();
  const configDir = draftDir.trim() ? detected.configDir : '';
  const sameLocation = normalize(settings.configDir) === normalize(configDir) || (previous?.found && normalize(previous.configDir) === normalize(detected.configDir));
  const next = { ...settings, configDir, applied: sameLocation || settings.applied?.hasRules === false ? settings.applied : null };
  // A reconnect must never mark previously edited, unwritten selections as applied.
  if (sameLocation && next.applied?.fingerprint === routingFingerprint(settings)) {
    next.applied = { ...next.applied, fingerprint: routingFingerprint(next) };
  }
  return next;
}

export function applicationStatus(settings: Settings, integration?: Integration, desktop = true, checking = false, writesPaused = false) {
  if (!desktop) return { label: '浏览器演示', message: '选择会自动保存；应用操作仅模拟，不修改 Clash。' };
  if (checking && !integration) return { label: '正在自动连接', message: '正在读取已保存的 Clash 配置，无需重新选择目录。' };
  if (writesPaused) return { label: '自动写入已暂停', message: '连接检查会继续；处理提示后重试，或修改分流选择以恢复自动应用。' };
  const applied = settings.applied;
  const dirty = !applied || applied.fingerprint !== routingFingerprint(settings);
  if (applied?.pendingRestart) {
    return { label: '待重启 Clash', message: `${applied.hasRules ? '规则已写入' : '规则已撤销'}，请重新打开 Clash。${dirty ? '还有未应用的选择，需再次应用。' : '重启后可在 Clash 连接页面检查路线。'}` };
  }
  if (applied?.hasRules === false) return { label: '自动应用已暂停', message: '本工具规则已撤销，软件和网站选择仍保留。修改分流选择或点击“立即应用”后恢复自动应用。' };
  if (!integration?.found) return { label: '未连接 Clash', message: '请在设置中连接 Clash 配置目录；软件选择保存在本机。' };
  if (applied?.hasRules && integration.managed && !dirty) return { label: '规则已写入', message: '当前选择已写入规则；请在 Clash 中使用规则模式并检查新连接路线。' };
  if (!applied && integration.managed) return { label: '检测到已有规则', message: '已有本工具规则。重新应用可将规则更新为当前选择，或点击撤销。' };
  return { label: '未应用', message: integration.managed ? '选择已保存，工具会自动更新规则。需要时可点击“立即应用”。' : '选择已保存，工具会自动应用并检查规则。需要时可点击“立即应用”。' };
}

// Keep successful results when another startup task fails, and permit retrying all tasks.
export async function readWorkspace(load: () => Promise<Settings>, scan: () => Promise<AppEntry[]>, inspect: (settings: Settings) => Promise<Integration>, onIntegration?: (result: PromiseSettledResult<Integration>) => void) {
  const settings = await load();
  const detection = Promise.resolve().then(() => inspect(settings)).then(value => {
    onIntegration?.({ status: 'fulfilled', value });
    return value;
  }, reason => {
    onIntegration?.({ status: 'rejected', reason });
    throw reason;
  });
  const [apps, integration] = await Promise.allSettled([Promise.resolve().then(scan), detection]);
  return { settings, apps, integration };
}
