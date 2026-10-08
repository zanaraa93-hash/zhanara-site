function createMutex() {
  let tail = Promise.resolve();

  return function runExclusive(fn) {
    const run = tail.then(() => fn());
    // The chain must survive a rejected task, otherwise every later call fails too.
    tail = run.catch(() => {});
    return run;
  };
}

module.exports = { createMutex };
