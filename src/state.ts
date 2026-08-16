import type { KnownActiveState, Liveness, PartState } from './part.ts';

/**
 * I4 — the whole translation, in one table.
 *
 * The `Record<KnownActiveState, …>` type is the enforcement: drop an arm and
 * `tsc` fails. There is no default arm here, so no systemd state can quietly
 * acquire a meaning we never chose for it.
 */
const TRANSLATION: Record<KnownActiveState, Liveness> = {
  active: 'running',
  reloading: 'reloading',
  activating: 'starting',      // not `running`: it has not arrived
  deactivating: 'stopping',    // not `stopped`: it has not arrived either
  inactive: 'stopped',
  failed: 'failed',            // not `stopped`: it went down for a reason
};

/**
 * Translate one `ActiveState` word. `installed: false` short-circuits, because
 * systemd answers `inactive` for units it has never heard of — reporting that
 * as `stopped` would be the exact lie I4 exists to prevent.
 */
export function translate(activeState: string, installed: boolean): PartState {
  if (!installed) return { kind: 'not-installed' };
  const known = Object.hasOwn(TRANSLATION, activeState);
  if (!known) return { kind: 'untranslatable', raw: activeState };
  return { kind: TRANSLATION[activeState as KnownActiveState] };
}
