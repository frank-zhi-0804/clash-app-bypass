import test from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import i18n, { normalizeLanguage, translateMessage } from '../src/i18n.ts';
import { messageFromError, uiMessage } from '../src/messages.ts';
import zhCN from '../src/locales/zh-CN.ts';
import en from '../src/locales/en.ts';
import { resumeAfterRoutingChange, routingFingerprint } from '../src/workflow.ts';

const backendZh = JSON.parse(readFileSync(new URL('../src/locales/backend.zh-CN.json', import.meta.url), 'utf8'));
const backendEn = JSON.parse(readFileSync(new URL('../src/locales/backend.en.json', import.meta.url), 'utf8'));
const placeholders = text => [...text.matchAll(/{{-?\s*([\w.]+)(?:\s*,[^}]*)?\s*}}/g)].map(match => match[1]).sort();
const app = { id: 'editor', name: 'My Editor', path: 'C:\\Apps\\editor.exe', processes: ['C:\\Apps\\editor.exe'], running: false, source: 'test', warnings: [] };
const settings = { selected: [app], websites: ['example.com'], configDir: 'C:\\Clash', dark: false, otherTraffic: 'subscription', proxyGroup: 'GLOBAL' };

test('language changes preserve the routing fingerprint and all routing choices', () => {
  const english = { ...settings, language: 'en' };
  const chinese = { ...settings, language: 'zh-CN' };
  assert.equal(routingFingerprint(english), routingFingerprint(settings));
  assert.equal(routingFingerprint(chinese), routingFingerprint(english));
  assert.equal(english.selected, settings.selected);
  assert.equal(english.websites, settings.websites);
});

test('switching language keeps explicit undo suspended and pending restart intact', () => {
  const undone = { ...settings, applied: { fingerprint: routingFingerprint(settings), revision: 3, hasRules: false, pendingRestart: false } };
  const english = { ...undone, language: 'en' };
  const next = resumeAfterRoutingChange(undone, english);
  assert.equal(next, english);
  assert.equal(next.applied, undone.applied);
  assert.equal(next.applied.hasRules, false);
  const waiting = { ...settings, applied: { ...undone.applied, hasRules: true, pendingRestart: true } };
  assert.equal(resumeAfterRoutingChange(waiting, { ...waiting, language: 'en' }).applied, waiting.applied);
});

test('missing, old, or unsupported language values default to Chinese', () => {
  for (const value of [undefined, null, '', 'en-US', 'fr', 'unknown', 1, {}, ['en']]) assert.equal(normalizeLanguage(value), 'zh-CN');
  assert.equal(normalizeLanguage('zh-CN'), 'zh-CN');
  assert.equal(normalizeLanguage('en'), 'en');
});

test('both language catalogues contain identical keys and interpolation contracts', () => {
  for (const [namespace, chinese, english] of [['translation', zhCN, en], ['backend', backendZh, backendEn]]) {
    assert.deepEqual(Object.keys(english).sort(), Object.keys(chinese).sort(), `${namespace}: missing or extra translation keys`);
    for (const [key, value] of Object.entries(chinese)) {
      assert.equal(typeof value, 'string', `${namespace}:${key}`);
      assert.ok(value.trim(), `${namespace}:${key}: empty Chinese text`);
      assert.equal(typeof english[key], 'string', `${namespace}:${key}`);
      assert.ok(english[key].trim(), `${namespace}:${key}: empty English text`);
      assert.deepEqual(placeholders(english[key]), placeholders(value), `${namespace}:${key}: interpolation parameters differ`);
      assert.doesNotMatch(english[key], /[\u3400-\u9fff]/, `${namespace}:${key}: untranslated Chinese UI text`);
    }
  }
});

test('every catalogue entry resolves within its requested locale without raw keys or placeholders', async () => {
  try {
    for (const [language, frontend, backend] of [['zh-CN', zhCN, backendZh], ['en', en, backendEn]]) {
      await i18n.changeLanguage(language);
      for (const [namespace, catalogue] of [['translation', frontend], ['backend', backend]]) {
        const loaded = i18n.getResourceBundle(language, namespace);
        for (const [key, text] of Object.entries(catalogue)) {
          assert.equal(loaded[key], text, `${language}/${namespace}:${key}: missing local resource, fallback would hide it`);
          const values = Object.fromEntries(placeholders(text).map(name => [name, name === 'count' ? 2 : 'sample']));
          const qualified = namespace === 'translation' ? key : `backend:${key}`;
          const rendered = String(i18n.t(qualified, values));
          assert.notEqual(rendered, qualified, `${language}/${qualified}: unresolved key`);
          assert.doesNotMatch(rendered, /{{[^}]*}}/, `${language}/${qualified}: unresolved interpolation`);
        }
      }
    }
  } finally { await i18n.changeLanguage('zh-CN'); }
});

test('English count messages select singular for one and plural for zero or many', async () => {
  try {
    await i18n.changeLanguage('en');
    for (const [namespace, catalogue] of [['translation', en], ['backend', backendEn]]) {
      for (const key of Object.keys(catalogue).filter(key => key.endsWith('_one'))) {
        const base = key.slice(0, -4);
        const qualified = namespace === 'translation' ? base : `backend:${base}`;
        assert.ok(catalogue[`${base}_other`], `${qualified}: missing plural counterpart`);
        for (const count of [0, 1, 2]) {
          const expected = catalogue[`${base}_${count === 1 ? 'one' : 'other'}`].replaceAll('{{count}}', String(count));
          assert.equal(String(i18n.t(qualified, { count })), expected, `${qualified}/${count}`);
          assert.equal(translateMessage({ key: qualified, values: { count } }), expected, `${qualified}/${count}: descriptor must also support plurals`);
        }
      }
    }
  } finally { await i18n.changeLanguage('zh-CN'); }
});

test('stored, nested, and delayed messages render in the current language', async () => {
  const message = uiMessage('error.detect', { error: { key: 'backend:live.conflict' } });
  const multiple = uiMessage('error.multiple', { errors: [message, uiMessage('error.save', { error: uiMessage('error.unknown') })] });
  const original = structuredClone(multiple);
  try {
    await i18n.changeLanguage('zh-CN');
    assert.match(translateMessage(multiple), /检测暂时失败/);
    let finish;
    const pending = new Promise(resolve => { finish = resolve; });
    await i18n.changeLanguage('en');
    finish(message);
    const rendered = translateMessage(await pending);
    assert.match(rendered, /Clash detection/);
    assert.match(rendered, /Active rules/);
    assert.doesNotMatch(rendered, /[\u3400-\u9fff]|\[object Object\]|backend:live\.conflict/);
    const joined = translateMessage(multiple);
    assert.match(joined, /; /);
    assert.doesNotMatch(joined, /[\u3400-\u9fff]|\[object Object\]/);
    assert.deepEqual(multiple, original, 'rendering must not mutate stored descriptors');
  } finally { await i18n.changeLanguage('zh-CN'); }
});

test('unknown errors and legacy JSON payloads use a localized fallback without leaking raw objects', async () => {
  const secret = 'sensitive-controller-detail';
  try {
    for (const language of ['zh-CN', 'en']) {
      await i18n.changeLanguage(language);
      const fallback = String(i18n.t('error.unknown'));
      for (const error of [new Error(secret), { detail: secret }, { key: 'backend:future.missing', values: { detail: secret } }]) {
        const rendered = translateMessage(messageFromError(error));
        assert.equal(rendered, fallback);
        assert.doesNotMatch(rendered, /sensitive-controller-detail|\[object Object\]|future\.missing/);
      }
      assert.equal(translateMessage(`  {"key":"backend:future.missing","values":{"detail":"${secret}"}}`), fallback);
    }
  } finally { await i18n.changeLanguage('zh-CN'); }
});

test('controlled native error detail is literal text under a localized technical summary', async () => {
  const detail = 'Access denied <img src=x onerror=alert(1)>';
  const message = { key: 'backend:technical', values: { detail } };
  try {
    await i18n.changeLanguage('en');
    const rendered = translateMessage(message);
    assert.match(rendered, /^The operation failed:/);
    assert.ok(rendered.includes(detail));
    assert.doesNotMatch(rendered, /backend:technical|\[object Object\]|{{detail}}/);
  } finally { await i18n.changeLanguage('zh-CN'); }
});
test('icon metadata changes preserve routing state', () => {
  const withIcon = { ...settings, selected: settings.selected.map(app => ({ ...app, iconShortcut: "C:/Users/User/Desktop/Game.lnk" })) };
  assert.equal(routingFingerprint(withIcon), routingFingerprint(settings));
});
