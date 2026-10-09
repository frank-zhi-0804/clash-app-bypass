import test from 'node:test';
import assert from 'node:assert/strict';
import { synchronize } from '../src/automation.ts';
import { routingFingerprint } from '../src/workflow.ts';
const path = 'C:\\Apps\\app.exe';
const base = { selected: [{ id: 'app', name: 'App', path, processes: [path], warnings: [], running: false, source: 'test' }], configDir: '', dark: false, otherTraffic: 'proxy', proxyGroup: 'GLOBAL' };
function fixtures(options = {}) {
  const calls = [];
  let rules = options.rules ?? [];
  const api = { refresh: async apps => apps, integration: async () => ({ found: true, running: options.running ?? true }),
    diagnose: async () => ({ mode: 'rule', rules, connections: [], unidentifiedConnections: 0 }),
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
  const f = fixtures({ running: true }); const settings = { ...base, applied: { revision: 2, fingerprint: routingFingerprint(base), hasRules: true, pendingRestart: false } };
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
