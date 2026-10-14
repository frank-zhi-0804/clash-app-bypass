export interface RoutingSnapshot {
  checkedAt: string;
  mode: string;
  findProcessMode: string;
  rules: string[];
  domainRules?: string[];
  unidentifiedConnections: number;
  connections: { path: string; direct: boolean; rejected: boolean; unknown?: boolean; rule: string; start: string }[];
}
type SelectedApp = { id: string; processes: string[]; suggestedProcesses?: string[] };
export function diagnoseApp(app: SelectedApp, snapshot: RoutingSnapshot) {
  const key = (path: string) => path.toLowerCase();
  const paths = new Set(app.processes.map(key));
  const rules = new Set(snapshot.rules.map(key));
  const connections = snapshot.connections.filter(c => paths.has(key(c.path)));
  const direct = connections.filter(c => c.direct).length;
  const blocked = connections.filter(c => c.rejected && !c.direct).length;
  const proxied = connections.filter(c => !c.direct && !c.rejected && !c.unknown).length;
  const unknown = connections.filter(c => c.unknown).length;
  const missingPaths = app.processes.filter(p => !rules.has(key(p)));
  const candidates = new Set((app.suggestedProcesses || []).map(key));
  const uncovered = [...new Set(snapshot.connections.filter(c => candidates.has(key(c.path)) && !paths.has(key(c.path)) && !c.direct).map(c => c.path))];
  if (snapshot.mode !== 'rule') return { label: 'diagnostics.status.ruleMode', severity: 'warning' as const, direct, proxied, blocked, missingPaths, uncovered };
  if (missingPaths.length) return { label: 'diagnostics.status.incomplete', severity: 'warning' as const, direct, proxied, blocked, missingPaths, uncovered };
  if (proxied || uncovered.length) return { label: 'diagnostics.status.proxied', severity: 'warning' as const, direct, proxied, blocked, missingPaths, uncovered };
  if (blocked) return { label: 'diagnostics.status.blocked', severity: 'warning' as const, direct, proxied, blocked, missingPaths, uncovered };
  if (unknown) return { label: 'diagnostics.status.unknown', severity: 'warning' as const, direct, proxied, blocked, missingPaths, uncovered };
  if (direct) return { label: 'diagnostics.status.direct', severity: 'success' as const, direct, proxied, blocked, missingPaths, uncovered };
  return { label: 'diagnostics.status.empty', severity: 'info' as const, direct, proxied, blocked, missingPaths, uncovered };
}
