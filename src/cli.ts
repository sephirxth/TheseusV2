#!/usr/bin/env node
import { parts } from '../parts.ts';
import { isRunning } from './part.ts';
import { Theseus } from './theseus.ts';

// A second adapter over the same three verbs. No behaviour lives here.
const [verb, name] = process.argv.slice(2);
const theseus = new Theseus();
for (const p of parts) theseus.add(p);

try {
  if (verb === 'up') await theseus.up(name);
  else if (verb === 'down') await theseus.down(name);
  else if (verb === 'status') {
    const s = await theseus.status();
    for (const p of s.parts) {
      const raw = 'raw' in p.state ? ` (${p.state.raw})` : '';
      const drift = p.unitMatchesDeclaration || p.state.kind === 'not-installed'
        ? '' : '  [unit differs from declaration]';
      console.log(`${p.name.padEnd(24)} ${p.state.kind}${raw}${drift}`);
    }
    for (const u of s.missingUnits) console.log(`drift: declared but not installed: ${u}`);
    for (const u of s.orphanUnits) console.log(`drift: installed but not declared: ${u}`);
    if (!s.parts.every((p) => isRunning(p.state))) process.exitCode = 1;
  } else {
    console.error('usage: theseus up|down|status [part]');
    process.exitCode = 2;
  }
} catch (e) {
  console.error(`${(e as Error).name}: ${(e as Error).message}`);
  process.exitCode = 1;
}
