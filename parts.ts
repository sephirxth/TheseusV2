import type { Part } from './src/part.ts';

/**
 * The declaration. This file is the truth; everything under
 * ~/.config/systemd/user is derived from it by `theseus up` (U5).
 */
export const parts: readonly Part[] = [
  // { name: 'bridge',  needs: [],         command: 'exec node bridge.js' },
  // { name: 'watcher', needs: ['bridge'], command: 'exec node watcher.js' },
];
