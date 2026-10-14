import type { RoutingSnapshot } from './routingDiagnostics.ts';

// These values have already been normalized by the desktop command.
export function websiteDomains(values: string[] = []): string[] {
  return [...new Set(values.map(value => value.trim().toLowerCase()).filter(Boolean))];
}

export function websiteRuleStatus(domain: string, snapshot?: RoutingSnapshot) {
  if (!snapshot) return { label: 'website.status.waiting', severity: 'info' as const };
  if (snapshot.mode !== 'rule') return { label: 'website.status.ruleMode', severity: 'warning' as const };
  return snapshot.domainRules?.some(loaded => loaded.toLowerCase() === domain.toLowerCase())
    ? { label: 'website.status.loaded', severity: 'success' as const }
    : { label: 'website.status.notLoaded', severity: 'warning' as const };
}
