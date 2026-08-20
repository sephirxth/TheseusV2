/**
 * 意图树（docs/design/intent.md）。
 *
 * **意图树不是一张新表，是痕迹表上的一次折叠。**
 *
 *  - 只有"我认了"的那几条痕迹长成节点；agent 提的（`intent.proposed`）一条也不长。
 *  - 一个节点的父亲，**就是它出生那一刻我正在追的那条**——不是一个可以被填错的
 *    字段，是折叠时按时间顺序算出来的（★A）。
 *  - 融合、修正、放弃，都是后来追加的痕迹，**一条也不改历史**。
 *
 * 树没有自己的存储。这个文件里没有任何"把树写回去"的地方——想让树上写的和
 * 实际发生的不一致，唯一的办法是让一件事发生，而发生就会留痕（U15-5）。
 *
 * 判据（第二节，三条全要，缺一不算）：一条要改动树的痕迹算数，当且仅当
 *   ① 它的上一步**直接指向**一条痕迹 H（隔几层 = 拿上周的话当今天的授权，不行）；
 *   ② H 的 actor 中间段是 `human`；
 *   ③ H 是从人的门进来的——这条是结构给的：agent 的门写不出 human（doors.ts）。
 * 判据在门上（写时早拒），但**做数的是折叠这次查询**：绕过门硬塞进来的，折叠照样不认。
 *
 * "当前"是我的，不是某个会话的（1.5，★1）。一次只有一个；切走是一个动作，会留痕
 * ——这正是 U17"回来不靠谁记得"能成立的原因。
 *
 * 折叠的形状照 DeepSeek Harness 的 `applyGoalProjection`：一个事件进来，认识就折，
 * 不认识就原样返回。**复杂的是判据，不是代码。**
 */
import { middleOf, agentDoor } from './doors.ts';
import type { Door } from './doors.ts';
import type { Origin, Step, Trace } from './trace.ts';

/** 这道门拒了。理由必须说得出来——一条只会拒不说为什么的门，等于一堵墙。 */
export class IntentRefused extends Error {
  override readonly name = 'IntentRefused';
}

/**
 * 三个记号（3.3，★D）：记号给机器，颜色给眼睛，两件事分开满足。
 * 行首固定、纯文本，一条正则就能从一堆对话里捞出来——记号之所以有用，
 * 是它搭在"对话已经被自动截走"这条已经在跑的管子上。
 * ★2：这三个字符串是我们定的，会不会和已有文本撞车，还没拿旧对话实测。
 */
export const MARK_ADOPTED = '[意图·认了]';
export const MARK_GUESSED = '[意图·猜的]';
export const MARK_CORRECTED = '[意图·纠了]';

export const guessedLine = (text: string): string => `${MARK_GUESSED} ${text}`;
export const correctedLine = (text: string): string => `${MARK_CORRECTED} ${text}`;

/**
 * 一个节点就是那条 `intent.adopted` 痕迹本身，用它的痕迹号（1.3，git commit 的做法：
 * 没有另一套编号就少一处会对不上的地方）。
 */
export interface IntentNode {
  readonly id: string;
  /** 现在的说法。修正换的是它；旧说法留在原来那条痕迹里，一个字不动。 */
  readonly saying: string;
  /** 出生边：出生那一刻的当前。永远不变——融合也不动它（★B）。 */
  readonly parent: string | null;
  /** 只有三种（4.4，照 DSH 的 Agent Note 生命周期）：**没有"悄悄消失"这个状态。** */
  readonly status: 'open' | 'done' | 'dropped';
  /** 融合：非出生边，两边对称（第五节，★B）。显示时带上"已与 X 并"。 */
  readonly mergedWith: readonly string[];
  /** 最近一次有动静（7.3 的排序用；**排序不改变任何一条的去留**）。 */
  readonly lastTouched: string;
}

export interface IntentTree {
  readonly current: string | null;
  readonly nodes: ReadonlyMap<string, IntentNode>;
}

export interface Propose {
  readonly text: string;
  /** 上一步与起点二选一，规矩同痕迹本身。 */
  readonly cause?: string;
  readonly origin?: Origin;
  /** 这个猜测凭什么（可选）。 */
  readonly about?: readonly string[];
  /** 幂等键（可选）：同一条提议重复提，不重复记。规矩同痕迹本身。 */
  readonly idem?: string;
}
export interface Adopt {
  /** 人那句话的痕迹号。做数的是它，不是写痕迹的 agent。 */
  readonly said: string;
  readonly text: string;
  /** 接的是哪条提议（可选）——接了，那条提议就算被回应了。 */
  readonly accepting?: string;
}
export interface Resume { readonly said: string; readonly node: string }
export interface Correct { readonly said: string; readonly target: string; readonly text: string }
export interface Drop { readonly said: string; readonly target: string; readonly why: string }
export interface Done { readonly said: string; readonly target: string }
export interface Merge { readonly said: string; readonly a: string; readonly b: string; readonly why?: string }

const str = (v: unknown): string => (typeof v === 'string' ? v : '');

interface Node {
  id: string;
  saying: string;
  parent: string | null;
  status: 'open' | 'done' | 'dropped';
  mergedWith: string[];
  lastTouched: string;
}

export class Intent {
  readonly #trace: Trace;
  readonly #door: Door;
  readonly #actor: string;

  /**
   * `actor` 是写痕迹的那个 agent 的三段身份。写入走 agent 的门：意图痕迹是
   * agent 替我记的，它自己**不可以**顶着 human 的名字写（合成的东西来源写死，
   * 结构上不可能被误认成人说的——DSH goal-round-driver 的做法）。
   */
  constructor(trace: Trace, actor: string) {
    this.#trace = trace;
    this.#door = agentDoor(trace);
    this.#actor = actor;
  }

  // ───────────────────────────── 写：七种痕迹 ─────────────────────────────

  /** "我猜你想要 X"。随便写，一条也不会长成节点——树上只有我认的。 */
  propose(o: Propose): Step {
    if (o.text.trim() === '') throw new IntentRefused(`intent.proposed: 空的猜测提不出来`);
    return this.#door.record({
      actor: this.#actor, type: 'intent.proposed',
      ...(o.cause !== undefined ? { cause: o.cause } : {}),
      ...(o.origin !== undefined ? { origin: o.origin } : {}),
      ...(o.about !== undefined && o.about.length > 0 ? { basis: o.about } : {}),
      ...(o.idem !== undefined ? { idem: o.idem } : {}),
      payload: { text: o.text },
    });
  }

  /** 长一个节点：父亲 = 此刻的当前，当前移到新节点。 */
  adopt(o: Adopt): Step {
    const h = this.#saidBy(o.said, 'intent.adopted');
    if (o.text.trim() === '') {
      throw new IntentRefused(`intent.adopted: 一个节点是一句话——空的说法长不成节点`);
    }
    if (o.accepting !== undefined) this.#mustBe(o.accepting, ['intent.proposed'], '接的');
    return this.#door.record({
      actor: this.#actor, type: 'intent.adopted', cause: h.id,
      ...(o.accepting !== undefined ? { basis: [o.accepting] } : {}),
      payload: { text: o.text },
    });
  }

  /** 当前移回一个已有节点。"回去"本身留痕——U17 靠的就是这条，不是谁的记性。 */
  resume(o: Resume): Step {
    const h = this.#saidBy(o.said, 'intent.resumed');
    this.#mustBe(o.node, ['intent.adopted'], '回去的');
    return this.#door.record({
      actor: this.#actor, type: 'intent.resumed', cause: h.id, basis: [o.node], payload: {},
    });
  }

  /**
   * 换掉一个节点（或一条提议）的现在的说法。旧说法留在原处一个字不动——
   * 于是"它猜错了什么、我改成了什么"天然成对留下来（U19 ③ 的原料）。
   */
  correct(o: Correct): Step {
    const h = this.#saidBy(o.said, 'intent.corrected');
    if (o.text.trim() === '') throw new IntentRefused(`intent.corrected: 纠成一句空话，等于没纠`);
    this.#mustBe(o.target, ['intent.adopted', 'intent.proposed'], '纠的');
    return this.#door.record({
      actor: this.#actor, type: 'intent.corrected', cause: h.id, basis: [o.target],
      payload: { text: o.text },
    });
  }

  /**
   * "我不做了" / "这条我不要"（从被指的那条是节点还是提议，就看得出是哪种）。
   * **必须带一句为什么**：放弃的理由是将来"要不要捡回来"的唯一依据（DSH 对
   * 否掉笔记的规矩——只在理由仍能拦住一个诱人的错误时保留）。
   */
  drop(o: Drop): Step {
    const h = this.#saidBy(o.said, 'intent.dropped');
    if (o.why.trim() === '') {
      throw new IntentRefused(`intent.dropped: 没有为什么。放弃的理由是将来"要不要捡回来"的唯一依据`);
    }
    this.#mustBe(o.target, ['intent.adopted', 'intent.proposed'], '不要的');
    return this.#door.record({
      actor: this.#actor, type: 'intent.dropped', cause: h.id, basis: [o.target],
      payload: { why: o.why },
    });
  }

  /** "做完了"。agent 没有这个口子（2.4）：任务干完了 ≠ 我的意图达成了。 */
  done(o: Done): Step {
    const h = this.#saidBy(o.said, 'intent.done');
    this.#mustBe(o.target, ['intent.adopted'], '做完的');
    return this.#door.record({
      actor: this.#actor, type: 'intent.done', cause: h.id, basis: [o.target], payload: {},
    });
  }

  /** 融合：加一条非出生边，两条出生边一个字不改（第五节，★B）。当前不动。 */
  merge(o: Merge): Step {
    const h = this.#saidBy(o.said, 'intent.merged');
    if (o.a === o.b) throw new IntentRefused(`intent.merged: 一个节点和它自己并不出东西`);
    this.#mustBe(o.a, ['intent.adopted'], '并的');
    this.#mustBe(o.b, ['intent.adopted'], '并的');
    return this.#door.record({
      actor: this.#actor, type: 'intent.merged', cause: h.id, basis: [o.a, o.b],
      payload: o.why !== undefined ? { why: o.why } : {},
    });
  }

  // ───────────────────────────── 读：折叠与视图 ─────────────────────────────

  /**
   * 折叠（1.2）。状态只有两样：当前是哪个节点，以及每个节点现在的样子。
   * 一个 switch，六个分支，每个分支改一处状态——复杂的在门上，不在这儿。
   *
   * 判据在每一条上重查一遍：**门是约定，查询是结构。** 绕过门塞进来的，这儿不认。
   */
  tree(): IntentTree {
    const nodes = new Map<string, Node>();
    let current: string | null = null;
    for (const s of this.#trace.ofType('intent.')) {
      if (s.type === 'intent.proposed') continue;            // 提议不进折叠：树上只有我认的
      if (s.cause === null) continue;                        // 判据①：必须直接挂在一句话上
      const h = this.#trace.get(s.cause);
      if (h === null) continue;
      if (middleOf(h.actor) !== 'human') continue;           // 判据②（③由 doors.ts 结构保证）
      const t0 = s.basis[0];
      switch (s.type) {
        case 'intent.adopted': {
          const text = str(s.payload['text']);
          if (text === '') continue;
          nodes.set(s.id, {
            id: s.id, saying: text, parent: current, status: 'open',
            mergedWith: [], lastTouched: s.ts,
          });
          current = s.id;
          break;
        }
        case 'intent.resumed': {
          const n = t0 === undefined ? undefined : nodes.get(t0);
          if (n === undefined) continue;
          current = n.id;
          n.lastTouched = s.ts;
          break;
        }
        case 'intent.corrected': {
          const n = t0 === undefined ? undefined : nodes.get(t0);
          if (n === undefined) continue;                     // 纠的是提议：树不动，对子留在痕迹里
          const text = str(s.payload['text']);
          if (text === '') continue;
          n.saying = text;
          n.lastTouched = s.ts;
          break;
        }
        case 'intent.dropped': {
          const n = t0 === undefined ? undefined : nodes.get(t0);
          if (n === undefined) continue;                     // 不要的是提议：树上本来就没有它
          n.status = 'dropped';
          n.lastTouched = s.ts;
          break;
        }
        case 'intent.done': {
          const n = t0 === undefined ? undefined : nodes.get(t0);
          if (n === undefined) continue;
          n.status = 'done';
          n.lastTouched = s.ts;
          break;
        }
        case 'intent.merged': {
          const a = t0 === undefined ? undefined : nodes.get(t0);
          const t1 = s.basis[1];
          const b = t1 === undefined ? undefined : nodes.get(t1);
          if (a === undefined || b === undefined || a === b) continue;
          a.mergedWith.push(b.id);
          b.mergedWith.push(a.id);
          a.lastTouched = s.ts;
          b.lastTouched = s.ts;
          break;
        }
        default:
          continue;                                          // 不认识的 intent.*：原样返回，不折
      }
    }
    return { current, nodes };
  }

  /** U15：从当前沿出生边走到根。根排在最前——"当初为什么开始"就在第一个。 */
  path(): readonly IntentNode[] {
    const { current, nodes } = this.tree();
    const out: IntentNode[] = [];
    for (let id = current; id !== null; ) {
      const n = nodes.get(id);
      if (n === undefined) break;
      out.unshift(n);
      id = n.parent;
    }
    return out;
  }

  /** U15 的那句话。不用我自己想，它就摆在那儿——是查出来的，不用谁记得写，也不会写错。 */
  line(): string {
    const p = this.path();
    if (p.length === 0) return `${MARK_ADOPTED} （空——还没认过任何意图）`;
    return `${MARK_ADOPTED} ${p.map((n) => n.saying).join(' > ')}`;
  }

  /**
   * U16：悬着的分支。判据只有一条（7.1）：既没"做完了"也没"我不做了"。
   * 特意不看多久没动、不看第几层、不看名单多长；**跑多久都不出现催收尾的提示**（7.2）。
   * 排序按最近有动静（7.3）——最近碰过的更容易接上，仅此而已。
   */
  dangling(): readonly IntentNode[] {
    return [...this.tree().nodes.values()]
      .filter((n) => n.status === 'open')
      .sort((x, y) =>
        x.lastTouched === y.lastTouched
          ? (x.id < y.id ? 1 : -1)
          : (x.lastTouched < y.lastTouched ? 1 : -1));
  }

  /**
   * U19 ④：agent 提了、我开过口、而那次开口没有回应它。**这不是树上的洞，是关于
   * agent 的信号。** "被回应"就是痕迹里往前走的那个查询（became），一行新代码都没写；
   * "轮到没轮到"用我的下一次开口当界（3.2，★C）——不用计时器，计时器会冤枉人。
   */
  unanswered(): readonly Step[] {
    return this.#trace.ofType('intent.proposed')
      .filter((p) => this.#trace.became(p.id).length === 0)
      .filter((p) => this.#trace.humanSpokeAfter(p.id));
  }

  /**
   * U19 ③：纠过的取得出来，**而且是成对的**——它猜错了什么（basis 指的那条，原文
   * 原样在）、我改成了什么（这条自己）。不用另外攒一份：追加不修改，对子天然留下。
   */
  corrections(): readonly { readonly guessed: Step; readonly corrected: Step }[] {
    const out: { guessed: Step; corrected: Step }[] = [];
    for (const s of this.#trace.ofType('intent.corrected')) {
      if (s.cause === null) continue;
      const h = this.#trace.get(s.cause);
      if (h === null || middleOf(h.actor) !== 'human') continue;
      const t0 = s.basis[0];
      const guessed = t0 === undefined ? null : this.#trace.get(t0);
      if (guessed === null) continue;
      out.push({ guessed, corrected: s });
    }
    return out;
  }

  /**
   * 开场摆在人面前的那段话（6.2：同一条管子，多送一样东西）：认了的路径一行，
   * 还没轮到我回应的猜测各一行。**没答的不在这里**（U19-5）——它是给 agent 的信号，
   * 不是我的作业；也永远不出现催收尾的话（U16-4）。
   */
  briefing(): string {
    const lines = [this.line()];
    for (const p of this.#trace.ofType('intent.proposed')) {
      if (this.#trace.became(p.id).length > 0) continue;     // 回应过的，翻篇了
      if (this.#trace.humanSpokeAfter(p.id)) continue;       // 没接的：是信号，不是作业（U19-5）
      lines.push(guessedLine(str(p.payload['text'])));
    }
    return lines.join('\n');
  }

  // ─────────────────────────────── 门上的判据 ───────────────────────────────

  /** 判据①②：这次改动必须挂在我说过的某一句话上——那句话摆在那儿，我一看就知道是不是。 */
  #saidBy(id: string, forWhat: string): Step {
    const h = this.#trace.get(id);
    if (h === null) {
      throw new IntentRefused(`${forWhat}: 说是挂在 ${id} 上，痕迹里没有这条`);
    }
    if (middleOf(h.actor) !== 'human') {
      throw new IntentRefused(
        `${forWhat}: ${id} 不是人说的话（actor '${h.actor}' 的中间段不是 human）`
        + `——agent 提的东西不自动成为节点，只有我接了它，它才是`);
    }
    return h;
  }

  #mustBe(id: string, kinds: readonly string[], what: string): Step {
    const s = this.#trace.get(id);
    if (s === null) throw new IntentRefused(`${what}那条（${id}）不在痕迹里`);
    if (!kinds.includes(s.type)) {
      throw new IntentRefused(`${what}那条（${id}）是 '${s.type}'，不是 ${kinds.join(' / ')}`);
    }
    return s;
  }
}
