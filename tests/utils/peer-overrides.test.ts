import { describe, it, expect } from 'vitest';
import {
  findInvalidPeerOverrideKeys,
  parsePeerOverrideKey,
  resolvePeerOverrides,
  resolvePeerOverridesForPackage,
} from '../../src/utils/peer-overrides';

describe('peer-overrides utils', () => {
  describe('parsePeerOverrideKey', () => {
    it('parses unscoped and scoped package names with and without version ranges', () => {
      expect(parsePeerOverrideKey('legacy')).toEqual({
        packageName: 'legacy',
        versionRange: null,
        exactVersion: false,
      });
      expect(parsePeerOverrideKey('@rili/ui')).toEqual({
        packageName: '@rili/ui',
        versionRange: null,
        exactVersion: false,
      });
      expect(parsePeerOverrideKey('legacy@1.x')).toEqual({
        packageName: 'legacy',
        versionRange: '1.x',
        exactVersion: false,
      });
      expect(parsePeerOverrideKey('@rili/ui@^1.16.0')).toEqual({
        packageName: '@rili/ui',
        versionRange: '^1.16.0',
        exactVersion: false,
      });
      expect(parsePeerOverrideKey('@rili/ui@1.16.220-feat-kso.417')).toEqual({
        packageName: '@rili/ui',
        versionRange: '1.16.220-feat-kso.417',
        exactVersion: true,
      });
      expect(parsePeerOverrideKey('legacy@=1.2.3')).toEqual({
        packageName: 'legacy',
        versionRange: '=1.2.3',
        exactVersion: true,
      });
    });

    it('rejects malformed keys and empty or invalid semver ranges', () => {
      expect(parsePeerOverrideKey('')).toBeNull();
      expect(parsePeerOverrideKey('   ')).toBeNull();
      expect(parsePeerOverrideKey('@scope')).toBeNull();
      expect(parsePeerOverrideKey('@scope/')).toBeNull();
      expect(parsePeerOverrideKey('legacy@')).toBeNull();
      expect(parsePeerOverrideKey('@rili/ui@')).toBeNull();
      expect(parsePeerOverrideKey('@rili/ui@   ')).toBeNull();
      expect(parsePeerOverrideKey('@rili/ui@not-a-range')).toBeNull();
    });
  });

  describe('findInvalidPeerOverrideKeys', () => {
    it('returns only invalid selector keys', () => {
      expect(
        findInvalidPeerOverrideKeys({
          '@rili/ui': { vue: '^2.6.0' },
          '@rili/ui@1.x': { vue: '^2.6.0' },
          '@rili/ui@': { vue: '^2.6.0' },
          'broken@not-semver': { vue: '^2.6.0' },
        }),
      ).toEqual(['@rili/ui@', 'broken@not-semver']);
    });
  });

  describe('resolvePeerOverrides', () => {
    it('matches versioned selectors including prerelease versions without affecting other majors', () => {
      const overrides = {
        '@rili/ui@1.x': { vue: '>=2.5.17 <3' },
      };

      expect(resolvePeerOverrides(overrides, '@rili/ui', '1.16.220-feat-kso.417')).toEqual({
        vue: '>=2.5.17 <3',
      });
      expect(resolvePeerOverrides(overrides, '@rili/ui', '1.0.0')).toEqual({
        vue: '>=2.5.17 <3',
      });
      expect(resolvePeerOverrides(overrides, '@rili/ui', '2.0.0-alpha.1')).toBeUndefined();
      expect(resolvePeerOverrides(overrides, '@rili/ui', '2.1.0')).toBeUndefined();
      expect(resolvePeerOverrides(overrides, '@rili/ui', undefined)).toBeUndefined();
    });

    it('merges matching tiers in order: name-only < range < exact version regardless of key order', () => {
      const overrides = {
        '@foo/ui@1.2.3': { vue: '2.6.14' },
        '@foo/ui@^1.0.0': { vue: '^2.7.0', 'vue-router': '^3.5.0' },
        '@foo/ui': { vue: '^2.6.0', 'vue-router': '^3.0.0', vuex: '^3.6.0' },
      };

      expect(resolvePeerOverrides(overrides, '@foo/ui', '1.2.3')).toEqual({
        vue: '2.6.14',
        'vue-router': '^3.5.0',
        vuex: '^3.6.0',
      });
      expect(resolvePeerOverrides(overrides, '@foo/ui', '1.5.0')).toEqual({
        vue: '^2.7.0',
        'vue-router': '^3.5.0',
        vuex: '^3.6.0',
      });
      expect(resolvePeerOverrides(overrides, '@foo/ui', '2.0.0')).toEqual({
        vue: '^2.6.0',
        'vue-router': '^3.0.0',
        vuex: '^3.6.0',
      });
      expect(resolvePeerOverrides(overrides, '@foo/ui')).toEqual({
        vue: '^2.6.0',
        'vue-router': '^3.0.0',
        vuex: '^3.6.0',
      });
    });

    it('does not treat malformed empty-range selectors as wildcard matches', () => {
      const overrides = {
        '@rili/ui@': { vue: '^2.6.0' },
      };

      expect(resolvePeerOverrides(overrides, '@rili/ui', '2.0.0')).toBeUndefined();
    });
  });

  describe('resolvePeerOverridesForPackage', () => {
    it('layers local alias-name overrides over manifest-name overrides', () => {
      const overrides = {
        '@rili/ui@1.x': { vue: '^2.6.0', 'vue-router': '^3.0.0' },
        'rili-legacy@1.x': { vue: '^2.7.0' },
      };

      expect(
        resolvePeerOverridesForPackage(
          overrides,
          { packageName: 'rili-legacy', manifestName: '@rili/ui' },
          '1.16.0',
        ),
      ).toEqual({
        vue: '^2.7.0',
        'vue-router': '^3.0.0',
      });
    });
  });
});
