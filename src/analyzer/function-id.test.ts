import { describe, expect, it } from 'vitest';
import ts from 'typescript';
import { collectFunctions } from './function-id.ts';

const FIXTURE = `
/** Adds. */
export function add(a: number, b: number): number { return a + b; }

export const scale = (n: number) => n * 2;

const helper = function inner() { return 1; };

export class Store {
  private items: string[] = [];
  constructor(seed: string) { this.items.push(seed); }
  push(item: string) { this.items.push(item); }
  get size() { return this.items.length; }
  set size(_n: number) {}
  bound = () => this.items.length;
}

export const api = {
  fetch(url: string) { return url; },
  parse: (raw: string) => raw.trim(),
  nested: {
    deep: () => 42,
  },
};

export function outer() {
  const local = () => 1;
  function innerFn() { return local(); }
  return [1, 2].map((n) => n * innerFn());
}

export function overloaded(a: string): string;
export function overloaded(a: number): number;
export function overloaded(a: string | number): string | number { return a; }

export default function main() { return add(1, 2); }

setTimeout(function tick() {}, 10);
setTimeout(() => {}, 10);
`;

function standalone(text: string): ts.SourceFile {
  return ts.createSourceFile('fixture.ts', text, ts.ScriptTarget.ES2022, true, ts.ScriptKind.TS);
}

function programLoaded(text: string): ts.SourceFile {
  const host = ts.createCompilerHost({});
  const original = host.getSourceFile.bind(host);
  host.getSourceFile = (name, version, ...rest) =>
    name === 'fixture.ts'
      ? ts.createSourceFile(name, text, version, true, ts.ScriptKind.TS)
      : original(name, version, ...rest);
  host.fileExists = (name) => name === 'fixture.ts';
  host.readFile = (name) => (name === 'fixture.ts' ? text : undefined);
  const program = ts.createProgram(['fixture.ts'], { target: ts.ScriptTarget.ES2022 }, host);
  return program.getSourceFile('fixture.ts')!;
}

describe('collectFunctions', () => {
  it('produces identical records from standalone and program-loaded parses', () => {
    const a = collectFunctions(standalone(FIXTURE), 'fixture.ts');
    const b = collectFunctions(programLoaded(FIXTURE), 'fixture.ts');
    const strip = (rs: ReturnType<typeof collectFunctions>) =>
      rs.map(({ node: _node, ...rest }) => rest);
    expect(strip(a)).toEqual(strip(b));
  });

  it('names the expected shapes and skips anonymous callbacks', () => {
    const ids = collectFunctions(standalone(FIXTURE), 'fixture.ts').map((r) => r.id);
    expect(ids).toEqual([
      'fn:fixture.ts#add',
      'fn:fixture.ts#scale',
      'fn:fixture.ts#helper',
      'fn:fixture.ts#Store.constructor',
      'fn:fixture.ts#Store.push',
      'fn:fixture.ts#Store.size[get]',
      'fn:fixture.ts#Store.size[set]',
      'fn:fixture.ts#Store.bound',
      'fn:fixture.ts#api.fetch',
      'fn:fixture.ts#api.parse',
      'fn:fixture.ts#api.nested.deep',
      'fn:fixture.ts#outer',
      'fn:fixture.ts#outer.local',
      'fn:fixture.ts#outer.innerFn',
      'fn:fixture.ts#overloaded',
      'fn:fixture.ts#main',
      'fn:fixture.ts#tick',
    ]);
  });

  it('collapses overloads onto the single implementation', () => {
    const records = collectFunctions(standalone(FIXTURE), 'fixture.ts');
    expect(records.filter((r) => r.name === 'overloaded')).toHaveLength(1);
  });

  it('gives redeclared names ordinal suffixes in source order', () => {
    const text = `
      function twice() { return 1; }
      namespace twice { export function inner() {} }
      const again = () => 1;
      const holder = { again: () => 2 };
      function twice2() {}
      function twice2() {}
    `;
    const ids = collectFunctions(standalone(text), 'x.ts').map((r) => r.id);
    expect(ids).toContain('fn:x.ts#twice2');
    expect(ids).toContain('fn:x.ts#twice2~1');
    expect(ids).toContain('fn:x.ts#again');
    expect(ids).toContain('fn:x.ts#holder.again');
  });

  it('marks export and async flags and block vs expression bodies', () => {
    const records = collectFunctions(standalone(FIXTURE), 'fixture.ts');
    const byName = new Map(records.map((r) => [r.qualifiedName, r]));
    expect(byName.get('add')!.isExported).toBe(true);
    expect(byName.get('helper')!.isExported).toBe(false);
    expect(byName.get('scale')!.body.isBlock).toBe(false);
    expect(byName.get('add')!.body.isBlock).toBe(true);

    const asyncRecords = collectFunctions(
      standalone('export const go = async () => { await Promise.resolve(); };'),
      'a.ts',
    );
    expect(asyncRecords[0]!.isAsync).toBe(true);
  });
});
