/** A part of Theseus. The repo declares these; everything else is derived. (§5) */
export interface Part {
  readonly name: string;
  readonly needs: readonly string[];
  readonly command: string;
  /**
   * I5b, optional: a command whose exit code 0 means "this part can do its job
   * now". A process existing and a part being able to work are two different
   * questions, and the kernel only answers the first one — nothing outside the
   * declaration can guess the second. Shaped after Kubernetes' readinessProbe:
   * an external check, per part, not compulsory.
   *
   * Omitted means what it means in Kubernetes: ready as soon as the process is
   * up. That is not a shortcut — it is the only honest answer left when the
   * declaration never said what "ready" would look like.
   */
  readonly ready?: string;
}

/** The ActiveState values we have a translation for. systemd(1) defines these six. */
export const KNOWN_ACTIVE_STATES = [
  'active', 'reloading', 'activating', 'deactivating', 'inactive', 'failed',
] as const;
export type KnownActiveState = (typeof KNOWN_ACTIVE_STATES)[number];

/**
 * I4: every state is a conclusion we can defend.
 * `starting` / `stopping` are deliberately NOT `running` / `stopped` — the
 * transition is evidence that it is moving, not evidence that it arrived.
 */
export type Liveness =
  | 'running' | 'reloading' | 'starting' | 'stopping' | 'stopped' | 'failed';

export type PartState =
  | { readonly kind: Liveness }
  /** No unit file on disk. Its own state — not `stopped`. */
  | { readonly kind: 'not-installed' }
  /** systemd said something we have no translation for. Carries the raw word. */
  | { readonly kind: 'untranslatable'; readonly raw: string };

/** The only claim of "it is up". Nothing else in the codebase may assert it. */
export const isRunning = (s: PartState): boolean => s.kind === 'running';
