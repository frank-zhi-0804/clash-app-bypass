export interface AppEntry {
  id: string;
  name: string;
  path: string;
  running: boolean;
  processes: string[];
  source: string;
  warnings: string[];
}
export interface Settings { selected: AppEntry[]; configDir: string; dark: boolean; otherTraffic: 'proxy' | 'subscription'; proxyGroup: string; }
export interface Integration {
  configDir: string;
  found: boolean;
  running: boolean;
  managed: boolean;
  message: string;
  proxyGroups: string[];
}
export interface OperationResult { message: string; ruleCount: number; }
