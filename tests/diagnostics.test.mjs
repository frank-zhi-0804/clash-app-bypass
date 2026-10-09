import { test } from 'node:test';
import assert from 'node:assert/strict';
import { diagnoseApp } from '../src/routingDiagnostics.ts';
const app = { id: 'game', processes: ['D:\\Game\\game.exe'], suggestedProcesses: ['D:\\Login\\login.exe'] };
const snapshot = { checkedAt: '', mode: 'rule', findProcessMode: 'always', rules: ['d:\\game\\GAME.exe'], unidentifiedConnections: 0, connections: [] };
const connection = (path, direct, rejected = false) => ({ path, direct, rejected, rule: 'ProcessPath', start: '' });
test('written rules without traffic are never presented as verified direct', () => {
  assert.equal(diagnoseApp(app, snapshot).label, '暂无可验证连接');
});
test('diagnosis distinguishes direct, mixed routes, blocked connections and missing rules', () => {
  const c = connection(app.processes[0], true);
  assert.equal(diagnoseApp(app, { ...snapshot, connections: [c] }).label, '已观察到直连');
  assert.equal(diagnoseApp(app, { ...snapshot, connections: [c, { ...c, direct: false }] }).label, '仍有连接使用代理');
  assert.equal(diagnoseApp(app, { ...snapshot, connections: [{ ...c, direct: false, rejected: true }] }).label, '部分连接被拒绝');
  assert.equal(diagnoseApp(app, { ...snapshot, rules: [], connections: [c] }).label, '直连规则未完整加载');
  assert.equal(diagnoseApp(app, { ...snapshot, mode: 'global', connections: [c] }).label, '请切换规则模式');
});
test('unconfirmed startup-chain helpers expose uncovered traffic without associating unrelated apps', () => {
  assert.equal(diagnoseApp(app, { ...snapshot, connections: [connection(app.suggestedProcesses[0], false)] }).uncovered.length, 1);
  assert.equal(diagnoseApp(app, { ...snapshot, connections: [connection('D:\\Other\\game.exe', false)] }).label, '暂无可验证连接');
});
