/**
 * 痕迹：留下的那份东西。**留痕**是写它，**追踪**是读它。
 *
 * 底座是 SQLite（docs/design/trace.md 0.5）。用的是 Node 22 内建的 `node:sqlite`——
 * 不引任何外部依赖，一个库文件，没有服务、没有守护进程、没有端口。
 *
 * 这个文件是**唯一的那道门**：所有写入从 `record` 进来，禁止绕过去直接动库
 * （照搬旧 Theseus 的 memory 契约——那是它做得最对的一件事）。
 *
 * 四件"痕迹不能丢、不能重"的硬约束，全是现成的，一行自己的逻辑都不写：
 *   写一半崩了 -> 一条一个事务（单条 INSERT 本身就是一个事务，ARIES 预写日志，SQLite 内建）
 *   同一件事记两遍 -> `idem` 唯一约束（Stripe 的幂等键）
 *   边写边读读到半条 -> WAL
 *   多个写入方 -> SQLite 自己排队
 *
 * 还有一件是白捡的：`CHECK (cause IS NULL OR cause < id)`。ULID 按时间排序，所以这是
 * 一句纯字符串比较，**却让因果成环从结构上不可能**——成环意味着某条记录是自己的祖先，
 * 那要求它比自己早。它替掉了本来要写的一整套环检测。
 */
import { createHash, randomBytes } from 'node:crypto';
import { mkdirSync, readFileSync, readdirSync } from 'node:fs';
import { dirname } from 'node:path';
import { DatabaseSync, type StatementSync } from 'node:sqlite';
import { isRoutine } from './routine.ts';

/** 我认得的三种起点。走到头必须落在其中之一，不许停在一个人不认识的东西上。 */
export type Origin = 'you-said' | 'clock-fired' | 'arrived-from-outside';

/** 交给这道门的一笔。`cause` 和 `origin` 二选一：要么有上一步，要么自己是个起点。 */
export interface Mark {
  /** 谁干的：namespace:type:session */
  readonly actor: string;
  readonly type: string;
  /** 上一步是哪条。 */
  readonly cause?: string;
  /** 没有上一步时，必须说清自己是哪种起点。 */
  readonly origin?: Origin;
  readonly payload?: Readonly<Record<string, unknown>>;
  /** 凭什么这么定 / 这么判断。决定与自我总结必须给。 */
  readonly basis?: readonly string[];
  /** 幂等键；不给的不参与去重。 */
  readonly idem?: string;
}

export interface Step {
  readonly id: string;
  readonly ts: string;
  readonly actor: string;
  readonly type: string;
  readonly cause: string | null;
  readonly origin: Origin | null;
  readonly routine: boolean;
  readonly basis: readonly string[];
  readonly payload: Record<string, unknown>;
}

/**
 * 链子走到头，落在哪儿。**这几种必须分得清清楚楚**——一条"技术上完整、实际上没回答
 * 问题"的链子，长得和一条好链子一模一样；断了你知道自己不知道，编了你以为自己知道。
 */
export type ChainEnd =
  /** 走到一个我认得的起点。 */
  | { readonly kind: 'origin'; readonly at: string; readonly origin: Origin }
  /** 走到一条没有上一步、也说不出自己是哪种起点的记录。经这道门写不出来，只可能是外面塞进来的。 */
  | { readonly kind: 'unrecognized'; readonly at: string; readonly type: string }
  /** 它指着的那条不在。**这里断了**，不许猜一个接上去。 */
  | { readonly kind: 'broken'; readonly at: string; readonly missing: string }
  /** 超过深度上限，还没走到头。**我没走完，不是我到头了。** */
  | { readonly kind: 'too-deep'; readonly at: string }
  /** 问的那条根本不在。 */
  | { readonly kind: 'no-such-step'; readonly at: string };

export interface Chain {
  /** [被问的那条, 它的上一步, …]。 */
  readonly steps: readonly Step[];
  readonly end: ChainEnd;
}

export interface TraceOptions {
  /** 现在几点（epoch 毫秒）。只有测试和补记会给。 */
  readonly now?: () => number;
}

/** 这道门拒了。**理由必须说得出来**——一条只会拒不说为什么的门，等于一堵墙。 */
export class TraceRefused extends Error {
  override readonly name = 'TraceRefused';
}

/** 第二道保险：防的是数据从别处被硬塞进来的情况。第一道是 CHECK。 */
const DEPTH = 64;

const COLS = 'id, ts, actor, type, cause, routine, payload';

const SCHEMA = `
CREATE TABLE IF NOT EXISTS trace (
  id       TEXT PRIMARY KEY,
  ts       TEXT NOT NULL,
  actor    TEXT NOT NULL,
  type     TEXT NOT NULL,
  cause    TEXT REFERENCES trace(id),
  routine  INTEGER NOT NULL DEFAULT 0,
  payload  TEXT NOT NULL,
  idem     TEXT UNIQUE,

  CHECK (cause IS NULL OR cause < id),

  -- 三段，且每段非空。上面 record() 里那道门是给人看的错误信息，
  -- 这一条是给"绕过门直接写库的人"准备的：门是约定，约束是结构。
  -- '_%' 要求每段至少一个字符；后半句挡掉四段及以上。
  CHECK (actor LIKE '_%:_%:_%' AND actor NOT LIKE '%:%:%:%')
);
CREATE INDEX IF NOT EXISTS trace_cause  ON trace(cause);
CREATE INDEX IF NOT EXISTS trace_ts     ON trace(ts);
CREATE INDEX IF NOT EXISTS trace_type   ON trace(type);
CREATE INDEX IF NOT EXISTS trace_actor  ON trace(actor);
CREATE INDEX IF NOT EXISTS trace_recent ON trace(routine, id DESC);
`;

/** 往回问"为什么发生"。一句递归查询走完全程，而且走的是主键。 */
const BACK = `
WITH RECURSIVE chain(id, ts, actor, type, cause, routine, payload, depth) AS (
  SELECT ${COLS}, 0 FROM trace WHERE id = ?
  UNION ALL
  SELECT t.id, t.ts, t.actor, t.type, t.cause, t.routine, t.payload, chain.depth + 1
    FROM trace t JOIN chain ON t.id = chain.cause
   WHERE chain.depth < ${DEPTH}
)
SELECT * FROM chain`;

/**
 * 往前问"这个要求后来怎么了"。走两种边：**它是谁的上一步**，以及**谁拿它当依据**。
 *
 * 只走前一种是不够的：两个要求被并成一件时，被并掉的那个不是任何人的上一步——
 * 而那正是当年 numpy 2.2.0 一声不吭消失的位置。
 */
const FORWARD = `
WITH RECURSIVE fwd(id, depth) AS (
  SELECT ?, 0
  UNION
  SELECT t.id, fwd.depth + 1
    FROM trace t, fwd
   WHERE fwd.depth < ${DEPTH}
     AND (t.cause = fwd.id
          OR EXISTS (SELECT 1 FROM json_each(t.payload, '$.basis') j WHERE j.value = fwd.id))
)
SELECT ${COLS} FROM trace WHERE id IN (SELECT id FROM fwd) AND id <> ? ORDER BY id`;

interface Row {
  id: string; ts: string; actor: string; type: string;
  cause: string | null; routine: number; payload: string; depth?: number;
}

const B32 = '0123456789ABCDEFGHJKMNPQRSTVWXYZ';
const RAND_MAX = 1n << 80n;

const encodeTime = (ms: number): string => {
  let n = ms;
  let out = '';
  for (let i = 0; i < 10; i++) { out = B32[n % 32] + out; n = Math.floor(n / 32); }
  return out;
};

const encodeRand = (r: bigint): string => {
  let n = r;
  let out = '';
  for (let i = 0; i < 16; i++) { out = B32[Number(n & 31n)] + out; n >>= 5n; }
  return out;
};

const rand80 = (): bigint => {
  let n = 0n;
  for (const b of randomBytes(10)) n = (n << 8n) | BigInt(b);
  return n;
};

/** 决定本身要留下来，还要留下它当时凭什么这么定。 */
const isDecision = (type: string): boolean => type.startsWith('decision.');

/** 系统关于它自己的话：反思 / 自我认知 / 改进结论。 */
const isConclusion = (type: string): boolean => type.startsWith('self.');

export class Trace {
  readonly #db: DatabaseSync;
  readonly #now: () => number;
  readonly #stmts = new Map<string, StatementSync>();
  #lastMs = -1;
  #lastRand = 0n;

  constructor(file: string, o: TraceOptions = {}) {
    this.#now = o.now ?? Date.now;
    mkdirSync(dirname(file), { recursive: true });
    this.#db = new DatabaseSync(file);
    this.#db.exec('PRAGMA journal_mode = WAL');       // 读的人看到的永远是完整状态
    this.#db.exec('PRAGMA synchronous = NORMAL');
    this.#db.exec('PRAGMA foreign_keys = ON');        // `cause` 指着的那条必须真在，删也删不掉
    this.#db.exec('PRAGMA busy_timeout = 5000');      // 多个写入方：排队，不是报错
    this.#db.exec(SCHEMA);
  }

  /**
   * 唯一的那道门。
   *
   * 拒的时候都在说同一件事：**别让一条将来查不动的痕迹进来。**
   * 没有上一步又说不出自己是哪种起点的，链子会停在一个人不认识的东西上；
   * 上一步不存在的，链子从出生就断了；决定不带依据的，查出来只有"它没做"。
   */
  record(m: Mark): Step {
    // 谁干的，必须分三段：地盘:身份:这一次。
    // 中间那段是"人还是 agent"的唯一依据——意图树整条判据压在它上面
    // （"上一步那条的中间段是 human 才算我的意图"）。它要是个自由字符串，
    // 那条判据就是在猜。
    //
    // 卡在这里而不是只写进文档，是因为这张表只追加：等有了真数据再加约束，
    // 就得重建这张表，而"痕迹不改写"是这套东西的立身之本。
    const seg = m.actor.split(':');
    if (seg.length !== 3 || seg.some((s) => s === '')) {
      throw new TraceRefused(`'${m.type}': 谁干的写成了 '${m.actor}' ——`
        + ` 必须是三段 地盘:身份:这一次（如 user:human:cli / agent:codex:sess-a1），`
        + ` 三段都不能空。中间那段决定这条痕迹算不算人说的。`);
    }

    const hasCause = m.cause !== undefined;
    const hasOrigin = m.origin !== undefined;
    if (hasCause && hasOrigin) {
      throw new TraceRefused(`'${m.type}': 同时给了上一步和起点种类 —— 一条痕迹只能是其中一种`);
    }
    if (!hasCause && !hasOrigin) {
      throw new TraceRefused(`'${m.type}': 既没有上一步，也没说自己是哪种起点`
        + `（我认得的起点只有三种：you-said / clock-fired / arrived-from-outside）`);
    }
    if (m.cause !== undefined && this.get(m.cause) === null) {
      throw new TraceRefused(`'${m.type}': 上一步 ${m.cause} 不在痕迹里`);
    }

    const basis = m.basis ?? [];
    const grounds = basis.map((id) => {
      const s = this.get(id);
      if (s === null) throw new TraceRefused(`'${m.type}': 依据 ${id} 不在痕迹里`);
      return s;
    });
    if ((isDecision(m.type) || isConclusion(m.type)) && grounds.length === 0) {
      throw new TraceRefused(`'${m.type}': 没有依据 —— 决定和自我总结必须留下它当时凭什么这么定`);
    }
    // U10-4。一条只检查形式的规矩会被形式满足：2026-06-10 那次导入给 2300 份文档
    // 各盖了一个"我属于第 N 批"的锚，规矩被满足了，满足得毫无意义。例行公事是机械动作、
    // 无语义，它可以是背景，**不可以是一条结论的全部依据**。
    if (isConclusion(m.type) && !grounds.some((g) => !g.routine)) {
      throw new TraceRefused(`'${m.type}': 依据全是例行公事（${grounds.map((g) => g.type).join(', ')}）`
        + ` —— 那是"这份东西属于第几批"，不是"这条结论从哪来"`);
    }

    if (m.idem !== undefined) {
      const hit = this.#byIdem(m.idem);
      if (hit !== null) return hit;                  // 同一件事，返回原来那条，不报错
    }

    const { id, ts } = this.#mint();
    const payload = JSON.stringify({
      ...(m.origin !== undefined ? { origin: m.origin } : {}),
      ...(basis.length > 0 ? { basis } : {}),
      body: m.payload ?? {},
    });
    try {
      // 单条 INSERT 自己就是一个事务：要么整条进去，要么当没发生。
      this.#db.prepare(`INSERT INTO trace(${COLS}, idem) VALUES(?,?,?,?,?,?,?,?)`).run(
        id, ts, m.actor, m.type, m.cause ?? null, isRoutine(m.type) ? 1 : 0, payload, m.idem ?? null,
      );
    } catch (e) {
      // 另一个写入方抢先用同一个幂等键写进去了：那就是同一件事，返回它那条。
      if (m.idem !== undefined) {
        const hit = this.#byIdem(m.idem);
        if (hit !== null) return hit;
      }
      throw new TraceRefused(`'${m.type}': ${(e as Error).message}`);
    }
    const written = this.get(id);
    if (written === null) throw new TraceRefused(`'${m.type}': 写完了却读不回来（${id}）`);
    return written;
  }

  get(id: string): Step | null {
    const row = this.#db.prepare(`SELECT ${COLS} FROM trace WHERE id = ?`).get(id) as Row | undefined;
    return row === undefined ? null : toStep(row);
  }

  /** U7：往回问"它为什么会发生"。 */
  why(id: string): Chain {
    const rows = this.#db.prepare(BACK).all(id) as unknown as Row[];
    if (rows.length === 0) return { steps: [], end: { kind: 'no-such-step', at: id } };
    const steps = rows.map(toStep);
    const tail = steps[steps.length - 1] as Step;
    const depth = rows[rows.length - 1]?.depth ?? 0;
    if (tail.cause === null) {
      return {
        steps,
        end: tail.origin !== null
          ? { kind: 'origin', at: tail.id, origin: tail.origin }
          : { kind: 'unrecognized', at: tail.id, type: tail.type },
      };
    }
    if (depth >= DEPTH) return { steps, end: { kind: 'too-deep', at: tail.id } };
    return { steps, end: { kind: 'broken', at: tail.id, missing: tail.cause } };
  }

  /** U8：往前问"我那个要求后来怎么了"。 */
  became(id: string): readonly Step[] {
    return (this.#db.prepare(FORWARD).all(id, id) as unknown as Row[]).map(toStep);
  }

  /**
   * 某一类痕迹，从头到尾按发生顺序。意图树的折叠从这儿读（design/intent.md 1.2）：
   * 折叠没有自己的存储，它每次都从这里重新长出来。
   * 前缀按字面比对，不是模式——`_` 在这儿就是下划线。
   */
  ofType(prefix: string): readonly Step[] {
    const rows = this.#q(
      `SELECT ${COLS} FROM trace WHERE substr(type, 1, length(?)) = ? ORDER BY id`,
    ).all(prefix, prefix) as unknown as Row[];
    return rows.map(toStep);
  }

  /**
   * 这条之后，人有没有再开口。"没接"的边界压在它上面（design/intent.md 3.2）：
   * 用对话自己的节拍当边界，不用墙上的钟——计时器会因为我今天忙就冤枉 agent 一次，
   * 而一条会冤枉人的检验，和一条不会说"不"的检验一样坏。
   *
   * `'%:human:%'` 比对的就是中间那段：actor 被门卡死为恰好三段（两个冒号），
   * 所以两边都有冒号的 human 只可能落在中间。
   */
  humanSpokeAfter(id: string): boolean {
    return this.#q(
      `SELECT 1 FROM trace WHERE id > ? AND actor LIKE '%:human:%' LIMIT 1`,
    ).get(id) !== undefined;
  }

  /** U9：看看最近都发生了什么。**默认不给例行公事**，要全部就明说。 */
  recent(o: { limit?: number; includeRoutine?: boolean } = {}): readonly Step[] {
    const rows = this.#db.prepare(
      `SELECT ${COLS} FROM trace WHERE (? = 1 OR routine = 0) ORDER BY id DESC LIMIT ?`,
    ).all(o.includeRoutine === true ? 1 : 0, o.limit ?? 50) as unknown as Row[];
    return rows.map(toStep);
  }

  /**
   * U12：部件的输出。**旁路截获，不是主动上报**——部件只管往 stdout 写，
   * systemd 把它接到文件里，这里把文件收进痕迹。**没有任何人需要记得多敲一条命令。**
   *
   * 幂等键是纯函数：同样的文件、同样的位置、同样的一行，永远同样的键。扫多少遍都不会记两遍。
   */
  absorb(dir: string): number {
    let n = 0;
    for (const f of readdirSync(dir)) {
      if (!f.endsWith('.log')) continue;
      const part = f.slice(0, -'.log'.length);
      const path = `${dir}/${f}`;
      const lines = readFileSync(path, 'utf8').split('\n');
      for (let i = 0; i < lines.length; i++) {
        const line = lines[i];
        if (line === undefined || line === '') continue;
        const idem = createHash('sha256').update(`${path}:${i}:${line}`).digest('hex');
        if (this.#byIdem(idem) !== null) continue;
        this.record({
          actor: `part:${part}:stdout`, type: 'part.output',
          origin: 'arrived-from-outside', payload: { part, line }, idem,
        });
        n++;
      }
    }
    return n;
  }

  /**
   * U11：老数据降采样，**不是删除**（RRDtool 1999 起、Prometheus 至今的标准做法：
   * 越老的分辨率越低，但永远不消失）。
   *
   * 只折叠例行公事，而且**只折叠没有任何人指着的那些**——被当作上一步或依据的一条都不动。
   * 这不是靠"例行事件基本不被当原因"这个说法，是查出来的；外加 `foreign_keys = ON`
   * 做第二道，真删到被指着的那条会当场失败而不是留下一条断链。
   */
  compact(o: { olderThanDays: number }): { folded: number; summaries: number } {
    const cutoff = new Date(this.#now() - o.olderThanDays * 86_400_000).toISOString();
    const victims = this.#db.prepare(`
      SELECT id, substr(ts, 1, 10) AS day, type FROM trace
       WHERE routine = 1 AND ts < ? AND type <> 'trace.compacted'
         AND id NOT IN (SELECT cause FROM trace WHERE cause IS NOT NULL)
         AND id NOT IN (SELECT j.value FROM trace, json_each(trace.payload, '$.basis') j)
    `).all(cutoff) as unknown as { id: string; day: string; type: string }[];
    if (victims.length === 0) return { folded: 0, summaries: 0 };

    const counts = new Map<string, number>();
    for (const v of victims) {
      const key = `${v.day} ${v.type}`;
      counts.set(key, (counts.get(key) ?? 0) + 1);
    }

    this.#db.exec('BEGIN IMMEDIATE');
    try {
      const del = this.#db.prepare('DELETE FROM trace WHERE id = ?');
      for (const v of victims) del.run(v.id);
      for (const [key, count] of counts) {
        const [day = '', type = ''] = key.split(' ');
        this.record({
          actor: 'system:trace:compact', type: 'trace.compacted', origin: 'clock-fired',
          payload: { day, type, count },
        });
      }
      this.#db.exec('COMMIT');
    } catch (e) {
      this.#db.exec('ROLLBACK');
      throw e;
    }
    return { folded: victims.length, summaries: counts.size };
  }

  close(): void {
    this.#db.close();
  }

  #byIdem(idem: string): Step | null {
    const row = this.#q(`SELECT ${COLS} FROM trace WHERE idem = ?`).get(idem) as Row | undefined;
    return row === undefined ? null : toStep(row);
  }

  /** 同一句 SQL 只编译一次。喂一整个月的旧账本时这一步值大约十倍。 */
  #q(sql: string): StatementSync {
    let s = this.#stmts.get(sql);
    if (s === undefined) { s = this.#db.prepare(sql); this.#stmts.set(sql, s); }
    return s;
  }

  /**
   * ULID：按时间排序、不需要任何协调就能保证唯一。同一毫秒里连着写就把随机那段加一，
   * 所以**同一个写入方的号严格递增**。
   *
   * 钟往回走时**不替它圆场**：号照实反映这个时刻。于是一个钟慢了的写入方去指一条更晚的
   * 记录时，`CHECK (cause < id)` 会当场拒掉——那正是它存在的理由。
   */
  #mint(): { id: string; ts: string } {
    const ms = Math.floor(this.#now());
    if (ms === this.#lastMs) {
      this.#lastRand += 1n;
      if (this.#lastRand >= RAND_MAX) { this.#lastMs += 1; this.#lastRand = rand80(); }
    } else {
      this.#lastMs = ms;
      this.#lastRand = rand80();
    }
    return {
      id: encodeTime(this.#lastMs) + encodeRand(this.#lastRand),
      ts: new Date(this.#lastMs).toISOString(),
    };
  }
}

const ORIGINS: ReadonlySet<string> = new Set(['you-said', 'clock-fired', 'arrived-from-outside']);

function toStep(row: Row): Step {
  const p = JSON.parse(row.payload) as { origin?: unknown; basis?: unknown; body?: unknown };
  const origin = typeof p.origin === 'string' && ORIGINS.has(p.origin) ? p.origin as Origin : null;
  return {
    id: row.id,
    ts: row.ts,
    actor: row.actor,
    type: row.type,
    cause: row.cause,
    origin,
    routine: row.routine === 1,
    basis: Array.isArray(p.basis) ? p.basis as string[] : [],
    payload: (p.body ?? {}) as Record<string, unknown>,
  };
}
