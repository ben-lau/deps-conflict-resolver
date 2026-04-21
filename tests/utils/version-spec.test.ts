import { describe, it, expect } from 'vitest';
import { parseNpmAlias } from '../../src/utils/version-spec';

describe('version-spec utilities', () => {
  describe('parseNpmAlias', () => {
    it('should parse simple npm alias', () => {
      expect(parseNpmAlias('npm:vue@2.6.14')).toEqual(['vue', '2.6.14']);
      expect(parseNpmAlias('npm:react@^18.0.0')).toEqual(['react', '^18.0.0']);
      expect(parseNpmAlias('npm:lodash@~4.17.21')).toEqual(['lodash', '~4.17.21']);
    });

    it('should parse scoped package alias', () => {
      expect(parseNpmAlias('npm:@vue/reactivity@^3.0.0')).toEqual([
        '@vue/reactivity',
        '^3.0.0',
      ]);
      expect(parseNpmAlias('npm:@scope/pkg@1.2.3')).toEqual(['@scope/pkg', '1.2.3']);
    });

    it('should parse version range with complex specifiers', () => {
      expect(parseNpmAlias('npm:pkg@>=1.0.0 <3.0.0')).toEqual(['pkg', '>=1.0.0 <3.0.0']);
      expect(parseNpmAlias('npm:pkg@1.0.0 || 2.0.0')).toEqual(['pkg', '1.0.0 || 2.0.0']);
    });

    it('should return null for non-npm alias specs', () => {
      expect(parseNpmAlias('^1.0.0')).toBeNull();
      expect(parseNpmAlias('~2.0.0')).toBeNull();
      expect(parseNpmAlias('1.0.0')).toBeNull();
      expect(parseNpmAlias('workspace:*')).toBeNull();
      expect(parseNpmAlias('catalog:default')).toBeNull();
      expect(parseNpmAlias('file:../local')).toBeNull();
    });

    it('should return null for malformed npm specs', () => {
      expect(parseNpmAlias('npm:')).toBeNull();
      expect(parseNpmAlias('npm:pkg')).toBeNull();
    });
  });
});
