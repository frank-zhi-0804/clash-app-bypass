export type Language = 'zh-CN' | 'en';
export interface UiMessage { key: string; values?: Record<string, unknown>; }
export type DisplayMessage = UiMessage | string;
export interface AppEntry {
  id: string;
  name: string;
  path: string;
  running: boolean;
  processes: string[];
  suggestedProcesses?: string[];
  source: string;
  warnings: string[];
  sourceMessage?: UiMessage;
  warningMessages?: UiMessage[];
  pathMissing?: boolean;
  iconShortcut?: string;
}
export interface AppliedState { revision?: number; fingerprint: string; pendingRestart: boolean; hasRules: boolean; }
export interface Settings { selected: AppEntry[]; websites?: string[]; language?: Language; configDir: string; dark: boolean; otherTraffic: 'proxy' | 'subscription'; proxyGroup: string; applied?: AppliedState | null; }
export interface NormalizedWebsite { host: string; domain: string; }
export interface Integration {
  configDir: string;
  found: boolean;
  running: boolean;
  managed: boolean;
  message: DisplayMessage;
  proxyGroups: string[];
}
export interface OperationResult { message: DisplayMessage; ruleCount: number; pendingRestart?: boolean; }
