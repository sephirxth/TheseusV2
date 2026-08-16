import { mkdir, open, readFile, unlink } from 'node:fs/promises';
import { audit } from './systemctl.ts';

/** O2b: someone else holds the lock and did not let go in time. */
export class LockBusy extends Error {
  override readonly name = 'LockBusy';
}

/** O2a: under $XDG_RUNTIME_DIR (tmpfs), so no lock can outlive the boot that made
 *  it; keyed by prefix, so the test instance never blocks a real one. */
export const lockPath = (prefix: string): string =>
  `${process.env['XDG_RUNTIME_DIR'] ?? `/run/user/${process.getuid?.() ?? 0}`}/theseus/${prefix}.lock`;

/**
 * O2: `up` and `down` never interleave, and whichever acquires last decides the
 * outcome. The lock is a file rather than a variable, so two shells can see each
 * other — which the in-memory epoch guard never could.
 */
export async function withLock<T>(
  prefix: string, what: string, waitMs: number, body: () => Promise<T>,
): Promise<T> {
  const path = lockPath(prefix);
  await mkdir(path.slice(0, path.lastIndexOf('/')), { recursive: true });
  const deadline = Date.now() + waitMs;
  for (;;) {
    try {
      const fh = await open(path, 'wx');              // O_EXCL: exactly one winner
      await fh.writeFile(`${process.pid}\n${what}\n`);
      await fh.close();
      audit(`lock acquire ${what}`);
      break;
    } catch (e) {
      if ((e as NodeJS.ErrnoException).code !== 'EEXIST') throw e;
    }
    const holder = (await readFile(path, 'utf8').catch(() => '')).trim();
    // A holder that no longer exists is not a holder. Without this, one crash
    // leaves an operator step — "go delete the lock file" — of exactly the kind
    // O4 exists to abolish.
    if (!alive(Number(holder.split('\n')[0]))) { await unlink(path).catch(() => {}); continue; }
    // O2b: wait, then name the holder. Never hang; never refuse instantly,
    // which would reject a `down` precisely while an `up` was running.
    if (Date.now() >= deadline) throw new LockBusy(`another theseus command holds ${path} `
      + `and did not finish within ${waitMs}ms. Holder: ${holder.split('\n').join(' ') || '(unreadable)'}`);
    await new Promise((r) => setTimeout(r, 25));
  }
  try { return await body(); } finally { audit('lock release'); await unlink(path).catch(() => {}); }
}

/** An unreadable holder counts as alive: never reap a lock we cannot account for. */
const alive = (pid: number): boolean => {
  if (!Number.isInteger(pid) || pid <= 0) return true;
  try { process.kill(pid, 0); return true; } catch (e) {
    return (e as NodeJS.ErrnoException).code === 'EPERM';   // alive, just not ours
  }
};
