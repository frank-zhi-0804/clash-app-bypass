import { uiMessage } from './messages.ts';
import type { FrontendMessageKey } from './locales/zh-CN.ts';
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
  const status = (label: FrontendMessageKey, message: FrontendMessageKey) => ({ label, message: uiMessage(message) });
  if (!desktop) return status('status.demo.label', 'status.demo.message');
  if (checking && !integration) return status('status.connecting.label', 'status.connecting.message');
  if (writesPaused) return status('status.writePaused.label', 'status.writePaused.message');
  const applied = settings.applied;
  const dirty = !applied || applied.fingerprint !== routingFingerprint(settings);
  if (applied?.pendingRestart) return status('status.restart.label', applied.hasRules ? dirty ? 'status.restart.writtenDirty' : 'status.restart.written' : dirty ? 'status.restart.removedDirty' : 'status.restart.removed');
  if (applied?.hasRules === false) return status('status.undone.label', 'status.undone.message');
  if (!integration?.found) return status('status.disconnected.label', 'status.disconnected.message');
  if (applied?.hasRules && integration.managed && !dirty) return status('status.written.label', 'status.written.message');
  if (!applied && integration.managed) return status('status.existing.label', 'status.existing.message');
  return status('status.unapplied.label', integration.managed ? 'status.unapplied.update' : 'status.unapplied.apply');
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
