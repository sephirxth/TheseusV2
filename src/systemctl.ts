import { execFile } from 'node:child_process';
import { appendFileSync } from 'node:fs';

/** E7: the user instance itself is unreachable. Never degrade into "nothing is running". */
export class SystemdUnavailable extends Error {
  override readonly name = 'SystemdUnavailable';
}

const UNREACHABLE = /Failed to connect to (the )?bus|Refusing to operate|D-?Bus connection|No such file or directory.*bus/i;

/** Every systemctl call in the codebase goes through here, so E7 has one place to live. */
export const audit = (line: string): void => {
  const log = process.env['THESEUS_EXEC_LOG'];
  if (log) appendFileSync(log, `${process.pid} ${line}\n`);
};

export function systemctl(argv: readonly string[]): Promise<string> {
  audit(`systemctl --user ${argv.join(' ')}`);
  return new Promise((resolve, reject) => {
    execFile('systemctl', ['--user', ...argv], { maxBuffer: 1 << 24 }, (err, stdout, stderr) => {
      if (!err) return resolve(stdout);
      if (UNREACHABLE.test(stderr) || UNREACHABLE.test(String(err.message))) {
        return reject(new SystemdUnavailable(
          `systemd user instance is unreachable, so nothing can be reported about ` +
          `any part. This is not the same as "nothing is running". systemctl said: ${stderr.trim()}`));
      }
      // I4: the exit code is reported as whatever the OS gave us, including
      // nothing at all. We do not invent a number to stand in for "not reported".
      reject(new Error(
        `systemctl --user ${argv.join(' ')} exited ${err.code ?? '(no exit code reported)'}: ${stderr.trim()}`));
    });
  });
}

/**
 * One call for N units (P3). unit -> its raw ActiveState plus whether systemd
 * knows the unit at all. `known` must come from systemd's own LoadState, never
 * from the disk: a unit whose file was deleted while it was running is still
 * loaded and still running, and asking the disk would report it as absent.
 */
export async function unitStates(
  units: readonly string[],
): Promise<Map<string, { active: string; known: boolean }>> {
  const out = new Map<string, { active: string; known: boolean }>();
  if (units.length === 0) return out;
  // `show` never starts anything (P1) and never fails on unknown units.
  const stdout = await systemctl(
    ['show', '--property=Id', '--property=ActiveState', '--property=LoadState', ...units]);
  for (const block of stdout.split('\n\n')) {
    const id = /^Id=(.*)$/m.exec(block)?.[1];
    const active = /^ActiveState=(.*)$/m.exec(block)?.[1];
    const load = /^LoadState=(.*)$/m.exec(block)?.[1];
    if (id && active !== undefined) out.set(id, { active, known: load !== 'not-found' });
  }
  return out;
}

/**
 * Units systemd currently holds under our prefix — including ones with no file
 * on disk. Read-only, and the prefix filter is applied here in our own code:
 * no glob is ever handed to systemctl.
 */
export async function loadedUnits(prefix: string): Promise<string[]> {
  const stdout = await systemctl(['list-units', '--all', '--type=service', '--no-legend', '--plain']);
  return stdout.split('\n')
    .map((line) => line.trim().split(/\s+/)[0] ?? '')
    .filter((u) => u.startsWith(prefix) && u.endsWith('.service'));
}
