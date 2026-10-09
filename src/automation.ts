import { routingFingerprint } from './workflow.ts';
import type { AppEntry, Integration, OperationResult, Settings } from './types.ts';
import type { RoutingSnapshot } from './routingDiagnostics.ts';
export const ROUTING_REVISION = 3;
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
  const dirty = fingerprint !== next.applied?.fingerprint || next.applied?.revision !== ROUTING_REVISION;
  const rules = new Set(snapshot?.rules.map(p => p.toLowerCase()));
  const incomplete = snapshot && (snapshot.mode !== 'rule' || (snapshot.findProcessMode && snapshot.findProcessMode !== 'always') || next.selected.some(a => a.processes.some(p => !rules.has(p.toLowerCase()))));
  let message = '';
  const suspended = next.applied?.hasRules === false;
  // Do not enable proxy fallback on a fresh install before the user chooses an app.
  // An explicit undo stays undone even when scanning discovers more helper paths.
  if (!suspended && (next.selected.length || next.applied?.hasRules) && (dirty || incomplete)) {
    const applied = await services.apply(next.selected, next.configDir, next.otherTraffic, next.proxyGroup);
    next = { ...next, applied: { fingerprint, revision: ROUTING_REVISION, pendingRestart: applied.pendingRestart ?? !integration.running, hasRules: next.selected.length > 0 || next.otherTraffic === 'proxy' } };
    message = applied.message;
  } else if (snapshot && next.applied?.pendingRestart && (suspended
    ? !integration.managed && next.selected.every(a => a.processes.every(p => !rules.has(p.toLowerCase())))
    : !incomplete)) {
    next = { ...next, applied: { ...next.applied, pendingRestart: false } };
  }
  if (JSON.stringify(next) !== JSON.stringify(settings)) await services.save(next);
  let diagnostics = snapshot;
  let diagnosticError = '';
  if (message && integration.running) {
    try { diagnostics = await services.diagnose(next.configDir); }
    catch (error) { diagnostics = undefined; diagnosticError = `规则操作已完成，但连接检查失败：${String(error)}`; }
  }
  return { settings: next, integration, diagnostics, diagnosticError, message };
}
