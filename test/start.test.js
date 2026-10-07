import test from 'node:test';
import assert from 'node:assert/strict';
import { mkdtempSync, mkdirSync, writeFileSync, rmSync } from 'node:fs';
import { join } from 'node:path';
import { tmpdir } from 'node:os';
import { spawnSync } from 'node:child_process';

test('start script forwards --since and arguments containing spaces', (t) => {
  const dir = mkdtempSync(join(tmpdir(), 'wa-start-test-'));
  t.after(() => rmSync(dir, { recursive: true, force: true }));
  const bin = join(dir, 'bin');
  mkdirSync(bin);
  writeFileSync(join(bin, 'node'), '#!/bin/sh\nif [ "$1" = "--version" ]; then echo v24.test; else printf "%s\\n" "$@"; fi\n', { mode: 0o755 });
  const result = spawnSync('bash', ['scripts/start.sh', '--since=2026-10-01', 'argument with spaces'], {
    encoding: 'utf8', env: { ...process.env, PATH: `${bin}:${process.env.PATH}`, NVM_DIR: join(dir, 'no-nvm') },
  });
  assert.equal(result.status, 0, result.stderr);
  assert.match(result.stdout, /index\.js\n--since=2026-10-01\nargument with spaces\n/);
});
