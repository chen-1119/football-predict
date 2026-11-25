// Behavioural guard: the published AI arena is fetched with a bearer token and
// must never be shown for another account, after sign-out, or when an old
// request resolves late. Runs the real AIArena component with a minimal hook
// runtime and controllable fetches (no DOM needed).
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');
const ts = require('typescript');

const root = path.join(__dirname, '..');
const arenaPath = path.join(root, 'src', 'pages', 'AIArena.tsx');
const previewPath = path.join(root, 'src', 'components', 'predictions', 'AIArenaPreview.tsx');
const componentSource = process.env.AI_ARENA_SOURCE_OVERRIDE
  ? fs.readFileSync(process.env.AI_ARENA_SOURCE_OVERRIDE, 'utf8')
  : fs.readFileSync(arenaPath, 'utf8');

const transpiled = ts.transpileModule(componentSource, {
  compilerOptions: {
    module: ts.ModuleKind.CommonJS,
    target: ts.ScriptTarget.ES2022,
    jsx: ts.JsxEmit.React,
    esModuleInterop: true,
  },
  fileName: arenaPath,
  reportDiagnostics: true,
});
assert.equal(
  (transpiled.diagnostics || []).filter((row) => row.category === ts.DiagnosticCategory.Error).length,
  0,
  'AIArena.tsx must transpile',
);

const sameDeps = (left, right) => Boolean(left && right && left.length === right.length
  && left.every((value, index) => Object.is(value, right[index])));

function createRuntime() {
  const slots = [];
  const queuedEffects = [];
  let cursor = 0;
  let dirty = false;
  const React = {
    Fragment: Symbol('Fragment'),
    createElement: (type, props, ...children) => ({ type, props: { ...(props || {}), children } }),
    useState(initial) {
      const index = cursor++;
      if (!(index in slots)) slots[index] = { value: typeof initial === 'function' ? initial() : initial };
      const slot = slots[index];
      return [slot.value, (next) => {
        const value = typeof next === 'function' ? next(slot.value) : next;
        if (!Object.is(value, slot.value)) {
          slot.value = value;
          dirty = true;
        }
      }];
    },
    useMemo(factory, deps) {
      const index = cursor++;
      const previous = slots[index];
      if (previous && sameDeps(previous.deps, deps)) return previous.value;
      slots[index] = { deps, value: factory() };
      return slots[index].value;
    },
    useCallback(callback, deps) {
      return React.useMemo(() => callback, deps);
    },
    useRef(initial) {
      const index = cursor++;
      if (!(index in slots)) slots[index] = { current: initial };
      return slots[index];
    },
    useEffect(effect, deps) {
      const index = cursor++;
      const previous = slots[index];
      if (previous && deps && sameDeps(previous.deps, deps)) return;
      slots[index] = { deps, cleanup: previous?.cleanup };
      queuedEffects.push({ index, effect });
    },
  };
  React.useLayoutEffect = React.useEffect;
  return {
    React,
    renderOnce(Component) {
      cursor = 0;
      dirty = false;
      const tree = Component();
      const effects = queuedEffects.splice(0);
      for (const { index, effect } of effects) {
        slots[index].cleanup?.();
        const cleanup = effect();
        slots[index].cleanup = typeof cleanup === 'function' ? cleanup : undefined;
      }
      return tree;
    },
    isDirty: () => dirty,
    unmount() {
      for (const slot of slots) if (slot && typeof slot.cleanup === 'function') slot.cleanup();
    },
  };
}

function findElement(node, type) {
  if (!node || typeof node !== 'object') return null;
  if (Array.isArray(node)) {
    for (const child of node) {
      const found = findElement(child, type);
      if (found) return found;
    }
    return null;
  }
  if (node.type === type) return node;
  return findElement(node.props?.children, type);
}

function deferred() {
  let resolve;
  let reject;
  const promise = new Promise((res, rej) => { resolve = res; reject = rej; });
  return { promise, resolve, reject };
}

const arenaFixture = (label, state = 'LOCKED') => ({
  label,
  state,
  complete: false,
  availableMatches: 2,
  agents: [],
  matches: [],
  dates: [],
  evidenceStandings: [],
  integrity: null,
  submissionRootHash: '',
  lockedAt: null,
});

function mountArena() {
  const runtime = createRuntime();
  const fetchCalls = [];
  const localArena = arenaFixture('local', 'FORMING');
  const context = { language: 'zh', matches: [], accessSession: null, isAccessVerified: false };
  const Preview = function AIArenaPreviewStub() { return null; };
  const icon = () => null;
  const stubs = {
    react: runtime.React,
    'lucide-react': new Proxy({}, { get: () => icon }),
    'react-router-dom': { Link: () => null, useParams: () => ({}) },
    '../components/predictions/AIArenaPreview': { AIArenaPreview: Preview },
    '../context/AppContextCore': { useApp: () => context },
    '../services/aiArena': {
      arenaPickLabel: () => '',
      buildBigFiveSurvivalArena: () => localArena,
      fetchPublishedBigFiveSurvivalArena: (token, signal) => {
        const call = { token, signal, ...deferred() };
        fetchCalls.push(call);
        return call.promise;
      },
    },
    '../styles/ai-arena.css': {},
  };
  const moduleRecord = { exports: {} };
  const localRequire = (specifier) => {
    if (specifier in stubs) return stubs[specifier];
    throw new Error(`Unexpected import in AIArena.tsx: ${specifier}`);
  };
  new Function('exports', 'require', 'module', transpiled.outputText)(moduleRecord.exports, localRequire, moduleRecord);
  const { AIArena } = moduleRecord.exports;
  assert.equal(typeof AIArena, 'function', 'AIArena must be exported');

  let tree = null;
  const render = () => {
    let guard = 0;
    do {
      tree = runtime.renderOnce(AIArena);
      guard += 1;
      assert.ok(guard < 20, 'render loop did not settle');
    } while (runtime.isDirty());
  };
  const settle = async () => {
    for (let round = 0; round < 10; round += 1) {
      // A short timer (not setImmediate) lets the 0 ms retry back-off fire.
      await new Promise((resolve) => setTimeout(resolve, 2));
      if (runtime.isDirty()) render();
    }
  };
  const shownArena = () => {
    const preview = findElement(tree, Preview);
    assert.ok(preview, 'arena overview must render AIArenaPreview');
    return preview.props.arena;
  };
  const signIn = (token) => {
    context.accessSession = { token, expiresAt: new Date(Date.now() + 3600000).toISOString() };
    context.isAccessVerified = true;
  };
  const signOut = () => {
    context.accessSession = null;
    context.isAccessVerified = false;
  };
  return { context, fetchCalls, localArena, render, settle, shownArena, signIn, signOut, unmount: runtime.unmount };
}

const results = [];
const scenario = async (name, run) => {
  try {
    await run();
    results.push({ name, ok: true });
  } catch (error) {
    results.push({ name, ok: false, error: error.message });
  }
};

(async () => {
  // Retry back-off should not slow the check down.
  globalThis.window = {
    setTimeout: (callback) => setTimeout(callback, 0),
    clearTimeout: (timer) => clearTimeout(timer),
  };

  await scenario('signed-in account sees only its own locked snapshot', async () => {
    const app = mountArena();
    app.signIn('token-a');
    app.render();
    assert.equal(app.fetchCalls.length, 1);
    assert.equal(app.fetchCalls[0].token, 'token-a');
    assert.equal(app.shownArena(), app.localArena, 'pending request shows the local arena');
    app.fetchCalls[0].resolve(arenaFixture('A'));
    await app.settle();
    assert.equal(app.shownArena().label, 'A');
    app.unmount();
  });

  await scenario('account switch hides the previous account snapshot while the new request is pending', async () => {
    const app = mountArena();
    app.signIn('token-a');
    app.render();
    app.fetchCalls[0].resolve(arenaFixture('A'));
    await app.settle();
    assert.equal(app.shownArena().label, 'A');
    app.signIn('token-b');
    app.render();
    assert.equal(app.fetchCalls[0].signal.aborted, true, 'old account request is aborted');
    const pendingB = app.fetchCalls.at(-1);
    assert.equal(pendingB.token, 'token-b');
    assert.notEqual(app.shownArena().label, 'A', 'account B must not see account A data');
    assert.equal(app.shownArena(), app.localArena);
    pendingB.resolve(arenaFixture('B'));
    await app.settle();
    assert.equal(app.shownArena().label, 'B');
    app.unmount();
  });

  await scenario('late response from the previous account is ignored', async () => {
    const app = mountArena();
    app.signIn('token-a');
    app.render();
    const staleA = app.fetchCalls[0];
    app.signIn('token-b');
    app.render();
    staleA.resolve(arenaFixture('A-late'));
    await app.settle();
    assert.equal(app.shownArena(), app.localArena, 'late A response must not be shown to B');
    app.fetchCalls.at(-1).resolve(arenaFixture('B'));
    await app.settle();
    assert.equal(app.shownArena().label, 'B');
    app.unmount();
  });

  await scenario('sign-out hides the snapshot and ignores in-flight responses', async () => {
    const app = mountArena();
    app.signIn('token-a');
    app.render();
    app.fetchCalls[0].resolve(arenaFixture('A'));
    await app.settle();
    assert.equal(app.shownArena().label, 'A');
    app.context.matches = [{ id: 'refresh' }];
    app.render();
    const refreshCall = app.fetchCalls.at(-1);
    assert.equal(refreshCall.token, 'token-a');
    app.signOut();
    app.render();
    assert.equal(refreshCall.signal.aborted, true, 'in-flight request is aborted on sign-out');
    assert.equal(app.shownArena(), app.localArena, 'signed-out view must not show private data');
    refreshCall.resolve(arenaFixture('A-after-signout'));
    await app.settle();
    assert.equal(app.shownArena(), app.localArena);
    const callsAfterSignOut = app.fetchCalls.length;
    app.render();
    assert.equal(app.fetchCalls.length, callsAfterSignOut, 'signed-out view does not fetch');
    app.unmount();
  });

  await scenario('expired or unverified session never shows or requests the private snapshot', async () => {
    const app = mountArena();
    app.signIn('token-a');
    app.render();
    app.fetchCalls[0].resolve(arenaFixture('A'));
    await app.settle();
    assert.equal(app.shownArena().label, 'A');
    app.context.isAccessVerified = false;
    app.render();
    assert.equal(app.shownArena(), app.localArena);
    app.unmount();
  });

  await scenario('failed requests for the new account fall back to the local arena', async () => {
    const app = mountArena();
    app.signIn('token-a');
    app.render();
    app.fetchCalls[0].resolve(arenaFixture('A'));
    await app.settle();
    app.signIn('token-b');
    app.render();
    for (let attempt = 0; attempt < 3; attempt += 1) {
      const call = app.fetchCalls.at(-1);
      assert.equal(call.token, 'token-b');
      call.reject(new Error('HTTP 503'));
      await app.settle();
    }
    assert.equal(app.fetchCalls.filter((call) => call.token === 'token-b').length, 3, 'three attempts for B');
    assert.equal(app.shownArena(), app.localArena);
    app.unmount();
  });

  await scenario('unmount aborts the pending request', async () => {
    const app = mountArena();
    app.signIn('token-a');
    app.render();
    app.unmount();
    assert.equal(app.fetchCalls[0].signal.aborted, true);
  });

  const previewSource = fs.readFileSync(previewPath, 'utf8');
  await scenario('preview derives its date fallback instead of resetting state in an effect', async () => {
    assert.doesNotMatch(previewSource, /useEffect\(\(\)\s*=>\s*\{\s*if \(activeDate !== 'all'/);
    assert.match(previewSource, /const activeDate = selectedDate !== 'all' && !arena\.dates\.includes\(selectedDate\) \? 'all' : selectedDate;/);
  });

  const failed = results.filter((row) => !row.ok);
  console.log(JSON.stringify({ ok: failed.length === 0, checks: results }, null, 2));
  if (failed.length) process.exitCode = 1;
})();
