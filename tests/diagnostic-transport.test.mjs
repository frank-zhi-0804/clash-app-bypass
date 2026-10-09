import { test } from 'node:test';
import assert from 'node:assert/strict';
import http from 'node:http';
import fs from 'node:fs';
import { execFile } from 'node:child_process';
import { promisify } from 'node:util';
test('local pipe diagnostics read real HTTP JSON, preserve Unicode paths and exclude private metadata', { skip: process.platform !== 'win32' }, async () => {
  const pipe = `\\\\.\\pipe\\clash-bypass-test-${process.pid}-${Date.now()}`;
  const requests = [];
  const path = 'D:\\游戏\\main.exe';
  const server = http.createServer((req, res) => {
    requests.push([req.method, req.url]);
    const data = {
      '/configs': { mode: 'rule', 'find-process-mode': 'always', secret: 'must-not-be-returned' },
      '/rules': { rules: [{ type: 'ProcessPath', proxy: 'DIRECT', payload: path }, { type: 'Match', proxy: 'GLOBAL', payload: '' }] },
      '/connections': { connections: [{ metadata: { processPath: path, host: 'private.example' }, chains: ['DIRECT'], rule: 'ProcessPath', start: '' }, { metadata: {}, chains: ['GLOBAL'] }] }
    };
    res.setHeader('Content-Type', 'application/json'); res.end(JSON.stringify(data[req.url]));
  });
  await new Promise((resolve, reject) => { server.once('error', reject); server.listen(pipe, resolve); });
  try {
    const source = `$controller='${pipe}'\n${fs.readFileSync(new URL('../src-tauri/scripts/diagnose.ps1', import.meta.url), 'utf8')}`;
    const { stdout } = await promisify(execFile)('powershell.exe', ['-NoProfile', '-NonInteractive', '-EncodedCommand', Buffer.from(source, 'utf16le').toString('base64')], { timeout: 15000, windowsHide: true });
    const snapshot = JSON.parse(stdout.replace(/^\uFEFF/, '').trim());
    assert.deepEqual(snapshot.rules, [path]);
    assert.equal(snapshot.connections[0].path, path);
    assert.equal(snapshot.connections[0].direct, true);
    assert.equal(snapshot.unidentifiedConnections, 1);
    assert.ok(!stdout.includes('private.example') && !stdout.includes('must-not-be-returned'));
    assert.deepEqual(requests, [['GET', '/configs'], ['GET', '/rules'], ['GET', '/connections']]);
  } finally { await new Promise(resolve => server.close(resolve)); }
});
test('online apply verifies existing rules before mutating and transfers Unicode through stdin', { skip: process.platform !== 'win32' }, async () => {
  const pipe = `\\\\.\\pipe\\clash-bypass-live-${process.pid}-${Date.now()}`;
  let writes = 0;
  let rules = [{ type: 'Match', payload: '', proxy: 'GLOBAL' }];
  const payload = JSON.stringify({ rules: ['PROCESS-PATH,D:\\游戏\\game.exe,DIRECT', 'MATCH,GLOBAL'] });
  const server = http.createServer((req, res) => {
    if (req.method === 'PUT') {
      let body = ''; req.on('data', d => body += d); req.on('end', () => {
        assert.equal(JSON.parse(body).payload, payload); writes++;
        rules = [{ type: 'ProcessPath', payload: 'D:\\游戏\\game.exe', proxy: 'DIRECT' }, { type: 'Match', payload: '', proxy: 'GLOBAL' }];
        res.writeHead(204); res.end();
      });
    } else { res.setHeader('Content-Type', 'application/json'); res.end(JSON.stringify(req.url === '/rules' ? { rules } : { mode: 'rule', 'mixed-port': 7897 })); }
  });
  await new Promise((resolve, reject) => { server.once('error', reject); server.listen(pipe, resolve); });
  const source = fs.readFileSync(new URL('../src-tauri/scripts/live-api.ps1', import.meta.url), 'utf8');
  const run = packet => new Promise((resolve, reject) => {
    const child = execFile('powershell.exe', ['-NoProfile', '-NonInteractive', '-EncodedCommand', Buffer.from(source, 'utf16le').toString('base64')], { timeout: 15000, windowsHide: true }, (error, stdout) => error ? reject(new Error('Live API refused request')) : resolve(stdout));
    child.stdin.end(JSON.stringify(packet));
  });
  const packet = { action: 'apply', controller: pipe, payload, general: { 'mixed-port': 7897 }, previousRules: ['MATCH,GLOBAL'], nextRules: ['PROCESS-PATH,D:\\游戏\\game.exe,DIRECT', 'MATCH,GLOBAL'] };
  try {
    assert.equal(JSON.parse((await run(packet)).trim()).verified, true); assert.equal(writes, 1);
    await assert.rejects(run(packet), /refused/); assert.equal(writes, 1);
  } finally { await new Promise(resolve => server.close(resolve)); }
});
