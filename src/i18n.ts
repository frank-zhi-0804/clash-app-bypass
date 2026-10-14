import i18n from 'i18next';
import { initReactI18next, useTranslation } from 'react-i18next';
import zhCN from './locales/zh-CN.ts';
import en from './locales/en.ts';
import backendZh from './locales/backend.zh-CN.json' with { type: 'json' };
import backendEn from './locales/backend.en.json' with { type: 'json' };
import { isUiMessage, normalizeLanguage } from './messages.ts';
import type { DisplayMessage } from './types.ts';
import type { FrontendTranslationKey } from './locales/zh-CN.ts';
export { normalizeLanguage };
void i18n.use(initReactI18next).init({
  resources: { 'zh-CN': { translation: zhCN, backend: backendZh }, en: { translation: en, backend: backendEn } },
  lng: 'zh-CN', fallbackLng: 'zh-CN', supportedLngs: ['zh-CN', 'en'], defaultNS: 'translation',
  keySeparator: false, interpolation: { escapeValue: false }, initAsync: false,
});
export default i18n;
// Messages stay semantic in state and are translated in the current render language.
export function translateMessage(message?: DisplayMessage | null): string {
  if (!message) return '';
  if (typeof message === 'string') return message.trim().startsWith('{') ? String(i18n.t('error.unknown')) : message;
  const values = Object.fromEntries(Object.entries(message.values ?? {}).map(([key, value]) => [key,
    isUiMessage(value) ? translateMessage(value) : Array.isArray(value) ? value.map(item => isUiMessage(item) ? translateMessage(item) : item).join(i18n.language === 'en' ? '; ' : '；') : value,
  ]));
  if (!i18n.exists(message.key, values)) return String(i18n.t('error.unknown'));
  return String(i18n.t(message.key, values));
}
export function useUiTranslation() {
  useTranslation();
  return (key: FrontendTranslationKey, values?: Record<string, unknown>) => String(i18n.t(key, values ?? {}));
}
