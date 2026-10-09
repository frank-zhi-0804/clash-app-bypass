import { routingFingerprint } from './workflow.ts';
import type { AppEntry, Integration, OperationResult, Settings } from './types.ts';
import type { RoutingSnapshot } from './routingDiagnostics.ts';
export interface AutomationServices {
  refresh(apps: AppEntry[]): Promise<AppEntry[]>;
  integration(dir: string): Promise<Integration>;
  diagnose(dir: string): Promise<RoutingSnapshot>;
  apply(apps: AppEntry[], dir: string, mode: Settings['otherTraffic'], group: string): Promise<OperationResult>;
  save(settings: Settings): Promise<void>;
}
export async function synchronize(settings: Settings, services: AutomationServices) {
  let next = { ...settings, selected: await services.refresh(settings.selected) };
  const integration = await services.integration(next.configDir);
  if (!integration.found) throw new Error(integration.message);
  const missing = next.selected.filter(a => a.pathMissing);
  if (missing.length) throw new Error(`程序路径已失效，请重新选择：${missing.map(a => a.name).join('、')}`);
  const snapshot = integration.running ? await services.diagnose(next.configDir) : undefined;
  const fingerprint = routingFingerprint(next);
  const dirty = fingerprint !== next.applied?.fingerprint;
  const rules = new Set(snapshot?.rules.map(p => p.toLowerCase()));
  const incomplete = snapshot && (snapshot.mode !== 'rule' || next.selected.some(a => a.processes.some(p => !rules.has(p.toLowerCase()))));
  let message = '';
  // Do not enable proxy fallback on a fresh install before the user chooses an app.
  if ((next.selected.length || next.applied?.hasRules) && (dirty || incomplete)) {
    const applied = await services.apply(next.selected, next.configDir, next.otherTraffic, next.proxyGroup);
    next = { ...next, applied: { fingerprint, pendingRestart: applied.pendingRestart ?? !integration.running, hasRules: next.selected.length > 0 || next.otherTraffic === 'proxy' } };
    message = applied.message;
  } else if (snapshot && !incomplete && next.applied?.pendingRestart) {
    next = { ...next, applied: { ...next.applied, pendingRestart: false } };
  }
  if (JSON.stringify(next) !== JSON.stringify(settings)) await services.save(next);
  const diagnostics = message && integration.running ? await services.diagnose(next.configDir) : snapshot;
  return { settings: next, integration, diagnostics, message };
}
