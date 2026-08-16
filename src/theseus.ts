import { mkdir, readFile, readdir, writeFile } from 'node:fs/promises';
import { homedir } from 'node:os';
import type { Part, PartState } from './part.ts';
import { withLock } from './lock.ts';
import { translate } from './state.ts';
import { loadedUnits, systemctl, unitStates } from './systemctl.ts';
import { READY_TIMEOUT_MS, unitName, unitText } from './unit.ts';

/** Something wrong with the declarations themselves. Raised before touching the disk. */
export class DeclarationError extends Error {
  override readonly name = 'DeclarationError';
}

export interface PartStatus {
  readonly name: string;
  readonly unit: string;
  readonly state: PartState;
  /** false = a unit is installed but its bytes are not what the declaration generates. */
  readonly unitMatchesDeclaration: boolean;
}

export interface Status {
  readonly parts: readonly PartStatus[];
  /** I2b, one direction: installed under our prefix, produced by no declaration. */
  readonly orphanUnits: readonly string[];
  /** I2b, the other direction: declared, but no unit installed. */
  readonly missingUnits: readonly string[];
}

export interface Options {
  readonly unitDir?: string;
  readonly traceDir?: string;
  readonly prefix?: string;
  /** O2b: how long a command waits for the lock before naming the holder and failing. */
  readonly lockWaitMs?: number;
  /** I5b/P2: how long a part's `ready` check may keep saying "not yet" before it is failed. */
  readonly readyTimeoutMs?: number;
}

export class Theseus {
  readonly unitDir: string;
  readonly prefix: string;
  readonly traceDir: string;
  readonly lockWaitMs: number;
  readonly readyTimeoutMs: number;
  readonly #parts = new Map<string, Part>();

  constructor(o: Options = {}) {
    this.unitDir = o.unitDir ?? `${homedir()}/.config/systemd/user`;
    this.lockWaitMs = o.lockWaitMs ?? 10_000;
    this.readyTimeoutMs = o.readyTimeoutMs ?? READY_TIMEOUT_MS;
    this.prefix = o.prefix ?? 'theseus-';
    this.traceDir = o.traceDir ?? `${homedir()}/.local/state/theseus/trace`;
  }

  add(part: Part): void {
    if (!/^[a-z0-9][a-z0-9._-]*$/.test(part.name)) {
      throw new DeclarationError(`part name '${part.name}' is not usable in a unit name`);
    }
    if (this.#parts.has(part.name)) throw new DeclarationError(`part '${part.name}' declared twice`);
    // A newline in either would end the directive early and turn the rest of the
    // string into unit-file syntax of its own.
    if (/[\n\r]/.test(part.command)) {
      throw new DeclarationError(`part '${part.name}': command must be a single line`);
    }
    if (part.ready !== undefined && /[\n\r]/.test(part.ready)) {
      throw new DeclarationError(`part '${part.name}': ready must be a single line`);
    }
    this.#parts.set(part.name, part);
  }

  /**
   * `up` is a state, not an action: when it returns without throwing, the units
   * on disk match the declarations and the requested parts have been started.
   *
   * E6 (was undefined in the requirements — decided here): **no rollback.**
   * If a part fails to start, whatever came up stays up and the error names the
   * failure. Rolling back would tear down parts that are correctly running, and
   * the rollback itself can fail — leaving a state nobody declared. `up` is
   * idempotent, so the repair for a partial start is to fix the part and run
   * `up` again; that reaches the declared state from wherever it stopped.
   *
   * Honest limitation: `ExecStart` is `/bin/sh -c "…"`, so systemd considers a
   * unit started the moment `sh` execs. A command that is broken INSIDE the
   * shell therefore usually cannot be caught here — it surfaces at the next
   * `status` as `failed`. E1 still holds (nothing is ever reported running),
   * but in practice `up` reports the failure late rather than at the failure.
   *
   * A part that declares `ready` (I5b) narrows that gap for itself: `up` does
   * not return until its check passes, and a part that never becomes ready
   * fails here rather than later. The gap is only closed for parts that say
   * what ready means — which is the whole point of the field being optional.
   */
  async up(name?: string): Promise<void> {
    const order = this.#plan();          // E4 — before the lock, and before anything is written
    const target = name ? [this.#get(name)] : order;
    // O2: serialized against every other process, not just other calls on this
    // object. `status` is read-only and deliberately takes no lock.
    await withLock(this.prefix, `up ${name ?? '(all)'}`, this.lockWaitMs, async () => {
      await mkdir(this.unitDir, { recursive: true });
      await mkdir(this.traceDir, { recursive: true });
      let changed = false;
      for (const p of order) changed = (await this.#sync(p)) || changed;
      if (changed) await systemctl(['daemon-reload']); // only when something actually moved
      if (target.length > 0) {
        await systemctl(['start', ...target.map((p) => unitName(this.prefix, p.name))]);
      }
    });
  }

  /** O3 is systemd's: when `stop` returns, it is stopped. */
  async down(name?: string): Promise<void> {
    const target = name ? [this.#get(name)] : [...this.#parts.values()];
    await withLock(this.prefix, `down ${name ?? '(all)'}`, this.lockWaitMs, async () => {
      // What systemd HOLDS decides what can be stopped — not what is on disk. A
      // unit whose file was deleted while it ran is still loaded and still
      // running; filtering by the disk would skip it and return "stopped" while
      // the process lived on. Still only ever units our own declarations produce.
      const loaded = new Set(await loadedUnits(this.prefix));
      const units = target
        .map((p) => unitName(this.prefix, p.name))
        .filter((u) => loaded.has(u));
      if (units.length > 0) await systemctl(['stop', ...units]);
    });
  }

  async status(): Promise<Status> {
    const onDisk = await this.#onDisk();
    const loaded = new Set(await loadedUnits(this.prefix));
    const parts = [...this.#parts.values()];
    const units = parts.map((p) => unitName(this.prefix, p.name));
    const raw = await unitStates(units);               // one call for N parts (P3), starts nothing (P1)
    // Liveness comes from systemd; whether the declaration is installed comes
    // from the disk. Reporting them separately is what stops a running-but-
    // fileless part from disappearing behind `not-installed`.
    const rows: PartStatus[] = await Promise.all(parts.map(async (p) => {
      const unit = unitName(this.prefix, p.name);
      const seen = raw.get(unit);
      return {
        name: p.name,
        unit,
        state: translate(seen?.active ?? '', seen?.known ?? false),
        unitMatchesDeclaration: onDisk.has(unit) && (await this.#read(unit)) === this.#text(p),
      };
    }));
    const declared = new Set(units);
    return {
      parts: rows,
      orphanUnits: [...new Set([...onDisk, ...loaded])].filter((u) => !declared.has(u)).sort(),
      missingUnits: units.filter((u) => !onDisk.has(u)),
    };
  }

  /**
   * E4: reject dependency cycles and undeclared dependencies, naming the chain,
   * and return the parts in dependency order. Callers run this before writing.
   */
  #plan(): Part[] {
    const order: Part[] = [];
    const mark = new Map<string, 'open' | 'done'>();
    const visit = (name: string, chain: readonly string[]): void => {
      if (mark.get(name) === 'done') return;
      const path = [...chain, name].join(' -> ');
      if (mark.get(name) === 'open') throw new DeclarationError(`dependency cycle: ${path}`);
      const part = this.#parts.get(name);
      if (!part) throw new DeclarationError(`undeclared dependency: ${path}`);
      mark.set(name, 'open');
      for (const need of part.needs) visit(need, [...chain, name]);
      mark.set(name, 'done');
      order.push(part);
    };
    for (const name of this.#parts.keys()) visit(name, []);
    return order;
  }

  #get(name: string): Part {
    const p = this.#parts.get(name);
    if (!p) throw new DeclarationError(`no such part: ${name}`);
    return p;
  }

  #read(unit: string): Promise<string | null> {
    return readFile(`${this.unitDir}/${unit}`, 'utf8').catch(() => null);
  }

  /** The one place the translation is invoked, so writing and checking cannot
   *  disagree about the configuration and report drift that is not there. */
  #text(part: Part): string {
    return unitText(part, this.prefix, this.traceDir, this.readyTimeoutMs);
  }

  /** Returns true when the file on disk changed. */
  async #sync(part: Part): Promise<boolean> {
    const unit = unitName(this.prefix, part.name);
    const want = this.#text(part);
    if ((await this.#read(unit)) === want) return false;
    await writeFile(`${this.unitDir}/${unit}`, want);
    return true;
  }

  /** Unit files on disk under our prefix. Answers "is the declaration installed",
   *  and nothing else — it is never the authority on what is running. */
  async #onDisk(): Promise<Set<string>> {
    const names = await readdir(this.unitDir).catch(() => [] as string[]);
    return new Set(names.filter((f) => f.startsWith(this.prefix) && f.endsWith('.service')));
  }
}
