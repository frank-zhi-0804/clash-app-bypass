export interface AppEntry {
  id: string;
  name: string;
  path: string;
  running: boolean;
  processes: string[];
  suggestedProcesses?: string[];
  source: string;
  warnings: string[];
  pathMissing?: boolean;
}
export interface AppliedState { revision?: number; fingerprint: string; pendingRestart: boolean; hasRules: boolean; }
export interface Settings { selected: AppEntry[]; websites?: string[]; configDir: string; dark: boolean; otherTraffic: 'proxy' | 'subscription'; proxyGroup: string; applied?: AppliedState | null; }
export interface NormalizedWebsite { host: string; domain: string; }
export interface Integration {
  configDir: string;
  found: boolean;
  running: boolean;
  managed: boolean;
  message: string;
  proxyGroups: string[];
}
export interface OperationResult { message: string; ruleCount: number; pendingRestart?: boolean; }
