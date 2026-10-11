import { test } from 'node:test';
import assert from 'node:assert/strict';
import http from 'node:http';
import fs from 'node:fs';
import { execFile } from 'node:child_process';
import { promisify } from 'node:util';
const liveApiSource = fs.readFileSync(new URL('../src-tauri/scripts/live-api.ps1', import.meta.url), 'utf8');
const runLiveApi = packet => new Promise((resolve, reject) => {
  const child = execFile('powershell.exe', ['-NoProfile', '-NonInteractive', '-EncodedCommand', Buffer.from(liveApiSource, 'utf16le').toString('base64')], { timeout: 15000, windowsHide: true }, (error, stdout, stderr) => {
    if (error || /^LIVE_[A-Z_]+$/.test(stdout.trim())) reject(Object.assign(new Error(`Live API refused request: ${stdout.trim() || stderr.trim()}`), { stdout, stderr }));
    else resolve(stdout);
  });
  child.stdin.end(JSON.stringify(packet));
});
const listen = server => new Promise((resolve, reject) => { server.once('error', reject); server.listen(server.testPipe, resolve); });
function liveServer(handler) {
  const server = http.createServer(handler);
  server.testPipe = `\\\\.\\pipe\\clash-bypass-live-${process.pid}-${Date.now()}-${Math.random().toString(16).slice(2)}`;
  return server;
}
const close = server => new Promise(resolve => server.close(resolve));
const json = (res, body) => { res.setHeader('Content-Type', 'application/json'); res.end(JSON.stringify(body)); };
const runDiagnostics = async pipe => {
  const source = `$controller='${pipe}'\n${fs.readFileSync(new URL('../src-tauri/scripts/diagnose.ps1', import.meta.url), 'utf8')}`;
  const { stdout } = await promisify(execFile)('powershell.exe', ['-NoProfile', '-NonInteractive', '-EncodedCommand', Buffer.from(source, 'utf16le').toString('base64')], { timeout: 15000, windowsHide: true });
  return { stdout, snapshot: JSON.parse(stdout.replace(/^\uFEFF/, '').trim()) };
};
test('local pipe diagnostics read real HTTP JSON, preserve Unicode paths and exclude private metadata', { skip: process.platform !== 'win32' }, async () => {
  const pipe = `\\\\.\\pipe\\clash-bypass-test-${process.pid}-${Date.now()}`;
  const requests = [];
  const path = 'D:\\游戏\\main.exe';
  const server = http.createServer((req, res) => {
    requests.push([req.method, req.url]);
    const data = {
      '/configs': { mode: 'rule', 'find-process-mode': 'always', secret: 'must-not-be-returned' },
      '/rules': { rules: [
        { type: 'ProcessPath', proxy: 'DIRECT', payload: path },
        { type: 'ProcessPath', proxy: 'DIRECT', payload: 'D:\\disabled.exe', extra: { disabled: true } },
        { type: 'DomainSuffix', proxy: 'DIRECT', payload: 'Example.COM' },
        { type: 'DomainSuffix', proxy: 'DIRECT', payload: 'disabled.example', extra: { disabled: true } },
        { type: 'DomainSuffix', proxy: 'GLOBAL', payload: 'proxy-only.example' },
        { type: 'Domain', proxy: 'DIRECT', payload: 'exact-only.example' },
        { type: 'DomainKeyword', proxy: 'DIRECT', payload: 'keyword-only.example' },
        { type: 'Match', proxy: 'GLOBAL', payload: '' }
      ] },
      '/connections': { connections: [{ metadata: { processPath: path, host: 'private.example', destinationIP: '192.0.2.123', destinationPort: '12345' }, chains: ['DIRECT'], rule: 'ProcessPath', start: '' }, { metadata: {}, chains: ['GLOBAL'] }] }
    };
    res.setHeader('Content-Type', 'application/json'); res.end(JSON.stringify(data[req.url]));
  });
  await new Promise((resolve, reject) => { server.once('error', reject); server.listen(pipe, resolve); });
  try {
    const source = `$controller='${pipe}'\n${fs.readFileSync(new URL('../src-tauri/scripts/diagnose.ps1', import.meta.url), 'utf8')}`;
    const { stdout } = await promisify(execFile)('powershell.exe', ['-NoProfile', '-NonInteractive', '-EncodedCommand', Buffer.from(source, 'utf16le').toString('base64')], { timeout: 15000, windowsHide: true });
    const snapshot = JSON.parse(stdout.replace(/^\uFEFF/, '').trim());
    assert.deepEqual(snapshot.rules, [path]);
    assert.deepEqual(snapshot.domainRules, ['example.com']);
    assert.equal(snapshot.connections[0].path, path);
    assert.equal(snapshot.connections[0].direct, true);
    assert.equal(snapshot.unidentifiedConnections, 1);
    for (const privateValue of ['private.example', 'must-not-be-returned', '192.0.2.123', '12345', 'disabled.example', 'proxy-only.example', 'exact-only.example', 'keyword-only.example']) assert.ok(!stdout.includes(privateValue));
    assert.deepEqual(requests, [['GET', '/configs'], ['GET', '/rules'], ['GET', '/connections']]);
  } finally { await new Promise(resolve => server.close(resolve)); }
});
test('website-only diagnostics preserve loaded duplicate suffixes, empty arrays and the connection privacy boundary', { skip: process.platform !== 'win32' }, async () => {
  let enabled = true;
  const server = liveServer((req, res) => {
    const suffix = { type: 'DomainSuffix', payload: 'Example.COM', proxy: 'DIRECT', extra: { disabled: !enabled } };
    const replies = {
      '/configs': { mode: 'rule', 'find-process-mode': 'always' },
      '/rules': { rules: [suffix, { ...suffix }] },
      '/connections': { connections: [{ metadata: { host: 'visited-private.example', destinationIP: '198.51.100.23' }, chains: ['DIRECT'], rule: 'DomainSuffix' }] }
    };
    json(res, replies[req.url]);
  });
  await listen(server);
  try {
    const { stdout, snapshot } = await runDiagnostics(server.testPipe);
    assert.deepEqual(snapshot.rules, []);
    assert.deepEqual(snapshot.domainRules, ['example.com', 'example.com']);
    assert.deepEqual(snapshot.connections, []);
    assert.equal(snapshot.unidentifiedConnections, 1);
    assert.ok(!stdout.includes('visited-private.example') && !stdout.includes('198.51.100.23'));
    enabled = false;
    assert.deepEqual((await runDiagnostics(server.testPipe)).snapshot.domainRules, []);
  } finally { await close(server); }
});
test('domain suffix preflight checks the exact type, payload, route and enabled state without writing', { skip: process.platform !== 'win32' }, async () => {
  let suffix = { type: 'DomainSuffix', payload: 'example.com', proxy: 'DIRECT' }, writes = 0;
  const server = liveServer((req, res) => {
    if (req.method === 'PUT') writes++;
    json(res, req.url === '/rules' ? { rules: [suffix, { type: 'Match', payload: '', proxy: 'GLOBAL' }] } : { mode: 'rule', 'find-process-mode': 'always', 'mixed-port': 7897 });
  });
  await listen(server);
  const packet = { action: 'preflight', controller: server.testPipe, general: { 'mixed-port': 7897 }, previousRules: ['DOMAIN-SUFFIX,example.com,DIRECT', 'MATCH,GLOBAL'] };
  try {
    assert.equal(JSON.parse((await runLiveApi(packet)).trim()).verified, true);
    for (const changed of [
      { payload: 'other.example.com' },
      { proxy: 'GLOBAL' },
      { type: 'Domain' },
      { extra: { disabled: true } }
    ]) {
      suffix = { type: 'DomainSuffix', payload: 'example.com', proxy: 'DIRECT', ...changed };
      await assert.rejects(runLiveApi(packet), /LIVE_CONFLICT/);
    }
    assert.equal(writes, 0);
  } finally { await close(server); }
});
test('domain suffix apply and removal preserve an identical subscription rule in the ordered rule list', { skip: process.platform !== 'win32' }, async () => {
  const original = ['DOMAIN-SUFFIX,example.com,DIRECT', 'MATCH,GLOBAL'];
  const inserted = [original[0], ...original];
  let active = original, writes = 0;
  const server = liveServer((req, res) => {
    if (req.method === 'PUT') {
      let body = ''; req.on('data', d => body += d); req.on('end', () => {
        active = JSON.parse(JSON.parse(body).payload).rules; writes++; res.writeHead(204); res.end();
      });
    } else json(res, req.url === '/rules' ? { rules: active.map(rule => {
      const [type, payload, proxy] = rule.split(',');
      return type === 'MATCH' ? { type: 'Match', payload: '', proxy: payload } : { type: 'DomainSuffix', payload, proxy };
    }) } : { mode: 'rule', 'find-process-mode': 'always', 'mixed-port': 7897 });
  });
  await listen(server);
  const apply = (previousRules, nextRules) => runLiveApi({ action: 'apply', controller: server.testPipe, general: { 'mixed-port': 7897 }, previousRules, nextRules, payload: JSON.stringify({ rules: nextRules }) });
  try {
    assert.equal(JSON.parse((await apply(original, inserted)).trim()).verified, true);
    assert.deepEqual(active, inserted);
    assert.equal(JSON.parse((await apply(inserted, original)).trim()).verified, true);
    assert.deepEqual(active, original);
    assert.equal(writes, 2);
    await assert.rejects(apply(inserted, original), /LIVE_CONFLICT/);
    assert.equal(writes, 2);
  } finally { await close(server); }
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
    } else { res.setHeader('Content-Type', 'application/json'); res.end(JSON.stringify(req.url === '/rules' ? { rules } : { mode: 'rule', 'find-process-mode': 'always', 'mixed-port': 7897 })); }
  });
  await new Promise((resolve, reject) => { server.once('error', reject); server.listen(pipe, resolve); });
  const packet = { action: 'apply', controller: pipe, payload, general: { 'mixed-port': 7897 }, previousRules: ['MATCH,GLOBAL'], nextRules: ['PROCESS-PATH,D:\\游戏\\game.exe,DIRECT', 'MATCH,GLOBAL'] };
  try {
    assert.equal(JSON.parse((await runLiveApi(packet)).trim()).verified, true); assert.equal(writes, 1);
    await assert.rejects(runLiveApi(packet), /LIVE_CONFLICT/); assert.equal(writes, 1);
  } finally { await new Promise(resolve => server.close(resolve)); }
});
test('online preflight refuses disabled rules and changed network settings without any PUT', { skip: process.platform !== 'win32' }, async () => {
  let disabled = true, writes = 0;
  const server = liveServer((req, res) => {
    if (req.method === 'PUT') writes++;
    json(res, req.url === '/rules' ? { rules: [{ type: 'Match', payload: '', proxy: 'GLOBAL', extra: { disabled } }] } : { 'mixed-port': 7898 });
  });
  await listen(server);
  const packet = { action: 'preflight', controller: server.testPipe, general: { 'mixed-port': 7897 }, previousRules: ['MATCH,GLOBAL'] };
  try {
    await assert.rejects(runLiveApi(packet), /LIVE_CONFLICT/);
    disabled = false;
    await assert.rejects(runLiveApi(packet), /LIVE_CONFLICT/);
    assert.equal(writes, 0);
  } finally { await close(server); }
});
test('preflight captures actual routing settings without exposing configuration secrets', { skip: process.platform !== 'win32' }, async () => {
  const requests = [];
  const server = liveServer((req, res) => {
    requests.push(req.method);
    json(res, req.url === '/rules' ? { rules: [{ type: 'Match', payload: '', proxy: 'GLOBAL' }] } : { mode: 'global', 'find-process-mode': 'strict', 'mixed-port': 7897, secret: 'secret-core-token' });
  });
  await listen(server);
  try {
    const reply = await runLiveApi({ action: 'preflight', controller: server.testPipe, general: { mode: 'rule', 'find-process-mode': 'always', 'mixed-port': 7897 }, previousRules: ['MATCH,GLOBAL'] });
    assert.deepEqual(JSON.parse(reply.trim()), { verified: true, previousRouting: { mode: 'global', findProcessMode: 'strict' } });
    assert.ok(!reply.includes('secret-core-token'));
    assert.deepEqual(requests, ['GET', 'GET']);
  } finally { await close(server); }
});
test('apply refuses routing changes after preflight while allowing a stable global-to-rule transition', { skip: process.platform !== 'win32' }, async () => {
  let writes = 0;
  let active = { mode: 'global', 'find-process-mode': 'always', 'mixed-port': 7897 };
  const server = liveServer((req, res) => {
    if (req.method === 'PUT') {
      req.resume(); req.on('end', () => { writes++; active = { ...active, mode: 'rule', 'find-process-mode': 'always' }; res.writeHead(204); res.end(); });
    } else json(res, req.url === '/rules' ? { rules: [{ type: 'Match', payload: '', proxy: 'GLOBAL' }] } : active);
  });
  await listen(server);
  const packet = { action: 'apply', controller: server.testPipe, general: { 'mixed-port': 7897 }, expectedRouting: { mode: 'global', findProcessMode: 'strict' }, payload: '{}', previousRules: ['MATCH,GLOBAL'], nextRules: ['MATCH,GLOBAL'] };
  try {
    await assert.rejects(runLiveApi(packet), /LIVE_CONFLICT/);
    assert.equal(writes, 0);
    active = { ...active, 'find-process-mode': 'strict' };
    assert.equal(JSON.parse((await runLiveApi(packet)).trim()).verified, true);
    assert.equal(writes, 1);
    assert.equal(active.mode, 'rule');
  } finally { await close(server); }
});
test('rollback restores routing settings when old and new rules are identical, then avoids duplicate reload', { skip: process.platform !== 'win32' }, async () => {
  const original = { mode: 'global', 'find-process-mode': 'strict', 'mixed-port': 7897, tun: { enable: false } };
  const applied = { ...original, mode: 'rule', 'find-process-mode': 'always' };
  let active = applied, writes = 0;
  const server = liveServer((req, res) => {
    if (req.method === 'PUT') {
      let body = ''; req.on('data', d => body += d); req.on('end', () => {
        assert.deepEqual(JSON.parse(JSON.parse(body).payload), original);
        active = original; writes++; res.writeHead(204); res.end();
      });
    } else json(res, req.url === '/rules' ? { rules: [{ type: 'Match', payload: '', proxy: 'GLOBAL' }] } : active);
  });
  await listen(server);
  const packet = { action: 'restore', controller: server.testPipe, general: original, previousGeneral: applied, payload: JSON.stringify(original), previousRules: ['MATCH,GLOBAL'], nextRules: ['MATCH,GLOBAL'] };
  try {
    assert.equal(JSON.parse((await runLiveApi(packet)).trim()).verified, true);
    assert.deepEqual(active, original); assert.equal(writes, 1);
    assert.equal(JSON.parse((await runLiveApi(packet)).trim()).verified, true);
    assert.equal(writes, 1);
  } finally { await close(server); }
});
test('rollback refuses a third configuration rather than overwriting external changes', { skip: process.platform !== 'win32' }, async () => {
  let writes = 0;
  const server = liveServer((req, res) => {
    if (req.method === 'PUT') writes++;
    json(res, req.url === '/rules' ? { rules: [{ type: 'Match', payload: '', proxy: 'GLOBAL' }] } : { mode: 'direct', 'find-process-mode': 'never', 'mixed-port': 7897 });
  });
  await listen(server);
  const packet = { action: 'restore', controller: server.testPipe, general: { mode: 'global', 'find-process-mode': 'strict' }, previousGeneral: { mode: 'rule', 'find-process-mode': 'always' }, payload: 'private-payload', previousRules: ['MATCH,GLOBAL'], nextRules: ['MATCH,GLOBAL'] };
  try {
    await assert.rejects(runLiveApi(packet), /LIVE_CONFLICT/);
    assert.equal(writes, 0);
  } finally { await close(server); }
});
test('failed reload reports a small error code and does not expose an API response or payload', { skip: process.platform !== 'win32' }, async () => {
  const server = liveServer((req, res) => {
    if (req.method === 'PUT') { res.writeHead(400); res.end('secret-subscription-response'); }
    else json(res, req.url === '/rules' ? { rules: [{ type: 'Match', payload: '', proxy: 'GLOBAL' }] } : { 'mixed-port': 7897 });
  });
  await listen(server);
  try {
    await assert.rejects(runLiveApi({ action: 'apply', controller: server.testPipe, general: { 'mixed-port': 7897 }, payload: 'secret-full-configuration', previousRules: ['MATCH,GLOBAL'], nextRules: ['MATCH,GLOBAL'] }), error => {
      assert.equal(error.stdout.trim(), 'LIVE_TRANSPORT'); assert.equal(error.stderr.trim(), '');
      assert.ok(!error.message.includes('secret-'));
      return true;
    });
  } finally { await close(server); }
});
test('successful reload must also enable process lookup, not just rule mode', { skip: process.platform !== 'win32' }, async () => {
  let writes = 0;
  const server = liveServer((req, res) => {
    if (req.method === 'PUT') { req.resume(); req.on('end', () => { writes++; res.writeHead(204); res.end(); }); }
    else json(res, req.url === '/rules' ? { rules: [{ type: 'Match', payload: '', proxy: 'GLOBAL' }] } : { mode: 'rule', 'find-process-mode': 'strict' });
  });
  await listen(server);
  try {
    await assert.rejects(runLiveApi({ action: 'apply', controller: server.testPipe, general: {}, payload: '{}', previousRules: ['MATCH,GLOBAL'], nextRules: ['MATCH,GLOBAL'] }), /LIVE_CONFLICT/);
    assert.equal(writes, 1);
  } finally { await close(server); }
});
