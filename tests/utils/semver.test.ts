import { describe, it, expect } from 'vitest';
import {
  satisfies,
  compare,
  findIntersection,
  findBestVersion,
  rangesIntersect,
  createAliasInstallSpec,
  generateAliasName,
} from '../../src/utils/semver';

describe('semver utilities', () => {
  describe('satisfies', () => {
    it('should return true when version satisfies range', () => {
      expect(satisfies('2.6.14', '^2.6.0')).toBe(true);
      expect(satisfies('2.6.14', '>=2.0.0 <3.0.0')).toBe(true);
      expect(satisfies('2.6.14', '2.x')).toBe(true);
    });

    it('should return false when version does not satisfy range', () => {
      expect(satisfies('3.0.0', '^2.6.0')).toBe(false);
      expect(satisfies('2.6.14', '>=3.0.0')).toBe(false);
      expect(satisfies('1.0.0', '>2.0.0')).toBe(false);
    });

    it('should handle edge cases', () => {
      expect(satisfies('invalid', '^1.0.0')).toBe(false);
      expect(satisfies('1.0.0', 'invalid-range')).toBe(false);
    });
  });

  describe('compare', () => {
    it('should compare versions correctly', () => {
      expect(compare('1.0.0', '2.0.0')).toBe(-1);
      expect(compare('2.0.0', '1.0.0')).toBe(1);
      expect(compare('1.0.0', '1.0.0')).toBe(0);
    });

    it('should handle prerelease versions', () => {
      expect(compare('1.0.0-alpha', '1.0.0')).toBe(-1);
      expect(compare('1.0.0', '1.0.0-beta')).toBe(1);
    });
  });

  describe('findIntersection', () => {
    it('should find versions satisfying all ranges', () => {
      const versions = ['1.0.0', '1.5.0', '2.0.0', '2.5.0', '3.0.0'];
      const ranges = ['>=1.0.0', '<3.0.0'];
      expect(findIntersection(versions, ranges)).toEqual(['1.0.0', '1.5.0', '2.0.0', '2.5.0']);
    });

    it('should return empty array when no intersection', () => {
      const versions = ['1.0.0', '2.0.0'];
      const ranges = ['>=3.0.0', '<4.0.0'];
      expect(findIntersection(versions, ranges)).toEqual([]);
    });

    it('should return all versions when ranges is empty', () => {
      const versions = ['1.0.0', '2.0.0'];
      expect(findIntersection(versions, [])).toEqual(versions);
    });
  });

  describe('findBestVersion', () => {
    it('should find the best (latest) satisfying version', () => {
      const versions = ['1.0.0', '1.5.0', '2.0.0', '2.5.0', '3.0.0'];
      const ranges = ['>=1.0.0', '<3.0.0'];
      expect(findBestVersion(versions, ranges)).toBe('2.5.0');
    });

    it('should return null when no version satisfies all ranges', () => {
      const versions = ['1.0.0', '4.0.0'];
      const ranges = ['>=2.0.0', '<3.0.0'];
      expect(findBestVersion(versions, ranges)).toBe(null);
    });
  });

  describe('rangesIntersect', () => {
    it('should return true for intersecting ranges', () => {
      expect(rangesIntersect('^2.0.0', '>=2.0.0 <3.0.0')).toBe(true);
      expect(rangesIntersect('>=1.0.0', '<=2.0.0')).toBe(true);
    });

    it('should return false for non-intersecting ranges', () => {
      expect(rangesIntersect('^2.0.0', '>=3.0.0')).toBe(false);
      expect(rangesIntersect('<1.0.0', '>2.0.0')).toBe(false);
    });
  });

  describe('createAliasInstallSpec', () => {
    it('should create correct npm alias spec', () => {
      expect(createAliasInstallSpec('vue2', 'vue', '2.6.14')).toBe('vue2@npm:vue@2.6.14');
    });
  });

  describe('generateAliasName', () => {
    it('should generate alias name with major version', () => {
      expect(generateAliasName('vue', '2.6.14')).toBe('vue2');
      expect(generateAliasName('vue-router', '3.5.0')).toBe('vue-router3');
    });

    it('should handle scoped packages', () => {
      expect(generateAliasName('@vue/composition-api', '1.2.3')).toBe('vue-composition-api1');
    });
  });
});
