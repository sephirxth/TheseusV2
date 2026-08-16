import assert from 'node:assert/strict';
import { mkdtempSync, readdirSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { afterEach, test } from 'node:test';
import { DeclarationError, Theseus } from '../src/theseus.ts';

/** Written down when made, removed when the test ends — the same bookkeeping the
 *  acceptance file does with `tmpDirs`. A sandbox that is never deleted is a pile. */
const tmpDirs: string[] = [];

/** A sandbox nowhere near ~/.config/systemd/user, so "no file appeared" is checkable. */
const sandbox = () => {
  const unitDir = mkdtempSync(`${tmpdir()}/theseus-t-units-`);
  tmpDirs.push(unitDir);
  return { unitDir, t: new Theseus({ unitDir, traceDir: `${unitDir}/trace`, prefix: 'theseus-t-' }) };
};

afterEach(() => {
  for (const d of tmpDirs.splice(0)) rmSync(d, { recursive: true, force: true });
});

// E4 — reject before generating any unit. Waiting for systemd to notice puts the
// error a long way from the declaration that caused it.
test('E4: a dependency cycle is rejected and names the chain', async () => {
  const { unitDir, t } = sandbox();
  t.add({ name: 'a', needs: ['b'], command: 'exec sleep 1' });
  t.add({ name: 'b', needs: ['c'], command: 'exec sleep 1' });
  t.add({ name: 'c', needs: ['a'], command: 'exec sleep 1' });
  await assert.rejects(t.up(), (e: Error) => {
    assert.equal(e.name, 'DeclarationError');
    assert.match(e.message, /dependency cycle: a -> b -> c -> a/);
    return true;
  });
  assert.deepEqual(readdirSync(unitDir), [], 'a unit file was written despite a cycle');
});

test('E4: a missing dependency is rejected and names the chain', async () => {
  const { unitDir, t } = sandbox();
  t.add({ name: 'a', needs: ['ghost'], command: 'exec sleep 1' });
  await assert.rejects(t.up(), (e: Error) => {
    assert.equal(e.name, 'DeclarationError');
    assert.match(e.message, /undeclared dependency: a -> ghost/);
    return true;
  });
  assert.deepEqual(readdirSync(unitDir), [], 'a unit file was written despite a missing dependency');
});

test('E4: the check covers every declaration, not just the one named in up()', async () => {
  const { unitDir, t } = sandbox();
  t.add({ name: 'ok', needs: [], command: 'exec sleep 1' });
  t.add({ name: 'broken', needs: ['ghost'], command: 'exec sleep 1' });
  await assert.rejects(t.up('ok'), DeclarationError);
  assert.deepEqual(readdirSync(unitDir), []);
});

test('a part name that could escape the unit directory is refused', () => {
  const { t } = sandbox();
  assert.throws(() => t.add({ name: '../evil', needs: [], command: 'x' }), DeclarationError);
  assert.throws(() => t.add({ name: 'a b', needs: [], command: 'x' }), DeclarationError);
});

test('a multi-line command is refused: it would silently truncate in the unit file', () => {
  const { t } = sandbox();
  assert.throws(() => t.add({ name: 'a', needs: [], command: 'x\nExecStop=rm -rf /' }), DeclarationError);
});

test('a multi-line `ready` is refused for the same reason as the command', () => {
  const { t } = sandbox();
  assert.throws(() => t.add({ name: 'a', needs: [], command: 'x', ready: 'true\nExecStop=rm -rf /' }),
    DeclarationError);
});

test('declaring the same part twice is refused (I2: the declaration is the only entry)', () => {
  const { t } = sandbox();
  t.add({ name: 'a', needs: [], command: 'x' });
  assert.throws(() => t.add({ name: 'a', needs: [], command: 'y' }), DeclarationError);
});
