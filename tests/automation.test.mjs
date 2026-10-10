import test from 'node:test';
import assert from 'node:assert/strict';
import { synchronize, SynchronizationFailure, readRetryDelay, ROUTING_REVISION } from '../src/automation.ts';
import { routingFingerprint, settingsAfterConnection } from '../src/workflow.ts';
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

test('temporary diagnostics retain the detected integration and recover without writing', async () => {
  const f = fixtures({ running: true, rules: [path] });
  const healthy = { ...base, applied: { revision: ROUTING_REVISION, fingerprint: routingFingerprint(base), hasRules: true, pendingRestart: false } };
  let reads = 0; let detected;
  const diagnose = f.api.diagnose;
  f.api.diagnose = async () => { if (++reads === 1) throw Error('temporary pipe failure'); return diagnose(); };
  await assert.rejects(synchronize(healthy, f.api, { onIntegration: value => { detected = value; } }), error => {
    assert.ok(error instanceof SynchronizationFailure);
    assert.equal(error.phase, 'diagnose'); assert.equal(error.pausesWrites, false);
    assert.equal(error.integration, detected); assert.equal(detected.found, true);
    return true;
  });
  const recovered = await synchronize(healthy, f.api);
  assert.equal(recovered.integration.found, true);
  assert.equal(recovered.diagnosticError, '');
  assert.deepEqual(f.calls, []);
});

test('a write conflict stops writes while subsequent checks and helper discovery continue', async () => {
  const f = fixtures({ running: true, fail: true });
  await assert.rejects(synchronize(base, f.api), error => error.phase === 'apply' && error.pausesWrites);
  f.api.refresh = async apps => apps.map(app => ({ ...app, processes: [app.path, 'C:\\Apps\\new-helper.exe'] }));
  let reads = 0; const diagnose = f.api.diagnose;
  f.api.diagnose = async () => { ++reads; return diagnose(); };
  for (let i = 0; i < 3; i++) await synchronize(base, f.api, { allowWrites: false });
  assert.equal(reads, 3);
  assert.deepEqual(f.calls, ['apply']);
});

test('a save failure preserves the completed application and retry saves without applying again', async () => {
  const f = fixtures({ running: true });
  const save = f.api.save; let attempts = 0; let completed;
  f.api.save = async settings => { if (++attempts === 1) throw Error('settings unavailable'); return save(settings); };
  await assert.rejects(synchronize(base, f.api), error => {
    assert.equal(error.phase, 'save'); assert.equal(error.pausesWrites, true);
    assert.equal(error.ruleWriteCompleted, true);
    completed = error.settings; assert.equal(completed.applied.hasRules, true);
    return true;
  });
  await synchronize(completed, f.api, { allowWrites: false });
  await synchronize(completed, f.api, { forceSave: true });
  assert.deepEqual(f.calls, ['apply', 'save']);
});

test('resolved directories preserve the empty automatic-detection setting and undo', async () => {
  const f = fixtures({ running: true });
  f.api.integration = async () => ({ found: true, running: true, managed: false, configDir: 'C:\\Users\\Local\\Clash' });
  const undone = { ...base, applied: { revision: 1, fingerprint: routingFingerprint(base), hasRules: false, pendingRestart: false } };
  const result = await synchronize(undone, f.api);
  assert.equal(result.settings.configDir, '');
  assert.equal(result.integration.configDir, 'C:\\Users\\Local\\Clash');
  assert.equal(result.settings.applied.hasRules, false);
  assert.deepEqual(f.calls, []);
});

test('missing selected paths do not prevent health reads once writes are paused', async () => {
  const f = fixtures({ running: true }); let reads = 0;
  f.api.refresh = async apps => apps.map(app => ({ ...app, pathMissing: true }));
  const diagnose = f.api.diagnose; f.api.diagnose = async () => { ++reads; return diagnose(); };
  await assert.rejects(synchronize(base, f.api), error => error.phase === 'selection' && error.pausesWrites);
  await synchronize(base, f.api, { allowWrites: false });
  assert.equal(reads, 2); assert.deepEqual(f.calls, []);
});

test('read retries back off promptly and remain bounded at thirty seconds', () => {
  assert.deepEqual([1, 2, 3, 4, 5, 50].map(readRetryDelay), [2000, 5000, 10000, 30000, 30000, 30000]);
});

test('offline reconnect does not lose a pending selection change', async () => {
  const f = fixtures({ running: false });
  const written = { ...base, applied: { revision: ROUTING_REVISION, fingerprint: routingFingerprint(base), hasRules: true, pendingRestart: false } };
  const edited = { ...written, selected: [{ ...base.selected[0], processes: [path, 'C:\\Apps\\new-helper.exe'] }] };
  const detected = { found: true, running: false, managed: true, configDir: 'C:\\Clash', proxyGroups: [] };
  const reconnected = settingsAfterConnection(edited, detected, 'C:\\Clash', detected);
  const result = await synchronize(reconnected, f.api);
  assert.deepEqual(f.calls, ['apply', 'save']);
  assert.equal(result.settings.applied.pendingRestart, true);
});

test('metadata save failures do not claim a rule write completed', async () => {
  const f = fixtures({ running: true, rules: [path] });
  const healthy = { ...base, applied: { revision: ROUTING_REVISION, fingerprint: routingFingerprint(base), hasRules: true, pendingRestart: false } };
  f.api.refresh = async apps => apps.map(app => ({ ...app, name: 'Updated display name' }));
  f.api.save = async () => { throw Error('settings unavailable'); };
  await assert.rejects(synchronize(healthy, f.api), error => error.phase === 'save' && error.ruleWriteCompleted === false);
  assert.deepEqual(f.calls, []);
});
