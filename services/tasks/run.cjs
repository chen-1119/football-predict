'use strict';
const { spawn } = require('node:child_process');
const { rolePlan } = require('./roles.cjs');
// Child failure cannot stop the read API or another source process. Existing
// collector/publisher locks, retry timing, COMMIT/ACK and freeze gates remain.
function runTask(role, { spawnImpl = spawn, env = process.env, executable = process.execPath } = {}) {
  const plan = rolePlan(role);
  if (env.FOOTBALL_SERVICE_LAYOUT !== 'separated-v1') throw new Error('Separated task requires an explicit service-layout cutover');
  if (spawnImpl === spawn) throw Object.assign(new Error('WRITER_HANDOVER_UNIMPLEMENTED'), { code: 'WRITER_HANDOVER_UNIMPLEMENTED' });
  let child, timer, stopped = false;
  function launch() {
    if (stopped) return;
    child = spawnImpl(executable, [plan.script, ...plan.args], { cwd: plan.root, env: { ...env, ...plan.env }, stdio: 'inherit', shell: false, windowsHide: true });
    let completed = false;
    const finished = code => {
      if (completed) return;
      completed = true;
      child = null;
      if (stopped) return;
      if (code === 75) process.exitCode = 75;
      else if (plan.intervalMs) timer = setTimeout(launch, code === 0 ? plan.intervalMs : 30 * 60_000);
      else { process.exitCode = code === 0 ? 0 : 1; }
    };
    child.once('exit', finished);
    child.once('error', () => finished(1));
  }
  const stop = () => { stopped = true; clearTimeout(timer); child?.kill('SIGTERM'); };
  launch();
  return { stop, plan };
}
if (require.main === module) {
  const role = process.argv[2];
  if (process.argv.includes('--plan')) console.log(JSON.stringify({ ...rolePlan(role),
    writerResources: require('./writerResourcePlan.cjs').writerResourcePlan([role]),
  }, null, 2));
  else {
    // A layout flag cannot transfer production writer ownership. The root
    // handover controller and per-transaction fencing are not installed yet.
    rolePlan(role);
    console.error('WRITER_HANDOVER_UNIMPLEMENTED');
    process.exitCode = 75;
  }
}
module.exports = { runTask };
