/**
 * 验收测试：docs/acceptance/lifecycle.md 的 U1–U6。
 *
 * 四条纪律（照规格）：
 *  一、只从需求推。断言的措辞照抄规格，不照代码。
 *  二、**只走用户看得见的那道门**：只 import `src/theseus.ts`（add / up / down / status）
 *      和 `parts.ts`（那份声明本身），其余一律靠观察真实系统——cgroup.procs、unit 文件、
 *      systemctl / journalctl 的输出、磁盘上的痕迹。本文件不 import
 *      lock.ts / unit.ts / systemctl.ts / state.ts / part.ts。
 *      （`../helpers.ts` 只是 systemctl / cgroup 的读取封装，它自己不 import 任何 src 模块。）
 *  三、断言"人的处境"，不是"机制的状态"。
 *  四、不是每条都得是代码：U2-4 与 U5-2 是扫文档 / 扫仓库。
 *
 * 安全：所有 unit 一律 `theseus-t-` 前缀；unit 名逐个字面量传给 systemctl，全程不出现通配；
 * 用户旧系统的 theseus.service / theseus-runtime-liveness.* 从不被触碰。
 *
 * 跑法：node --test test/acceptance/lifecycle.test.ts
 */
import assert from 'node:assert/strict';
import { execFileSync, spawnSync } from 'node:child_process';
import { createHash } from 'node:crypto';
import {
  existsSync, mkdtempSync, readFileSync, readdirSync, rmSync, statSync, writeFileSync,
} from 'node:fs';
import { tmpdir } from 'node:os';
import { afterEach, test } from 'node:test';
import { Theseus } from '../../src/theseus.ts';
import {
  PREFIX, UNIT_DIR, cgroup, cleanup, mkTraceDir, testUnitFiles, testUnitsHeldBySystemd, until,
} from '../helpers.ts';

const REPO = new URL('../../', import.meta.url).pathname.replace(/\/$/, '');
const tmpDirs: string[] = [];

const mk = (): { t: Theseus; traceDir: string } => {
  const traceDir = mkTraceDir();
  tmpDirs.push(traceDir);
  return { traceDir, t: new Theseus({ unitDir: UNIT_DIR, traceDir, prefix: PREFIX }) };
};

const sandbox = (tag: string): Theseus => {
  const unitDir = mkdtempSync(`${tmpdir()}/theseus-t-${tag}-`);
  tmpDirs.push(unitDir);
  return new Theseus({ unitDir, traceDir: `${unitDir}/trace`, prefix: `${PREFIX}${tag}-` });
};

/** 三个部件：B 依赖 A，C 依赖 B。声明顺序故意打乱成 c,a,b —— 调用方没有以任何形式提供顺序。 */
const abc = (t: Theseus): void => {
  t.add({ name: 'c', needs: ['b'], command: 'exec sleep 3000' });
  t.add({ name: 'a', needs: [], command: 'exec sleep 3000' });
  t.add({ name: 'b', needs: ['a'], command: 'exec sleep 3000' });
};

/** 真实系统的回答：这个 unit 变成 active 的单调时刻（微秒）。0 = 从没起来过。 */
const activeEnterUs = (unit: string): number => Number(execFileSync(
  'systemctl', ['--user', 'show', '--property=ActiveEnterTimestampMonotonic', '--value', unit],
  { encoding: 'utf8' },
).trim());

/** 内核的回答：这些 unit 里现在有哪些进程。unit 名来自 status()，不是自己拼的。 */
const pidsOf = (units: readonly string[]): string[] => units.flatMap((u) => cgroup(u).procs).sort();

const unitsOf = async (t: Theseus): Promise<string[]> => (await t.status()).parts.map((p) => p.unit);

const alive = (pid: string): boolean => existsSync(`/proc/${pid}`);

const walkFiles = (dir: string, out: string[] = []): string[] => {
  for (const e of readdirSync(dir)) {
    if (e === 'node_modules' || e === '.git') continue;
    const p = `${dir}/${e}`;
    if (statSync(p).isDirectory()) walkFiles(p, out);
    else out.push(p);
  }
  return out;
};

/** 仓库快照：文件 -> 内容 hash + mtime。 */
const snapshot = (): Map<string, string> => new Map(walkFiles(REPO).map((p) => [
  p, `${createHash('sha256').update(readFileSync(p)).digest('hex')}:${statSync(p).mtimeMs}`,
]));

const diff = (before: Map<string, string>, after: Map<string, string>): string[] => {
  const changed: string[] = [];
  for (const [p, v] of after) if (before.get(p) !== v) changed.push(`${before.has(p) ? 'changed' : 'created'} ${p}`);
  for (const p of before.keys()) if (!after.has(p)) changed.push(`deleted ${p}`);
  return changed.sort();
};

afterEach(() => {
  cleanup();
  for (const d of tmpDirs.splice(0)) rmSync(d, { recursive: true, force: true });
});

// ───────────────────────────── U1 · 我要把系统跑起来 ─────────────────────────────

test('U1-1: 该跑的都在跑 —— 三个部件的进程都真实存在', async () => {
  const { t } = mk();
  abc(t);
  await t.up();
  for (const u of await unitsOf(t)) {
    const procs = cgroup(u).procs;
    assert.ok(procs.length >= 1, `${u} 没有任何进程在跑（cgroup 是空的）`);
    assert.ok(procs.every(alive), `${u} 的 cgroup 里写着 ${procs} 但 /proc 下没有它们`);
  }
});

test('U1-2: 顺序对 —— A 的启动时刻早于 B，B 早于 C', async () => {
  const { t } = mk();
  abc(t);
  await t.up();
  const ta = activeEnterUs(`${PREFIX}a.service`);
  const tb = activeEnterUs(`${PREFIX}b.service`);
  const tc = activeEnterUs(`${PREFIX}c.service`);
  assert.ok(ta > 0 && tb > 0 && tc > 0, `有部件从没变成 active：a=${ta} b=${tb} c=${tc}`);
  assert.ok(ta < tb, `A 不早于 B：a=${ta} b=${tb}`);
  assert.ok(tb < tc, `B 不早于 C：b=${tb} c=${tc}`);
  console.log(`  U1-2: a=${ta}µs, b=+${tb - ta}µs, c=+${tc - tb}µs`);
});

test('U1-3: 连做三次，还是那些进程 —— 数进程，不看返回值', async () => {
  const { t } = mk();
  abc(t);
  await t.up();
  const units = await unitsOf(t);
  const after1 = pidsOf(units);
  assert.equal(after1.length, 3, `一次之后应有 3 个进程，实际 ${after1.length}：${after1}`);
  await t.up();
  await t.up();
  const after3 = pidsOf(units);
  assert.equal(after3.length, after1.length, `三次之后进程数变了：${after1.length} -> ${after3.length}`);
  assert.deepEqual(after3, after1, '还是三个进程，但不是同一批 —— 有部件被重启过');
});

test('U1-4: 只起一个，它依赖的跟着来', async () => {
  const { t } = mk();
  abc(t);
  await t.up('c');                                   // 只点名 C
  for (const name of ['a', 'b', 'c']) {
    assert.ok(cgroup(`${PREFIX}${name}.service`).procs.length >= 1, `只点名 C，但 ${name} 没跑起来`);
  }
});

test('U1-5: 我不需要知道谁依赖谁 —— 只给了一个名字，没有以任何形式提供顺序，结果仍然正确', async () => {
  const { t } = mk();
  abc(t);                                            // 声明顺序 c,a,b：既不是依赖序也不是字母序
  await t.up('c');                                   // 只有一个名字，没有次序
  const ta = activeEnterUs(`${PREFIX}a.service`);
  const tb = activeEnterUs(`${PREFIX}b.service`);
  const tc = activeEnterUs(`${PREFIX}c.service`);
  assert.ok(ta > 0 && tb > 0 && tc > 0, `有部件没起来：a=${ta} b=${tb} c=${tc}`);
  assert.ok(ta < tb && tb < tc, `顺序不对：a=${ta} b=${tb} c=${tc}`);
});

// ───────────────────────────── U2 · 我要把系统停干净 ─────────────────────────────

/** 会 fork 出孙进程的部件：sh 自己 + 两个 sleep。 */
const FORKING = '/bin/sh -c "sleep 3000 & sleep 3000 & wait"';

test('U2-1: 它说完成的那一刻，就是真停了 —— 在 down() 返回的那一瞬间断言进程数为 0', async () => {
  const { t } = mk();
  t.add({ name: 'plain', needs: [], command: 'exec sleep 3000' });
  t.add({ name: 'forker', needs: [], command: FORKING });
  await t.up();
  const units = await unitsOf(t);
  await until('孙进程出现', () => cgroup(`${PREFIX}forker.service`).procs.length >= 3);
  assert.ok(pidsOf(units).length >= 4, '前提没成立：停之前根本没那么多进程');

  await t.down();
  // 下面这行没有 sleep、没有轮询：这就是 down() 返回的那一瞬间。
  assert.deepEqual(pidsOf(units), [], 'down() 说完成了，但还有进程活着');
});

test('U2-2: 孙进程也没了', async () => {
  const { t } = mk();
  t.add({ name: 'forker', needs: [], command: FORKING });
  await t.up();
  const unit = `${PREFIX}forker.service`;
  await until('孙进程出现', () => cgroup(unit).procs.length >= 3);
  const before = cgroup(unit).procs;
  console.log(`  U2-2: 停之前 ${unit} 里有 ${before.length} 个进程：${before.join(' ')}`);

  await t.down();
  const survivors = before.filter(alive);
  assert.deepEqual(survivors, [], `这些进程在 down() 返回后还活着：${survivors.join(' ')}`);
});

test('U2-3: 痕迹不再增长 —— 记下返回那一刻的大小，等一段时间再看，必须一模一样', async () => {
  const { t, traceDir } = mk();
  t.add({ name: 'noisy', needs: [], command: '/bin/sh -c "while :; do date; sleep 0.05; done"' });
  await t.up();
  const trace = `${traceDir}/noisy.log`;
  await until('痕迹出现', () => existsSync(trace) && statSync(trace).size > 0);
  const first = statSync(trace).size;
  await until('痕迹在长', () => statSync(trace).size > first);

  await t.down();
  const atReturn = statSync(trace).size;
  await new Promise((r) => setTimeout(r, 2000));     // 等一段真实时间
  const later = statSync(trace).size;
  assert.equal(later, atReturn, `down() 返回时 ${atReturn}B，2 秒后 ${later}B —— 痕迹还在长`);
  console.log(`  U2-3: 跑着时 ${first}B 且在长；返回那一刻 ${atReturn}B；2 秒后仍 ${later}B`);
});

/**
 * U2-4：不是代码测试，是扫文档。
 *
 * 收集口径故意放宽：任何可能在告诉人"按什么次序做事"的句子都收上来——含"先"的句子
 * （去掉"原先/先后/优先"这类合成词），加"然后 / 记得 / 别忘 / 务必 / 切记"，
 * 加英文 first…then / before you / remember to run。收上来之后逐句判定。
 *
 * 判定分类：
 *   operator-order  写给操作者的顺序要求 —— 本条不通过
 *   negation        文档在说"你不需要这么做"（正是 U2-4 要的证据）
 *   history         描述历史 / 旧系统 / 事故经过
 *   spec            规格自己在描述"这一条怎么扫"
 *   design-method   写给设计者/实现者的方法论（怎么做设计决定），不是操作运行中的系统
 *   mechanism       描述代码内部的先后，不是人要做的动作
 *   deferred        "先不做" = 眼下不做
 *   heading         标题 / 表头
 *   not-ordering    是"要记得做某事"，但不是顺序要求（另在报告里单列）
 *
 * 判定表按句子片段匹配。文档一改，对不上的句子会让这条测试报"出现了没判定过的句子"——
 * 这是要的：新句子必须被人重新判一次，不能默默溜过去。
 */
type Verdict =
  | 'operator-order' | 'negation' | 'history' | 'spec'
  | 'design-method' | 'mechanism' | 'deferred' | 'heading' | 'not-ordering';

const JUDGED: readonly (readonly [string, Verdict])[] = [
  ['第一原则：先找成熟解法，再考虑自己造', 'design-method'],
  ['有什么问题先想想是不是这类问题的本质已经有成熟解决方法了', 'design-method'],
  ['碰到一个问题，先问一句', 'design-method'],
  ['都该先回头问一遍第一句话', 'design-method'],
  ['不许 sleep 之后再查', 'spec'],
  ['扫全部文档：把每一句"先…再…"找出来', 'spec'],
  ['必须先关定时器再停服务', 'history'],
  ['不存在任何一个"必须先跑一次"的安装脚本', 'negation'],
  ['调用方不需要记住任何「先 A 再 B」', 'negation'],
  ['把文档里所有"先…再…"找出来', 'spec'],
  ['然后当真退出码报"已停止"', 'history'],
  ['然后才启动', 'mechanism'],
  ['先按第一原则问一句', 'design-method'],
  ['先去已有的需求里找一遍', 'design-method'],
  ['降采样前先查一遍有多少', 'design-method'],
  ['谁来写（U12：不靠谁记得）', 'heading'],
  ['负责回复的副本经常记得回复、忘了留痕', 'history'],
  ['后来靠在提示词里写"必须记得"来堵', 'history'],
  ['前两个不需要任何人记得', 'negation'],
  ['靠谁记得？', 'heading'],
  ['仍然要它自己记得', 'not-ordering'],
  ['这一步先不做', 'deferred'],
  ['换个 agent 还记得', 'heading'],
  ['动手前先查有多少', 'design-method'],
  ['先不做**', 'deferred'],
  ['先不做，但别再从头推导', 'deferred'],
  ['不需要"先关那个定时器再停服务"', 'negation'],
  ['必须先关掉那个定时器再停服务', 'history'],
  ['也不需要记得跑某个单独的安装脚本', 'negation'],
  ['我不需要谁「记得」去留痕', 'heading'],
  ['不靠哪个人、哪个 agent 记得多敲一条命令', 'negation'],
  ['后来的办法是在提示词里硬写"必须记得"', 'history'],
  ['不用先想它发生在新旧分界线的哪一边', 'negation'],
  ['换个会话，它还记得我们聊过什么', 'heading'],
  ['我也不需要记得"上次是跟谁说的"', 'negation'],
  ['但收着不等于记得', 'mechanism'],
  ['下次要用时先重新定位', 'history'],
  // 痕迹那两份文档进仓后补判（2026-08-10）。逐句判过，没有一句是写给操作者的顺序要求。
  ['那边先有代码、验收去审计；这边还没有代码', 'design-method'],
  ['先量出现状，再写代码', 'design-method'],
  ['这次是先有验收、代码照着长', 'design-method'],
  ['那次是先有代码、验收去审计，找到一条红', 'history'],
  ['先报 412 条 = 3.2%', 'history'],
  ['先报 16，搜过对话档案后更正为 14', 'history'],
  ['先写 12794 / 95.8%（粗算）', 'history'],
  ['不是被接受然后打个标记', 'mechanism'],
  ['也就是说：这个系统记得住', 'mechanism'],
  ['我先跟一个 agent 聊过一件事', 'spec'],
  ['照镜子不算记得', 'spec'],
  ['我不需要记得上次是跟谁说的', 'negation'],
  ['要是某一类痕迹仍然依赖谁记得', 'not-ordering'],
  ['换个 agent、换个会话，它还记得', 'heading'],
  ['它一响，人先怀疑的是检验而不是代码', 'design-method'],
  // 环的需求、意图树的设计与验收、痕迹设计的新章节进仓后补判（2026-08-17）。
  // 逐句判过，55 句，没有一句是写给操作者的顺序要求。
  // 判定口径：选那个能解释"它为什么不是操作者顺序要求"的值。
  // 系统在人之前动手（它先问我、它先出现在我面前）算 mechanism —— 顺序压在系统这边，人什么都不用做。

  // docs/requirements/loop.md —— 环的用例
  ['小事自己做，大事先问', 'mechanism'],
  ['然后不管它', 'negation'],
  ['我不需要再去点一下、催一句、或者记得', 'negation'],
  ['U21 · 撤不回来的事，先问我一声', 'mechanism'],
  ['能撤的它直接做了，撤不回来的它先出现在我面前', 'mechanism'],
  ['发出去（消息、邮件、贴文）、删东西、花钱', 'mechanism'],
  ['一件很小但撤不回来的事，先问', 'mechanism'],
  ['我先问了你，你说了才动', 'history'],
  ['这道关卡，最常见的死法不是它拦不住', 'design-method'],
  ['先不猜', 'deferred'],

  // docs/acceptance/intent.md —— 意图树验收
  ['发生过融合之后再问一遍，仍然唯一', 'spec'],
  ['它自己说了要装下全部，然后漏了 15 条', 'history'],
  ['U17-3 和 U12（不需要谁记得去留痕）是同一个要求换了个位置', 'negation'],
  ['没人记得记一笔，事情仍然在', 'negation'],
  ['先量出现状，代码才有个照着长的东西', 'design-method'],

  // docs/acceptance/trace.md —— 痕迹验收新增断言
  ['要么让我确认，要么先去查账户真实余额', 'spec'],
  ['我不需要事先知道有东西被吞了', 'negation'],
  ['造一条这样的要求，然后', 'spec'],
  ['它一响，人先怀疑的是检验而不是系统', 'design-method'],

  // docs/design/intent.md —— 意图树设计
  ['一处措辞先讲清楚', 'design-method'],
  ['0.1 先量一遍旧的那棵', 'design-method'],
  ['先量现状，再写代码', 'design-method'],
  ['好处是能直接挂到一个老节点上，不必先', 'design-method'],
  ['放弃的理由有两条：一是上面说的两个说法', 'mechanism'],
  ['我一次只在追一件事，切走是一个动作，会留痕', 'negation'],
  ['2.1 先看别人怎么做的：DeepSeek Harness', 'design-method'],
  ['没有第二个地方要写，也没有谁要记得多敲一条命令', 'negation'],
  ['[意图·纠了] 不是验收，是先把判据定下来', 'spec'],
  ['因为对话已经被自动截走了', 'negation'],
  ['这三个字符串是我们定的', 'design-method'],
  ['要用这条判据，理由就得先在那儿', 'design-method'],
  ['在那儿找不到血缘建模的先例', 'design-method'],
  ['现在它是查出来的：不用谁记得写，也不会写错', 'negation'],
  ['判据本身可以留下来当筛子', 'design-method'],
  ['目标那套东西本身：在血缘上没有先例可抄', 'design-method'],
  ['要挂到老节点上就得先', 'mechanism'],
  ['融合 = 一条非出生边，两条出生边不动', 'design-method'],
  ['融合的表示是自己造的', 'design-method'],

  // docs/design/trace.md —— 痕迹设计新章节
  ['先说清楚它答不了的那一半，别含糊过去', 'design-method'],
  ['先按字节做，这条留着', 'deferred'],
  ['5.3 进索引之前先问一句', 'mechanism'],
  ['文档自己先破这条规矩说不过去', 'design-method'],
  ['不靠谁记得去看', 'negation'],
  ['10.1 先按第一原则问', 'design-method'],
  ['先解释两个词，后面一直用', 'design-method'],
  ['不过就直接返回，连折叠都不做', 'mechanism'],
  ['外层套着的那个先响时', 'mechanism'],
  ['先给告示预留字节', 'mechanism'],
  ['就得先证明这个探针在它该响的时候会响', 'design-method'],
  ['先解释一个词', 'design-method'],
  ['校验过的候选先**暂存**起来', 'mechanism'],
  ['的字节数做——**但字节不等于读的人真正付的代价**', 'deferred'],
  ['一响人先怀疑检验，几次之后就没人看了', 'design-method'],
  ['校验过的候选先暂存，发布时核对', 'mechanism'],

  // 四份需求文档补写"不这么做会怎样"的反面场景之后补判（2026-08-17）。
  // 逐句判过，16 句，没有一句是写给操作者的顺序要求 —— 它们全是"不这么做会怎样"底下
  // 那段亲历叙述：讲的是**没有这条需求时我过的是什么日子**，不是叫谁按什么次序动手。
  // 沿用上一段的口径：系统在人之前动手算 mechanism。
  // 三个值各管一类：亲历/实测的经过 = history；对着一个设计选择讲道理（"要是不…我会…"）
  // = design-method；顺序压在系统那边 = mechanism。

  // docs/requirements/intent.md —— U15 的反面场景
  ['每次开口它都先告诉我', 'mechanism'],

  // docs/requirements/loop.md —— U20 / U21 / U24 的反面场景
  ['后写的盖掉先写的', 'mechanism'],
  ['我先问了，得到答复才动', 'history'],
  ['我派了一件活出去，然后就没有然后了', 'history'],
  ['然后我派了一件需要长时间思考的活', 'design-method'],

  // docs/requirements/trace.md —— U8 / U10 / U11 / U12 / U13 / U14 的反面场景
  ['我先说「装 numpy 2.1.0」', 'history'],
  ['你是怎么决定哪些事要先问我一声的', 'mechanism'],
  ['我拿这四个词挨个去搜整份记忆，然后等', 'history'],
  ['我先在心里估一下值不值得等', 'history'],
  ['办法是在叮嘱里加一句', 'history'],
  ['管用了一阵子', 'history'],
  ['话到嘴边我先卡了一下', 'history'],
  ['我做的第一件事不是问，是先判断这事该去哪边问', 'history'],
  ['要是不把这句话明写出来', 'design-method'],
  ['我要是只碰巧问了头两个', 'design-method'],
  ['空的我一眼就不会信', 'design-method'],

  // docs/TODO.md —— 不是这个项目的文件（root 写入、未被 git 跟踪），见报告。
  // "先验" 是先验概率的先验，不是"先做这个"：扫描器的 COMPOUNDS 没收这个词，是一次词法误伤。
  ['支持 M1 装配（注入 Captain 先验与 L3 当前任务上下文）', 'spec'],

  // README.md 进仓后补判（2026-08-19）。两句都在架构图（mermaid）的边标签里。
  ['没人需要记得留痕', 'negation'],
  ['该动的自己动，撤不回的先问', 'mechanism'],

  // docs/requirements/bridge.md 进仓后补判（2026-08-19）。逐句判过，10 句，没有一句是
  // 写给操作者的顺序要求：反面场景与案底的亲历叙述 = history；引用"我会说的话" = spec；
  // 系统替人记着 = mechanism；画布与手机入口留到后面 = deferred。
  ['靠反复叮嘱"必须记得"来堵', 'history'],
  ['文档换英文、口吻重来、然后是这份桥', 'history'],
  ['新开一段，我先花几分钟把背景讲一遍', 'history'],
  ['"先弄别的"、"回到刚才那个"', 'spec'],
  ['我说"先弄别的"，它答"好"', 'history'],
  ['每段对话**记得自己是从哪个节点出发的**', 'mechanism'],
  ['旧系统那位「记得回复、忘了留痕」的', 'history'],
  ['（2026-08-19 游渊定：先做桥）', 'deferred'],
  ['先让第一个入口（桥）立住', 'design-method'],
  ['等桥在我最常说话的地方先立住', 'deferred'],
];

test('U2-4: 我没有被要求按任何顺序做事 —— 扫全部文档，没有一句"先…再…"是写给操作者的', () => {
  const COMPOUNDS = /原先|先后|优先|领先|祖先|先进|先前|率先|先生/g;
  const SUSPECT = [
    /先/, /然后|之后再|再执行|再运行|再敲/, /记得|别忘|务必|切记/,
    /\bfirst\b[^.\n]{0,80}\bthen\b/i, /before you\b|make sure to run|remember to run/i,
  ];
  const found: { where: string; text: string }[] = [];
  for (const f of walkFiles(REPO).filter((p) => p.endsWith('.md'))) {
    readFileSync(f, 'utf8').split('\n').forEach((line, i) => {
      for (const s of line.split(/(?<=[。！？])/)) {
        if (SUSPECT.some((re) => re.test(s.replace(COMPOUNDS, '')))) {
          found.push({ where: `${f.replace(`${REPO}/`, '')}:${i + 1}`, text: s.trim() });
        }
      }
    });
  }
  assert.ok(found.length > 0, '一句都没扫到 —— 是扫描坏了，不是文档干净');

  const unjudged = found.filter((s) => !JUDGED.some(([snip]) => s.text.includes(snip)));
  assert.deepEqual(unjudged.map((s) => `${s.where} ${s.text}`), [],
    '出现了没被判定过的句子：必须逐句判一次，才能说 U2-4 过没过');

  const offenders = found
    .filter((s) => JUDGED.some(([snip, v]) => v === 'operator-order' && s.text.includes(snip)))
    .map((s) => `${s.where} ${s.text}`);
  assert.deepEqual(offenders, [], '文档里还有写给操作者的顺序要求');
  console.log(`  U2-4: 扫到 ${found.length} 句可疑的，逐句判定后 0 句是写给操作者的顺序要求`);
});

// ──────────────────────────── U3 · 我要知道现在什么在跑 ────────────────────────────

test('U3-1: 说在跑，就真在跑', async () => {
  const { t } = mk();
  t.add({ name: 'live1', needs: [], command: 'exec sleep 3000' });
  t.add({ name: 'live2', needs: [], command: 'exec sleep 3000' });
  await t.up();
  const running = (await t.status()).parts.filter((p) => p.state.kind === 'running');
  assert.ok(running.length > 0, '一个都没报"在跑"，这条无从验起');
  for (const p of running) {
    const procs = cgroup(p.unit).procs;
    assert.ok(procs.length >= 1 && procs.every(alive),
      `它说 ${p.name} 在跑，真实系统里 ${p.unit} 一个活进程都没有`);
  }
});

test('U3-2: 说停了，就真停了', async () => {
  const { t } = mk();
  t.add({ name: 'on', needs: [], command: 'exec sleep 3000' });
  t.add({ name: 'off', needs: [], command: 'exec sleep 3000' });
  await t.up();
  await t.down('off');
  const stopped = (await t.status()).parts.filter((p) => p.state.kind === 'stopped');
  assert.ok(stopped.length > 0, '一个都没报"停了"，这条无从验起');
  for (const p of stopped) {
    assert.deepEqual(cgroup(p.unit).procs, [], `它说 ${p.name} 停了，${p.unit} 里还有进程`);
  }
});

test('U3-3: 还在启动中的，不许说成在跑', async () => {
  const { t, traceDir } = mk();
  const ready = `${traceDir}/READY`;
  // 一个"启动很慢"的部件：3 秒后才开始真正干活，干活的第一件事是写下 READY。
  // 声明里连"什么算起来了"一起说了：READY 出现，才算这个部件能干活。
  t.add({
    name: 'slow', needs: [],
    command: `/bin/sh -c "sleep 3; touch ${ready}; exec sleep 3000"`,
    ready: `test -e ${ready}`,
  });
  const starting = t.up();
  starting.catch(() => { /* 下面 await 它；这里只是不让它变成没人接的拒绝 */ });

  // 等到内核确认它的进程真的在了 —— 这一刻正是这条用例要问的处境：
  // 有进程，但部件还干不了活。
  await until('它的进程起来了', () => cgroup(`${PREFIX}slow.service`).procs.length >= 1);
  const before = existsSync(ready);
  const during = (await t.status()).parts[0]?.state.kind;
  const after = existsSync(ready);
  assert.equal(before || after, false, '前提没成立：它已经起来了，这一问不在"启动中"');
  assert.notEqual(during, 'running', `它还在启动中（READY 还没写出来），却被报成 "${during}"`);

  // 就绪之后再问一次：这时候才可以说"在跑"，否则这条用例只要一律不说"在跑"就能糊弄过去。
  await starting;
  assert.ok(existsSync(ready), 'up() 返回了，但它还没就绪');
  assert.equal((await t.status()).parts[0]?.state.kind, 'running',
    '它已经能干活了，却还不肯说"在跑"');
});

test('U3-4: 问不出来的时候，不许说"停了"', async () => {
  const { t } = mk();
  t.add({ name: 'blind', needs: [], command: 'exec sleep 3000' });
  await t.up();
  // 让它问不到底层系统：把会话总线指到一个存在、但没有 user bus 的目录
  // （远程会话没开 lingering 就是这个形状）。只动环境，不动内部代码。
  const saved = [process.env['XDG_RUNTIME_DIR'], process.env['DBUS_SESSION_BUS_ADDRESS']] as const;
  const noBus = mkdtempSync(`${tmpdir()}/theseus-t-nobus-`);
  tmpDirs.push(noBus);
  process.env['XDG_RUNTIME_DIR'] = noBus;
  process.env['DBUS_SESSION_BUS_ADDRESS'] = `unix:path=${noBus}/bus`;
  let answer: string;
  try {
    answer = await t.status().then(
      (s) => `给了答案：${JSON.stringify(s.parts.map((p) => [p.name, p.state]))}`,
      (e: Error) => `拒答：${e.name}: ${e.message}`,
    );
  } finally {
    if (saved[0] !== undefined) process.env['XDG_RUNTIME_DIR'] = saved[0];
    if (saved[1] !== undefined) process.env['DBUS_SESSION_BUS_ADDRESS'] = saved[1];
    else delete process.env['DBUS_SESSION_BUS_ADDRESS'];
  }
  assert.ok(answer.startsWith('拒答'), `问不到底层系统时它照样给了答案：${answer}`);
  assert.doesNotMatch(answer, /"kind":"(stopped|not-installed)"/, `问不到时降级成了"没在跑"：${answer}`);
  assert.match(answer, /unreachable|not the same as "nothing is running"/,
    `拒答了，但没说清"我问不到"：${answer}`);
  assert.equal((await t.status()).parts[0]?.state.kind, 'running', '它看不见的这段时间里，部件一直在跑');
  console.log(`  U3-4: ${answer.split('.')[0]}`);
});

// ───────────────────────────── U4 · 我要加一个新部件 ─────────────────────────────

test('U4-1: 只动声明这一处，新部件就被纳管了', async () => {
  const decl = `${REPO}/parts.ts`;
  const original = readFileSync(decl, 'utf8');
  const traceDir = mkTraceDir();
  tmpDirs.push(traceDir);
  const before = snapshot();
  try {
    // 这是这条用例里"我做的全部事情"：在声明里加一行。
    assert.ok(original.includes('\n];'), '声明文件不是预期的形状，测试需要重写');
    writeFileSync(decl, original.replace('\n];',
      `\n  { name: 'newcomer', needs: [], command: 'exec sleep 3000' },\n];`));

    // 另起一个进程读那份声明（新进程 = 没有模块缓存），只用公开的三个动作。
    const script = `
      import { parts } from ${JSON.stringify(`${REPO}/parts.ts`)};
      import { Theseus } from ${JSON.stringify(`${REPO}/src/theseus.ts`)};
      const t = new Theseus(${JSON.stringify({ unitDir: UNIT_DIR, traceDir, prefix: PREFIX })});
      for (const p of parts) t.add(p);
      await t.up();
      console.log('UP ' + JSON.stringify((await t.status()).parts));
      await t.down();
      console.log('DOWN ' + JSON.stringify((await t.status()).parts));
    `;
    const child = spawnSync(process.execPath, ['--input-type=module', '-e', script], { encoding: 'utf8' });
    assert.equal(child.status, 0, `没改任何别的东西就用不起来：${child.stderr}`);
    const rows = (tag: string): { name: string; state: { kind: string } }[] =>
      JSON.parse(child.stdout.split('\n').find((l) => l.startsWith(`${tag} `))?.slice(tag.length + 1) ?? '[]');
    assert.equal(rows('UP').find((p) => p.name === 'newcomer')?.state.kind, 'running', '新部件起不来');
    assert.equal(rows('DOWN').find((p) => p.name === 'newcomer')?.state.kind, 'stopped', '新部件停不掉');

    const changed = diff(before, snapshot());
    assert.deepEqual(changed, [`changed ${decl}`],
      '除了声明那一处，还有别的文件被改过（启停代码 / 手写的配置 / 安装脚本）');
  } finally {
    writeFileSync(decl, original);
  }
});

test('U4-2: 依赖绕了个圈 → 当场报错并点名那条链', async () => {
  const t = sandbox('u42');
  t.add({ name: 'x', needs: ['y'], command: 'exec sleep 1' });
  t.add({ name: 'y', needs: ['z'], command: 'exec sleep 1' });
  t.add({ name: 'z', needs: ['x'], command: 'exec sleep 1' });
  await assert.rejects(t.up(), (e: Error) => {
    for (const n of ['x', 'y', 'z']) {
      assert.match(e.message, new RegExp(`\\b${n}\\b`), `错误信息里没点名 ${n}：${e.message}`);
    }
    return true;
  });
});

test('U4-3: 依赖的东西不存在 → 当场报错并点名', async () => {
  const t = sandbox('u43');
  t.add({ name: 'x', needs: ['nosuchthing'], command: 'exec sleep 1' });
  await assert.rejects(t.up(), (e: Error) => {
    assert.match(e.message, /nosuchthing/, `错误信息里没点名那个不存在的东西：${e.message}`);
    return true;
  });
});

test('U4-4: 在动手做任何事之前拦下 —— 磁盘上一个文件都没生成，一个进程都没启动', async () => {
  const unitDir = mkdtempSync(`${tmpdir()}/theseus-t-u44-`);
  tmpDirs.push(unitDir);
  const traceDir = `${unitDir}/trace`;
  const prefix = `${PREFIX}u44-`;
  const t = new Theseus({ unitDir, traceDir, prefix });
  t.add({ name: 'good', needs: [], command: 'exec sleep 3000' });
  t.add({ name: 'bad', needs: ['ghost'], command: 'exec sleep 3000' });
  await assert.rejects(t.up(), /ghost/);

  assert.deepEqual(readdirSync(unitDir), [], `出错了还是往盘上写了东西：${readdirSync(unitDir)}`);
  assert.equal(existsSync(traceDir), false, '出错了还是建了痕迹目录');
  const started = testUnitsHeldBySystemd().filter((u) => u.startsWith(prefix));
  assert.deepEqual(started, [], `出错了还是启动了东西：${started}`);
});

// ─────────────────────── U5 · 我要把 Theseus 搬到另一台机器 ───────────────────────

test('U5-1: 完全恢复 —— 按名字逐个删光这份声明产生的文件，做一次启动动作，一切照旧', async () => {
  const { t } = mk();
  t.add({ name: 'm1', needs: [], command: 'exec sleep 3000' });
  t.add({ name: 'm2', needs: ['m1'], command: 'exec sleep 3000' });
  await t.up();

  // 模拟"一台什么都没装的机器"：把这份声明装进系统的每一样，按名字逐个清掉。
  const installed = await unitsOf(t);                // 名字来自 status()，不是通配
  await t.down();
  for (const u of installed) {
    assert.ok(u.startsWith(PREFIX), `安全闸：拒绝删不属于测试前缀的 ${u}`);
    rmSync(`${UNIT_DIR}/${u}`, { force: true });      // 逐个字面量，全程没有 theseus-* 通配
  }
  execFileSync('systemctl', ['--user', 'daemon-reload']);
  assert.deepEqual(testUnitFiles(), [], '前提没成立：文件没删干净');
  assert.deepEqual((await t.status()).parts.map((p) => p.state.kind), ['not-installed', 'not-installed']);

  await t.up();                                      // 拷仓库过来 + 一个动作，没有别的步骤
  const back = await t.status();
  assert.deepEqual(back.parts.map((p) => [p.name, p.state.kind]), [['m1', 'running'], ['m2', 'running']]);
  assert.ok(back.parts.every((p) => p.unitMatchesDeclaration), '恢复出来的东西跟声明对不上');
  assert.deepEqual([...back.missingUnits], []);
  assert.deepEqual([...back.orphanUnits], []);
});

test('U5-2: 没有单独的安装步骤 —— 仓库里没有安装脚本，文档里也没有"装完还要手动做一件事"', () => {
  const files = walkFiles(REPO).map((f) => f.replace(`${REPO}/`, ''));
  const scripts = files.filter((f) =>
    /(^|\/)(install|setup|bootstrap|provision|postinstall|configure)[^/]*$/i.test(f)
    || /\.sh$/.test(f) || /(^|\/)Makefile$/.test(f));
  assert.deepEqual(scripts, [], `仓库里有看着像"必须先跑一次"的安装脚本：${scripts}`);

  const pkg = JSON.parse(readFileSync(`${REPO}/package.json`, 'utf8')) as { scripts?: Record<string, string> };
  const hooks = Object.keys(pkg.scripts ?? {})
    .filter((k) => ['preinstall', 'install', 'postinstall', 'prepare', 'prepublish'].includes(k));
  assert.deepEqual(hooks, [], `package.json 里有安装钩子：${hooks}`);

  // 文档里提到"安装脚本 / 安装步骤"的每一句，必须是在说"没有这东西"。
  const claims: string[] = [];
  for (const f of files.filter((p) => p.endsWith('.md'))) {
    readFileSync(`${REPO}/${f}`, 'utf8').split('\n').forEach((line, i) => {
      for (const s of line.split(/(?<=[。！？])/)) {
        if (/安装脚本|安装步骤|install script/i.test(s) && !/没有|不需要|不存在|无需|不用/.test(s)) {
          claims.push(`${f}:${i + 1} ${s.trim()}`);
        }
      }
    });
  }
  assert.deepEqual(claims, [], `文档里还写着要做的安装动作：\n${claims.join('\n')}`);
});

test('U5-3: 没有东西被落在系统里 —— 装进系统的每一样都推得出来，反过来也一样', async () => {
  const { t, traceDir } = mk();
  t.add({ name: 's1', needs: [], command: 'exec sleep 3000' });
  t.add({ name: 's2', needs: ['s1'], command: 'exec sleep 3000' });
  await t.up();
  const declared = (await unitsOf(t)).sort();

  const s = await t.status();
  assert.deepEqual([...s.missingUnits], [], '声明里有，系统里没装');
  assert.deepEqual([...s.orphanUnits], [], '系统里有声明推不出来的东西');
  assert.deepEqual(testUnitFiles().sort(), declared, '盘上的文件跟声明推出来的对不上');
  assert.deepEqual(testUnitsHeldBySystemd().sort(), declared, 'systemd 手里握着声明推不出来的 unit');
  const strayTraces = readdirSync(traceDir).filter((f) => !['s1.log', 's2.log'].includes(f));
  assert.deepEqual(strayTraces, [], `痕迹目录里有推不出来的文件：${strayTraces}`);
});

// ───────────────────────────── U6 · 出问题时我要能查 ─────────────────────────────

test('U6-1: 装着、但声明里没有的 → 被点名', async () => {
  const { t } = mk();
  t.add({ name: 'declared', needs: [], command: 'exec sleep 3000' });
  await t.up();
  const intruder = `${PREFIX}intruder.service`;      // 手工塞一个进去
  writeFileSync(`${UNIT_DIR}/${intruder}`, '[Service]\nExecStart=/bin/true\n');

  const s = await t.status();
  assert.ok(s.orphanUnits.includes(intruder),
    `手工塞进去的 ${intruder} 没被报出来：${JSON.stringify(s.orphanUnits)}`);
});

test('U6-2: 声明了、但没装的 → 被点名', async () => {
  const { t } = mk();
  t.add({ name: 'kept', needs: [], command: 'exec sleep 3000' });
  t.add({ name: 'wiped', needs: [], command: 'exec sleep 3000' });
  await t.up();
  await t.down('wiped');
  const wiped = `${PREFIX}wiped.service`;
  rmSync(`${UNIT_DIR}/${wiped}`, { force: true });    // 手工删掉一个该装的

  const s = await t.status();
  assert.ok(s.missingUnits.includes(wiped),
    `被删掉的 ${wiped} 没被报出来：${JSON.stringify(s.missingUnits)}`);
});

test('U6-3: 在跑、但盘上没有它的文件的 → 也要被点名，不许从列表里消失', async () => {
  const { t } = mk();
  t.add({ name: 'fileless', needs: [], command: 'exec sleep 3000' });
  await t.up();
  const unit = `${PREFIX}fileless.service`;
  rmSync(`${UNIT_DIR}/${unit}`, { force: true });     // 文件没了，进程还在

  const s = await t.status();
  const row = s.parts.find((p) => p.name === 'fileless');
  assert.ok(row, '它从列表里消失了');
  assert.equal(row.state.kind, 'running', `它还在跑，却被报成 ${row.state.kind}`);
  assert.ok(cgroup(unit).procs.length >= 1, '前提没成立：进程其实已经没了');
  assert.ok(s.missingUnits.includes(unit), '盘上没文件这件事没被报出来');

  // 换一个"什么都没声明"的人来问，它也不该凭空消失。
  const observerTrace = mkTraceDir();
  tmpDirs.push(observerTrace);
  const observer = new Theseus({ unitDir: UNIT_DIR, traceDir: observerTrace, prefix: PREFIX });
  assert.ok((await observer.status()).orphanUnits.includes(unit),
    '在别人眼里，这个在跑但盘上无文件的东西凭空消失了');
});

test('U6-4: 不只能用 Theseus 自己的工具 —— 每个部件都能被 systemctl status 和 journalctl 直接查到', async () => {
  const { t } = mk();
  t.add({ name: 'q1', needs: [], command: 'exec sleep 3000' });
  t.add({ name: 'q2', needs: ['q1'], command: 'exec sleep 3000' });
  await t.up();

  for (const p of (await t.status()).parts) {
    const st = spawnSync('systemctl', ['--user', 'status', p.unit, '--no-pager'], { encoding: 'utf8' });
    assert.equal(st.status, 0, `systemctl status ${p.unit} 退出 ${st.status}：${st.stderr}`);
    assert.match(st.stdout, /Active: active \(running\)/, `systemctl 查不到 ${p.unit} 在跑：\n${st.stdout}`);

    const j = spawnSync('journalctl', ['--user', '-u', p.unit, '-n', '20', '--no-pager'], { encoding: 'utf8' });
    assert.equal(j.status, 0, `journalctl -u ${p.unit} 退出 ${j.status}：${j.stderr}`);
    assert.match(j.stdout, new RegExp(p.unit.replaceAll('.', '\\.')),
      `journalctl 跟不到 ${p.unit} 的日志：\n${j.stdout}`);
  }
});

test('U6-5: 主动报，不是等我撞见 —— 三种对不上都出现在正常的那一问里', async () => {
  const { t } = mk();
  t.add({ name: 'normal', needs: [], command: 'exec sleep 3000' });
  t.add({ name: 'erased', needs: [], command: 'exec sleep 3000' });
  t.add({ name: 'ghost', needs: [], command: 'exec sleep 3000' });
  await t.up();
  const stranger = `${PREFIX}stranger.service`;
  writeFileSync(`${UNIT_DIR}/${stranger}`, '[Service]\nExecStart=/bin/true\n');   // ① 装着但没声明
  await t.down('erased');
  rmSync(`${UNIT_DIR}/${PREFIX}erased.service`, { force: true });                // ② 声明了但没装
  rmSync(`${UNIT_DIR}/${PREFIX}ghost.service`, { force: true });                 // ③ 在跑但盘上没文件

  const s = await t.status();                        // 正常的那一问，没加任何参数
  assert.ok(s.orphanUnits.includes(stranger), `① 没在这一问里出现：${JSON.stringify(s.orphanUnits)}`);
  assert.ok(s.missingUnits.includes(`${PREFIX}erased.service`), `② 没在这一问里出现：${JSON.stringify(s.missingUnits)}`);
  assert.ok(s.missingUnits.includes(`${PREFIX}ghost.service`), `③ 没在这一问里出现：${JSON.stringify(s.missingUnits)}`);
  assert.equal(s.parts.find((p) => p.name === 'ghost')?.state.kind, 'running', '③ 在跑这件事被这一问漏掉了');
});
