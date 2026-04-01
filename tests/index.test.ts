import { describe, it, expect } from 'vitest';
import { DepsConflictResolver, createResolver } from '../src/index';

describe('index exports', () => {
  it('should export DepsConflictResolver class', () => {
    const resolver = new DepsConflictResolver({
      projectRoot: '/test/project',
      dependencies: ['vue'],
    });
    expect(resolver).toBeInstanceOf(DepsConflictResolver);
    expect(resolver.getAnalysisResult()).toBeNull();
  });

  it('should export createResolver that returns initialized resolver', async () => {
    const resolver = await createResolver({
      projectRoot: process.cwd(),
      dependencies: ['semver'],
    });
    expect(resolver).toBeInstanceOf(DepsConflictResolver);
    expect(resolver.getAnalysisResult()).not.toBeNull();
  });
});
