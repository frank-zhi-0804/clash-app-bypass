import { test } from 'node:test';
import assert from 'node:assert/strict';
import { diagnoseApp } from '../src/routingDiagnostics.ts';
const app = { id: 'game', processes: ['D:\\Game\\game.exe'], suggestedProcesses: ['D:\\Login\\login.exe'] };
const snapshot = { checkedAt: '', mode: 'rule', findProcessMode: 'always', rules: ['d:\\game\\GAME.exe'], unidentifiedConnections: 0, connections: [] };
const connection = (path, direct, rejected = false) => ({ path, direct, rejected, rule: 'ProcessPath', start: '' });
test('written rules without traffic are never presented as verified direct', () => {
  assert.equal(diagnoseApp(app, snapshot).label, 'diagnostics.status.empty');
});
test('diagnosis distinguishes direct, mixed routes, blocked connections and missing rules', () => {
  const c = connection(app.processes[0], true);
  assert.equal(diagnoseApp(app, { ...snapshot, connections: [c] }).label, 'diagnostics.status.direct');
  assert.equal(diagnoseApp(app, { ...snapshot, connections: [c, { ...c, direct: false }] }).label, 'diagnostics.status.proxied');
  assert.equal(diagnoseApp(app, { ...snapshot, connections: [{ ...c, direct: false, rejected: true }] }).label, 'diagnostics.status.blocked');
  assert.equal(diagnoseApp(app, { ...snapshot, rules: [], connections: [c] }).label, 'diagnostics.status.incomplete');
  assert.equal(diagnoseApp(app, { ...snapshot, mode: 'global', connections: [c] }).label, 'diagnostics.status.ruleMode');
});
test('unconfirmed startup-chain helpers expose uncovered traffic without associating unrelated apps', () => {
  assert.equal(diagnoseApp(app, { ...snapshot, connections: [connection(app.suggestedProcesses[0], false)] }).uncovered.length, 1);
  assert.equal(diagnoseApp(app, { ...snapshot, connections: [connection('D:\\Other\\game.exe', false)] }).label, 'diagnostics.status.empty');
});
