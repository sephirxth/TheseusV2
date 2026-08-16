/**
 * ★C —— 哪些类型算"例行公事"。这是这个系统特有的判断，没有别人能替我们定。
 *
 * 口径照 docs/acceptance/trace.md 写死的那五类，一个字不改：
 * 时钟到点、触发器自己的记账、定期搬运、主动思考周期开始、主动思考的结论是"没事可做"。
 *
 * **写的时候标，不在读的时候猜**（syslog 从 1980 年代起的做法）。留到读的时候猜会猜错，
 * 而且猜错的方式还不稳定——今天这条被过滤了，明天没有。
 *
 * 两处需要说明：
 *  一、`ingest.*` 用前缀，不是只认 `ingest.transcripts`。规格给的理由是"机械搬运、无语义"，
 *      那条理由对 `ingest.roam` 一字不差地成立——而 2026-06-10 那次给 2300 份文档盖章的
 *      正是 `ingest.roam`。只认一个类型名，那次合规章就不会被认出来。
 *  二、`trace.compacted` 是降采样自己的记账，同样是例行。
 */
const ROUTINE_TYPES: ReadonlySet<string> = new Set([
  'time.tick',                      // 时钟到点
  'watcher.fired',                  // 触发器自己的记账
  'proactive_thinking.started',     // 主动思考周期开始
  'proactive_thinking.quiet',       // 主动思考的结论是"没事可做"
  'trace.compacted',                // 降采样自己的记账
]);

/** 机械搬运，无语义。**不是空心跳**——它每一条都真的搬了文件，仍归例行。 */
const ROUTINE_PREFIXES: readonly string[] = ['ingest.'];

export const isRoutine = (type: string): boolean =>
  ROUTINE_TYPES.has(type) || ROUTINE_PREFIXES.some((p) => type.startsWith(p));
