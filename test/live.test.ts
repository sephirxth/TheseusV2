import assert from 'node:assert/strict';
import { execFileSync, spawn, spawnSync } from 'node:child_process';
import { existsSync, mkdirSync, mkdtempSync, readFileSync, rmSync, statSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { dirname } from 'node:path';
import { after, afterEach, test } from 'node:test';
import { lockPath } from '../src/lock.ts';
import { SystemdUnavailable } from '../src/systemctl.ts';
import { Theseus } from '../src/theseus.ts';
import { PREFIX, UNIT_DIR, cgroup, cleanup, mkTraceDir, testUnitFiles, until } from './helpers.ts';

/**
 * Everything this file puts under /tmp is written down and removed again — the
 * same bookkeeping the acceptance file does with `tmpDirs`, extended to the exec
 * logs, which are files rather than directories.
 *
 * Removed after each test, not at the end of the run: waiting until the end
 * means the pile is still growing while the run is going, and a run that is
 * killed leaves all of it behind. `heldToEnd` is the one exception — O3
 * deliberately re-reads its trace file in `after()`, seconds of real time
 * later, to show the trace stopped growing.
 */
const tmpPaths: string[] = [];
const heldToEnd: string[] = [];
const keep = (p: string): string => { tmpPaths.push(p); return p; };
const tmpTrace = (): string => keep(mkTraceDir());
const drop = (paths: string[]): void => {
  for (const p of paths.splice(0)) rmSync(p, { recursive: true, force: true });
};

// Real systemctl --user throughout. No mocks.
const mk = () => {
  const traceDir = tmpTrace();
  return { traceDir, t: new Theseus({ unitDir: UNIT_DIR, traceDir, prefix: PREFIX }) };
};
const settled = (t: Theseus, name: string) => async () => {
  const s = (await t.status()).parts.find((p) => p.name === name)?.state.kind;
  return s !== 'starting' && s !== 'stopping';
};

afterEach(() => { cleanup(); drop(tmpPaths); });

test('I1 + idempotence: three ups leave one process, and daemon-reload is issued once', async () => {
  const { t } = mk();
  t.add({ name: 'once', needs: [], command: 'exec sleep 3000' });
  const log = keep(`${tmpdir()}/theseus-t-exec-${process.pid}.log`);
  rmSync(log, { force: true });
  process.env['THESEUS_EXEC_LOG'] = log;
  try {
    await t.up();
    await t.up();
    await t.up();
  } finally { delete process.env['THESEUS_EXEC_LOG']; }

  const cg = cgroup(`${PREFIX}once.service`);
  assert.equal(cg.procs.length, 1, `cgroup ${cg.path} holds ${cg.procs.length} processes: ${cg.procs}`);
  const lines = readFileSync(log, 'utf8').trim().split('\n');
  assert.equal(lines.filter((l) => l.includes('daemon-reload')).length, 1,
    `daemon-reload was issued when nothing changed:\n${lines.join('\n')}`);
  assert.equal(lines.filter((l) => l.includes(' start ')).length, 3);
});

test('I6: down takes the whole process tree with it — cgroup.procs is empty', async () => {
  const { t } = mk();
  t.add({ name: 'tree', needs: [], command: '/bin/sh -c "sleep 3000 & sleep 3000 & wait"' });
  await t.up();
  const unit = `${PREFIX}tree.service`;
  await until('grandchildren to appear', () => cgroup(unit).procs.length >= 3);
  const before = cgroup(unit);
  assert.ok(before.path, 'no cgroup path to read — the test is not looking at the kernel');
  console.log(`  I6: before down, ${before.path} holds ${before.procs.length}: ${before.procs.join(' ')}`);

  await t.down();
  const now = cgroup(unit);
  assert.deepEqual(now.procs, [], `cgroup still holds ${now.procs.join(' ')}`);
});

let o3: { trace: string; sizeAtReturn: number } | null = null;

test('O3: down() returning means it really stopped — asserted at the instant it returns', async () => {
  // Not `mk()`: this one trace dir has to outlive its own test, because `after()`
  // reads the file again at the end of the run.
  const traceDir = mkTraceDir();
  heldToEnd.push(traceDir);
  const t = new Theseus({ unitDir: UNIT_DIR, traceDir, prefix: PREFIX });
  t.add({ name: 'noisy', needs: [], command: '/bin/sh -c "while :; do date; sleep 0.05; done"' });
  await t.up();
  const trace = `${traceDir}/noisy.log`;
  await until('the part to write something', () => existsSync(trace) && statSync(trace).size > 0);
  const first = statSync(trace).size;
  await until('the trace file to grow', () => statSync(trace).size > first);
  const growing = statSync(trace).size;

  await t.down();
  // Everything below runs with no sleep and no polling: this is the instant down() returned.
  assert.deepEqual(cgroup(`${PREFIX}noisy.service`).procs, [], 'a process survived down()');
  const sizeAtReturn = statSync(trace).size;
  for (let i = 0; i < 500; i++) assert.equal(statSync(trace).size, sizeAtReturn);
  console.log(`  O3: grew ${first}B -> ${growing}B while running; ${sizeAtReturn}B at the instant down() returned`);
  o3 = { trace, sizeAtReturn };   // re-checked in after(), several seconds of real time later
});

test('§5 migration: delete every generated unit file, run up, everything comes back', async () => {
  const { t } = mk();
  t.add({ name: 'm1', needs: [], command: 'exec sleep 3000' });
  t.add({ name: 'm2', needs: ['m1'], command: 'exec sleep 3000' });
  await t.up();
  await t.down();

  for (const f of testUnitFiles()) rmSync(`${UNIT_DIR}/${f}`, { force: true });
  execFileSync('systemctl', ['--user', 'daemon-reload']);
  assert.deepEqual(testUnitFiles(), [], 'setup failed: unit files were not deleted');
  const gone = await t.status();
  assert.deepEqual(gone.parts.map((p) => p.state.kind), ['not-installed', 'not-installed']);
  assert.equal(gone.missingUnits.length, 2);

  await t.up();                                   // one command, no install step
  const back = await t.status();
  assert.deepEqual(back.parts.map((p) => p.state.kind), ['running', 'running']);
  assert.ok(back.parts.every((p) => p.unitMatchesDeclaration), 'recovered units do not match the declaration');
  assert.deepEqual([...back.missingUnits], []);
});

test('I2b: drift is reported in both directions', async () => {
  const { t } = mk();
  t.add({ name: 'kept', needs: [], command: 'exec sleep 3000' });
  t.add({ name: 'deleted', needs: [], command: 'exec sleep 3000' });
  await t.up();

  // Direction 1: installed here, produced by no declaration.
  writeFileSync(`${UNIT_DIR}/${PREFIX}orphan.service`, '[Service]\nExecStart=/bin/true\n');
  // Direction 2: declared, no unit installed.
  await t.down('deleted');
  rmSync(`${UNIT_DIR}/${PREFIX}deleted.service`, { force: true });

  const s = await t.status();
  assert.deepEqual([...s.orphanUnits], [`${PREFIX}orphan.service`], 'orphan unit not named');
  assert.deepEqual([...s.missingUnits], [`${PREFIX}deleted.service`], 'missing unit not named');
  assert.equal(s.parts.find((p) => p.name === 'deleted')?.state.kind, 'not-installed');
  assert.equal(s.parts.find((p) => p.name === 'kept')?.state.kind, 'running');
});

test('I2b: a hand-edited unit is reported as not matching its declaration', async () => {
  const { t } = mk();
  t.add({ name: 'edited', needs: [], command: 'exec sleep 3000' });
  await t.up();
  writeFileSync(`${UNIT_DIR}/${PREFIX}edited.service`, '[Service]\nExecStart=/bin/true\n');
  assert.equal((await t.status()).parts[0]?.unitMatchesDeclaration, false);
  await t.up();                                   // up repairs it
  assert.equal((await t.status()).parts[0]?.unitMatchesDeclaration, true);
});

/**
 * The disk is not the authority on what is running. Deleting a unit file does
 * not stop the process, and an adapter that filters by the disk reports the part
 * as `not-installed` and refuses to stop it — a running process hidden behind a
 * word that reads like "there is nothing here". This is U2 and U6 at once.
 */
test('a part whose unit file is deleted while it runs stays visible, and down() still stops it', async () => {
  const { t } = mk();
  t.add({ name: 'ghostly', needs: [], command: 'exec sleep 3000' });
  await t.up();
  const unit = `${PREFIX}ghostly.service`;
  rmSync(`${UNIT_DIR}/${unit}`, { force: true });   // the file goes; the process does not

  const s = await t.status();
  assert.equal(s.parts[0]?.state.kind, 'running', 'a running part vanished behind not-installed');
  assert.deepEqual([...s.missingUnits], [unit], 'the deleted unit file was not reported');
  assert.equal(s.parts[0]?.unitMatchesDeclaration, false);

  await t.down();
  assert.deepEqual(cgroup(unit).procs, [], 'down() returned success while the process kept running');
});

test('U6: a running unit with no file and no declaration is still named as drift', async () => {
  const { t } = mk();
  t.add({ name: 'ghost-orphan', needs: [], command: 'exec sleep 3000' });
  await t.up();
  const unit = `${PREFIX}ghost-orphan.service`;
  rmSync(`${UNIT_DIR}/${unit}`, { force: true });
  // Someone else's view: this instance declares nothing at all.
  const observer = new Theseus({ unitDir: UNIT_DIR, traceDir: tmpTrace(), prefix: PREFIX });
  const s = await observer.status();
  assert.ok(s.orphanUnits.includes(unit),
    `a running unit with no file went unreported: ${JSON.stringify(s.orphanUnits)}`);
  await t.down();
});

test('E7: an unreachable user instance is reported, not silently read as "nothing is running"', async () => {
  const { t } = mk();
  t.add({ name: 'e7', needs: [], command: 'exec sleep 3000' });
  await t.up();
  const saved = [process.env['XDG_RUNTIME_DIR'], process.env['DBUS_SESSION_BUS_ADDRESS']] as const;
  // A runtime dir that exists and is writable but holds no user bus — which is
  // exactly the shape of a remote session without lingering. (Pointing it at a
  // nonexistent path would instead break the lock, testing the wrong thing.)
  const noBus = keep(mkdtempSync(`${tmpdir()}/theseus-t-nobus-`));
  process.env['XDG_RUNTIME_DIR'] = noBus;
  process.env['DBUS_SESSION_BUS_ADDRESS'] = `unix:path=${noBus}/bus`;
  try {
    await assert.rejects(t.status(), (e: Error) => {
      assert.equal(e.name, 'SystemdUnavailable');
      assert.match(e.message, /not the same as "nothing is running"/);
      return true;
    });
    await assert.rejects(t.up(), SystemdUnavailable);
    await assert.rejects(t.down(), SystemdUnavailable);
  } finally {
    if (saved[0] !== undefined) process.env['XDG_RUNTIME_DIR'] = saved[0];
    if (saved[1] !== undefined) process.env['DBUS_SESSION_BUS_ADDRESS'] = saved[1];
    else delete process.env['DBUS_SESSION_BUS_ADDRESS'];
  }
  // The part was running the whole time the adapter could not see it.
  assert.equal((await t.status()).parts[0]?.state.kind, 'running');
});

test('O1 live: needs governs existence, not just order — Requires= is the right field', async () => {
  const { t } = mk();
  t.add({ name: 'dep', needs: [], command: 'exec sleep 3000' });
  t.add({ name: 'app', needs: ['dep'], command: 'exec sleep 3000' });
  await t.up('app');                              // only `app` was asked for
  assert.deepEqual((await t.status()).parts.map((p) => [p.name, p.state.kind]),
    [['dep', 'running'], ['app', 'running']], 'the dependency was not pulled up');

  await t.down('dep');                            // taking the dependency down
  await until('app to settle', settled(t, 'app'));
  assert.equal((await t.status()).parts.find((p) => p.name === 'app')?.state.kind, 'stopped',
    'app survived its dependency going away — After= without Requires=');
});

test('E1 + E6: a broken part reports failed, and the parts that came up stay up', async () => {
  const { t } = mk();
  t.add({ name: 'good', needs: [], command: 'exec sleep 3000' });
  t.add({ name: 'broken', needs: [], command: 'exec /nonexistent/binary' });
  await t.up().catch(() => { /* E6: `up` may report the failure; either way it does not roll back */ });
  await until('broken to settle', settled(t, 'broken'));
  const s = await t.status();
  assert.equal(s.parts.find((p) => p.name === 'broken')?.state.kind, 'failed');
  assert.equal(s.parts.find((p) => p.name === 'good')?.state.kind, 'running', 'E6: a good part was rolled back');
});

/** A separate OS process running one verb. Two of these is a genuinely concurrent pair. */
const inAnotherProcess = (verb: 'up' | 'down', traceDir: string, log: string) =>
  new Promise<void>((resolve, reject) => {
    const src = new URL('../src/theseus.ts', import.meta.url).href;
    const child = spawn(process.execPath, ['--input-type=module', '-e', `
      import { Theseus } from ${JSON.stringify(src)};
      const t = new Theseus(${JSON.stringify({ unitDir: UNIT_DIR, traceDir, prefix: PREFIX })});
      t.add({ name: 'race', needs: [], command: 'exec sleep 3000' });
      await t.${verb}();
    `], { env: { ...process.env, THESEUS_EXEC_LOG: log } });
    let err = '';
    child.stderr.on('data', (d) => { err += d; });
    child.on('close', (code) => code === 0 ? resolve() : reject(new Error(`child ${verb} exited ${code}: ${err}`)));
  });

/**
 * O2: the rule is "last one issued wins", not "stop wins".
 *
 * The claim under test is mutual exclusion, so the assertion reads the lock's
 * own audit trail: acquire and release must strictly alternate. An earlier
 * version of this test compared which child FINISHED last against the final
 * state — and passed even with the lock removed, because "finished last" tracks
 * "acted last" whether or not anything is serialized. It proved nothing.
 */
test('O2: up and down from two processes are serialized — no overlap, and the last holder decides', async () => {
  const { t, traceDir } = mk();
  t.add({ name: 'race', needs: [], command: 'exec sleep 3000' });
  await t.up();                                   // install first, so only the commands race
  const log = keep(`${tmpdir()}/theseus-t-o2-${process.pid}.log`);

  const seen: string[] = [];
  for (let round = 0; round < 6; round++) {
    rmSync(log, { force: true });
    await Promise.all([
      inAnotherProcess('up', traceDir, log),
      inAnotherProcess('down', traceDir, log),
    ]);
    const events = readFileSync(log, 'utf8').trim().split('\n').filter((l) => / lock (acquire|release)/.test(l));
    assert.equal(events.length, 4, `expected two acquire/release pairs, got:\n${events.join('\n')}`);
    events.forEach((e, i) => assert.ok(e.includes(`lock ${i % 2 === 0 ? 'acquire' : 'release'}`),
      `round ${round}: the two commands overlapped instead of taking turns:\n${events.join('\n')}`));

    // Whoever acquired last decides — not "stop wins", not chance.
    const last = events[2]?.includes('lock acquire up') ? 'running' : 'stopped';
    await until('the unit to settle', settled(t, 'race'));
    assert.equal((await t.status()).parts[0]?.state.kind, last,
      `round ${round}: the second command to hold the lock should have decided the outcome`);
    seen.push(last === 'running' ? 'up' : 'down');
  }
  console.log(`  O2: 6 rounds, second holder was [${seen.join(' ')}]; never overlapped, outcome matched all 6`);
});

test('O2b: a command that cannot get the lock waits, then fails naming the holder', async () => {
  const path = lockPath(PREFIX);
  mkdirSync(dirname(path), { recursive: true });
  writeFileSync(path, `${process.pid}\nup (all)\n`);      // a genuinely live holder: this process
  try {
    const blocked = new Theseus({
      unitDir: UNIT_DIR, traceDir: tmpTrace(), prefix: PREFIX, lockWaitMs: 400 });
    blocked.add({ name: 'busy', needs: [], command: 'exec sleep 3000' });
    const t0 = Date.now();
    await assert.rejects(blocked.up(), (e: Error) => {
      assert.equal(e.name, 'LockBusy');
      assert.match(e.message, new RegExp(`\\b${process.pid}\\b`), 'the error does not name the holder');
      return true;
    });
    const waited = Date.now() - t0;
    assert.ok(waited >= 400, `gave up after ${waited}ms — it refused instantly instead of waiting`);
    assert.ok(waited < 5000, `waited ${waited}ms — that is not a bounded wait`);
    console.log(`  O2b: waited ${waited}ms, then named holder pid ${process.pid}`);
  } finally { rmSync(path, { force: true }); }
});

test('O2a: the lock lives on tmpfs and is keyed by prefix, so it cannot wedge a different instance', async () => {
  assert.ok(lockPath(PREFIX).startsWith(process.env['XDG_RUNTIME_DIR'] ?? '\0'),
    `the lock is not under XDG_RUNTIME_DIR, so a reboot would not clear it: ${lockPath(PREFIX)}`);
  assert.notEqual(lockPath(`${PREFIX}alt-`), lockPath(PREFIX));

  const held = lockPath(PREFIX);
  mkdirSync(dirname(held), { recursive: true });
  writeFileSync(held, `${process.pid}\nup (all)\n`);
  try {
    const other = new Theseus({
      unitDir: UNIT_DIR, traceDir: tmpTrace(), prefix: `${PREFIX}alt-`, lockWaitMs: 400 });
    other.add({ name: 'x', needs: [], command: 'exec sleep 3000' });
    await other.up();                             // a different prefix must not be blocked
    assert.equal((await other.status()).parts[0]?.state.kind, 'running');
    await other.down();
  } finally { rmSync(held, { force: true }); }
});

test('O2a: a lock left behind by a process that no longer exists does not wedge the system', async () => {
  const { t } = mk();
  t.add({ name: 'stale', needs: [], command: 'exec sleep 3000' });
  const path = lockPath(PREFIX);
  mkdirSync(dirname(path), { recursive: true });
  const gone = spawnSync(process.execPath, ['-e', 'process.exit(0)']);   // this pid is now free
  writeFileSync(path, `${gone.pid}\nup (all)\n`);
  await t.up();                                   // must neither hang nor refuse
  assert.equal((await t.status()).parts[0]?.state.kind, 'running');
  await t.down();
});

test('I3: a part does not depend on the adapter process staying alive', async () => {
  const { traceDir, t } = mk();
  t.add({ name: 'orphaned', needs: [], command: 'exec sleep 3000' });
  const src = new URL('../src/theseus.ts', import.meta.url).href;
  // A DIFFERENT process declares it and brings it up, then exits.
  const child = spawnSync(process.execPath, ['--input-type=module', '-e', `
    import { Theseus } from ${JSON.stringify(src)};
    const t = new Theseus(${JSON.stringify({ unitDir: UNIT_DIR, traceDir, prefix: PREFIX })});
    t.add({ name: 'orphaned', needs: [], command: 'exec sleep 3000' });
    await t.up();
  `], { encoding: 'utf8' });
  assert.equal(child.status, 0, `the child failed: ${child.stderr}`);

  // The process that started it is gone. Ask from here.
  assert.equal((await t.status()).parts[0]?.state.kind, 'running');
  const procs = cgroup(`${PREFIX}orphaned.service`).procs;
  assert.equal(procs.length, 1);
  const ppid = readFileSync(`/proc/${procs[0]}/stat`, 'utf8').split(') ').at(-1)?.split(' ')[1];
  assert.notEqual(ppid, String(child.pid), 'the part is still parented to the process that started it');
});

test('E3 + P2: a part that ignores SIGTERM is killed within TimeoutStopSec, never waited on forever', async () => {
  const { t } = mk();
  t.add({ name: 'stubborn', needs: [], command: `/bin/sh -c "trap '' TERM; while :; do sleep 1; done"` });
  await t.up();
  const unit = `${PREFIX}stubborn.service`;
  await until('it to be up', () => cgroup(unit).procs.length >= 1);

  const t0 = Date.now();
  await t.down();
  const elapsed = Date.now() - t0;
  assert.deepEqual(cgroup(unit).procs, [], 'the part survived down()');
  assert.ok(elapsed >= 5000, `down() returned in ${elapsed}ms — SIGTERM was not really ignored, so this proves nothing`);
  assert.ok(elapsed < 20_000, `down() took ${elapsed}ms — the wait is not bounded by TimeoutStopSec`);
  console.log(`  E3/P2: SIGTERM ignored; down() returned after ${elapsed}ms (TimeoutStopSec=10)`);
});

/** systemd's own word, asked directly. Not the code under test reporting on itself. */
const activeState = (unit: string): string => execFileSync(
  'systemctl', ['--user', 'show', '--property=ActiveState', '--value', unit], { encoding: 'utf8' }).trim();

/**
 * The evidence I5b exists for. Before it, `activating` was a translation arm
 * that never fired: sampling a part that needed 5s of setup, every 5ms, gave
 * 152 samples and not one `activating` — `Type=exec` calls a unit up the moment
 * `sh` execs. This test is the other half of that measurement: with a `ready`
 * check declared, the state is real, so the arm carries weight again.
 */
test('I5b: a part with a `ready` check really does pass through `activating`', async () => {
  const { t, traceDir } = mk();
  const readyFile = `${traceDir}/READY`;
  t.add({
    name: 'slowready', needs: [],
    command: `/bin/sh -c "sleep 2; touch ${readyFile}; exec sleep 3000"`,
    ready: `test -e ${readyFile}`,
  });
  const unit = `${PREFIX}slowready.service`;
  const seen: string[] = [];
  let sampling = true;
  const sampler = (async () => {
    while (sampling) {
      seen.push(activeState(unit));
      await new Promise((r) => setTimeout(r, 5));
    }
  })();
  await t.up();                                   // returns only once the check passed
  sampling = false;
  await sampler;
  seen.push(activeState(unit));

  const transitions = seen.filter((s, i) => s !== seen[i - 1]);
  const activating = seen.filter((s) => s === 'activating').length;
  console.log(`  I5b: ${seen.length} samples of ActiveState, ${activating} × activating; ` +
    `${transitions.join(' -> ')}`);
  assert.ok(activating > 0, `${seen.length} samples and not one 'activating' — the arm is still dead`);
  assert.deepEqual(transitions, ['inactive', 'activating', 'active'],
    `it did not go inactive -> activating -> active: ${transitions.join(' -> ')}`);
});

test('I5b + P2 + E3: a part that never becomes ready is failed — not stopped, not waited on forever', async () => {
  const t = new Theseus({ unitDir: UNIT_DIR, traceDir: tmpTrace(), prefix: PREFIX, readyTimeoutMs: 700 });
  t.add({ name: 'neverready', needs: [], command: 'exec sleep 3000', ready: 'false' });
  const t0 = Date.now();
  await assert.rejects(t.up(), /neverready/, 'up() returned as if a part that never became ready had started');
  const elapsed = Date.now() - t0;
  assert.ok(elapsed >= 700, `up() came back in ${elapsed}ms — it never waited, so this proves nothing`);
  assert.ok(elapsed < 20_000, `up() took ${elapsed}ms — the wait for readiness is not bounded`);

  await until('neverready to settle', settled(t, 'neverready'));
  assert.equal((await t.status()).parts[0]?.state.kind, 'failed',
    'the readiness check ran out of time and the part was not reported as failed');
  console.log(`  I5b/P2: ready never passed; up() failed after ${elapsed}ms (TimeoutStartSec=700ms)`);
});

test('P3: the cost of up, down and status does not grow with the number of parts', async () => {
  const log = keep(`${tmpdir()}/theseus-t-p3-${process.pid}.log`);
  const callsFor = async (n: number): Promise<Record<string, number>> => {
    const { t } = mk();
    for (let i = 0; i < n; i++) t.add({ name: `p3-${i}`, needs: [], command: 'exec sleep 3000' });
    const one = async (f: () => Promise<unknown>): Promise<number> => {
      rmSync(log, { force: true });
      process.env['THESEUS_EXEC_LOG'] = log;
      try { await f(); } finally { delete process.env['THESEUS_EXEC_LOG']; }
      return readFileSync(log, 'utf8').trim().split('\n').length;
    };
    const r = { status: await one(() => t.status()), up: await one(() => t.up()), down: await one(() => t.down()) };
    cleanup();
    return r;
  };
  const small = await callsFor(3);
  const large = await callsFor(12);
  console.log(`  P3: 3 parts -> ${JSON.stringify(small)};  12 parts -> ${JSON.stringify(large)}`);
  assert.deepEqual(large, small, 'the number of systemctl calls grew with the number of parts');
});

test('P1: status() starts nothing', async () => {
  const { t } = mk();
  t.add({ name: 'p1', needs: [], command: 'exec sleep 3000' });
  await t.up();
  await t.down();
  assert.equal((await t.status()).parts[0]?.state.kind, 'stopped');
  assert.equal((await t.status()).parts[0]?.state.kind, 'stopped');
  assert.deepEqual(cgroup(`${PREFIX}p1.service`).procs, []);
});

after(() => {
  try {
    if (o3) {
      assert.equal(statSync(o3.trace).size, o3.sizeAtReturn,
        'the trace file grew after down() returned');
      console.log(`  O3: still ${o3.sizeAtReturn}B at the end of the run`);
    }
    cleanup();
    assert.deepEqual(testUnitFiles(), [], 'a theseus-t-* unit file survived teardown');
  } finally {
    // In a `finally` so a red assertion above still cannot leave a pile behind.
    drop(tmpPaths);
    drop(heldToEnd);
  }
});
