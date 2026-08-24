/**
 * Vitest setup file appended to the target's config by the shim.
 *
 * SPIKE VERSION: proves that a setup file living inside gnosis binds to the
 * running vitest instance (hooks actually fire in worker processes) and that
 * test attribution context is reachable.
 */
import { appendFileSync } from 'node:fs';
import { join } from 'node:path';
import { beforeEach } from 'vitest';

const outDir = process.env.GNOSIS_OUT_DIR!;
let count = 0;

beforeEach((ctx) => {
  count += 1;
  if (count <= 2) {
    appendFileSync(
      join(outDir, `setup-${process.pid}.log`),
      `hook fired: test=${JSON.stringify(ctx.task.name)} file=${ctx.task.file?.filepath ?? '?'}\n`,
    );
  }
});

process.on('exit', () => {
  appendFileSync(join(outDir, `setup-${process.pid}.log`), `total hooks: ${count}\n`);
});
