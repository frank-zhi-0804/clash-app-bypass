import type { DisplayMessage, Language, UiMessage } from './types.ts';
import type { FrontendTranslationKey } from './locales/zh-CN.ts';
export function normalizeLanguage(value: unknown): Language { return value === 'en' ? 'en' : 'zh-CN'; }
export function uiMessage(key: FrontendTranslationKey, values?: Record<string, unknown>): UiMessage { return { key, ...(values ? { values } : {}) }; }
export function isUiMessage(value: unknown): value is UiMessage { return !!value && typeof value === 'object' && typeof (value as UiMessage).key === 'string'; }
export function messageFromError(error: unknown): DisplayMessage {
  if (isUiMessage(error)) return error;
  if (error && typeof error === 'object' && 'uiMessage' in error && isUiMessage(error.uiMessage)) return error.uiMessage;
  return uiMessage('error.unknown');
}
