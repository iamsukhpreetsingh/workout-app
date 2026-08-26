#!/usr/bin/env node
// Route-registry guardrail (see backend README, "Adding a new endpoint").
// Every HTTP endpoint in this backend must be registered through
// registerRoute() so it appears in the admin API Explorer automatically.
// This script statically scans route files and flags any raw
// router.get/post/put/patch/delete or app.get/post/... registration that
// bypasses the wrapper.
//
// Usage:
//   node scripts/checkRouteRegistry.js            # report only, exit 0 with warning summary
//   node scripts/checkRouteRegistry.js --strict   # exit 1 if violations found (for CI)

const fs = require('fs');
const path = require('path');

const ROOT = path.resolve(__dirname, '..');
const SCAN_DIRS = [path.join(ROOT, 'src', 'routes')];
const SCAN_FILES = [path.join(ROOT, 'server.js')];
// only router./app. HTTP registrations count as violations — not req.get(),
// res.get(), or other same-named methods on other objects
const RAW_CALL = /\b(?:router|app)\.(get|post|put|patch|delete)\s*\(/;
const REGISTERED = /registerRoute\s*\(/;

function collectFiles() {
  const files = [...SCAN_FILES];
  for (const dir of SCAN_DIRS) {
    for (const f of fs.readdirSync(dir)) {
      if (f.endsWith('.js')) files.push(path.join(dir, f));
    }
  }
  return files;
}

function scan() {
  const violations = [];
  let registeredCount = 0;
  for (const file of collectFiles()) {
    const rel = path.relative(ROOT, file);
    const source = fs.readFileSync(file, 'utf8');
    registeredCount += (source.match(REGISTERED) || []).length;
    const lines = source.split('\n');
    lines.forEach((line, i) => {
      const m = line.match(RAW_CALL);
      if (!m) return;
      // allow express plumbing: app.use, static mounts, error handlers
      if (line.trim().startsWith('//')) return;
      violations.push({ file: rel, line: i + 1, method: m[1], text: line.trim() });
    });
  }
  return { violations, registeredCount };
}

function main() {
  const strict = process.argv.includes('--strict');
  const { violations, registeredCount } = scan();
  console.log(`route registry check: ${registeredCount} registerRoute() call(s), ${violations.length} raw registration(s)`);
  for (const v of violations) {
    console.log(`  WARN ${v.file}:${v.line} raw .${v.method}( bypasses registerRoute(): ${v.text.slice(0, 90)}`);
  }
  if (violations.length) {
    console.log(
      `\nNew endpoints MUST use registerRoute() so they appear in the admin API Explorer.\n` +
        `Migrate incrementally; every NEW route from now on is required. See backend README.`
    );
  }
  if (strict && violations.length) process.exitCode = 1;
}

main();
