/**
 * 验收测试：docs/acceptance/intent.md 的 U15–U19。
 *
 * 六条纪律（照规格）：
 *  一、只从需求推。断言的措辞照抄规格，不照代码。
 *  二、只走用户看得见的那道门：只 import `src/trace.ts`、`src/intent.ts`、`src/doors.ts`。
 *  三、断言「人的处境」，不是「机制的状态」。
 *  四、不是每条都得是代码：U15-6 / U16-6 / U18-5 / U19-8 的"旧树那半"已在
 *      2026-08-16 拿真数据量完，数字记在规格里；这里验的是"新的必须…"那半。
 *  五、不许把实现写进断言。
 *  六、这一份的红比绿更重要：凡断言"取得出来 / 捞得出来 / 列得出来"的，
 *      绿必须是**真的取一次、看一眼取到的是什么**，不能是"机制在那儿"。
 *
 * 跑法：node --test test/acceptance/intent.test.ts
 */
import assert from 'node:assert/strict';
import { existsSync, mkdtempSync, readFileSync, readdirSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { after, afterEach, test } from 'node:test';
import { agentDoor, humanDoor } from '../../src/doors.ts';
import { Intent, IntentRefused, correctedLine } from '../../src/intent.ts';
import { Trace, TraceRefused } from '../../src/trace.ts';
import type { Step } from '../../src/trace.ts';

const TMP_PREFIX = `theseus-t-intent-${process.pid}-`;
const tmpDirs: string[] = [];
const made: string[] = [];
const traces: Trace[] = [];

const scratch = (): string => {
  const dir = mkdtempSync(`${tmpdir()}/${TMP_PREFIX}`);
  tmpDirs.push(dir);
  made.push(dir);
  return dir;
};

const A = 'agent:claude:sess-t';

/** 一份空痕迹 + 替我记痕迹的那个 agent + 一个可拨的钟（默认真钟）。 */
const mk = (now?: () => number): { t: Trace; i: Intent; file: string } => {
  const file = `${scratch()}/trace.db`;
  const t = now ? new Trace(file, { now }) : new Trace(file);
  traces.push(t);
  return { t, i: new Intent(t, A), file };
};

/** 我说的一句话：走人的门。 */
const said = (t: Trace, what: string): Step =>
  humanDoor(t).record({
    actor: 'user:human:cli', type: 'user.message_received',
    origin: 'you-said', payload: { text: what },
  });

/** 说一句就认下一条意图。返回节点号（= 那条 intent.adopted 的痕迹号）。 */
const adopt = (t: Trace, i: Intent, sentence: string, saying: string): string =>
  i.adopt({ said: said(t, sentence).id, text: saying }).id;

afterEach(() => {
  for (const t of traces.splice(0)) t.close();
  for (const d of tmpDirs.splice(0)) rmSync(d, { recursive: true, force: true });
});

// ──────────────── U15 · 我随时知道自己在追什么、它从哪来 ────────────────

/** 需求里那条真走过的路：七跳，中间没有一跳是错的。 */
const SEVEN_JUMPS = [
  '停旧系统', '启停该怎么设计', '人类史上怎么解决', '换地基',
  '写需求', '沉淀经验', '痕迹', '意图树',
];

test('U15-1: 一句话就说清了 —— 既有我此刻在追的，也有它是从哪个更大的念头分出来的', () => {
  const { t, i } = mk();
  adopt(t, i, '把 Theseus 重建起来', '重建 Theseus');
  adopt(t, i, '先把启停做了', '把启停做出来');
  const line = i.line();
  assert.ok(line.includes('把启停做出来'), `这句话里没有我此刻在追的：${line}`);
  assert.ok(line.includes('重建 Theseus'), `这句话里没有它从哪个念头分出来：${line}`);
});

test('U15-2: 不用我自己想，它摆在那儿 —— 换个会话重新打开，什么都不问，这句话还是原样', () => {
  const { t, i, file } = mk();
  adopt(t, i, '把 Theseus 重建起来', '重建 Theseus');
  adopt(t, i, '先把启停做了', '把启停做出来');
  const before = i.line();

  // 新会话：另一个进程般重新打开同一份痕迹，不带任何内存里的状态。
  const fresh = new Trace(file);
  traces.push(fresh);
  assert.equal(new Intent(fresh, A).line(), before,
    '换个地方打开，那句话就不一样了 —— 说明它不是从痕迹里看出来的，是记在谁的脑子里的');
});

test('U15-3: 走七跳还答得上"当初为什么开始" —— 根那层在，中间六层一层不缺', () => {
  const { t, i } = mk();
  for (const jump of SEVEN_JUMPS) adopt(t, i, `下一跳：${jump}`, jump);
  const line = i.line();
  for (const jump of SEVEN_JUMPS) {
    assert.ok(line.includes(jump), `站在第七跳上问"我在追什么"，「${jump}」这一层不见了：${line}`);
  }
  const heads = SEVEN_JUMPS.map((j) => line.indexOf(j));
  assert.deepEqual(heads, [...heads].sort((a, b) => a - b),
    `层的顺序乱了 —— 答案必须从"当初为什么开始"一路说到现在：${line}`);
});

test('U15-4: 路只有一条 —— 随便挑一个节点问它从哪来，答案唯一；融合之后再问，仍然唯一', () => {
  const { t, i } = mk();
  const root = adopt(t, i, '把家里的系统理顺', '理顺工作系统');
  const a = adopt(t, i, '先做道路管养的本子', '道路管养本子');
  i.resume({ said: said(t, '回到大盘').id, node: root });
  const b = adopt(t, i, '再开 LLMAD 研究', 'LLMAD 研究');

  /** 只用看得见的树问"它从哪来"：一步只有一个上一层，就是一条路。 */
  const wayUp = (node: string): string[] => {
    const nodes = i.tree().nodes;
    const way: string[] = [];
    for (let cur: string | null = node; cur !== null; ) {
      const n = nodes.get(cur);
      if (n === undefined) break;
      way.push(cur);
      cur = n.parent;
    }
    return way;
  };
  const beforeA = wayUp(a);
  const beforeB = wayUp(b);
  assert.deepEqual(beforeA, [a, root], '问 A 从哪来，答案不是唯一的一条路');

  i.merge({ said: said(t, '这俩是一件事').id, a, b });
  assert.deepEqual(wayUp(a), beforeA, '融合之后再问 A 从哪来，那条路变了');
  assert.deepEqual(wayUp(b), beforeB, '融合之后再问 B 从哪来，那条路变了');
});

test('U15-5: 树上说的和实际发生的不可能是两回事 —— 改说法的唯一办法是发生一件事，而旧说法原地不动', () => {
  const { t, i, file } = mk();
  const node = adopt(t, i, '把事件表做出来', '做一张事件表');

  // 我纠正它。树跟着变 ——
  i.correct({ said: said(t, '不叫事件表，叫痕迹').id, target: node, text: '把痕迹做出来' });
  assert.equal(i.tree().nodes.get(node)?.saying, '把痕迹做出来', '我纠了，树上还是旧说法');

  // —— 而历史一个字没动：出生那条痕迹里还是当时的话。
  assert.equal(t.get(node)?.payload['text'], '做一张事件表',
    '旧说法被改掉了 —— 那就有了第二份可以被编辑的东西');

  // 没有第二份存储：从文件重新打开，看到的是同一棵树。
  const fresh = new Trace(file);
  traces.push(fresh);
  assert.deepEqual(new Intent(fresh, A).tree(), i.tree(),
    '两次从痕迹里长出来的树不一样 —— 说明有一份树被另存了');
});

test('U15-6: 新的必须 100% —— 树上每一个节点都指得回一条真痕迹（指不回的根本进不来）', () => {
  const { t, i } = mk();
  for (const jump of SEVEN_JUMPS) adopt(t, i, `说：${jump}`, jump);
  const nodes = [...i.tree().nodes.values()];
  assert.ok(nodes.length > 0);
  for (const n of nodes) {
    assert.ok(t.get(n.id) !== null, `节点「${n.saying}」（${n.id}）指不回任何一条痕迹 —— 它凭空存在`);
  }
});

// ──────────── U16 · 我散出去的分支不会丢，想捡的时候捡得回来 ────────────

test('U16-1/U16-2: 悬着的列得出来，每一条都看得到它当时长到哪一步、旁边在聊什么', () => {
  const { t, i } = mk();
  adopt(t, i, '把网理顺', '理顺网络');
  const derp = adopt(t, i, '搭杭州 DERP', '自建杭州 DERP');
  agentDoor(t).record({
    actor: A, type: 'task.requested', cause: derp,
    payload: { task: '压测 DERP 中继延迟' },
  });
  agentDoor(t).record({
    actor: A, type: 'task.completed', cause: derp,
    payload: { note: '延迟 38ms，可用' },
  });

  const list = i.dangling();
  assert.ok(list.some((n) => n.id === derp), '开了头没走完的分支，名单上没有它 —— 它就那么消失了');

  // 真的取一次，看一眼取到的是什么（纪律六）。
  const under = t.became(derp);
  assert.ok(under.some((s) => s.payload['task'] === '压测 DERP 中继延迟'),
    '名单上有它，但它当时长到哪一步查不到 —— 只剩一句干巴巴的标题');
  assert.ok(under.some((s) => s.payload['note'] === '延迟 38ms，可用'),
    '旁边聊过什么也该在 —— 不在，捡回来还是得重新想一遍');
});

test('U16-3: 没有第四种状态 —— 每一条开过头的都落在 悬着/不做了/做完了 里，没有"悄悄不见了"', () => {
  const { t, i } = mk();
  const ids = Array.from({ length: 12 }, (_, k) => adopt(t, i, `开头 ${k}`, `意图 ${k}`));
  i.done({ said: said(t, '第 3 件做完了').id, target: ids[3] as string });
  i.drop({ said: said(t, '第 5 件不做了').id, target: ids[5] as string, why: '方向换了' });

  const { nodes } = i.tree();
  assert.equal(nodes.size, ids.length,
    `开过头的有 ${ids.length} 条，树上只剩 ${nodes.size} 条 —— 少掉的那几条就是第四种状态`);
  for (const id of ids) {
    const n = nodes.get(id);
    assert.ok(n !== undefined, `${id} 悄悄不见了`);
    assert.ok(['open', 'done', 'dropped'].includes(n.status),
      `${id} 落在了三种之外：${n.status}`);
  }
});

test('U16-4/U16-5: 收不收不看时长 —— 只差"悬了多久"的两条待遇完全一样，过一年也没人催收尾', () => {
  const day = 86_400_000;
  let clock = Date.parse('2026-01-01T00:00:00Z');
  const { t, i } = mk(() => clock);

  adopt(t, i, '开工', '大盘');
  const old = adopt(t, i, '想法甲', '一个想法');
  clock += 300 * day;                                   // 一条悬了很久
  const young = adopt(t, i, '想法乙', '一个想法');       // 一条刚开的，各方面都一样

  const listBefore = i.dangling().map((n) => n.id);
  assert.ok(listBefore.includes(old) && listBefore.includes(young),
    '只差"悬了多久"，待遇就不一样了 —— 有一条不在名单上');

  const briefingBefore = i.briefing();
  clock += 400 * day;                                   // 又过了一年多，什么都没发生
  assert.deepEqual(i.dangling().map((n) => n.id), listBefore,
    '时间自己把名单改了 —— "远"这个没人定义清楚的判据悄悄长回来了');
  assert.equal(i.briefing(), briefingBefore,
    '过了一年，摆在我面前的话变了 —— 需求里明确删掉的"主动提醒回归"不许悄悄长回来');
  for (const text of [i.briefing(), ...i.dangling().map((n) => n.saying)]) {
    assert.ok(!/催|收尾|该处理|快去/.test(text), `出现了催收尾的话：${text}`);
  }
});

test('U16-6: 新的必须 0 漏、0 混 —— 悬着的全在名单上，做完的和不做的一条不混进来', () => {
  const { t, i } = mk();
  const open: string[] = [];
  const closed: string[] = [];
  for (let k = 0; k < 10; k++) {
    const id = adopt(t, i, `第 ${k} 个念头`, `念头 ${k}`);
    if (k % 3 === 0) {
      i.done({ said: said(t, `第 ${k} 个做完了`).id, target: id });
      closed.push(id);
    } else if (k % 3 === 1) {
      i.drop({ said: said(t, `第 ${k} 个不做了`).id, target: id, why: '试过，走不通' });
      closed.push(id);
    } else {
      open.push(id);
    }
  }
  // 真的取一次（纪律六）：名单和"树上非闭环的"必须一模一样 —— 按条数、按每一条。
  const list = i.dangling().map((n) => n.id).sort();
  assert.deepEqual(list, [...open].sort(),
    `名单漏了或混了 —— 那份旧的"防丢视图"漏 15 条混 2 条，就是这么开始的`);
  for (const id of closed) {
    assert.ok(!list.includes(id), `已闭环的 ${id} 混进了悬着的名单`);
  }
});

// ────────────────────── U17 · 跳走了，我能回来 ──────────────────────

test('U17-1..4: 跳走再回来 —— 不给编号、没人写交接，拿回来的是当时那一步的原样', () => {
  const { t, i } = mk();
  const home = adopt(t, i, '把家里的网理顺', '理顺网络');
  const derp = adopt(t, i, '搭杭州 DERP', '自建杭州 DERP');
  const step1 = agentDoor(t).record({
    actor: A, type: 'task.completed', cause: derp,
    payload: { note: '协议选型定了：走 DERP 自建，不用 relay 公网' },
  });

  // 跳走：当前移走，本身就是一个动作。
  i.resume({ said: said(t, '先弄别的').id, node: home });
  adopt(t, i, '先把占城大师的问题修了', '修占城大师');

  const before = t.recent({ limit: 1000, includeRoutine: true }).length;

  // 回来：我只说"回到刚才那个"。不给会话编号、不给任何号（U17-2）——
  // 指认哪条是"刚才那个"是 agent 的事，做数的是我这句话。
  const back = said(t, '回到刚才那个');
  i.resume({ said: back.id, node: derp });

  assert.equal(i.tree().current, derp, '说了"回到刚才那个"，当前却没回去');
  assert.ok(!/[0-9A-Z]{26}|sess-|handoff/.test('回到刚才那个'),
    '这句话里混进了编号 —— 现在的办法正是"还得记住一串会话编号"，那是要废掉的');

  // U17-3：没有任何人做过"写交接"这个额外动作 —— 回来只多了我这句话和那次移动。
  assert.equal(t.recent({ limit: 1000, includeRoutine: true }).length, before + 2,
    '回来这件事之外还写了别的 —— 要是回来得靠一份手写交接，系统就没在替我记着');

  // U17-1/U17-4：接着刚才那儿走 —— 它名下发生过的事原样在，不是被总结过的版本。
  const ctx = t.became(derp);
  const found = ctx.find((s) => s.id === step1.id);
  assert.ok(found !== undefined, '当时做到哪一步，回来查不到了');
  assert.deepEqual(found.payload, step1.payload,
    '拿回来的不是当时那一步，是一份被重写过的摘要');
});

// ──────────── U18 · 两件事原来是一件，我要能把它们并起来 ────────────

test('U18-1..4: 说一句就能并；两边的出身都在；路仍然唯一；"为什么对两个方向负责"答得出来', () => {
  const { t, i } = mk();
  const root = adopt(t, i, '把手头的研究理清', '理清研究');
  const roads = adopt(t, i, '开道路管养的本子', '道路管养本子');
  i.resume({ said: said(t, '回大盘').id, node: root });
  const llmad = adopt(t, i, '开 LLMAD 研究', 'LLMAD 研究');

  const parentsBefore = [i.tree().nodes.get(roads)?.parent, i.tree().nodes.get(llmad)?.parent];

  // U18-1：说一句就能并 —— 一句话，不用给编号、不用填表。
  const oneSentence = said(t, '这俩其实是一件事');
  i.merge({ said: oneSentence.id, a: roads, b: llmad, why: '一份研究出两个本子，共用同一个内核' });

  const after = i.tree();
  // U18-2：并完之后分别问这两条"你从哪儿来"，两个答案都还在，而且都是并之前那个。
  assert.deepEqual([after.nodes.get(roads)?.parent, after.nodes.get(llmad)?.parent], parentsBefore,
    '并的时候把出身抹掉了 —— 半年后就说不清它曾经是两个念头');
  assert.equal(t.get(roads)?.payload['text'], '道路管养本子', '被并的那条的原话被动过了');
  assert.equal(t.get(llmad)?.payload['text'], 'LLMAD 研究', '被并的那条的原话被动过了');

  // U18-4：真的去查一次"为什么这份研究要同时对两个方向负责"。
  const a = after.nodes.get(roads);
  const b = after.nodes.get(llmad);
  assert.ok(a !== undefined && b !== undefined);
  assert.ok(a.mergedWith.includes(llmad) && b.mergedWith.includes(roads),
    '并完看不出它俩是一件事 —— 那这次并等于没发生');
  const record = t.became(roads).find((s) => s.type === 'intent.merged');
  assert.ok(record !== undefined, '从其中一条往后查，查不到那次并线');
  assert.equal(record.payload['why'], '一份研究出两个本子，共用同一个内核',
    '并线查到了，但"为什么"不见了');
  assert.equal(record.cause, oneSentence.id, '这次并挂的不是我那句话');
});

// U18-5（旧树那半）：旧树里没有任何一处表示"这两个是一件事"——那次真实的并线在树上
// 完全看不出来。这条不是退化，是从来没有过；数字已记在规格里，这里没有可跑的代码。

// ──────── U19 · 它越来越懂我，而且我纠正它不白费 ────────

test('U19-1/U19-7: 猜的和认的我一眼分得开 —— 而且把颜色全部去掉、当纯文本捞，仍然分得开', () => {
  const { t, i } = mk();
  adopt(t, i, '把意图树做出来', '做意图树');
  const me = said(t, '设计写完了');
  const guess = i.propose({ cause: me.id, text: '你接下来大概是想把验收也写了？' });

  const shown = i.briefing();
  assert.ok(shown.split('\n').some((l) => l.startsWith('[意图·认了]') && l.includes('做意图树')),
    `认过的那行看不出是认过的：\n${shown}`);
  assert.ok(shown.split('\n').some((l) => l.startsWith('[意图·猜的]') && l.includes('验收')),
    `它猜的那行看不出是猜的 —— 看不见哪句是猜的，我就不会开口纠：\n${shown}`);

  // 我纠它，回应本身也带记号（3.3 的第三条要求）。
  const fix = said(t, '不是验收，是先把判据定下来');
  i.correct({ said: fix.id, target: guess.id, text: '先把判据定下来' });

  // U19-7 的验法必须是"把颜色全部去掉之后还剩什么"：落成纯文本文件再捞。
  const transcript = `${scratch()}/transcript.txt`;
  writeFileSync(transcript, `${shown}\n${correctedLine('先把判据定下来')}\n`);
  const plain = readFileSync(transcript, 'utf8');
  assert.ok(!/\x1b\[/.test(plain), '记号里混了终端颜色码 —— 颜色不进文本，将来捞不出来');
  const fished = [...plain.matchAll(/^\[意图·(认了|猜的|纠了)\] (.*)$/gm)].map((m) => m[1]);
  assert.deepEqual(fished, ['认了', '猜的', '纠了'],
    `纯文本状态下一条正则捞出来的是：${fished} —— 三种记号必须都捞得出、分得开`);
});

test('U19-2/U19-3: 一句话就能纠，纠过的取得出来而且成对 —— 真的捞一次，看两边的原文', () => {
  const { t, i } = mk();
  const me = said(t, '接着做');
  const guess = i.propose({ cause: me.id, text: '你是想先写验收吧？' });
  // 一句话就完事，不给编号、不进任何菜单 —— 编号是 agent 自己指的。
  i.correct({ said: said(t, '不是验收，是先把判据定下来').id, target: guess.id, text: '先把判据定下来' });

  const pairs = i.corrections();
  assert.equal(pairs.length, 1, `纠了一次，捞出来 ${pairs.length} 对`);
  const pair = pairs[0];
  assert.ok(pair !== undefined);
  assert.equal(pair.guessed.payload['text'], '你是想先写验收吧？',
    '只有纠没有猜 —— 不知道纠的是什么，这对就不成对');
  assert.equal(pair.corrected.payload['text'], '先把判据定下来',
    '只有猜没有纠 —— 那就是今天的状况，信号被扔掉了');
});

test('U19-4/U19-5: 我不吭声也被记下来 —— 但它不算树上的洞，也不再摆到我面前', () => {
  const { t, i } = mk();
  adopt(t, i, '把意图树做出来', '做意图树');
  const me = said(t, '设计写完了');
  const guess = i.propose({ cause: me.id, text: '要不要顺手把环也设计了？' });

  // 我还没再开口 —— 还没轮到，不是没接（不冤枉人）。
  assert.equal(i.unanswered().length, 0,
    '我根本还没开口，它就被记成"没接"了 —— 一条会冤枉人的检验和不会说不的检验一样坏');

  // 我开口了，而那次开口没有回应它 —— 从这一刻起它进信号那一堆。
  said(t, '先把折叠写完');
  const ignored = i.unanswered();
  assert.equal(ignored.length, 1, '我没答这件事本身查不出来 —— 免费的信号又被扔掉了');
  const sig = ignored[0];
  assert.ok(sig !== undefined);
  assert.equal(sig.payload['text'], '要不要顺手把环也设计了？', '提了什么，查不到原文');
  assert.equal(sig.actor, A, '谁提的，查不到');
  assert.ok(sig.ts.length > 0, '什么时候提的，查不到');

  // U19-5：它不出现在"我在追什么"里，也不出现在"还有什么悬着的"名单里。
  assert.ok(!i.briefing().includes('环也设计'),
    '我没答的又被摆回我面前了 —— 那是把 agent 的信号当成了我的作业');
  assert.ok(!i.dangling().some((n) => n.id === guess.id),
    '没答的提议挂上了悬着的名单 —— 需求明说那不是树上的洞');
  assert.ok(!i.line().includes('环也设计'), '没答的提议爬进了"我在追什么"');
});

test('U19-6: 没有我的一句话，长不出节点 —— 门上被拒；绕过门硬塞，折叠照样不认', () => {
  const { t, i } = mk();
  adopt(t, i, '开工', '大盘');
  const sizeBefore = i.tree().nodes.size;

  // ① agent 拿自己的话当授权：门上被拒，而且什么都没留下。
  const agentStep = agentDoor(t).record({
    actor: A, type: 'agent.observed', origin: 'arrived-from-outside', payload: {},
  });
  const before = t.recent({ limit: 1000, includeRoutine: true }).length;
  assert.throws(
    () => i.adopt({ said: agentStep.id, text: '我觉得该做这个' }),
    IntentRefused,
    'agent 直接去认一个意图（不经过我说话），被收下了',
  );
  assert.equal(t.recent({ limit: 1000, includeRoutine: true }).length, before,
    '被拒之后痕迹里还是多了东西');

  // ② agent 的门伪造"人说的话"：当场被拒（结构上写不出来）。
  assert.throws(
    () => agentDoor(t).record({
      actor: 'user:human:cli', type: 'user.message_received', origin: 'you-said',
      payload: { text: '（这句是 agent 编的）' },
    }),
    TraceRefused,
    'agent 的门写出了一条"人说的话" —— 判据被绕过去了',
  );

  // ③ 绕到门后面直接写一条挂在 agent 话上的 adopted：树上不许多出这个节点。
  t.record({
    actor: A, type: 'intent.adopted', cause: agentStep.id, payload: { text: '硬塞的意图' },
  });
  assert.equal(i.tree().nodes.size, sizeBefore,
    '树上多出了一个没有任何一句人话背书的节点 —— agent 提的东西自动成了节点');
});

test('U19-8: 新的必须 100% —— 每个节点都说得出"这是我说的"，那句话原文摆在那儿', () => {
  const { t, i } = mk();
  const sentences = ['把 Theseus 重建起来', '先做启停', '再做痕迹'];
  for (const s of sentences) adopt(t, i, s, `做：${s}`);

  const nodes = [...i.tree().nodes.values()];
  assert.equal(nodes.length, sentences.length);
  for (const n of nodes) {
    const born = t.get(n.id);
    assert.ok(born !== null && born.cause !== null, `节点「${n.saying}」说不出它挂在哪句话上`);
    const h = t.get(born.cause);
    assert.ok(h !== null, `节点「${n.saying}」挂着的那句话不在痕迹里`);
    assert.ok(h.actor.split(':')[1] === 'human',
      `节点「${n.saying}」挂着的不是人说的话：${h.actor}`);
    assert.ok(sentences.includes(String(h.payload['text'])),
      `那句话的原文对不上 —— "这是我说的"就答不上来了：${String(h.payload['text'])}`);
  }
});

test('U19-9: 复现那三次被扔掉的纠正 —— 同样的三次走一遍，三次都必须捞得回来', () => {
  const { t, i } = mk();
  adopt(t, i, '接着写设计', '写设计文档');

  // 需求里点名的三次。当时三次都被当场吸收，三次都没留下任何取得出来的东西。
  const 三次: Array<[string, string]> = [
    ['这个模块叫 supervisor 怎么样？', 'supervisor 这个名字不合规矩'],
    ['把事件表的 schema 定一下？', '不叫事件表，该叫痕迹'],
    ['第二个知识库也不保留了吧？', '"不保留第二个知识库"说的是 PKM，不是别的'],
  ];
  for (const [猜, 纠] of 三次) {
    const g = i.propose({ cause: said(t, '继续').id, text: 猜 });
    i.correct({ said: said(t, 纠).id, target: g.id, text: 纠 });
  }

  // 走一遍同样的三次，三次都必须捞得回来 —— 绿必须是"我真的捞出来看了一眼"。
  const pairs = i.corrections();
  assert.equal(pairs.length, 3, `三次纠正，捞回来 ${pairs.length} 次`);
  for (const [猜, 纠] of 三次) {
    const hit = pairs.find((p) => p.guessed.payload['text'] === 猜);
    assert.ok(hit !== undefined, `「${猜}」那次纠正没捞回来 —— 它又只活在那段对话里了`);
    assert.equal(hit.corrected.payload['text'], 纠,
      `捞回来了猜的，改成了什么却对不上：${String(hit.corrected.payload['text'])}`);
  }
});

// ──────────────────────────── 门的形状 ────────────────────────────

test('门：放弃必须带一句为什么 —— 那是将来"要不要捡回来"的唯一依据', () => {
  const { t, i } = mk();
  const node = adopt(t, i, '开个头', '一个念头');
  assert.throws(
    () => i.drop({ said: said(t, '不做了').id, target: node, why: '   ' }),
    IntentRefused,
    '不带理由的放弃被收下了 —— 将来"要不要捡回来"就没有任何依据',
  );
  assert.equal(i.tree().nodes.get(node)?.status, 'open', '被拒了，状态却动了');
});

test('门：并不出东西的并、空话的认，都进不来', () => {
  const { t, i } = mk();
  const node = adopt(t, i, '开个头', '一个念头');
  assert.throws(() => i.merge({ said: said(t, '并').id, a: node, b: node }), IntentRefused);
  assert.throws(() => i.adopt({ said: said(t, '认').id, text: '   ' }), IntentRefused);
  assert.throws(
    () => i.resume({ said: said(t, '回去').id, node: said(t, '这不是节点').id }),
    IntentRefused,
    '"回去的"指着一条根本不是意图的痕迹，也被收下了',
  );
});

// ───────────── 跑完不许在 /tmp 留东西（照痕迹那份的收尾）─────────────

after(() => {
  const left = made.filter(existsSync);
  assert.deepEqual(left, [], `跑完在 /tmp 留下了 ${left.length} 个残留：${left.join(', ')}`);
  const foreign = readdirSync(tmpdir()).filter((f) => f.startsWith('theseus-t-intent-'));
  if (foreign.length > 0) console.log(`  /tmp 里还有 ${foreign.length} 个别的进程留下的意图临时目录`);
});
