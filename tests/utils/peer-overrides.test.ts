import { describe, it, expect, vi } from 'vitest';
import semver from 'semver';
import {
  findInvalidPeerOverrideKeys,
  getEffectivePeerDependencies,
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

    it('compiles selectors once per peerOverrides object reference', () => {
      const overrides = {
        '@rili/ui@1.x': { vue: '^2.6.0' },
      };
      const validRangeSpy = vi.spyOn(semver, 'validRange');

      try {
        expect(resolvePeerOverrides(overrides, '@rili/ui', '1.2.0')).toEqual({ vue: '^2.6.0' });
        const afterFirstLookup = validRangeSpy.mock.calls.length;
        expect(afterFirstLookup).toBeGreaterThan(0);

        for (let index = 0; index < 20; index++) {
          expect(resolvePeerOverrides(overrides, 'unrelated-pkg', '1.0.0')).toBeUndefined();
          expect(resolvePeerOverrides(overrides, '@rili/ui', '1.5.0')).toEqual({ vue: '^2.6.0' });
        }
        expect(validRangeSpy.mock.calls.length).toBe(afterFirstLookup);
      } finally {
        validRangeSpy.mockRestore();
      }
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

  describe('getEffectivePeerDependencies', () => {
    it('merges declared peers, optional meta, and versioned peerOverrides into a single map', () => {
      const manifest = {
        name: '@rili/ui',
        version: '1.16.220-feat-kso.417',
        peerDependencies: {
          vue: '>=2.5.17',
          'vue-router': '>=3.0.0',
          vuex: '^3.0.0',
        },
        peerDependenciesMeta: {
          'vue-router': { optional: true },
          vuex: { optional: true },
        },
      };

      const peers = getEffectivePeerDependencies(manifest, '@rili/ui', {
        '@rili/ui@1.x': {
          vue: '>=2.5.17 <3',
          'vue-router': '^3.6.0',
          'omitted-peer': '^1.0.0',
        },
      });

      expect(Object.fromEntries(peers)).toEqual({
        vue: { range: '>=2.5.17 <3', optional: false, overridden: true },
        'vue-router': { range: '^3.6.0', optional: false, overridden: true },
        vuex: { range: '^3.0.0', optional: true, overridden: false },
        'omitted-peer': { range: '^1.0.0', optional: false, overridden: true },
      });
    });
  });
});
