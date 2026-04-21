import { describe, it, expect } from 'vitest';
import {
  isVirtualModuleRequest,
  isPathLikeRequest,
  isWebpackInternalRequest,
} from '../../src/utils/module-request';

describe('module-request utilities', () => {
  describe('isVirtualModuleRequest', () => {
    it('should detect \\0-prefixed virtual modules', () => {
      expect(isVirtualModuleRequest('\0virtual:my-module')).toBe(true);
      expect(isVirtualModuleRequest('\0rollup-plugin-xyz')).toBe(true);
    });

    it('should reject non-virtual requests', () => {
      expect(isVirtualModuleRequest('vue')).toBe(false);
      expect(isVirtualModuleRequest('./local')).toBe(false);
      expect(isVirtualModuleRequest('')).toBe(false);
    });
  });

  describe('isPathLikeRequest', () => {
    it('should detect relative paths', () => {
      expect(isPathLikeRequest('./foo')).toBe(true);
      expect(isPathLikeRequest('../bar')).toBe(true);
      expect(isPathLikeRequest('./nested/deep/file.js')).toBe(true);
    });

    it('should detect Unix absolute paths', () => {
      expect(isPathLikeRequest('/usr/local/lib')).toBe(true);
      expect(isPathLikeRequest('/home/user/project')).toBe(true);
    });

    it('should detect Windows drive letter paths', () => {
      expect(isPathLikeRequest('C:\\Users\\test')).toBe(true);
      expect(isPathLikeRequest('D:/projects/app')).toBe(true);
      expect(isPathLikeRequest('c:\\lower\\case')).toBe(true);
    });

    it('should detect Windows UNC paths', () => {
      expect(isPathLikeRequest('\\\\server\\share')).toBe(true);
      expect(isPathLikeRequest('\\\\192.168.1.1\\data')).toBe(true);
    });

    it('should reject bare module identifiers', () => {
      expect(isPathLikeRequest('vue')).toBe(false);
      expect(isPathLikeRequest('@vue/reactivity')).toBe(false);
      expect(isPathLikeRequest('lodash/debounce')).toBe(false);
    });

    it('should reject empty string', () => {
      expect(isPathLikeRequest('')).toBe(false);
    });
  });

  describe('isWebpackInternalRequest', () => {
    it('should detect webpack/ prefixed requests', () => {
      expect(isWebpackInternalRequest('webpack/runtime/compat')).toBe(true);
      expect(isWebpackInternalRequest('webpack/container/reference')).toBe(true);
    });

    it('should detect ! prefixed loaders', () => {
      expect(isWebpackInternalRequest('!raw-loader!./file.txt')).toBe(true);
      expect(isWebpackInternalRequest('!style-loader!css-loader')).toBe(true);
    });

    it('should reject normal module requests', () => {
      expect(isWebpackInternalRequest('vue')).toBe(false);
      expect(isWebpackInternalRequest('./local')).toBe(false);
      expect(isWebpackInternalRequest('@scope/pkg')).toBe(false);
    });
  });
});
