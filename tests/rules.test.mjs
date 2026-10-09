import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import vm from 'node:vm';
const template = fs.readFileSync(new URL('../shared/managed-wrapper.js', import.meta.url), 'utf8');
const rules = ['PROCESS-PATH,C:\\Games\\Steam\\steam.exe,DIRECT', 'PROCESS-PATH,C:\\Games\\Steam\\steamwebhelper.exe,DIRECT'];
function run(original, config, repeat = 1) {
  const ctx = vm.createContext({});
  vm.runInContext(original + '\n' + template.replace('__VERGE_DIRECT_RULES__', JSON.stringify(rules)).replace('__VERGE_DIRECT_ROUTING__', JSON.stringify({ mode: 'subscription', proxyGroup: 'GLOBAL' })), ctx);
  ctx.config = config;
  let result;
  for (let n = 0; n < repeat; n++) result = vm.runInContext('main(config, "subscription-name")', ctx);
  return result;
}
test('direct rules precede MATCH and preserve custom main and other fields', () => {
  const c = { rules: ['MATCH,Proxy'], dns: { enable: true }, 'find-process-mode': 'off' };
  const r = run('function main(c, name) { c.custom = name; return c; }', c);
  assert.deepEqual(Array.from(r.rules), [...rules, 'MATCH,Proxy']);
  assert.equal(r.custom, 'subscription-name'); assert.equal(r.dns.enable, true);
  assert.equal(r['find-process-mode'], 'always');
});
test('applying configuration multiple times does not duplicate tool rules', () => {
  const r = run('function main(c) { return c; }', { rules: [rules[0], 'DOMAIN,example.org,DIRECT', 'MATCH,Proxy'] }, 3);
  assert.deepEqual(Array.from(r.rules), [...rules, 'DOMAIN,example.org,DIRECT', 'MATCH,Proxy']);
});
test('supports original main returning a new object', () => {
  const r = run('function main(c) { return { ...c, rules: ["MATCH,Proxy"] }; }', { port: 7897 });
  assert.equal(r.port, 7897); assert.equal(r.rules.length, 3);
});
test('does not swallow invalid original script results', () => {
  assert.throws(() => run('function main(c) { return undefined; }', {}), /must return/);
  assert.throws(() => run('async function main(c) { return c; }', {}), /must return/);
});
test('serialized paths cannot inject JavaScript', () => {
  const unusual = 'PROCESS-PATH,C:\\Apps\\a"quoted.exe,DIRECT';
  const ctx = vm.createContext({});
  vm.runInContext('function main(c) { return c; }\n' + template.replace('__VERGE_DIRECT_RULES__', JSON.stringify([unusual])).replace('__VERGE_DIRECT_ROUTING__', JSON.stringify({ mode: 'subscription', proxyGroup: 'GLOBAL' })), ctx);
  assert.equal(vm.runInContext('main({}).rules[0]', ctx), unusual);
});

function routed(config, mode = 'proxy', proxyGroup = 'GLOBAL', direct = rules) {
  const ctx = vm.createContext({ config });
  vm.runInContext('function main(c) { return c; }\n' + template.replace('__VERGE_DIRECT_RULES__', JSON.stringify(direct)).replace('__VERGE_DIRECT_ROUTING__', JSON.stringify({ mode, proxyGroup })), ctx);
  return vm.runInContext('main(config)', ctx);
}
test('proxy default overrides subscription GitHub DIRECT and MATCH rules', () => {
  const result = routed({ rules: ['DOMAIN-SUFFIX,github.com,DIRECT', 'GEOIP,CN,DIRECT', 'MATCH,DIRECT'] });
  assert.deepEqual(Array.from(result.rules), [...rules, 'MATCH,GLOBAL']);
});
test('explicit selected proxy group is used after app exceptions', () => {
  const result = routed({ 'proxy-groups': [{ name: '我的代理组' }], rules: ['MATCH,DIRECT'] }, 'proxy', '我的代理组');
  assert.deepEqual(Array.from(result.rules), [...rules, 'MATCH,我的代理组']);
});
test('no selected apps still keeps proxy fallback', () => {
  assert.deepEqual(Array.from(routed({ rules: ['MATCH,DIRECT'] }, 'proxy', 'GLOBAL', []).rules), ['MATCH,GLOBAL']);
});
test('subscription mode preserves original routing', () => {
  assert.deepEqual(Array.from(routed({ rules: ['MATCH,DIRECT'] }, 'subscription').rules), [...rules, 'MATCH,DIRECT']);
});
test('invalid or missing proxy group is rejected', () => {
  for (const group of ['DIRECT', 'REJECT', '', 'bad,group', 'Missing']) assert.throws(() => routed({}, 'proxy', group));
});
test('invalid routing mode is rejected', () => { assert.throws(() => routed({}, 'unknown')); });
