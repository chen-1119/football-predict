'use strict';
const { test } = require('node:test'), assert = require('node:assert/strict');
const fs = require('node:fs'), vm = require('node:vm'), ts = require('typescript');
const { parseArgs } = require('../scripts/bootstrapAccountAdmin.cjs');
const flatten = node => Array.isArray(node) ? node.flatMap(flatten) : node && typeof node === 'object' ? [node, ...flatten(node.props?.children)] : [];
const words = node => Array.isArray(node) ? node.map(words).join('') : node && typeof node === 'object' ? words(node.props?.children) : node == null || typeof node === 'boolean' ? '' : String(node);
async function mount(role = 'admin') {
  const states = [], effects = [], callbacks = [], scheduled = [], requests = [];
  let stateIndex = 0, effectIndex = 0, callbackIndex = 0, tree, failure = null;
  const rows = [{ id: 'bob-id', username: 'bob', displayName: '用户乙', role: 'user', status: 'active', createdAt: '2026-09-22T00:00:00Z' },
    { id: 'self-id', username: 'manager', displayName: '管理员', role: 'admin', status: 'active', createdAt: '2026-09-22T00:00:00Z' }];
  const account = { user: { id: 'self-id', role }, loading: false, refresh: async () => {},
    accountAction: async (path, body) => { requests.push({ path, body }); if (failure) throw Error(failure); return { ok: true }; } };
  const react = {
    useState(initial) { const index = stateIndex++; if (!(index in states)) states[index] = initial; return [states[index], value => { states[index] = typeof value === 'function' ? value(states[index]) : value; }]; },
    useCallback(fn, deps) { const index = callbackIndex++, previous = callbacks[index]; if (!previous || deps.some((dep, i) => dep !== previous.deps[i])) callbacks[index] = { fn, deps }; return callbacks[index].fn; },
    useEffect(fn, deps) { const index = effectIndex++, previous = effects[index]; if (!previous || deps.some((dep, i) => dep !== previous.deps[i])) { effects[index] = { deps }; scheduled.push(fn); } }
  };
  const module = { exports: {} };
  vm.runInNewContext(ts.transpileModule(fs.readFileSync(require.resolve('../src/pages/AccountAdmin.tsx'), 'utf8'),
    { compilerOptions: { target: ts.ScriptTarget.ES2022, module: ts.ModuleKind.CommonJS, jsx: ts.JsxEmit.ReactJSX } }).outputText, {
    module, exports: module.exports, AbortController, Error, require(id) {
      if (id === 'react') return react;
      if (id === 'react/jsx-runtime') return { jsx: (type, props) => ({ type, props }), jsxs: (type, props) => ({ type, props }), Fragment: 'fragment' };
      if (id === 'react-router-dom') return { Link: 'a' };
      if (id === '../context/AccountContext') return { useAccount: () => account };
      if (id === '../services/accountApi') return { accountRequest: async path => { requests.push({ path }); return { ok: true, rows }; } };
      if (id.endsWith('.css')) return {};
      throw Error(id);
    }
  });
  function render() { stateIndex = effectIndex = callbackIndex = 0; tree = module.exports.AccountAdmin(); while (scheduled.length) scheduled.shift()(); return tree; }
  const find = predicate => flatten(tree).find(predicate);
  const field = id => find(node => node.props?.id === id);
  const change = (id, value) => { field(id).props.onChange({ target: { value } }); render(); };
  render(); await new Promise(resolve => setImmediate(resolve)); render();
  return { render, find, field, change, requests, account, fail(value) { failure = value; }, text: () => words(tree),
    async submit() { await find(node => node.type === 'form').props.onSubmit({ preventDefault() {} }); render(); } };
}

test('regular users cannot load the admin list or see a mutation form', async () => {
  const h = await mount('user'); assert.equal(h.requests.length, 0); assert.equal(h.find(node => node.type === 'form'), undefined);
  assert.match(h.text(), /仅供运营和管理员/);
});

test('operators can grant only to regular users with explicit reason and current-password confirmation', async () => {
  const h = await mount('operator'); assert.equal(h.field('admin-operation'), undefined);
  assert.equal(flatten(h.field('admin-target')).filter(node => node.type === 'option').length, 2);
  h.change('admin-target', 'bob-id'); h.change('admin-days', '2'); h.change('admin-reason', '测试体验赠送'); h.change('admin-password', 'a private admin password');
  await h.submit(); const request = h.requests.find(row => row.body);
  assert.equal(request.path, '/admin/users/bob-id/grant'); assert.equal(request.body.days, 2);
  assert.equal(request.body.reason, '测试体验赠送'); assert.equal(request.body.currentPassword, 'a private admin password');
  assert.equal(h.field('admin-password').props.value, ''); assert.match(h.text(), /已为 bob 赠送 2 天/);
});

test('an admin cannot change their own role or status, even if submit is invoked directly', async () => {
  const h = await mount('admin'); h.change('admin-target', 'self-id'); h.change('admin-operation', 'role');
  h.change('admin-reason', 'test'); h.change('admin-password', 'a private admin password'); await h.submit();
  assert.equal(h.requests.filter(row => row.body).length, 0); assert.match(h.text(), /不能修改自己的管理员角色/);
});

test('failed reauthentication is visible, clears the password, and never shows success', async () => {
  const h = await mount('admin'); h.fail('reauthentication_required'); h.change('admin-target', 'bob-id'); h.change('admin-operation', 'status');
  h.change('admin-reason', '测试禁用'); h.change('admin-password', 'incorrect admin password'); await h.submit();
  assert.match(h.text(), /当前密码不正确/); assert.equal(h.field('admin-password').props.value, '');
  assert.equal(h.find(node => node.props?.role === 'status'), undefined);
  assert.equal(h.requests.find(row => row.body).path, '/admin/users/bob-id/status');
});

test('bootstrap CLI requires the explicitly named existing account and first-admin flag', () => {
  assert.deepEqual(parseArgs(['--username', ' Owner_Test ', '--confirm-first-admin']), { username: 'owner_test', confirmFirstAdmin: true });
  for (const args of [[], ['--username', 'owner'], ['--confirm-first-admin'], ['--username', 'owner', '--confirm-first-admin', '--password', 'secret']]) assert.throws(() => parseArgs(args));
});
