#!/usr/bin/env node
/*
 * One-shot setup: seed dev store + push theme + publish.
 *
 * Usage:
 *   node scripts/setup.mjs              # dry-run preview
 *   node scripts/setup.mjs --write      # do the thing (slim, ~3 min total)
 *   node scripts/setup.mjs --write --full   # full catalog (~10 min)
 *   node scripts/setup.mjs --write --wipe   # wipe + re-seed
 *
 * Requires .env with SHOPIFY_STORE_URL + SHOPIFY_ACCESS_TOKEN.
 */

import { spawn } from 'node:child_process';
import path from 'node:path';

const startedAt = Date.now();
const scriptDir = path.dirname(new URL(import.meta.url).pathname.replace(/^\/([A-Z]:)/, '$1'));
const args = process.argv.slice(2);

// Each child prefixes its lines so the interleaved output stays legible.
function runStep(label, script, extraArgs = []) {
  return new Promise((resolve, reject) => {
    const startedAt = Date.now();
    const child = spawn('node', [path.join(scriptDir, script), ...args, ...extraArgs], { stdio: ['ignore', 'pipe', 'pipe'] });
    const tag = `[${label}]`;
    const onLine = (stream) => (chunk) => {
      const lines = chunk.toString('utf-8').split(/\r?\n/);
      for (const l of lines) if (l.trim()) stream.write(`${tag} ${l}\n`);
    };
    child.stdout.on('data', onLine(process.stdout));
    child.stderr.on('data', onLine(process.stderr));
    child.on('exit', (code) => {
      const s = Math.round((Date.now() - startedAt) / 1000);
      if (code !== 0) reject(new Error(`${label} failed after ${s}s (exit ${code})`));
      else { console.log(`✓ ${label} took ${s}s`); resolve(); }
    });
  });
}

// Run sequentially: seed (incl. media) first, then theme push. Parallel runs cause
// the wipe step's DELETE requests to be heavily rate-limited by the simultaneous theme
// asset uploads, leading to thousands of failed wipes.
try {
  await runStep('seed', 'seed-to-dev-store.mjs');
  await runStep('theme', 'push-theme.mjs');
} catch (e) {
  console.error(`\n✗ ${e.message}. Aborting.`);
  process.exit(1);
}

const total = Math.round((Date.now() - startedAt) / 1000);
console.log(`\n━━━ TOTAL: ${total}s (${(total / 60).toFixed(1)} min) ━━━`);
console.log('You can now visit your dev store and pick the ONE thing to fix.');
