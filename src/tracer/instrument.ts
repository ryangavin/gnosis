/**
 * The instrumentation transform: pure (source, relPath) → spliced source.
 *
 * Every named function body from the shared walk gets an enter/exit pair:
 *
 *   { stmts }   →  { globalThis.__gnosisEnter?.("id"); try { stmts }
 *                    finally { globalThis.__gnosisExit?.(); } }
 *   => expr     →  => { ...enter; try { return (expr); } finally { ...exit; } }
 *
 * Splicing is positional via magic-string — never a printer, which would
 * re-format and break source maps. try/finally is exactly right for async
 * functions and generators (finally runs on return, throw, and completion),
 * `super()` inside try is legal, and the optional-call form keeps the code
 * inert anywhere the collector isn't installed.
 *
 * Anonymous callbacks are untouched by design: their calls attribute to the
 * nearest named enclosing function on the runtime stack, mirroring the
 * static analyzer's attribution.
 */
import MagicString from 'magic-string';
import ts from 'typescript';
import { collectFunctions } from '../analyzer/function-id.ts';

export interface InstrumentResult {
  code: string;
  map: ReturnType<MagicString['generateMap']>;
  functionCount: number;
}

export function instrument(source: string, relPath: string): InstrumentResult | null {
  const scriptKind = relPath.endsWith('.tsx') ? ts.ScriptKind.TSX : ts.ScriptKind.TS;
  const sourceFile = ts.createSourceFile(relPath, source, ts.ScriptTarget.ES2022, true, scriptKind);
  const records = collectFunctions(sourceFile, relPath);
  if (records.length === 0) return null;

  const s = new MagicString(source);
  for (const record of records) {
    const id = JSON.stringify(record.id);
    if (record.body.isBlock) {
      s.appendLeft(record.body.start + 1, `globalThis.__gnosisEnter?.(${id});try{`);
      s.prependRight(record.body.end - 1, `}finally{globalThis.__gnosisExit?.()}`);
    } else {
      s.appendLeft(record.body.start, `{globalThis.__gnosisEnter?.(${id});try{return (`);
      s.prependRight(record.body.end, `)}finally{globalThis.__gnosisExit?.()}}`);
    }
  }
  return {
    code: s.toString(),
    map: s.generateMap({ hires: true }),
    functionCount: records.length,
  };
}
