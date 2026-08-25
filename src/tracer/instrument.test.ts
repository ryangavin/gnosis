import { afterEach, describe, expect, it } from 'vitest';
import ts from 'typescript';
import { instrument } from './instrument.ts';
import { createCollector, type Collector } from './runtime.ts';

interface TraceLog {
  events: { kind: 'enter' | 'exit'; id?: string }[];
  collector: Collector;
}

function installCollector(): TraceLog {
  const collector = createCollector();
  const events: TraceLog['events'] = [];
  const g = globalThis as unknown as {
    __gnosisEnter?: (id: string) => void;
    __gnosisExit?: () => void;
  };
  g.__gnosisEnter = (id) => {
    events.push({ kind: 'enter', id });
    collector.enter(id);
  };
  g.__gnosisExit = () => {
    events.push({ kind: 'exit' });
    collector.exit();
  };
  return { events, collector };
}

function uninstallCollector(): void {
  const g = globalThis as unknown as { __gnosisEnter?: unknown; __gnosisExit?: unknown };
  delete g.__gnosisEnter;
  delete g.__gnosisExit;
}

async function load(source: string, relPath = 'fixture.ts'): Promise<Record<string, unknown>> {
  const result = instrument(source, relPath);
  const code = result ? result.code : source;
  const js = ts.transpileModule(code, {
    compilerOptions: { module: ts.ModuleKind.ESNext, target: ts.ScriptTarget.ES2022 },
  }).outputText;
  return import(`data:text/javascript;base64,${Buffer.from(js).toString('base64')}`) as Promise<
    Record<string, unknown>
  >;
}

afterEach(uninstallCollector);

describe('instrument', () => {
  it('preserves sync behavior and records balanced enter/exit', async () => {
    const { events } = installCollector();
    const mod = await load(`export function add(a: number, b: number) { return a + b; }`);
    expect((mod.add as (a: number, b: number) => number)(2, 3)).toBe(5);
    expect(events).toEqual([
      { kind: 'enter', id: 'fn:fixture.ts#add' },
      { kind: 'exit' },
    ]);
  });

  it('records the exit even when the function throws', async () => {
    const { events } = installCollector();
    const mod = await load(`export function boom(): never { throw new Error('no'); }`);
    expect(() => (mod.boom as () => void)()).toThrow('no');
    expect(events.filter((e) => e.kind === 'exit')).toHaveLength(1);
  });

  it('wraps expression-bodied arrows, object literals included', async () => {
    const { events } = installCollector();
    const mod = await load(
      `export const make = (n: number) => ({ value: n * 2 });\nexport const pick = (a: number, b: number) => a > b ? a : b;`,
    );
    expect((mod.make as (n: number) => { value: number })(4)).toEqual({ value: 8 });
    expect((mod.pick as (a: number, b: number) => number)(1, 9)).toBe(9);
    expect(events).toHaveLength(4);
  });

  it('handles async functions across await boundaries', async () => {
    const { events } = installCollector();
    const mod = await load(
      `export const fetchTwice = async (n: number) => { const a = await Promise.resolve(n); const b = await Promise.resolve(a); return b + 1; };`,
    );
    await expect((mod.fetchTwice as (n: number) => Promise<number>)(5)).resolves.toBe(6);
    expect(events).toEqual([
      { kind: 'enter', id: 'fn:fixture.ts#fetchTwice' },
      { kind: 'exit' },
    ]);
  });

  it('handles generators, including early termination', async () => {
    const { events } = installCollector();
    const mod = await load(
      `export function* naturals() { let n = 0; while (true) yield n++; }`,
    );
    const gen = (mod.naturals as () => Generator<number>)();
    expect([gen.next().value, gen.next().value]).toEqual([0, 1]);
    expect(events.filter((e) => e.kind === 'exit')).toHaveLength(0);
    gen.return(undefined);
    expect(events.filter((e) => e.kind === 'exit')).toHaveLength(1);
  });

  it('leaves super() calls legal in instrumented constructors', async () => {
    const { events } = installCollector();
    const mod = await load(`
      export class Base { tag: string; constructor(tag: string) { this.tag = tag; } }
      export class Kid extends Base { constructor() { super('kid'); } }
    `);
    const Kid = mod.Kid as new () => { tag: string };
    expect(new Kid().tag).toBe('kid');
    expect(events.map((e) => e.id ?? e.kind)).toEqual([
      'fn:fixture.ts#Kid.constructor',
      'fn:fixture.ts#Base.constructor',
      'exit',
      'exit',
    ]);
  });

  it('instruments accessors and class property arrows', async () => {
    const { events } = installCollector();
    const mod = await load(`
      export class Box {
        private v = 1;
        get value() { return this.v; }
        set value(n: number) { this.v = n; }
        double = () => this.value * 2;
      }
    `);
    const box = new (mod.Box as new () => { value: number; double: () => number })();
    box.value = 21;
    expect(box.value).toBe(21);
    expect(box.double()).toBe(42);
    const ids = events.filter((e) => e.kind === 'enter').map((e) => e.id);
    expect(ids).toEqual([
      'fn:fixture.ts#Box.value[set]',
      'fn:fixture.ts#Box.value[get]',
      'fn:fixture.ts#Box.double',
      'fn:fixture.ts#Box.value[get]',
    ]);
  });

  it('nests named functions correctly and skips anonymous callbacks', async () => {
    const { events, collector } = installCollector();
    const mod = await load(`
      export function outer() {
        const local = (n: number) => n + 1;
        return [1, 2].map((n) => local(n));
      }
    `);
    expect((mod.outer as () => number[])()).toEqual([2, 3]);
    // The anonymous map callback is invisible; local's caller is outer.
    const lines = collector.flush();
    const edge = lines.find((l) => l.to === 'fn:fixture.ts#outer.local');
    expect(edge?.from).toBe('fn:fixture.ts#outer');
    expect(edge?.n).toBe(2);
    expect(events.filter((e) => e.id === 'fn:fixture.ts#outer.local')).toHaveLength(2);
  });

  it('instruments only the overload implementation', () => {
    const result = instrument(
      `export function f(a: string): string;\nexport function f(a: number): number;\nexport function f(a: unknown): unknown { return a; }`,
      'fixture.ts',
    )!;
    expect(result.functionCount).toBe(1);
  });

  it('returns null for sources with nothing to instrument', () => {
    expect(instrument(`export const N = 4;\nexport type T = string;`, 'fixture.ts')).toBeNull();
  });

  it('produces parseable TSX with the enter hook ahead of the JSX return', () => {
    const result = instrument(
      `export const Face = ({ on }: { on: boolean }) => <div className={on ? 'lit' : 'dim'} />;`,
      'Face.tsx',
    )!;
    expect(result.code).toContain('__gnosisEnter?.("fn:Face.tsx#Face");try{return (');
    const js = ts.transpileModule(result.code, {
      compilerOptions: {
        module: ts.ModuleKind.ESNext,
        target: ts.ScriptTarget.ES2022,
        jsx: ts.JsxEmit.ReactJSX,
      },
    });
    expect(js.outputText).toContain('__gnosisEnter');
  });
});

describe('collector attribution', () => {
  it('attributes a bare call to the current test file and aggregates counts', () => {
    const collector = createCollector();
    collector.setCurrentTest('adds things', 'core/src/ops.test.ts');
    collector.enter('fn:core/src/ops.ts#applyOps');
    collector.exit();
    collector.enter('fn:core/src/ops.ts#applyOps');
    collector.exit();
    const lines = collector.flush();
    expect(lines).toEqual([
      {
        t: 'edge',
        from: 'file:core/src/ops.test.ts',
        to: 'fn:core/src/ops.ts#applyOps',
        n: 2,
        tests: ['adds things'],
        testFiles: ['core/src/ops.test.ts'],
      },
    ]);
    expect(collector.flush()).toEqual([]);
  });
});
