import { test } from "node:test";
import assert from "node:assert/strict";
import { ForegroundScheduler, type SchedulerClock } from "../src/git-sync/scheduler";

function fakeClock() {
  let now = 0;
  const timers = new Map<ReturnType<typeof setTimeout>, { at: number; call: () => void }>();
  const clock: SchedulerClock = {
    now: () => now,
    setTimeout: (call, ms) => {
      const id = setTimeout(() => {}, 2 ** 30);
      id.unref();
      timers.set(id, { at: now + ms, call });
      return id;
    },
    clearTimeout: id => { clearTimeout(id); timers.delete(id); },
  };
  return {
    clock,
    async advance(ms: number) {
      now += ms;
      for (const [id, timer] of [...timers]) {
        if (timer.at <= now) { clock.clearTimeout(id); timer.call(); }
      }
      for (let i = 0; i < 8; i++) await Promise.resolve();
    },
  };
}

test("saved edits coalesce and foreground polling stops while hidden", async () => {
  const time = fakeClock();
  let runs = 0, visible = true;
  const scheduler = new ForegroundScheduler(async () => { runs++; }, () => true, () => visible, error => { throw error; }, time.clock);
  scheduler.schedule();
  await time.advance(2000);
  scheduler.schedule();
  await time.advance(2000);
  assert.equal(runs, 0);
  await time.advance(1000);
  assert.equal(runs, 1);
  visible = false;
  await time.advance(60000);
  assert.equal(runs, 1);
  visible = true;
  scheduler.schedule(0);
  await time.advance(0);
  assert.equal(runs, 2);
  scheduler.stop();
  await time.advance(120000);
  assert.equal(runs, 2);
});

test("simultaneous manual and automatic requests never overlap", async () => {
  const time = fakeClock();
  let runs = 0;
  let release: () => void = () => {};
  const scheduler = new ForegroundScheduler(async () => {
    runs++;
    await new Promise<void>(resolve => { release = resolve; });
  }, () => true, () => true, error => { throw error; }, time.clock);
  const first = scheduler.now();
  const second = scheduler.now();
  const third = scheduler.now();
  scheduler.schedule();
  assert.equal(runs, 1);
  release();
  await first;
  await Promise.resolve();
  // Manual requests made during a run coalesce into one follow-up run.
  assert.equal(runs, 2);
  release();
  await Promise.all([second, third]);
  assert.equal(runs, 2);
  scheduler.stop();
});

test("server retry deadline survives edits and manual sync; manual sync works with automatic off", async () => {
  const time = fakeClock();
  let runs = 0, automatic = true;
  const errors: unknown[] = [];
  const scheduler = new ForegroundScheduler(async () => {
    if (++runs === 1) throw Object.assign(new Error("rate limited"), { retryAt: 120000 });
  }, () => automatic, () => true, error => { errors.push(error); }, time.clock);
  await scheduler.now();
  scheduler.schedule(0);
  await time.advance(60000);
  await scheduler.now();
  assert.equal(runs, 1);
  assert.equal(errors.length, 2);
  await time.advance(60000);
  assert.equal(runs, 2);
  automatic = false;
  await time.advance(60000);
  assert.equal(runs, 2);
  await scheduler.now();
  assert.equal(runs, 3);
  scheduler.stop();
});

test("default timers retain the browser global receiver during schedule and stop", async () => {
  const { buildSync } = await import("esbuild");
  const { runInNewContext } = await import("node:vm");
  const result = buildSync({ entryPoints: ["src/git-sync/scheduler.ts"], bundle: true, platform: "browser", format: "cjs", write: false });
  const output = result.outputFiles[0].text;
  // Window timers accept a global invocation, but throw when borrowed as clock methods.
  runInNewContext(`
    let created = 0, cleared = 0;
    function setTimeout(callback, milliseconds) {
      if (this !== globalThis) throw Error('Illegal invocation');
      return ++created;
    }
    function clearTimeout(id) {
      if (this !== globalThis) throw Error('Illegal invocation');
      cleared++;
    }
    const module = { exports: {} };
    ${output}
    const scheduler = new module.exports.ForegroundScheduler(async () => {}, () => true, () => true, error => { throw error; });
    scheduler.schedule(); scheduler.schedule(); scheduler.stop();
    if (created !== 2 || cleared !== 2) throw Error('Timers were not scheduled and cleared');
  `);
});

test("idle foreground checks wait five minutes while saved edits still sync after three seconds", async () => {
  const time = fakeClock();
  let runs = 0;
  const scheduler = new ForegroundScheduler(async () => { runs++; }, () => true, () => true, error => { throw error; }, time.clock);
  await scheduler.now();
  await time.advance(60000);
  assert.equal(runs, 1);
  await time.advance(239999);
  assert.equal(runs, 1);
  await time.advance(1);
  assert.equal(runs, 2);
  scheduler.schedule();
  await time.advance(2999);
  assert.equal(runs, 2);
  await time.advance(1);
  assert.equal(runs, 3);
  scheduler.stop();
});
