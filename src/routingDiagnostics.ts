export interface RoutingSnapshot {
  checkedAt: string;
  mode: string;
  findProcessMode: string;
  rules: string[];
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
  if (snapshot.mode !== 'rule') return { label: '请切换规则模式', severity: 'warning' as const, direct, proxied, blocked, missingPaths, uncovered };
  if (missingPaths.length) return { label: '直连规则未完整加载', severity: 'warning' as const, direct, proxied, blocked, missingPaths, uncovered };
  if (proxied || uncovered.length) return { label: '仍有连接使用代理', severity: 'warning' as const, direct, proxied, blocked, missingPaths, uncovered };
  if (blocked) return { label: '部分连接被拒绝', severity: 'warning' as const, direct, proxied, blocked, missingPaths, uncovered };
  if (unknown) return { label: '部分连接路线无法确认', severity: 'warning' as const, direct, proxied, blocked, missingPaths, uncovered };
  if (direct) return { label: '已观察到直连', severity: 'success' as const, direct, proxied, blocked, missingPaths, uncovered };
  return { label: '暂无可验证连接', severity: 'info' as const, direct, proxied, blocked, missingPaths, uncovered };
}
