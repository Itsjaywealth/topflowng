#!/usr/bin/env node
/**
 * TopFlowNG — repository syntax gate.
 *
 * Runs `node --check` over every JavaScript source file in the repository
 * (server, routes, services, middleware, lib, migrations, test helpers, scripts
 * and Playwright config). Never touches node_modules or generated artifact
 * directories. Exits non-zero on the first failing file so CI can fail fast.
 *
 * Usage: node scripts/syntax-check.cjs
 */

'use strict';

const fs = require('fs');
const path = require('path');
const { execFileSync } = require('node:child_process');

const ROOT = path.resolve(__dirname, '..');
const EXCLUDED_DIRS = new Set(['node_modules', '.git', '.github', 'test-results', 'playwright-report', 'coverage']);
const EXTS = new Set(['.js', '.cjs', '.mjs']);

function collect(dir, acc = []) {
  for (const entry of fs.readdirSync(dir, { withFileTypes: true })) {
    if (EXCLUDED_DIRS.has(entry.name)) continue;
    const full = path.join(dir, entry.name);
    if (entry.isDirectory()) {
      collect(full, acc);
    } else if (entry.isFile() && EXTS.has(path.extname(entry.name))) {
      acc.push(full);
    }
  }
  return acc;
}

const files = collect(ROOT);
let failures = 0;

for (const file of files) {
  try {
    execFileSync(process.execPath, ['--check', file], { stdio: 'pipe' });
  } catch (e) {
    failures += 1;
    const out = (e.stderr && e.stderr.toString()) || e.message;
    const first = String(out).split('\n').slice(0, 3).join('\n');
    console.error(`SYNTAX FAIL  ${path.relative(ROOT, file)}\n${first}`);
  }
}

console.log(`Syntax check: ${files.length} file(s), ${failures} failure(s).`);
if (failures > 0) process.exit(1);