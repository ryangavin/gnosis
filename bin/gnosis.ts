#!/usr/bin/env -S node --disable-warning=ExperimentalWarning
import { main } from '../src/cli/index.ts';

main(process.argv.slice(2)).catch((error: unknown) => {
  console.error(error instanceof Error ? error.message : error);
  process.exitCode = 1;
});
