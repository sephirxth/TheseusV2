import assert from 'node:assert/strict';
import { readFileSync, readdirSync } from 'node:fs';
import { test } from 'node:test';

const SRC = new URL('../src/', import.meta.url).pathname;
const files = readdirSync(SRC).map((f) => [f, readFileSync(SRC + f, 'utf8')] as const);

// I2a — `theseus-bridge-runtime.service` was made with `systemd-run --unit=…`.
// It had no file on disk and vanished from the unit list the moment it stopped.
test('I2a: no transient units — `systemd-run` appears nowhere in the source', () => {
  const offenders = files.filter(([, body]) => body.includes('systemd-run')).map(([f]) => f);
  assert.deepEqual(offenders, [], `transient-unit creation found in: ${offenders.join(', ')}`);
});

test('I2a: every unit we touch comes from a file we wrote — no --runtime, no --transient', () => {
  for (const [f, body] of files) {
    assert.ok(!/--transient|--runtime\b/.test(body), `${f} creates units that leave nothing on disk`);
  }
});

// One choke point for talking to systemd is what makes E7 a single arm rather
// than a thing every call site has to remember.
// Running a process at all means importing `node:child_process`, so that import
// IS the property — and it is the whole property. The earlier form matched the
// bare text `exec(`, which is not process execution: `db.exec('PRAGMA …')` in
// trace.ts tripped it while running nothing. It also let `execSync` through.
// Naming the import instead is both narrower on false alarms and wider on real ones.
test('every systemctl invocation goes through src/systemctl.ts', () => {
  const strays = files
    .filter(([f]) => f !== 'systemctl.ts')
    .filter(([, body]) => /child_process/.test(body))
    .map(([f]) => f);
  assert.deepEqual(strays, [], `these run processes without going through the wrapper: ${strays}`);
});
