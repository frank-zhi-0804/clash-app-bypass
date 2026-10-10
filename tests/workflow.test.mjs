import test from 'node:test';
import assert from 'node:assert/strict';
import { applicationStatus, readWorkspace, resumeAfterRoutingChange, routingFingerprint, settingsAfterConnection } from '../src/workflow.ts';

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
  assert.equal(applicationStatus({ ...removed, applied: { ...removed.applied, pendingRestart: false } }, { ...integration, managed: false }).label, '自动应用已暂停');
  assert.equal(applicationStatus(written, integration, false).label, '浏览器演示');
});

test('only a user routing change resumes automatic application after undo', () => {
  const undone = { ...settings, applied: { fingerprint: routingFingerprint(settings), hasRules: false, pendingRestart: false } };
  const themeChange = { ...undone, dark: true };
  assert.equal(resumeAfterRoutingChange(undone, themeChange), themeChange);
  const labelChange = { ...undone, selected: [{ ...app, name: 'Display name' }] };
  assert.equal(resumeAfterRoutingChange(undone, labelChange), labelChange);
  const selectionChange = { ...undone, selected: [] };
  assert.equal(resumeAfterRoutingChange(undone, selectionChange).applied, null);
  const fallbackChange = { ...undone, otherTraffic: 'subscription' };
  assert.equal(resumeAfterRoutingChange(undone, fallbackChange).applied, null);
});

test('integration is published before a slow software scan finishes', async () => {
  let finishScan; let connected; let finished = false;
  const scanPending = new Promise(resolve => { finishScan = resolve; });
  const detected = new Promise(resolve => { connected = resolve; });
  const workspace = readWorkspace(async () => settings, () => scanPending, async () => integration, connected).then(result => { finished = true; return result; });
  const early = await detected;
  assert.equal(early.status, 'fulfilled'); assert.equal(early.value, integration);
  assert.equal(finished, false);
  finishScan([app]);
  assert.equal((await workspace).apps.status, 'fulfilled');
});

test('connection discovery and write suspension have distinct status messages', () => {
  assert.equal(applicationStatus(settings, undefined, true, true).label, '正在自动连接');
  assert.equal(applicationStatus(settings, integration, true, false, true).label, '自动写入已暂停');
  assert.equal(applicationStatus(settings, { ...integration, managed: false }, true, false).label, '未应用');
});

test('reconnecting keeps automatic directories empty, undo intact, and dirty selections dirty', () => {
  const automatic = { ...settings, configDir: '' };
  const written = { ...automatic, applied: { fingerprint: routingFingerprint(automatic), hasRules: true, pendingRestart: false } };
  const reconnected = settingsAfterConnection(written, integration, '', integration);
  assert.equal(reconnected.configDir, '');
  assert.equal(reconnected.applied.fingerprint, routingFingerprint(written));
  const edited = { ...written, selected: [{ ...app, processes: [...app.processes, 'C:\\Steam\\new.exe'] }] };
  const changedRepresentation = settingsAfterConnection(edited, integration, integration.configDir, integration);
  assert.equal(changedRepresentation.applied.fingerprint, written.applied.fingerprint);
  assert.notEqual(changedRepresentation.applied.fingerprint, routingFingerprint(changedRepresentation));
  const undone = { ...written, applied: { ...written.applied, hasRules: false } };
  assert.equal(settingsAfterConnection(undone, integration, '', integration).applied.hasRules, false);
});
