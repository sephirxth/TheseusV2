/**
 * Mutation lock. Breaks one load-bearing property in the real source, checks
 * that the test which claims to protect it actually goes red, then restores the
 * file byte-for-byte (verified by sha256).
 *
 * A mutation that does NOT turn its test red is reported loudly: that test is
 * decoration, and the property it claims to protect is unprotected.
 *
 *   node test/mutation-lock.mjs
 */
import { spawnSync } from 'node:child_process';
import { createHash } from 'node:crypto';
import { readFileSync, writeFileSync } from 'node:fs';
import { cleanup, testUnitFiles } from './helpers.ts';

const ROOT = new URL('..', import.meta.url).pathname;
const sha = (b) => createHash('sha256').update(b).digest('hex');

const MUTATIONS = [
  {
    id: 'I4/activating',
    breaks: 'report `activating` as running — claim a part is up while it is still coming up',
    file: 'src/state.ts',
    from: "  activating: 'starting',",
    to: "  activating: 'running',",
    test: 'test/state.test.ts',
  },
  {
    id: 'I4/not-installed',
    breaks: 'believe systemd\'s `inactive` for a unit that was never installed, and call it stopped',
    file: 'src/state.ts',
    from: "  if (!installed) return { kind: 'not-installed' };",
    to: "  if (!installed && false) return { kind: 'not-installed' };",
    test: 'test/state.test.ts',
  },
  {
    id: 'I4/untranslatable',
    breaks: 'let an unknown ActiveState fall through to a default instead of surfacing raw',
    file: 'src/state.ts',
    from: "  if (!known) return { kind: 'untranslatable', raw: activeState };",
    to: "  if (!known) return { kind: 'stopped' };",
    test: 'test/state.test.ts',
  },
  {
    id: 'I2b/orphans',
    breaks: 'look for drift in one direction only — stop reporting units nothing declares',
    file: 'src/theseus.ts',
    from: '      orphanUnits: [...new Set([...onDisk, ...loaded])].filter((u) => !declared.has(u)).sort(),',
    to: '      orphanUnits: [],',
    test: 'test/live.test.ts',
    pattern: 'drift is reported in both directions',
  },
  {
    id: 'I2b/missing',
    breaks: 'look for drift in the other direction only — stop reporting declarations with no unit',
    file: 'src/theseus.ts',
    from: '      missingUnits: units.filter((u) => !onDisk.has(u)),',
    to: '      missingUnits: [],',
    test: 'test/live.test.ts',
    pattern: 'drift is reported in both directions',
  },
  {
    id: 'I2b/fileless-orphan',
    breaks: 'go back to the disk alone for orphans — a running unit with no file becomes invisible',
    file: 'src/theseus.ts',
    from: '      orphanUnits: [...new Set([...onDisk, ...loaded])].filter((u) => !declared.has(u)).sort(),',
    to: '      orphanUnits: [...onDisk].filter((u) => !declared.has(u)).sort(),',
    test: 'test/live.test.ts',
    pattern: 'no file and no declaration',
  },
  {
    id: 'U2/down-uses-disk',
    breaks: 'let the disk decide what down() may stop — a running unit with no file is silently skipped',
    file: 'src/theseus.ts',
    from: '      const loaded = new Set(await loadedUnits(this.prefix));\n      const units = target',
    to: '      const loaded = await this.#onDisk();\n      const units = target',
    test: 'test/live.test.ts',
    pattern: 'deleted while it runs',
  },
  {
    id: 'O2/no-lock',
    breaks: 'drop the exclusion — every command "acquires" the lock, so up and down interleave again',
    file: 'src/lock.ts',
    from: "      const fh = await open(path, 'wx');",
    to: "      const fh = await open(path, 'w');",
    test: 'test/live.test.ts',
    pattern: 'serialized',
  },
  {
    id: 'O2b/refuse-instantly',
    breaks: 'refuse the moment the lock is busy instead of waiting — rejects a down while an up runs',
    file: 'src/lock.ts',
    from: '    if (Date.now() >= deadline) throw new LockBusy(',
    to: '    if (true) throw new LockBusy(',
    test: 'test/live.test.ts',
    pattern: 'naming the holder',
  },
  {
    id: 'I4/liveness-from-disk',
    breaks: 'take "does systemd know this unit" from the disk again — a running part reads not-installed',
    file: 'src/theseus.ts',
    from: "        state: translate(seen?.active ?? '', seen?.known ?? false),",
    to: "        state: translate(seen?.active ?? '', onDisk.has(unit)),",
    test: 'test/live.test.ts',
    pattern: 'deleted while it runs',
  },
  {
    id: 'O1/Requires',
    breaks: 'translate `needs` into After= only — order without existence',
    file: 'src/unit.ts',
    from: '    ...(deps ? [`Requires=${deps}`, `After=${deps}`] : []),',
    to: '    ...(deps ? [`After=${deps}`] : []),',
    test: 'test/unit.test.ts',
  },
  {
    id: 'I5b/no-ExecStartPost',
    breaks: 'drop the readiness probe — a part that declared what "ready" means is called up the moment its process exists',
    file: 'src/unit.ts',
    from: '      `ExecStartPost=/bin/sh -c "until ${quote(part.ready)}; do sleep 0.1; done"`,\n',
    to: '',
    test: 'test/acceptance/lifecycle.test.ts',
    pattern: 'U3-3',
  },
  {
    id: 'I5b/ready-always',
    breaks: 'probe parts that never said what ready means — a vacuous check on every unit instead of none',
    file: 'src/unit.ts',
    from: '    ...(part.ready === undefined ? [] : [\n      `ExecStartPost=/bin/sh -c "until ${quote(part.ready)};',
    to: "    ...(false ? [] : [\n      `ExecStartPost=/bin/sh -c \"until ${quote(part.ready ?? 'true')};",
    test: 'test/unit.test.ts',
    pattern: 'no `ready` means neither line',
  },
  {
    id: 'I5b/unescaped-ready',
    breaks: 'stop escaping `ready` — a % in the check becomes a systemd specifier, a quote ends the argument',
    file: 'src/unit.ts',
    from: '${quote(part.ready)}',
    to: '${part.ready}',
    test: 'test/unit.test.ts',
    pattern: 'escaped exactly like the command',
  },
  {
    id: 'P2/no-TimeoutStartSec',
    breaks: 'let the wait for readiness run on whatever bound the machine happens to have, instead of ours',
    file: 'src/unit.ts',
    from: '      `TimeoutStartSec=${readyTimeoutMs}ms`,\n',
    to: '',
    test: 'test/unit.test.ts',
    pattern: 'finite TimeoutStartSec',
  },
  {
    id: 'E4/missing-dep',
    breaks: 'stop rejecting an undeclared dependency before generating units',
    file: 'src/theseus.ts',
    from: '      if (!part) throw new DeclarationError(`undeclared dependency: ${path}`);',
    to: '      if (!part) return;',
    test: 'test/precheck.test.ts',
  },
  {
    id: 'idempotence/daemon-reload',
    breaks: 'issue daemon-reload on every up, even when nothing changed',
    file: 'src/theseus.ts',
    from: "    if (changed) await systemctl(['daemon-reload']);",
    to: "    if (changed || true) await systemctl(['daemon-reload']);",
    test: 'test/live.test.ts',
    pattern: 'idempotence',
  },
  // ─────────────────────────────── 痕迹（U7–U12）───────────────────────────────
  {
    id: 'U7-2/origin-optional',
    breaks: 'stop demanding an origin from a step with no cause — chains get to end on something nobody recognises',
    file: 'src/trace.ts',
    from: '    if (!hasCause && !hasOrigin) {',
    to: '    if (false) {',
    test: 'test/acceptance/trace.test.ts',
    pattern: 'U7-2b',
  },
  {
    id: 'U7-4/guess-the-cause',
    breaks: 'walk back to the nearest earlier record instead of the declared cause — "这儿应该是那个东西触发的吧"',
    file: 'src/trace.ts',
    from: '    FROM trace t JOIN chain ON t.id = chain.cause',
    to: '    FROM trace t JOIN chain ON t.id = (SELECT max(x.id) FROM trace x WHERE x.id < chain.id)',
    test: 'test/acceptance/trace.test.ts',
    pattern: 'U7-4:',
  },
  {
    id: 'U7-4c/too-deep-hidden',
    breaks: 'stop saying "I did not walk to the end" — a truncated walk reports like any other unfinished chain',
    file: 'src/trace.ts',
    from: "    if (depth >= DEPTH) return { steps, end: { kind: 'too-deep', at: tail.id } };",
    to: "    if (false) return { steps, end: { kind: 'too-deep', at: tail.id } };",
    test: 'test/acceptance/trace.test.ts',
    pattern: 'U7-4c',
  },
  {
    id: 'U8-2/decide-without-grounds',
    breaks: 'accept a decision that never says what it was decided on — "它没做" with no "凭什么"',
    file: 'src/trace.ts',
    from: '    if ((isDecision(m.type) || isConclusion(m.type)) && grounds.length === 0) {',
    to: '    if (false) {',
    test: 'test/acceptance/trace.test.ts',
    pattern: 'U8-2',
  },
  {
    id: 'U8-3/forward-cause-only',
    breaks: 'follow only "whose previous step am I" — the request that got merged away becomes unreachable again',
    file: 'src/trace.ts',
    from: "          OR EXISTS (SELECT 1 FROM json_each(t.payload, '$.basis') j WHERE j.value = fwd.id))",
    to: '          OR 1 = 0)',
    test: 'test/acceptance/trace.test.ts',
    pattern: 'U8-3',
  },
  {
    id: 'U9-1/default-shows-all',
    breaks: 'drop the default filter — open it and get a screen of heartbeats again',
    file: 'src/trace.ts',
    from: 'FROM trace WHERE (? = 1 OR routine = 0) ORDER BY id DESC LIMIT ?',
    to: 'FROM trace WHERE (? = 1 OR 1 = 1) ORDER BY id DESC LIMIT ?',
    test: 'test/acceptance/trace.test.ts',
    pattern: 'U9-1',
  },
  {
    id: 'U9-3/tick-is-notable',
    breaks: 'stop calling the clock routine — the default view goes back to being mostly heartbeats',
    file: 'src/routine.ts',
    from: "  'time.tick',                      // 时钟到点",
    to: '',
    test: 'test/acceptance/trace.test.ts',
    pattern: 'U9-3',
  },
  {
    id: 'U10-4/ingest-exact-match',
    breaks: 'recognise only `ingest.transcripts` — the 2026-06-10 batch stamp (`ingest.roam`) stops counting as routine',
    file: 'src/routine.ts',
    from: "const ROUTINE_PREFIXES: readonly string[] = ['ingest.'];",
    to: "const ROUTINE_PREFIXES: readonly string[] = ['ingest.transcripts'];",
    test: 'test/acceptance/trace.test.ts',
    pattern: 'U10-4',
  },
  {
    id: 'U10-4/stamp-is-grounds',
    breaks: 'let a conclusion rest entirely on routine bookkeeping — "我属于第 N 批导入" passes as a reason again',
    file: 'src/trace.ts',
    from: '    if (isConclusion(m.type) && !grounds.some((g) => !g.routine)) {',
    to: '    if (false) {',
    test: 'test/acceptance/trace.test.ts',
    pattern: 'U10-4',
  },
  {
    id: 'U11-3/compact-anything-old',
    breaks: 'fold routine records without checking whether anything points at them — cleanup starts breaking chains',
    file: 'src/trace.ts',
    from: '         AND id NOT IN (SELECT cause FROM trace WHERE cause IS NOT NULL)\n',
    to: '',
    test: 'test/acceptance/trace.test.ts',
    pattern: 'U11-3',
  },
  {
    id: 'U12-1/absorb-key-impure',
    breaks: 'make the absorb key non-deterministic — the same line gets recorded again on every sweep',
    file: 'src/trace.ts',
    from: 'const idem = createHash(\'sha256\').update(`${path}:${i}:${line}`).digest(\'hex\');',
    to: 'const idem = createHash(\'sha256\').update(`${path}:${i}:${line}:${Math.random()}`).digest(\'hex\');',
    test: 'test/acceptance/trace.test.ts',
    pattern: 'U12-1',
  },
  {
    id: 'idem/lookup-blind',
    breaks: 'stop finding the record a key already wrote — the same thing gets written twice, or refused outright',
    file: 'src/trace.ts',
    from: '    return row === undefined ? null : toStep(row);\n  }\n\n  /** 同一句 SQL 只编译一次。',
    to: '    return null;\n  }\n\n  /** 同一句 SQL 只编译一次。',
    test: 'test/acceptance/trace.test.ts',
    pattern: '同一个幂等键',
  },
  {
    id: 'cause<id/no-CHECK',
    breaks: 'drop `CHECK (cause < id)` — a writer whose clock is behind can hang a cause later than its own effect',
    file: 'src/trace.ts',
    from: '\n\n  CHECK (cause IS NULL OR cause < id)',
    to: '',
    test: 'test/acceptance/trace.test.ts',
    pattern: '不成环',
  },
  {
    id: 'ulid/not-monotonic',
    breaks: 'draw fresh randomness inside one millisecond instead of incrementing — ids stop being ordered',
    file: 'src/trace.ts',
    from: '      this.#lastRand += 1n;',
    to: '      this.#lastRand = rand80();',
    test: 'test/acceptance/trace.test.ts',
    pattern: '严格递增',
  },
  {
    id: 'E7/unavailable',
    breaks: 'stop recognising an unreachable user instance, so it degrades into an ordinary failure',
    file: 'src/systemctl.ts',
    from: 'const UNREACHABLE = /Failed to connect to (the )?(user scope )?bus|Refusing to operate|D-?Bus connection|No such file or directory.*bus/i;',
    to: 'const UNREACHABLE = /\\0this pattern never matches\\0/;',
    test: 'test/live.test.ts',
    pattern: 'E7',
  },
  // ─────────────────────────────── 意图树（U15–U19）───────────────────────────────
  {
    id: 'U19-6/fold-trusts-anyone',
    breaks: 'fold marks whose cause is not a human utterance — an agent adopting on its own say-so grows a node',
    file: 'src/intent.ts',
    from: "      if (middleOf(h.actor) !== 'human') continue;           // 判据②（③由 doors.ts 结构保证）",
    to: '      if (false) continue;',
    test: 'test/acceptance/intent.test.ts',
    pattern: 'U19-6',
  },
  {
    id: 'U19-6/agent-door-open',
    breaks: "let the agent door write '人说的话' — the whole criterion can be forged from the reachable entry",
    file: 'src/doors.ts',
    from: "    if (middleOf(m.actor) === 'human') {",
    to: '    if (false) {',
    test: 'test/acceptance/intent.test.ts',
    pattern: 'U19-6',
  },
  {
    id: 'U15-3/birth-edge-lost',
    breaks: 'stop hanging a new node on the current one — every intent becomes a root and the path loses its middle',
    file: 'src/intent.ts',
    from: "            id: s.id, saying: text, parent: current, status: 'open',",
    to: "            id: s.id, saying: text, parent: null, status: 'open',",
    test: 'test/acceptance/intent.test.ts',
    pattern: 'U15-3',
  },
  {
    id: 'U17/resume-goes-nowhere',
    breaks: 'record the jump back but never move the current — "回到刚才那个" leaves me where I was',
    file: 'src/intent.ts',
    from: '          current = n.id;',
    to: '          void n.id;',
    test: 'test/acceptance/intent.test.ts',
    pattern: 'U17',
  },
  {
    id: 'U18-2/merge-rewrites-birth',
    breaks: 'let merging move a birth edge — one line loses where it came from, exactly what U18 forbids',
    file: 'src/intent.ts',
    from: '          a.mergedWith.push(b.id);',
    to: '          a.parent = b.id;\n          a.mergedWith.push(b.id);',
    test: 'test/acceptance/intent.test.ts',
    pattern: 'U18-',
  },
  {
    id: 'U16-6/dangling-mixes-closed',
    breaks: "stop filtering by status — the '防丢' list mixes finished and dropped intents in again",
    file: 'src/intent.ts',
    from: "      .filter((n) => n.status === 'open')",
    to: '      .filter(() => true)',
    test: 'test/acceptance/intent.test.ts',
    pattern: 'U16-6',
  },
  {
    id: 'U19-4/boundary-by-clock-not-turn',
    breaks: 'drop the "my next utterance" boundary — a proposal is blamed as ignored before I ever spoke',
    file: 'src/intent.ts',
    from: '      .filter((p) => this.#trace.humanSpokeAfter(p.id));',
    to: '      .filter(() => true);',
    test: 'test/acceptance/intent.test.ts',
    pattern: 'U19-4',
  },
  {
    id: 'U19-9/pairs-lose-the-guess',
    breaks: 'return corrections without resolving what they corrected — only the fix survives, the pair breaks',
    file: 'src/intent.ts',
    from: '      const guessed = t0 === undefined ? null : this.#trace.get(t0);',
    to: '      const guessed = null;',
    test: 'test/acceptance/intent.test.ts',
    pattern: 'U19-9',
  },
  {
    id: 'drop/no-why-needed',
    breaks: 'accept an abandonment with no reason — the only grounds for "要不要捡回来" stop existing',
    file: 'src/intent.ts',
    from: "    if (o.why.trim() === '') {",
    to: '    if (false) {',
    test: 'test/acceptance/intent.test.ts',
    pattern: '放弃必须带一句为什么',
  },
];

const decorative = [];
const damaged = [];

for (const m of MUTATIONS) {
  const path = ROOT + m.file;
  const original = readFileSync(path);
  const before = sha(original);
  const text = original.toString('utf8');
  if (!text.includes(m.from)) {
    console.log(`MISSED   ${m.id.padEnd(26)} target text not found in ${m.file} — mutation never applied`);
    decorative.push(`${m.id} (target text not found; the script is stale)`);
    continue;
  }
  let red = false;
  let tail = '';
  try {
    writeFileSync(path, text.replace(m.from, m.to));
    const args = ['--test', '--test-concurrency=1', ...(m.pattern ? ['--test-name-pattern', m.pattern] : []), m.test];
    const r = spawnSync('node', args, { cwd: ROOT, encoding: 'utf8' });
    red = r.status !== 0;
    tail = (r.stdout ?? '').split('\n').filter((l) => /^# (pass|fail)/.test(l)).join(' ');
  } finally {
    writeFileSync(path, original);
  }
  const after = sha(readFileSync(path));
  if (after !== before) damaged.push(`${m.id}: ${m.file} NOT restored (${before} -> ${after})`);
  console.log(`${red ? 'RED   ' : 'GREEN '}   ${m.id.padEnd(26)} ${m.test}${m.pattern ? ` /${m.pattern}/` : ''}  ${tail}`);
  console.log(`         mutation: ${m.breaks}`);
  if (!red) decorative.push(`${m.id} — ${m.breaks}`);
}

cleanup();
if (testUnitFiles().length > 0) damaged.push(`test units left behind: ${testUnitFiles()}`);

console.log(`\n${MUTATIONS.length - decorative.length}/${MUTATIONS.length} mutations turned their test red.`);
if (damaged.length > 0) {
  console.log(`\n!!!! SOURCE NOT RESTORED / RESIDUE !!!!\n${damaged.map((d) => `  ${d}`).join('\n')}`);
}
if (decorative.length > 0) {
  console.log(`\n!!!! ${decorative.length} TEST(S) ARE DECORATION — the mutation did not turn them red !!!!`);
  for (const d of decorative) console.log(`  ${d}`);
}
process.exitCode = decorative.length + damaged.length > 0 ? 1 : 0;
