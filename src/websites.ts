import type { RoutingSnapshot } from './routingDiagnostics.ts';

// These values have already been normalized by the desktop command.
export function websiteDomains(values: string[] = []): string[] {
  return [...new Set(values.map(value => value.trim().toLowerCase()).filter(Boolean))];
}

export function websiteRuleStatus(domain: string, snapshot?: RoutingSnapshot) {
  if (!snapshot) return { label: '等待检查', severity: 'info' as const };
  if (snapshot.mode !== 'rule') return { label: '等待规则模式', severity: 'warning' as const };
  return snapshot.domainRules?.some(loaded => loaded.toLowerCase() === domain.toLowerCase())
    ? { label: '网站规则已加载', severity: 'success' as const }
    : { label: '网站规则尚未加载', severity: 'warning' as const };
}
