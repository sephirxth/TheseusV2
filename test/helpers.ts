import { execFileSync } from 'node:child_process';
import { existsSync, mkdtempSync, readFileSync, readdirSync, rmSync } from 'node:fs';
import { homedir, tmpdir } from 'node:os';

/**
 * SAFETY. Every unit these tests create is named `theseus-t-<something>.service`.
 * The real system's units are `theseus.service`, `theseus-runtime-liveness.*`,
 * `theseus-bridge-runtime.*` and they are deliberately stopped. Nothing here
 * ever passes a glob to systemctl: unit names are enumerated from the directory,
 * filtered by this prefix, and passed one by one as literal arguments.
 */
export const PREFIX = 'theseus-t-';
export const UNIT_DIR = `${homedir()}/.config/systemd/user`;

/**
 * 名字里带进程号。**`/tmp` 是全机器共用的**：不带进程号时，两个测试进程的临时目录
 * 长得一模一样，谁也说不清一个残留是谁留的——收尾那种"扫一遍 /tmp，这个前缀的都不许剩"
 * 的检验于是会指着隔壁说你漏了（实测响过）。带上进程号，每个残留都认得回它的主人。
 */
export const mkTraceDir = (): string => mkdtempSync(`${tmpdir()}/theseus-t-trace-${process.pid}-`);

/** Unit files on disk that belong to the tests. Never matches the real system's. */
export function testUnitFiles(): string[] {
  return readdirSync(UNIT_DIR).filter((f) => f.startsWith(PREFIX) && f.endsWith('.service'));
}

/**
 * Units systemd holds under the test prefix — including any with no file left on
 * disk. Those are exactly the ones that leak if teardown only looks at the disk,
 * which is how a `theseus-t-noisy.service` once survived a whole run.
 */
export function testUnitsHeldBySystemd(): string[] {
  return execFileSync(
    'systemctl', ['--user', 'list-units', '--all', '--type=service', '--no-legend', '--plain'],
    { encoding: 'utf8' },
  ).split('\n')
    .map((line) => line.trim().split(/\s+/)[0] ?? '')
    .filter((u) => u.startsWith(PREFIX) && u.endsWith('.service'));
}

export function cleanup(): void {
  const files = testUnitFiles();
  const all = [...new Set([...files, ...testUnitsHeldBySystemd()])];
  // One at a time: a single unloaded unit must not abort the stop of the rest.
  for (const u of all) {
    try { execFileSync('systemctl', ['--user', 'stop', u], { stdio: 'ignore' }); } catch { /* never loaded */ }
    try { execFileSync('systemctl', ['--user', 'reset-failed', u], { stdio: 'ignore' }); } catch { /* not failed */ }
  }
  for (const f of files) rmSync(`${UNIT_DIR}/${f}`, { force: true });
  if (all.length > 0) execFileSync('systemctl', ['--user', 'daemon-reload']);
}

/**
 * The kernel's answer to "what is in this unit", read from cgroup.procs.
 * `path` is null when systemd reports no control group, i.e. the unit holds nothing.
 */
export function cgroup(unit: string): { path: string | null; procs: string[] } {
  const rel = execFileSync(
    'systemctl', ['--user', 'show', '--property=ControlGroup', '--value', unit],
    { encoding: 'utf8' },
  ).trim();
  if (!rel) return { path: null, procs: [] };
  for (const root of ['/sys/fs/cgroup/unified', '/sys/fs/cgroup']) {
    const p = `${root}${rel}/cgroup.procs`;
    if (existsSync(p)) {
      return { path: p, procs: readFileSync(p, 'utf8').split('\n').filter(Boolean) };
    }
  }
  return { path: null, procs: [] };  // systemd released the cgroup: nothing is left
}

/** Wait for a condition by polling. Only ever used BEFORE a `down()`, never after. */
export async function until(what: string, f: () => boolean | Promise<boolean>, ms = 5000): Promise<void> {
  const deadline = Date.now() + ms;
  while (Date.now() < deadline) {
    if (await f()) return;
    await new Promise((r) => setTimeout(r, 20));
  }
  throw new Error(`timed out waiting for: ${what}`);
}
