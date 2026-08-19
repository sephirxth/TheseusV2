/**
 * 两道门（docs/design/intent.md 2.3）。
 *
 * "是不是我的意图"整条判据压在 actor 的中间段上（human 与否）。这条判据要有
 * 东西兜着：agent 只要写得出一条中间段是 `human` 的痕迹，判据就被绕过去了。
 *
 * 做法照 DeepSeek Harness：他们的模型够不着宿主入口，所以伪造不出"人说的话"。
 * 我们的对应物——
 *
 *   人的门（转录截获 / CLI / 面板）   只替人开口：中间段必须是 `human`
 *   agent 的门（MCP 工具、CLI 子命令该接的那个）   写不出：中间段是 `human` 的当场被拒
 *
 * 默认值的方向也照他们踩过的坑反着定（authority.ts:67-68 的警告）：不声明自己
 * 是谁的生产者，在这里**得不到**人的权限——不是我们更小心，是这个错误没地方犯。
 *
 * ★5 必须说清楚：两道门在同一个进程里。能直接 import `Trace` 的代码仍然伪造
 * 得出"人说的话"；拦得住的是 agent 实际够得着的那个入口。DSH 同样只拦到这一层。
 */
import { TraceRefused } from './trace.ts';
import type { Mark, Step, Trace } from './trace.ts';

/** actor 的中间段：`namespace:type:session` 里决定"人还是 agent"的那一段。 */
export const middleOf = (actor: string): string => actor.split(':')[1] ?? '';

export interface Door {
  record(m: Mark): Step;
}

/** agent 够得着的那个入口。 */
export const agentDoor = (t: Trace): Door => ({
  record(m: Mark): Step {
    if (middleOf(m.actor) === 'human') {
      throw new TraceRefused(
        `'${m.type}': agent 的门写不出"人说的话"（'${m.actor}' 的中间段是 human）`);
    }
    return t.record(m);
  },
});

/** 人的门。别的生产者必须显式声明自己是谁，不许静默继承人的权限。 */
export const humanDoor = (t: Trace): Door => ({
  record(m: Mark): Step {
    if (middleOf(m.actor) !== 'human') {
      throw new TraceRefused(
        `'${m.type}': 人的门只替人开口（'${m.actor}' 的中间段不是 human）`);
    }
    return t.record(m);
  },
});
