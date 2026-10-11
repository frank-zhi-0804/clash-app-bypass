import test from 'node:test';
import assert from 'node:assert/strict';
import { websiteDomains, websiteRuleStatus } from '../src/websites.ts';
import { routingFingerprint, resumeAfterRoutingChange } from '../src/workflow.ts';
import { synchronize, SynchronizationFailure } from '../src/automation.ts';
const base = (overrides = {}) => ({ selected: [], configDir: 'C:\\Clash', dark: false, otherTraffic: 'subscription', proxyGroup: 'GLOBAL', websites: ['example.com'], ...overrides });
const snapshot = (overrides = {}) => ({ checkedAt: '2026-10-11T00:00:00Z', mode: 'rule', findProcessMode: 'always', rules: [], domainRules: [], connections: [], unidentifiedConnections: 0, ...overrides });
function fixture(overrides = {}) {
  let current = snapshot(overrides);
  const calls = { apply: [], save: [] };
  const services = {
    refresh: async apps => apps,
    integration: async () => ({ found: true, running: true, managed: true, configDir: 'C:\\Clash', message: '', proxyGroups: ['GLOBAL'] }),
    diagnose: async () => current,
    apply: async (apps, configDir, mode, group, websites) => {
      calls.apply.push({ apps, configDir, mode, group, websites: [...websites] });
      current = { ...current, mode: 'rule', domainRules: [...websites], rules: apps.flatMap(app => app.processes) };
      return { message: 'applied', pendingRestart: false, ruleCount: websites.length + current.rules.length };
    },
    save: async value => { calls.save.push(structuredClone(value)); },
  };
  return { calls, services, setSnapshot: value => { current = { ...current, ...value }; } };
}
test('website lists deduplicate without guessing a registrable domain', () => {
  assert.deepEqual(websiteDomains([' Example.COM ', 'example.com', '', 'News.Example.COM']), ['example.com', 'news.example.com']);
  assert.deepEqual(websiteDomains(), []);
});
test('empty website lists preserve the existing application fingerprint', () => {
  const settings = base({ websites: undefined, selected: [{ id: 'app', path: 'C:/Apps/Main.exe', processes: ['c:\\apps\\HELPER.EXE', 'C:\\Apps\\Main.exe'] }] });
  const expected = JSON.stringify({ configDir: 'c:\\clash', mode: 'subscription', group: '', paths: ['c:\\apps\\helper.exe', 'c:\\apps\\main.exe'] });
  assert.equal(routingFingerprint(settings), expected);
  assert.equal(routingFingerprint({ ...settings, websites: [] }), expected);
});
test('website ordering and duplicates do not make routing dirty', () => {
  assert.equal(routingFingerprint(base({ websites: ['Example.ORG', 'example.com', 'example.org'] })), routingFingerprint(base({ websites: ['example.com', 'example.org'] })));
  assert.notEqual(routingFingerprint(base()), routingFingerprint(base({ websites: ['example.org'] })));
});
test('website status requires rule mode and the exact root rule to be loaded', () => {
  assert.equal(websiteRuleStatus('example.com').label, '等待检查');
  assert.equal(websiteRuleStatus('example.com', snapshot({ mode: 'global', domainRules: ['example.com'] })).label, '等待规则模式');
  assert.equal(websiteRuleStatus('example.com', snapshot({ domainRules: ['EXAMPLE.COM'] })).label, '网站规则已加载');
  assert.equal(websiteRuleStatus('example.com', snapshot({ domainRules: ['other.example.com'] })).label, '网站规则尚未加载');
});
test('a website-only selection writes domain rules and saves applied state', async () => {
  const f = fixture(); const result = await synchronize(base(), f.services);
  assert.equal(f.calls.apply.length, 1);
  assert.deepEqual(f.calls.apply[0], { apps: [], configDir: 'C:\\Clash', mode: 'subscription', group: 'GLOBAL', websites: ['example.com'] });
  assert.equal(f.calls.save.length, 1);
  assert.deepEqual(result.settings.websites, ['example.com']);
  assert.equal(result.settings.applied.hasRules, true); assert.equal(result.settings.applied.pendingRestart, false);
});
test('loaded website-only selection does not repair an irrelevant process mode', async () => {
  const f = fixture(); const first = await synchronize(base(), f.services);
  f.setSnapshot({ findProcessMode: 'strict', domainRules: ['EXAMPLE.COM'] });
  await synchronize(first.settings, f.services);
  assert.equal(f.calls.apply.length, 1); assert.equal(f.calls.save.length, 1);
});
test('missing website rules repair a clean fingerprint', async () => {
  const f = fixture(); const first = await synchronize(base({ websites: ['example.com', 'example.org'] }), f.services);
  f.setSnapshot({ domainRules: ['example.com'] }); await synchronize(first.settings, f.services);
  assert.equal(f.calls.apply.length, 2); assert.deepEqual(f.calls.apply[1].websites, ['example.com', 'example.org']);
});
test('read-only synchronization cannot restore missing website rules', async () => {
  const f = fixture(); const first = await synchronize(base(), f.services);
  f.setSnapshot({ domainRules: [] }); await synchronize(first.settings, f.services, { allowWrites: false });
  assert.equal(f.calls.apply.length, 1);
});
test('removing the last website in subscription mode requests removal of managed rules', async () => {
  const f = fixture(); const first = await synchronize(base(), f.services);
  const result = await synchronize(resumeAfterRoutingChange(first.settings, { ...first.settings, websites: [] }), f.services);
  assert.equal(f.calls.apply.length, 2); assert.deepEqual(f.calls.apply[1].websites, []);
  assert.equal(result.settings.applied.hasRules, false); assert.deepEqual(result.settings.websites, []);
});
test('undo stays suspended until website selections change', async () => {
  const f = fixture(); const first = await synchronize(base(), f.services);
  const undone = { ...first.settings, applied: { ...first.settings.applied, hasRules: false } };
  f.setSnapshot({ domainRules: [] }); await synchronize(undone, f.services);
  assert.equal(f.calls.apply.length, 1);
  assert.equal(resumeAfterRoutingChange(undone, { ...undone, websites: ['EXAMPLE.COM'] }).applied.hasRules, false);
  const changed = resumeAfterRoutingChange(undone, { ...undone, websites: ['example.com', 'example.org'] });
  assert.equal(changed.applied, null); await synchronize(changed, f.services);
  assert.equal(f.calls.apply.length, 2); assert.deepEqual(f.calls.apply[1].websites, ['example.com', 'example.org']);
});
test('proxy fallback survives removal of the last website', async () => {
  const f = fixture(); const first = await synchronize(base({ otherTraffic: 'proxy' }), f.services);
  const result = await synchronize({ ...first.settings, websites: [] }, f.services);
  assert.equal(f.calls.apply.length, 2); assert.equal(f.calls.apply[1].mode, 'proxy');
  assert.deepEqual(f.calls.apply[1].websites, []); assert.equal(result.settings.applied.hasRules, true);
});
test('website writes are not repeated when retrying a failed settings save', async () => {
  const f = fixture(); const goodSave = f.services.save;
  f.services.save = async () => { throw Error('disk unavailable'); };
  let failure;
  await assert.rejects(synchronize(base(), f.services), error => { failure = error; return error instanceof SynchronizationFailure; });
  assert.deepEqual(failure.settings.websites, ['example.com']); assert.equal(failure.ruleWriteCompleted, true);
  f.services.save = goodSave;
  const result = await synchronize(failure.settings, f.services, { forceSave: true });
  assert.equal(f.calls.apply.length, 1); assert.equal(f.calls.save.length, 1); assert.equal(result.settings.applied.hasRules, true);
});
