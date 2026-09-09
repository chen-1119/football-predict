"use strict";
// One publication algorithm, with explicit storage operations. The legacy
// synchronous API remains synchronous; native PostgreSQL awaits real I/O.
function runSynchronousPublication(iterator) {
  let step = iterator.next();
  while (!step.done) {
    try {
      if (step.value && typeof step.value.then === "function") throw new Error("asynchronous storage used by synchronous publication");
      step = iterator.next(step.value);
    } catch (error) { step = iterator.throw(error); }
  }
  return step.value;
}
async function runAsynchronousPublication(iterator) {
  let step = iterator.next();
  while (!step.done) {
    let value;
    try { value = await step.value; }
    catch (error) { step = iterator.throw(error); continue; }
    step = iterator.next(value);
  }
  return step.value;
}
module.exports = { runSynchronousPublication, runAsynchronousPublication };
