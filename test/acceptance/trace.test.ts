/**
 * 验收测试：docs/acceptance/trace.md 的 U7–U12（这一轮的核心范围）。
 *
 * 五条纪律（照规格）：
 *  一、只从需求推。断言的措辞照抄规格，不照代码。
 *  二、**只走用户看得见的那道门**：只 import `src/trace.ts`（追踪本身）和
 *      `src/theseus.ts`（U12-1 要一个真部件在跑）。不 import 任何内部模块。
 *      （`../helpers.ts` 是 systemctl / 临时目录的读取封装，它自己不 import 任何 src 模块。）
 *  三、断言"人的处境"，不是"机制的状态"。
 *  四、不是每条都得是代码：U9-3 是拿真实旧账本量。
 *  五、不许把实现写进断言。
 *
 * 范围：U7 全部、U8 全部、U9 全部，U10-2 / U10-4 / U11-1 / U11-3 / U12-1，
 * 以及那条"不配当用例、只能当前提"的不丢不重。
 * **U13（迁移）/ U14（跨 agent）本轮不写** —— 写了也只是一堆注定红的。
 *
 * 临时物：每个库放进自己的 mkdtemp 目录，afterEach 整个删掉（WAL 会额外留
 * `-wal` / `-shm`，删目录才干净）。收尾逐个确认**这一进程造过的**都没了，必须为 0。
 *
 * 跑法：node --test test/acceptance/trace.test.ts
 */
import assert from 'node:assert/strict';
import { existsSync, mkdtempSync, readdirSync, readFileSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { after, afterEach, test } from 'node:test';
import { Theseus } from '../../src/theseus.ts';
import { Trace, TraceRefused } from '../../src/trace.ts';
import type { Origin, Step } from '../../src/trace.ts';
import { PREFIX, UNIT_DIR, cleanup, until } from '../helpers.ts';

/** 旧账本。U9-3 要拿它量一遍——量不到就是量不到，不许静静跳过。 */
const OLD_LEDGER = process.env['THESEUS_OLD_LEDGER']
  ?? '/home/youyuan/Theseus/memory/L1_ledger/events';

/**
 * 前缀带上进程号。**不是为了好看**：`/tmp` 是所有人共用的，收尾那条断言最早写成
 * "扫一遍 /tmp，凡是这个前缀的都不许剩"——于是隔壁跑同一份测试时，它会指着别人的
 * 目录说我漏了（实测五次里响一次，而那个目录随后自己没了）。**一条会冤枉人的检验，
 * 和一条不会说不的检验一样坏。** 现在只认自己造的那些。
 */
const TMP_PREFIX = `theseus-t-trace-${process.pid}-`;
const tmpDirs: string[] = [];
/** 这一进程造过的每一个临时目录，只进不出 —— 收尾逐个确认它们真的没了。 */
const made: string[] = [];
const traces: Trace[] = [];

const scratch = (): string => {
  const dir = mkdtempSync(`${tmpdir()}/${TMP_PREFIX}`);
  tmpDirs.push(dir);
  made.push(dir);
  return dir;
};

/** 一份空痕迹 + 一个可拨的钟（默认真钟）。 */
const mk = (now?: () => number): Trace => {
  const dir = scratch();
  const t = now ? new Trace(`${dir}/trace.db`, { now }) : new Trace(`${dir}/trace.db`);
  traces.push(t);
  return t;
};

const A = 'test:acceptance:trace';

/** 一句话开头：人说的那句。 */
const said = (t: Trace, what: string): Step =>
  t.record({ actor: 'user:human:cli', type: 'user.message_received', origin: 'you-said', payload: { text: what } });

afterEach(() => {
  for (const t of traces.splice(0)) t.close();
  for (const d of tmpDirs.splice(0)) rmSync(d, { recursive: true, force: true });
});

// ─────────────────────── U7 · 我要能查「刚才那件事为什么发生」 ───────────────────────

test('U7-1: 每一步都指得出它的上一步 —— 每一跳都落到一条真实存在的记录上', () => {
  const t = mk();
  const s0 = said(t, '把这周的开销汇总一下');
  const s1 = t.record({ actor: A, type: 'task.requested', cause: s0.id, payload: { task: 'weekly-cost' } });
  const s2 = t.record({ actor: A, type: 'agent.spawned', cause: s1.id, payload: { runner: 'codex' } });
  const s3 = t.record({ actor: A, type: 'task.completed', cause: s2.id, payload: { task: 'weekly-cost' } });

  const chain = t.why(s3.id);
  assert.deepEqual(chain.steps.map((s) => s.id), [s3.id, s2.id, s1.id, s0.id],
    '往回走的顺序不是「问的那条 → 它的上一步 → …」');
  for (const s of chain.steps) {
    if (s.cause === null) continue;
    assert.ok(t.get(s.cause) !== null, `${s.type} 指着 ${s.cause}，而那条根本不在痕迹里`);
  }
});

test('U7-2: 一直查到一个我认得的起点 —— 三种之一，不许停在不认识的东西上', () => {
  const t = mk();
  const roots: Array<[Origin, string]> = [
    ['you-said', 'user.message_received'],
    ['clock-fired', 'time.tick'],
    ['arrived-from-outside', 'inbound.message'],
  ];
  for (const [origin, type] of roots) {
    const r = t.record({ actor: A, type, origin });
    const leaf = t.record({ actor: A, type: 'task.requested', cause: r.id });
    const end = t.why(leaf.id).end;
    assert.equal(end.kind, 'origin', `从 ${type} 起的链子走到头，答案说的是 ${end.kind}`);
    assert.equal(end.kind === 'origin' ? end.origin : '', origin);
  }
});

test('U7-2b: 一条没有上一步、又说不出自己是哪种起点的痕迹，根本写不进去', () => {
  const t = mk();
  assert.throws(
    () => t.record({ actor: A, type: 'something.happened' }),
    TraceRefused,
    '没有上一步、也没说自己是哪种起点，却被收下了 —— 那条链子将来会停在一个人不认识的东西上',
  );
});

/**
 * 规格给的验法是"故意抽掉中间一跳，答案必须明说这里断了"。**这里没照着做，理由要写在这儿。**
 *
 * 经这道门，链子断不了：上一步必须已经存在，门里没有删除动作，清理只折叠没人指着的。
 * 想抽掉中间一跳，只能绕到门后面去改库——而那验的是一个这个系统造不出来的处境，
 * 绿了也说明不了运行中的系统。
 *
 * 所以这条验的是**断链造不出来**。"答案必须明说这里断了"仍然要验，但它的第一个真实场景
 * 是 U13 把旧账本那 0.2% 指向不存在事件的记录搬进来的时候——它属于那一轮。
 */
test('U7-3: 中途不许断 —— 指向一条不存在的记录，当场被拒，而且什么都没写下', () => {
  const t = mk();
  const s0 = said(t, '看看昨天那个任务');
  const before = t.recent({ limit: 1000, includeRoutine: true }).length;
  assert.throws(
    () => t.record({ actor: A, type: 'task.requested', cause: '01JZZZZZZZZZZZZZZZZZZZZZZZ' }),
    TraceRefused,
    '上一步根本不存在，却被收下了 —— 这就是一条从出生就断了的链子',
  );
  assert.equal(t.recent({ limit: 1000, includeRoutine: true }).length, before,
    '被拒之后痕迹里还是多了东西');
  assert.equal(t.why(s0.id).steps.length, 1);
});

test('U7-4: 不许编 —— 时间上紧挨着的两条，不会被当成有因果', () => {
  const t = mk();
  const a = said(t, 'numpy 升到 2.1.0');
  const b = said(t, 'numpy 升到 2.2.0');   // 紧挨着、内容还极像：最容易被「猜」上去的一对
  const chain = t.why(b.id);
  assert.deepEqual(chain.steps.map((s) => s.id), [b.id],
    `第二条自己就是个起点，答案却把它接到了别的东西上：${chain.steps.map((s) => s.type)}`);
  assert.notEqual(chain.steps[0]?.cause, a.id, '「这儿应该是那个东西触发的吧」—— 正是不许出现的那句');
});

test('U7-4b: 不许编 —— 问一条不存在的，明说没有，不给一条看起来连着的链子', () => {
  const t = mk();
  said(t, '随便记一条，好让库里不是空的');
  const chain = t.why('01JZZZZZZZZZZZZZZZZZZZZZZZ');
  assert.deepEqual(chain.steps, [], '问的东西根本不在，却给了我几步');
  assert.equal(chain.end.kind, 'no-such-step', `答案说的是 ${chain.end.kind}`);
});

test('U7-4c: 不许编 —— 链子长过上限时，明说是走不到底，不冒充起点', () => {
  const t = mk();
  let cur = t.record({ actor: A, type: 'time.tick', origin: 'clock-fired' });
  for (let i = 0; i < 80; i++) cur = t.record({ actor: A, type: 'step', cause: cur.id });
  const chain = t.why(cur.id);
  assert.equal(chain.end.kind, 'too-deep',
    `走不到底却报了 ${chain.end.kind} —— 那是把「我没走完」说成了「我到头了」`);
  assert.ok(chain.steps.length > 1 && chain.steps.length <= 66, `步数 ${chain.steps.length} 不像有上限`);
});

// ────────────────────── U8 · 我要能查「这件事为什么没发生」 ──────────────────────

const DECISIONS = ['decision.declined', 'decision.deferred', 'decision.merged', 'decision.dropped'];

test('U8-1: 没做的事也留痕 —— 决定不做 / 推迟 / 当成一件 / 丢掉，四种都查得到', () => {
  const t = mk();
  for (const type of DECISIONS) {
    const req = t.record({ actor: A, type: 'task.requested', origin: 'you-said', payload: { what: type } });
    t.record({ actor: A, type, cause: req.id, basis: [req.id], payload: { why: '预算不够' } });
    const after = t.became(req.id);
    assert.ok(after.some((s) => s.type === type),
      `我提的要求被「${type}」了，可顺着它往后查什么都没有：${after.map((s) => s.type)}`);
  }
});

test('U8-2: 还要留下它当时凭什么这么定 —— 说不出依据的决定，写不进去', () => {
  const t = mk();
  for (const type of DECISIONS) {
    const req = t.record({ actor: A, type: 'task.requested', origin: 'you-said' });
    assert.throws(
      () => t.record({ actor: A, type, cause: req.id }),
      TraceRefused,
      `「${type}」不带任何依据就被收下了 —— 查出来只有「它没做」，没有「凭什么」`,
    );
    assert.throws(
      () => t.record({ actor: A, type, cause: req.id, basis: ['01JZZZZZZZZZZZZZZZZZZZZZZZ'] }),
      TraceRefused,
      `「${type}」的依据指向一条不存在的记录，却被收下了`,
    );
    // 另一半：查出来的不只是"它没做"，还得有它当时依据的是什么。
    const budget = t.record({ actor: A, type: 'drive.budget_decided', origin: 'clock-fired' });
    const dec = t.record({ actor: A, type, cause: req.id, basis: [budget.id] });
    assert.deepEqual(t.get(dec.id)?.basis, [budget.id],
      `「${type}」记下来了，可再去查它凭什么这么定，依据不见了`);
  }
});

test('U8-3: 复现那次真事故 —— 两个相似但不同的要求，第二个必须查得出发生了什么', () => {
  const t = mk();
  const r1 = t.record({
    actor: A, type: 'task.requested', origin: 'you-said',
    payload: { text: '把 numpy 升到 2.1.0' }, idem: 'upgrade:numpy:2.1.0',
  });
  const r2 = t.record({
    actor: A, type: 'task.requested', origin: 'you-said',
    payload: { text: '把 numpy 升到 2.2.0' }, idem: 'upgrade:numpy:2.2.0',
  });
  assert.notEqual(r1.id, r2.id, '两个不同的要求被并成了一条 —— 正是当年吞掉 2.2.0 的那一下');

  // 系统这次把它们当成一件事办了。**当成一件可以，第二个查不到不行。**
  t.record({
    actor: A, type: 'decision.merged', cause: r1.id, basis: [r1.id, r2.id],
    payload: { why: '同一个包，合并成一次升级' },
  });
  const after2 = t.became(r2.id);
  assert.ok(after2.length > 0, '第二个要求后来怎么了 —— 一句话都查不到');
  assert.ok(after2.some((s) => s.type === 'decision.merged'),
    `第二个要求后面只有：${after2.map((s) => s.type)}`);
});

test('U8-4: 静默是不合格的 —— 两段文字再像，也不会被悄悄当成同一件', () => {
  const t = mk();
  const mark = (text: string) => t.record({ actor: A, type: 'task.requested', origin: 'you-said', payload: { text } });
  // 当年的实测：像 95.5% / 94.1% / 90.9%，全被吞掉，一声不吭。
  const pairs: Array<[string, string]> = [
    ['把 numpy 升到 2.1.0', '把 numpy 升到 2.2.0'],
    ['review PR #412', 'review PR #418'],
    ['转账 500 元给张三', '转账 800 元给张三'],
  ];
  for (const [x, y] of pairs) {
    const a = mark(x);
    const b = mark(y);
    assert.notEqual(a.id, b.id, `「${x}」和「${y}」被当成了同一件事`);
    assert.ok(t.get(b.id) !== null, `「${y}」在痕迹里完全不存在 —— 「没记录」不是一种合格的答案`);
  }
});

// ─────────────────── U9 · 我要一眼看见有意义的事，不被心跳淹掉 ───────────────────

const noise = (t: Trace, n: number): void => {
  for (let i = 0; i < n; i++) {
    t.record({ actor: 'system:tick-injector:-', type: 'time.tick', origin: 'clock-fired', payload: { i } });
    t.record({ actor: 'system:watcher:-', type: 'watcher.fired', origin: 'clock-fired', payload: { i } });
  }
};

test('U9-1: 默认给我的，基本没有例行公事', () => {
  const t = mk();
  noise(t, 200);
  const real = [
    said(t, '帮我看看这个 bug'),
    t.record({ actor: A, type: 'task.requested', origin: 'you-said' }),
    t.record({ actor: A, type: 'task.failed', origin: 'arrived-from-outside' }),
  ];
  const view = t.recent();
  assert.ok(view.length > 0, '翻开是空的');
  const routine = view.filter((s) => s.routine);
  assert.deepEqual(routine, [], `默认视图里混进了 ${routine.length} 条例行公事：${routine.map((s) => s.type)}`);
  for (const r of real) {
    assert.ok(view.some((s) => s.id === r.id), `值得一看的 ${r.type} 没出现在默认视图里`);
  }
});

test('U9-2: 我要全部时，能拿到全部', () => {
  const t = mk();
  noise(t, 20);
  said(t, '一句真话');
  const all = t.recent({ limit: 1000, includeRoutine: true });
  assert.equal(all.length, 41, `明说要全部，却只给了 ${all.length} 条`);
  assert.ok(all.some((s) => s.type === 'time.tick'), '明说要看心跳，心跳没出现');
});

test('U9-3: 拿真实旧数据量一遍 —— 把旧账本 8 月那批喂进去，默认视图必须只剩一小撮', () => {
  assert.ok(existsSync(OLD_LEDGER), `旧账本不在 ${OLD_LEDGER} —— 这条量不出来就是量不出来，不算绿`);
  const files = readdirSync(OLD_LEDGER).filter((f) => f.startsWith('2026-08-') && f.endsWith('.jsonl'));
  assert.ok(files.length > 0, `${OLD_LEDGER} 里没有 8 月的账本`);

  const t = mk();
  let fed = 0;
  for (const f of files.sort()) {
    for (const line of readFileSync(`${OLD_LEDGER}/${f}`, 'utf8').split('\n')) {
      if (!line.trim()) continue;
      const e = JSON.parse(line) as { type?: string };
      if (typeof e.type !== 'string') continue;
      // 喂进来的是外面的东西：只带类型，旧的因果不跟着搬（那是 U13 的事）。
      t.record({ actor: 'ledger:august:replay', type: e.type, origin: 'arrived-from-outside' });
      fed++;
    }
  }
  const all = t.recent({ limit: 200_000, includeRoutine: true }).length;
  const notable = t.recent({ limit: 200_000 }).length;
  const pct = (notable / all) * 100;
  console.log(`  U9-3: 喂进 ${fed} 条，默认视图 ${notable} 条 = ${pct.toFixed(2)}%（例行 ${all - notable} 条）`);
  assert.equal(all, fed, '喂进去的和记下来的对不上');
  assert.ok(notable > 0, '默认视图一条都不剩 —— 那是把有意义的也一起埋了');
  assert.ok(pct <= 5,
    `默认视图还占 ${pct.toFixed(2)}% —— 规格说该落在个位数百分比；还剩这么多，是规则定错了，不是数据的问题`);
});

// ────────────────────────── U10 · 系统自己也读这份痕迹 ──────────────────────────

test('U10-2: 指不回去的，根本不该被写下来 —— 没有任何依据的自我总结必须被拒', () => {
  const t = mk();
  const seen = t.record({ actor: A, type: 'task.failed', origin: 'arrived-from-outside', payload: { task: 'x' } });

  assert.throws(
    () => t.record({ actor: A, type: 'self.reflection', origin: 'clock-fired', payload: { text: '我最近做得不错' } }),
    TraceRefused,
    '一段没有任何依据的自我总结被收下了 —— 而且不是被拒，是被接受然后打个标记',
  );
  assert.throws(
    () => t.record({
      actor: A, type: 'self.reflection', origin: 'clock-fired',
      basis: ['01JZZZZZZZZZZZZZZZZZZZZZZZ'], payload: { text: '我最近做得不错' },
    }),
    TraceRefused,
    '依据指向一条不存在的记录，却被收下了',
  );
  const ok = t.record({
    actor: A, type: 'self.reflection', origin: 'clock-fired',
    basis: [seen.id], payload: { text: '这个任务失败了两次，得改' },
  });
  assert.ok(t.get(ok.id) !== null, '有真实依据的自我总结反倒写不进去');
});

test('U10-4: 锚不许是合规章 —— 拿一次批量导入给几百条结论当依据，全部被拒', () => {
  const t = mk();
  // 真实形状：2026-06-10 一次导入，5 个锚盖在 2300 份文档上，长这样：
  // {"type":"ingest.roam","payload":{"batch":4,"batches":5,"batch_pages":500}}
  const stamp = t.record({
    actor: 'system:ingest:-', type: 'ingest.roam', origin: 'arrived-from-outside',
    payload: { batch: 4, batches: 5, batch_pages: 500 },
  });
  assert.equal(t.get(stamp.id)?.routine, true, '批量搬运本身就该算例行公事');

  for (let i = 0; i < 20; i++) {
    assert.throws(
      () => t.record({
        actor: A, type: 'self.conclusion', origin: 'clock-fired',
        basis: [stamp.id], payload: { text: `第 ${i} 条结论` },
      }),
      TraceRefused,
      '「我属于第几批导入」被当成了「这条结论从哪来」—— 规矩被形式满足了',
    );
  }

  // 真依据照收；批量章混在里面也不该把真依据一起否掉。
  const real = t.record({ actor: A, type: 'task.failed', origin: 'arrived-from-outside' });
  const ok = t.record({
    actor: A, type: 'self.conclusion', origin: 'clock-fired',
    basis: [stamp.id, real.id], payload: { text: '这个任务失败了' },
  });
  assert.ok(t.get(ok.id) !== null, '依据里有真东西，却被一起拒了');
});

// ─────────────────────────── U11 · 我要它一年后还能用 ───────────────────────────

test('U11-1: 量涨了，查一条的代价不跟着涨', () => {
  const chainOf = (t: Trace, depth: number): string => {
    let cur = t.record({ actor: A, type: 'user.message_received', origin: 'you-said' });
    for (let i = 0; i < depth; i++) cur = t.record({ actor: A, type: 'step', cause: cur.id });
    return cur.id;
  };
  const measure = (volume: number): { ms: number; n: number } => {
    const t = mk();
    const leaf = chainOf(t, 8);
    for (let i = 0; i < volume; i++) {
      t.record({ actor: 'system:tick-injector:-', type: 'time.tick', origin: 'clock-fired', payload: { i } });
    }
    const runs: number[] = [];
    for (let i = 0; i < 41; i++) {
      const t0 = process.hrtime.bigint();
      const n = t.why(leaf).steps.length;
      runs.push(Number(process.hrtime.bigint() - t0) / 1e6);
      assert.equal(n, 9);
    }
    runs.sort((a, b) => a - b);
    return { ms: runs[20] ?? 0, n: volume };
  };
  const small = measure(2_000);
  const big = measure(20_000);
  const ratio = big.ms / Math.max(small.ms, 1e-4);
  console.log(`  U11-1: ${small.n} 条 -> ${small.ms.toFixed(3)}ms，${big.n} 条 -> ${big.ms.toFixed(3)}ms（×${ratio.toFixed(2)}）`);
  assert.ok(ratio < 3,
    `量涨 10 倍，查一条的耗时涨了 ${ratio.toFixed(2)} 倍 —— 这就是「翻它的代价跟着一直涨」`);
});

test('U11-3: 清理不许制造断链 —— 清完重跑一遍 U7，还是绿的', () => {
  const day = 86_400_000;
  let clock = Date.parse('2026-01-01T00:00:00Z');
  const t = mk(() => clock);

  // 很久以前：一条真链子（中间夹着一条例行的），外加一堆没人指着的心跳。
  const s0 = t.record({ actor: A, type: 'user.message_received', origin: 'you-said', payload: { text: '开工' } });
  const tick = t.record({ actor: 'system:tick-injector:-', type: 'time.tick', cause: s0.id });
  const s2 = t.record({ actor: A, type: 'task.requested', cause: tick.id });
  const s3 = t.record({ actor: A, type: 'task.completed', cause: s2.id });
  for (let i = 0; i < 500; i++) {
    t.record({ actor: 'system:tick-injector:-', type: 'time.tick', origin: 'clock-fired', payload: { i } });
  }
  const lonely = t.recent({ limit: 10_000, includeRoutine: true }).filter((s) => s.routine).length;

  clock += 400 * day;                                   // 一年多以后
  const r = t.compact({ olderThanDays: 30 });
  console.log(`  U11-3: 折叠 ${r.folded} 条（原有例行 ${lonely} 条），留下 ${r.summaries} 条计数`);
  assert.ok(r.folded > 0, '清理什么都没折叠 —— 那这条断言等于没验');

  // U7 全部断言，原样重跑一遍。
  const chain = t.why(s3.id);
  assert.deepEqual(chain.steps.map((s) => s.id), [s3.id, s2.id, tick.id, s0.id],
    '清理之后链子变了 —— 正是 U7 最怕的那种断链');
  for (const s of chain.steps) {
    if (s.cause === null) continue;
    assert.ok(t.get(s.cause) !== null, `清理之后 ${s.type} 指着的 ${s.cause} 不见了`);
  }
  assert.equal(chain.end.kind, 'origin');
  assert.equal(chain.end.kind === 'origin' ? chain.end.origin : '', 'you-said');

  // 老东西不消失：那一天发生过多少次，仍然答得出。
  const summaries = t.recent({ limit: 10_000, includeRoutine: true })
    .filter((s) => s.type === 'trace.compacted');
  assert.ok(summaries.length > 0, '折叠完连「那天有多少次」都答不出来了 —— 那是删除，不是降采样');
  const counted = summaries.reduce((n, s) => n + Number(s.payload['count'] ?? 0), 0);
  assert.equal(counted, r.folded, `折叠了 ${r.folded} 条，计数只留下 ${counted}`);
});

// ────────────────────── U12 · 我不需要谁「记得」去留痕 ──────────────────────

test('U12-1: 部件干的事，自动就在 —— 没人做任何额外动作', async () => {
  const traceDir = scratch();
  const sys = new Theseus({ unitDir: UNIT_DIR, traceDir, prefix: PREFIX });
  const t = mk();
  const before = t.recent({ limit: 1000, includeRoutine: true }).length;
  assert.equal(before, 0);

  try {
    sys.add({ name: 'chatty', needs: [], command: 'echo THESEUS-PART-SPOKE; exec sleep 3000' });
    await sys.up();
    await until('部件把话说出来', () => existsSync(`${traceDir}/chatty.log`)
      && readFileSync(`${traceDir}/chatty.log`, 'utf8').includes('THESEUS-PART-SPOKE'));

    // 部件没做额外动作，写部件的人也没有，任何 agent 都没有。
    const n = t.absorb(traceDir);
    assert.ok(n > 0, '部件说了话，痕迹里一条都没有');
    const found = t.recent({ limit: 1000, includeRoutine: true })
      .filter((s) => JSON.stringify(s.payload).includes('THESEUS-PART-SPOKE'));
    assert.equal(found.length, 1, `部件那句话在痕迹里出现了 ${found.length} 次`);
    assert.ok(found[0]?.actor.includes('chatty'), `记下来了，但看不出是谁说的：${found[0]?.actor}`);

    // 再扫一遍：同一件事不许记两遍。
    t.absorb(traceDir);
    t.absorb(traceDir);
    const again = t.recent({ limit: 1000, includeRoutine: true })
      .filter((s) => JSON.stringify(s.payload).includes('THESEUS-PART-SPOKE'));
    assert.equal(again.length, 1, `扫三遍之后那句话变成了 ${again.length} 条`);
  } finally {
    cleanup();
  }
});

// ────────── 前提：痕迹不能丢、不能重（不占用例的位置，但八条全压在它上面）──────────

test('不重：同一个幂等键写两遍 = 同一条，不报错', () => {
  const t = mk();
  const one = t.record({ actor: A, type: 'assistant.replied', origin: 'you-said', idem: 'reply-v1:msg-7:slot-0' });
  const two = t.record({ actor: A, type: 'assistant.replied', origin: 'you-said', idem: 'reply-v1:msg-7:slot-0' });
  assert.equal(two.id, one.id, '同一个幂等键写出了两条不同的痕迹');
  assert.equal(t.recent({ limit: 100, includeRoutine: true }).length, 1);
});

test('不重：没给幂等键的，照常写入 —— 不强迫每个写入方都想清楚幂等性', () => {
  const t = mk();
  const one = t.record({ actor: A, type: 'assistant.replied', origin: 'you-said', payload: { text: '好' } });
  const two = t.record({ actor: A, type: 'assistant.replied', origin: 'you-said', payload: { text: '好' } });
  assert.notEqual(two.id, one.id, '没给幂等键，两条一模一样的痕迹被并成了一条');
  assert.equal(t.recent({ limit: 100, includeRoutine: true }).length, 2);
});

test('不成环：钟慢了的那个写入方，造不出一条「果早于因」的痕迹', () => {
  const file = `${scratch()}/trace.db`;
  let clock = Date.parse('2026-08-10T12:00:00Z');
  const ahead = new Trace(file, { now: () => clock });
  traces.push(ahead);
  const s0 = ahead.record({ actor: A, type: 'user.message_received', origin: 'you-said' });

  clock -= 3600_000;                                   // 另一个写入方，钟慢了一小时
  const behind = new Trace(file, { now: () => clock });
  traces.push(behind);
  assert.throws(
    () => behind.record({ actor: A, type: 'task.requested', cause: s0.id }),
    TraceRefused,
    '钟慢了的写入方造出了一条比自己的因还早的果 —— 顺着这种边走下去就是个圈',
  );
});

test('不丢：号是严格递增的 —— 同一毫秒里连着写也不会撞车', () => {
  const t = mk(() => 1_770_000_000_000);               // 钟钉死：全在同一毫秒
  const ids = Array.from({ length: 1000 }, () =>
    t.record({ actor: A, type: 'time.tick', origin: 'clock-fired' }).id);
  assert.equal(new Set(ids).size, ids.length, '同一毫秒里写出了重复的号');
  for (let i = 1; i < ids.length; i++) {
    assert.ok((ids[i] ?? '') > (ids[i - 1] ?? ''), `第 ${i} 个号没有比前一个大：${ids[i - 1]} -> ${ids[i]}`);
  }
});

// ───────────── U11-4 的自家部分：跑完不许在 /tmp 留东西（临时物记账后删）─────────────

after(() => {
  const left = made.filter(existsSync);
  assert.deepEqual(left, [], `跑完在 /tmp 留下了 ${left.length} 个残留：${left.join(', ')}`);
  // 别人留下的不由这条断言判，但也不装看不见 —— 报出来，让人自己看一眼。
  const foreign = readdirSync(tmpdir()).filter((f) => f.startsWith('theseus-t-trace-'));
  if (foreign.length > 0) console.log(`  /tmp 里还有 ${foreign.length} 个别的进程留下的痕迹临时目录`);
});
