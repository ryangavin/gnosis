import { describe, expect, it } from 'vitest';
import { containersFor, parentPath } from './domains.ts';

describe('containersFor', () => {
  it('names the first segment the domain and every deeper folder a directory', () => {
    expect(containersFor('chart/server/bassline.ts')).toEqual({
      domain: 'chart',
      directories: ['chart/server'],
    });
  });

  it('walks the whole chain for a deeply nested file', () => {
    expect(containersFor('set/src/components/devices/eq8/bind.ts')).toEqual({
      domain: 'set',
      directories: [
        'set/src',
        'set/src/components',
        'set/src/components/devices',
        'set/src/components/devices/eq8',
      ],
    });
  });

  it('gives a file directly under its domain no directories', () => {
    expect(containersFor('core/ops.ts')).toEqual({ domain: 'core', directories: [] });
  });

  it('leaves a repo-root file with no containers at all', () => {
    expect(containersFor('vitest.config.ts')).toEqual({ directories: [] });
  });

  it('does not treat src as transparent — a folder is a folder', () => {
    // v1 skipped `src` when splitting domains, which made the boundary you
    // saw depend on the rule rather than on the tree.
    expect(containersFor('chart/src/App.tsx').directories).toEqual(['chart/src']);
  });

  it('is independent of how many files a domain holds', () => {
    // The v1 split only kicked in past a threshold, so the same path shape
    // nested differently depending on its neighbours.
    expect(containersFor('a/b/c.ts')).toEqual({ domain: 'a', directories: ['a/b'] });
  });
});

describe('parentPath', () => {
  it('drops the last segment', () => {
    expect(parentPath('set/src/components')).toBe('set/src');
    expect(parentPath('set/src')).toBe('set');
  });

  it('has nothing above a first-level segment', () => {
    expect(parentPath('set')).toBeUndefined();
  });
});
