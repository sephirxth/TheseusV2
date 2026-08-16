import assert from 'node:assert/strict';
import { test } from 'node:test';
import { KNOWN_ACTIVE_STATES, isRunning, type PartState } from '../src/part.ts';
import { translate } from '../src/state.ts';

const kind = (s: string): string => translate(s, true).kind;

// I4 — every ActiveState systemd can produce gets its own arm.
test('I4: each systemd ActiveState has its own arm, none shared', () => {
  const kinds = KNOWN_ACTIVE_STATES.map(kind);
  assert.deepEqual(kinds, ['running', 'reloading', 'starting', 'stopping', 'stopped', 'failed']);
  assert.equal(new Set(kinds).size, KNOWN_ACTIVE_STATES.length, 'two ActiveStates collapsed into one kind');
});

test('I4: activating is NOT running', () => {
  assert.notEqual(kind('activating'), 'running');
  assert.equal(isRunning(translate('activating', true)), false);
});

test('I4: deactivating is NOT stopped', () => {
  assert.notEqual(kind('deactivating'), 'stopped');
});

test('I4: failed is NOT stopped', () => {
  assert.notEqual(kind('failed'), 'stopped');
  assert.equal(kind('failed'), 'failed');
});

test('I4: reloading is its own state and is not a claim about the new config', () => {
  assert.equal(kind('reloading'), 'reloading');
});

test('I4: a unit that is not installed is its own state, not stopped', () => {
  // systemd really does answer ActiveState=inactive for units it never heard of
  // (verified: `systemctl --user show theseus-t-nope.service` -> inactive).
  // Believing that answer is exactly the lie this arm prevents.
  assert.equal(translate('inactive', false).kind, 'not-installed');
  assert.equal(translate('active', false).kind, 'not-installed');
});

test('I4: an unrecognised ActiveState surfaces raw, it does not fall through to a default', () => {
  const s: PartState = translate('mounting', true);
  assert.equal(s.kind, 'untranslatable');
  assert.equal('raw' in s ? s.raw : null, 'mounting');
  assert.equal(isRunning(s), false);
});

test('I4: only `running` is a claim that the part is up', () => {
  const all = [...KNOWN_ACTIVE_STATES.map((s) => translate(s, true)),
    translate('inactive', false), translate('nonsense', true)];
  assert.deepEqual(all.filter(isRunning).map((s) => s.kind), ['running']);
});
