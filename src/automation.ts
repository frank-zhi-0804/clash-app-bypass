import { routingFingerprint } from './workflow.ts';
import type { AppEntry, Integration, OperationResult, Settings } from './types.ts';
import type { RoutingSnapshot } from './routingDiagnostics.ts';
import { websiteDomains } from './websites.ts';
export const ROUTING_REVISION = 3;
export type SynchronizationPhase = 'refresh' | 'integration' | 'diagnose' | 'selection' | 'apply' | 'save';
export class SynchronizationFailure extends Error {
  readonly pausesWrites: boolean;
  readonly phase: SynchronizationPhase;
  readonly integration?: Integration;
  readonly settings?: Settings;
  readonly ruleWriteCompleted: boolean;
  constructor(phase: SynchronizationPhase, error: unknown, integration?: Integration, settings?: Settings, ruleWriteCompleted = false) {
    super(error instanceof Error ? error.message : String(error));
    this.name = 'SynchronizationFailure';
    this.phase = phase; this.integration = integration; this.settings = settings;
    this.ruleWriteCompleted = ruleWriteCompleted;
    this.pausesWrites = phase === 'apply' || phase === 'save' || phase === 'selection';
  }
}
export interface SynchronizationOptions {
  allowWrites?: boolean;
  forceSave?: boolean;
  onIntegration?(integration: Integration): void;
}
export function readRetryDelay(attempt: number): number {
  return [2000, 5000, 10000, 30000][Math.min(Math.max(attempt - 1, 0), 3)];
}
export interface AutomationServices {
  refresh(apps: AppEntry[]): Promise<AppEntry[]>;
  integration(dir: string): Promise<Integration>;
  diagnose(dir: string): Promise<RoutingSnapshot>;
  apply(apps: AppEntry[], dir: string, mode: Settings['otherTraffic'], group: string, websites?: string[]): Promise<OperationResult>;
  save(settings: Settings): Promise<void>;
}
export async function synchronize(settings: Settings, services: AutomationServices, options: SynchronizationOptions = {}) {
  let selected: AppEntry[];
  try { selected = await services.refresh(settings.selected); }
  catch (error) { throw new SynchronizationFailure('refresh', error); }
  let next = { ...settings, selected };
  let integration: Integration;
  try { integration = await services.integration(next.configDir); }
  catch (error) { throw new SynchronizationFailure('integration', error); }
  options.onIntegration?.(integration);
  if (!integration.found) throw new SynchronizationFailure('integration', integration.message, integration);
  let snapshot: RoutingSnapshot | undefined;
  try { snapshot = integration.running ? await services.diagnose(next.configDir) : undefined; }
  catch (error) { throw new SynchronizationFailure('diagnose', error, integration); }
  const missing = next.selected.filter(a => a.pathMissing);
  if (options.allowWrites !== false && missing.length) throw new SynchronizationFailure('selection', `程序路径已失效，请重新选择：${missing.map(a => a.name).join('、')}`, integration);
  const fingerprint = routingFingerprint(next);
  const dirty = fingerprint !== next.applied?.fingerprint || next.applied?.revision !== ROUTING_REVISION;
  const websites = websiteDomains(next.websites);
  const rules = new Set(snapshot?.rules.map(p => p.toLowerCase()));
  const domainRules = new Set(snapshot?.domainRules?.map(domain => domain.toLowerCase()));
  const incomplete = snapshot && (snapshot.mode !== 'rule' || (next.selected.length > 0 && snapshot.findProcessMode && snapshot.findProcessMode !== 'always') || next.selected.some(a => a.processes.some(p => !rules.has(p.toLowerCase()))) || websites.some(domain => !domainRules.has(domain)));
  let message = '';
  let ruleWriteCompleted = false;
  const suspended = next.applied?.hasRules === false;
  // Do not enable proxy fallback on a fresh install before the user chooses an app.
  // An explicit undo stays undone even when scanning discovers more helper paths.
  if (options.allowWrites !== false && !suspended && (next.selected.length || websites.length || next.applied?.hasRules) && (dirty || incomplete)) {
    let applied: OperationResult;
    try { applied = await services.apply(next.selected, next.configDir, next.otherTraffic, next.proxyGroup, websites); }
    catch (error) { throw new SynchronizationFailure('apply', error, integration); }
    ruleWriteCompleted = true;
    next = { ...next, applied: { fingerprint, revision: ROUTING_REVISION, pendingRestart: applied.pendingRestart ?? !integration.running, hasRules: next.selected.length > 0 || websites.length > 0 || next.otherTraffic === 'proxy' } };
    message = applied.message;
  } else if (snapshot && next.applied?.pendingRestart && (suspended
    ? !integration.managed && next.selected.every(a => a.processes.every(p => !rules.has(p.toLowerCase()))) && websites.every(domain => !domainRules.has(domain))
    : !incomplete)) {
    next = { ...next, applied: { ...next.applied, pendingRestart: false } };
  }
  if (options.allowWrites !== false && (options.forceSave || JSON.stringify(next) !== JSON.stringify(settings))) {
    try { await services.save(next); }
    catch (error) { throw new SynchronizationFailure('save', error, integration, next, ruleWriteCompleted); }
  }
  let diagnostics = snapshot;
  let diagnosticError = '';
  if (message && integration.running) {
    try { diagnostics = await services.diagnose(next.configDir); }
    catch (error) { diagnostics = undefined; diagnosticError = `规则操作已完成，但连接检查失败：${String(error)}`; }
  }
  return { settings: next, integration, diagnostics, diagnosticError, message };
}
