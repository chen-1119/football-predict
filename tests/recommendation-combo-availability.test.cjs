'use strict';
const { test, after } = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs'), os = require('node:os'), path = require('node:path');
const ts = require(process.env.TYPESCRIPT_LIBRARY || 'typescript');
const { createRuntime } = require('../scripts/recommendationPlatform/runtime.cjs');
const { match, memoryPorts, validators } = require('./recommendationFixture.cjs');
const tmp = fs.mkdtempSync(path.join(os.tmpdir(), 'combo-availability-'));
after(() => fs.rmSync(tmp, { recursive: true, force: true }));
fs.writeFileSync(path.join(tmp, 'view.cjs'), ts.transpileModule(
  fs.readFileSync(path.join(__dirname, '../src/services/recommendationCenterView.ts'), 'utf8'),
  { compilerOptions: { target: ts.ScriptTarget.ES2022, module: ts.ModuleKind.CommonJS } },
).outputText);
const V = require(path.join(tmp, 'view.cjs'));
const parsed = p => V.parseRecommendationCenter({ recommendationCenter: p.state.view });
const sizes = p => p.state.lanes.combos.previews.map(c => c.size);

// These tests describe the production transaction boundaries: singles commit,
// the source can advance, then combos start a NEW transaction/snapshot.
test('source advancing between publish and combos cannot drop every current candidate', async () => {
  const p = memoryPorts(), r = createRuntime(p, { validators });
  await r.publish(); const old = structuredClone(p.state.decisions);
  p.now += 60000; p.current = [1,2,3].map(id => match(id, p.now));
  assert.equal((await r.combos()).ok, true);
  assert.deepEqual(sizes(p), [2,3]);
  assert.equal(p.state.decisions.length, 6);
  assert.deepEqual(p.state.decisions.slice(0,3), old);
  for (const c of p.state.lanes.combos.previews) for (const d of c.legs) {
    assert.equal(d.modelGeneratedAt, new Date(p.now).toISOString());
    assert.deepEqual(d, p.state.decisions.find(x => x.decisionId === d.decisionId));
  }
});
test('a standalone combo pass can create both previews without a prior single pass', async () => {
  const p = memoryPorts(), r = createRuntime(p, { validators });
  assert.equal((await r.combos()).ok, true);
  assert.deepEqual(sizes(p), [2,3]); assert.equal(p.state.decisions.length, 3);
});
test('a failed publish lane does not prevent combos binding the shared decisions', async () => {
  const p = memoryPorts(), r = createRuntime(p, { validators });
  p.faults.add('publish'); const output = await r.publishingCycle();
  assert.equal(output.publication.ok, false); assert.equal(output.combinations.ok, true);
  assert.deepEqual(sizes(p), [2,3]); assert.equal(p.state.view.current.length, 3);
});
test('after every source update, combos keep using the newest input rather than retrying old IDs', async () => {
  const p = memoryPorts(), r = createRuntime(p, { validators });
  for (let i=0;i<3;i++) {
    await r.publish(); p.now += 1000; p.current = [1,2,3].map(id => match(id, p.now));
    await r.combos(); assert.deepEqual(sizes(p), [2,3]);
  }
});
test('combo read-back uses existing immutable publication time on an identical-input retry', async () => {
  const p = memoryPorts(), r = createRuntime(p, { validators });
  await r.combos(); const before = structuredClone(p.state.decisions);
  p.now += 60000; await r.combos();
  assert.deepEqual(p.state.decisions, before);
  for (const c of p.state.lanes.combos.previews) for (const d of c.legs)
    assert.deepEqual(d, before.find(x => x.decisionId === d.decisionId));
});
test('one bad candidate write does not suppress combinations of the remaining valid matches', async () => {
  const p = memoryPorts(); p.current = [1,2,3,4].map(id => match(id)); p.faults.add('match:2');
  const r = createRuntime(p, { validators }); await r.combos();
  assert.deepEqual(sizes(p), [2,3]); assert.equal(p.state.decisions.length, 3);
  assert.ok(p.state.issues.some(x => x.lane === 'combos' && x.sourceMatchId === '2'));
});
test('all failed writes are not reported as a successfully empty pool', async () => {
  const p = memoryPorts(); p.faults.add('insertDecision');
  const output = await createRuntime(p, { validators }).combos();
  assert.equal(output.ok, false); assert.equal(p.state.decisions.length, 0);
});
test('freeze after a source advance binds persisted current versions and stays immutable on rerun', async () => {
  const p = memoryPorts(); p.now = Date.parse('2026-09-17T12:59:00Z');
  p.current = [1,2,3].map(id => match(id, p.now));
  const r = createRuntime(p, { validators }); await r.publish();
  p.now += 60000; p.current = [1,2,3].map(id => match(id, p.now)); await r.combos();
  assert.equal(p.state.combos.length, 2);
  const before = structuredClone(p.state.combos);
  for (const c of before) for (const d of c.legs) assert.ok(p.state.decisions.some(x => x.decisionId === d.decisionId));
  p.now += 60000; p.current = [4,5,6].map(id => match(id, p.now)); await r.combos();
  assert.deepEqual(p.state.combos, before);
});
test('fresh source with a now-suspended match cannot reuse its old decision to fill a combo', async () => {
  const p = memoryPorts(), r = createRuntime(p, { validators }); await r.publish();
  p.current = [1,2,3].map(id => match(id, p.now, { saleStatus: 'SUSPENDED' }));
  await r.combos(); assert.deepEqual(sizes(p), []);
});
test('stale SP cannot be made eligible merely by binding the decision again', async () => {
  const p = memoryPorts(), r = createRuntime(p, { validators }); await r.publish();
  p.now += 16*60000; await r.combos(); assert.deepEqual(sizes(p), []);
});
test('impossible SP floor remains enforced; no second direction is substituted', async () => {
  const p = memoryPorts(); p.current = [1,2,3].map(id => match(id, p.now, { odds: { odds1:1.2,oddsX:4,odds2:7 } }));
  const r = createRuntime(p, { validators }); await r.combos();
  assert.deepEqual(sizes(p), []); assert.equal(p.state.lanes.combos.candidateCount, 3);
  assert.ok(p.state.decisions.every(d => d.tipCode === '1'));
});
test('same-event duplicates never turn one game into multiple combo legs', async () => {
  const p = memoryPorts(); p.current = [match(1),match(1),match(1)];
  await createRuntime(p, { validators }).combos(); assert.deepEqual(sizes(p), []); assert.equal(p.state.decisions.length, 1);
});
test('fresh combo previews render even when the single lane is error and its source is old', async () => {
  const p = memoryPorts(), r = createRuntime(p, { validators }); await r.publishingCycle();
  p.state.view.lanes.publish.status = 'error'; p.state.view.inputAsOf = '2026-09-16T10:00:00Z';
  const x = parsed(p); assert.equal(V.comboPreviewForSize(x,2,p.now)?.size,2); assert.equal(V.comboPreviewForSize(x,3,p.now)?.size,3);
});
test('fresh combos render when no single lane ever existed', async () => {
  const p = memoryPorts(), r = createRuntime(p, { validators }); await r.combos(); await r.view();
  const x = parsed(p); assert.ok(V.comboPreviewForSize(x,2,p.now)); assert.ok(V.comboPreviewForSize(x,3,p.now));
});
test('a failed combo lane cannot borrow a healthy single lane to make stale previews appear current', async () => {
  const p=memoryPorts(),r=createRuntime(p,{validators});await r.publishingCycle();
  p.state.view.lanes.combos.status='error';
  assert.equal(V.comboPreviewForSize(parsed(p),2,p.now),undefined);
});
test('rerendered view clock cannot make an old combo lane fresh', async () => {
  const p=memoryPorts(),r=createRuntime(p,{validators});await r.publishingCycle();
  p.state.view.lanes.combos.inputAsOf='2026-09-16T10:00:00Z';
  assert.equal(V.comboPreviewForSize(parsed(p),2,p.now),undefined);
});
test('failed read, future source clock, new business day and expired quotes all hide only live previews', async () => {
  const p=memoryPorts(),r=createRuntime(p,{validators});await r.publishingCycle();const x=parsed(p);
  assert.equal(V.comboPreviewForSize(x,2,p.now,true),undefined);
  assert.equal(V.comboPreviewForSize(x,2,p.now+16*60000),undefined);
  assert.equal(V.comboPreviewForSize(x,2,p.now+86400000),undefined);
  x.lanes.combos.inputAsOf=new Date(p.now+60000).toISOString();
  assert.equal(V.comboPreviewForSize(x,2,p.now),undefined);
});
test('one frozen size does not hide the other live preview', async () => {
  const p=memoryPorts(),r=createRuntime(p,{validators});await r.publishingCycle();const x=parsed(p);
  // Test selector independence: the actual frozen result is separately rendered.
  x.todayCombos.push({ combo:{...x.previews[0],frozenAt:new Date(p.now).toISOString()},settlement:{state:'PENDING'} });
  assert.equal(V.comboPreviewForSize(x,2,p.now),undefined);
  assert.ok(V.comboPreviewForSize(x,3,p.now));
});
test('combo lane candidate counts and as-of survive frontend normalization', async () => {
  const p=memoryPorts(),r=createRuntime(p,{validators});await r.publishingCycle();
  const x=parsed(p);assert.equal(x.lanes.combos.candidateCount,3);assert.equal(x.lanes.combos.inputAsOf,new Date(p.now).toISOString());
});
