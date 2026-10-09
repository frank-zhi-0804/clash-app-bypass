import test from 'node:test';
import assert from 'node:assert/strict';
import { applicationStatus, readWorkspace, routingFingerprint } from '../src/workflow.ts';

const app = { id: 'steam', name: 'Steam', path: 'C:\\Steam\\steam.exe', processes: ['C:\\Steam\\steam.exe', 'C:\\Steam\\helper.exe'], running: false, source: 'test', warnings: [] };
const settings = { selected: [app], configDir: 'C:\\Clash', dark: false, otherTraffic: 'proxy', proxyGroup: 'GLOBAL' };
const integration = { found: true, managed: true, running: false, configDir: 'C:\\Clash', proxyGroups: ['GLOBAL'], message: '' };

test('startup preserves settings and Clash detection when scanning fails, then retries successfully', async () => {
  let attempts = 0;
  const scan = async () => { if (++attempts === 1) throw new Error('scanner temporarily unavailable'); return [app]; };
  const first = await readWorkspace(async () => settings, scan, async () => integration);
  assert.equal(first.settings, settings);
  assert.equal(first.apps.status, 'rejected');
  assert.equal(first.integration.status, 'fulfilled');
  const retry = await readWorkspace(async () => settings, scan, async () => integration);
  assert.equal(retry.apps.status, 'fulfilled');
  assert.deepEqual(retry.apps.value, [app]);
});

test('a failed Clash detection does not discard a successful scan', async () => {
  const result = await readWorkspace(async () => settings, async () => [app], async () => { throw new Error('detection failed'); });
  assert.equal(result.apps.status, 'fulfilled');
  assert.equal(result.integration.status, 'rejected');
});

test('a failed settings load is surfaced without silently using defaults', async () => {
  let scanned = false;
  await assert.rejects(readWorkspace(async () => { throw new Error('invalid settings'); }, async () => { scanned = true; return []; }, async () => integration), /invalid settings/);
  assert.equal(scanned, false);
});

test('theme, app labels, path case, and process ordering do not mark routing dirty', () => {
  const equivalent = { ...settings, dark: true, configDir: 'c:/clash', selected: [{ ...app, name: 'New display name', path: app.path.toUpperCase(), processes: [...app.processes].reverse() }] };
  assert.equal(routingFingerprint(equivalent), routingFingerprint(settings));
  assert.notEqual(routingFingerprint({ ...settings, selected: [{ ...app, processes: [app.path] }] }), routingFingerprint(settings));
  assert.notEqual(routingFingerprint({ ...settings, proxyGroup: 'Proxy' }), routingFingerprint(settings));
});

test('status distinguishes saved choices, pending restart, written rules, edits, and undo', () => {
  assert.equal(applicationStatus(settings, { ...integration, managed: false }).label, '未应用');
  assert.equal(applicationStatus(settings, integration).label, '检测到已有规则');
  const written = { ...settings, applied: { fingerprint: routingFingerprint(settings), hasRules: true, pendingRestart: true } };
  assert.equal(applicationStatus(written, integration).label, '待重启 Clash');
  const restarted = { ...written, applied: { ...written.applied, pendingRestart: false } };
  assert.equal(applicationStatus(restarted, { ...integration, running: true }).label, '规则已写入');
  assert.equal(applicationStatus({ ...restarted, selected: [] }, integration).label, '未应用');
  assert.equal(applicationStatus({ ...restarted, dark: true }, integration).label, '规则已写入');
  const removed = { ...written, applied: { ...written.applied, hasRules: false } };
  assert.match(applicationStatus(removed, { ...integration, managed: false }).message, /规则已撤销/);
  assert.equal(applicationStatus({ ...removed, applied: { ...removed.applied, pendingRestart: false } }, { ...integration, managed: false }).label, '未应用');
  assert.equal(applicationStatus(written, integration, false).label, '浏览器演示');
});
