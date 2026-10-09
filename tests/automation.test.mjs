import test from 'node:test';
import assert from 'node:assert/strict';
import { synchronize, ROUTING_REVISION } from '../src/automation.ts';
import { routingFingerprint } from '../src/workflow.ts';
const path = 'C:\\Apps\\app.exe';
const base = { selected: [{ id: 'app', name: 'App', path, processes: [path], warnings: [], running: false, source: 'test' }], configDir: '', dark: false, otherTraffic: 'proxy', proxyGroup: 'GLOBAL' };
function fixtures(options = {}) {
  const calls = [];
  let rules = options.rules ?? [];
  const api = { refresh: async apps => apps, integration: async () => ({ found: true, running: options.running ?? true, managed: options.managed ?? true }),
    diagnose: async () => ({ mode: options.mode ?? 'rule', findProcessMode: options.findProcessMode ?? 'always', rules, connections: [], unidentifiedConnections: 0 }),
    apply: async apps => { calls.push('apply'); if(options.fail) throw Error('conflict'); rules = apps.flatMap(a => a.processes); return { message: 'applied', pendingRestart: !options.running }; },
    save: async () => calls.push('save') };
  return { api, calls };
}
test('selection changes apply automatically and unchanged healthy rules do not reload', async () => {
  const f = fixtures({ running: true }); const first = await synchronize(base, f.api);
  assert.deepEqual(f.calls, ['apply', 'save']);
  await synchronize(first.settings, f.api); assert.deepEqual(f.calls, ['apply', 'save']);
});
test('missing rules after an external reload trigger repair even with unchanged selections', async () => {
  const f = fixtures({ running: true }); const settings = { ...base, applied: { revision: ROUTING_REVISION, fingerprint: routingFingerprint(base), hasRules: true, pendingRestart: false } };
  await synchronize(settings, f.api); assert.equal(f.calls[0], 'apply');
});
test('offline apply reports pending startup and fresh empty installs remain untouched', async () => {
  const f = fixtures({ running: false }); assert.equal((await synchronize(base, f.api)).settings.applied.pendingRestart, true);
  const empty = fixtures(); await synchronize({ ...base, selected: [] }, empty.api); assert.deepEqual(empty.calls, []);
});
test('failed apply never saves a success state', async () => {
  const f = fixtures({ fail: true }); await assert.rejects(synchronize(base, f.api), /conflict/); assert.deepEqual(f.calls, ['apply']);
});

test("upgraded routing is applied once even when all previous paths are loaded", async () => {
  const f = fixtures({ running: true, rules: [path] });
  const settings = { ...base, applied: { fingerprint: routingFingerprint(base), hasRules: true, pendingRestart: false } };
  const upgraded = await synchronize(settings, f.api);
  await synchronize(upgraded.settings, f.api);
  assert.deepEqual(f.calls, ["apply", "save"]);
});

test("explicit undo remains undone until selections change", async () => {
  const f = fixtures({ running: true });
  await synchronize({ ...base, applied: { revision: 2, fingerprint: routingFingerprint(base), hasRules: false, pendingRestart: false } }, f.api);
  assert.deepEqual(f.calls, []);
});

test('undo stays suspended through revision upgrades and automatic helper discovery', async () => {
  const f = fixtures({ running: true });
  const helper = 'C:\\Apps\\helper.exe';
  f.api.refresh = async apps => apps.map(app => ({ ...app, processes: [...app.processes, helper] }));
  const undone = { ...base, applied: { revision: 1, fingerprint: routingFingerprint(base), hasRules: false, pendingRestart: false } };
  const result = await synchronize(undone, f.api);
  assert.deepEqual(f.calls, ['save']);
  assert.equal(result.settings.applied.hasRules, false);
  assert.deepEqual(result.settings.selected[0].processes, [path, helper]);
});

test('disabled process identification is repaired despite loaded path rules', async () => {
  const f = fixtures({ running: true, rules: [path], findProcessMode: 'off' });
  const healthySelection = { ...base, applied: { revision: ROUTING_REVISION, fingerprint: routingFingerprint(base), hasRules: true, pendingRestart: false } };
  await synchronize(healthySelection, f.api);
  assert.deepEqual(f.calls, ['apply', 'save']);
});

test('a connection check failure after a successful write preserves the applied result', async () => {
  const f = fixtures({ running: true });
  let reads = 0;
  const diagnose = f.api.diagnose;
  f.api.diagnose = async () => { if (++reads === 2) throw Error('controller temporarily unavailable'); return diagnose(); };
  const result = await synchronize(base, f.api);
  assert.deepEqual(f.calls, ['apply', 'save']);
  assert.equal(result.settings.applied.hasRules, true);
  assert.equal(result.message, 'applied');
  assert.equal(result.diagnostics, undefined);
  assert.match(result.diagnosticError, /规则操作已完成.*temporarily unavailable/);
});

test('pending removal clears only after previously owned path rules are absent', async () => {
  const undone = { ...base, applied: { revision: ROUTING_REVISION, fingerprint: routingFingerprint(base), hasRules: false, pendingRestart: true } };
  const stale = fixtures({ running: true, managed: false, rules: [path] });
  assert.equal((await synchronize(undone, stale.api)).settings.applied.pendingRestart, true);
  assert.deepEqual(stale.calls, []);
  const restarted = fixtures({ running: true, managed: false });
  assert.equal((await synchronize(undone, restarted.api)).settings.applied.pendingRestart, false);
  assert.deepEqual(restarted.calls, ['save']);
});

test('pending written rules clear after loaded-rule verification without another write', async () => {
  const written = { ...base, applied: { revision: ROUTING_REVISION, fingerprint: routingFingerprint(base), hasRules: true, pendingRestart: true } };
  const f = fixtures({ running: true, rules: [path] });
  assert.equal((await synchronize(written, f.api)).settings.applied.pendingRestart, false);
  assert.deepEqual(f.calls, ['save']);
});
