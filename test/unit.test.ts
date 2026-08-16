import assert from 'node:assert/strict';
import { test } from 'node:test';
import { unitName, unitText } from '../src/unit.ts';

const P = 'theseus-t-';
const TR = '/tmp/trace';
const part = (name: string, needs: string[], command = 'exec sleep 1') => ({ name, needs, command });
const withReady = (ready: string) => ({ ...part('a', []), ready });

// O1 — the requirements doc calls out picking the wrong field as OUR bug:
// After= orders, Requires= governs existence. `needs` means both.
test('O1: needs becomes BOTH Requires= and After=', () => {
  const t = unitText(part('b', ['a']), P, TR);
  assert.match(t, /^Requires=theseus-t-a\.service$/m);
  assert.match(t, /^After=theseus-t-a\.service$/m);
});

test('O1: multiple needs land on one line each, in declaration order', () => {
  const t = unitText(part('c', ['a', 'b']), P, TR);
  assert.match(t, /^Requires=theseus-t-a\.service theseus-t-b\.service$/m);
  assert.match(t, /^After=theseus-t-a\.service theseus-t-b\.service$/m);
});

test('O1: no needs means neither line, not an empty one', () => {
  const t = unitText(part('a', []), P, TR);
  assert.doesNotMatch(t, /Requires=/);
  assert.doesNotMatch(t, /After=/);
});

test('the translation is deterministic — this is what makes drift detectable by bytes', () => {
  assert.equal(unitText(part('a', ['x']), P, TR), unitText(part('a', ['x']), P, TR));
});

test('% is escaped: systemd would otherwise read it as a specifier', () => {
  assert.match(unitText(part('a', [], 'date +%s'), P, TR), /ExecStart=.*date \+%%s/);
});

test('quotes in a command are escaped rather than ending the argument', () => {
  assert.match(unitText(part('a', [], 'echo "hi"'), P, TR), /ExecStart=\/bin\/sh -c "echo \\"hi\\""/);
});

// P2 — down must have an upper bound; the bound lives in the unit.
test('P2: the generated unit carries a finite TimeoutStopSec', () => {
  const [, secs] = /^TimeoutStopSec=(\d+)$/m.exec(unitText(part('a', []), P, TR)) ?? [];
  assert.ok(secs && Number(secs) > 0 && Number.isFinite(Number(secs)));
});

// I5b — "is there a process" and "can it do its job" are two questions. Only the
// declaration can answer the second, and `ready` is where it says so.
test('I5b: `ready` becomes the ExecStartPost that holds the unit in `activating`', () => {
  const t = unitText(withReady('test -e /tmp/x'), P, TR);
  assert.match(t, /^ExecStartPost=\/bin\/sh -c "until test -e \/tmp\/x; do sleep 0\.1; done"$/m);
});

test('I5b: no `ready` means neither line, not an empty one', () => {
  const t = unitText(part('a', []), P, TR);
  assert.doesNotMatch(t, /ExecStartPost/);
  assert.doesNotMatch(t, /TimeoutStartSec/);
  // Byte-for-byte: dropping the two lines from the `ready` version reproduces it
  // exactly, so nothing is left behind where they would have been.
  assert.equal(t, unitText(withReady('true'), P, TR)
    .replace(/^ExecStartPost=.*\n/m, '').replace(/^TimeoutStartSec=.*\n/m, ''));
});

test('I5b: `ready` is escaped exactly like the command — % would otherwise be a specifier', () => {
  const t = unitText(withReady('test -n "$(date +%s)"'), P, TR);
  assert.match(t, /^ExecStartPost=\/bin\/sh -c "until test -n \\"\$\(date \+%%s\)\\"; do sleep 0\.1; done"$/m);
});

// P2 again, for the other direction: waiting for "ready yet?" also needs a bound.
test('P2: a `ready` check carries a finite TimeoutStartSec, and it is configurable', () => {
  const [, secs] = /^TimeoutStartSec=(\d+)ms$/m.exec(unitText(withReady('true'), P, TR)) ?? [];
  assert.ok(secs && Number(secs) > 0 && Number.isFinite(Number(secs)));
  assert.match(unitText(withReady('true'), P, TR, 250), /^TimeoutStartSec=250ms$/m);
});

test('trace output is append-only, both streams (§5)', () => {
  const t = unitText(part('a', []), P, TR);
  assert.match(t, /^StandardOutput=append:\/tmp\/trace\/a\.log$/m);
  assert.match(t, /^StandardError=append:\/tmp\/trace\/a\.log$/m);
});

test('unit names carry the prefix, which is what keeps the test instance off the real one', () => {
  assert.equal(unitName('theseus-t-', 'x'), 'theseus-t-x.service');
  assert.ok(!unitName('theseus-t-', 'x').startsWith('theseus-runtime'));
});
