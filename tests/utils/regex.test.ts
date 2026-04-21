import { describe, it, expect } from 'vitest';
import { escapeRegex } from '../../src/utils/regex';

describe('regex utilities', () => {
  describe('escapeRegex', () => {
    it('should escape special regex characters', () => {
      expect(escapeRegex('foo.bar')).toBe('foo\\.bar');
      expect(escapeRegex('a*b+c?')).toBe('a\\*b\\+c\\?');
      expect(escapeRegex('(a|b)')).toBe('\\(a\\|b\\)');
      expect(escapeRegex('[a-z]')).toBe('\\[a-z\\]');
      expect(escapeRegex('a{1,2}')).toBe('a\\{1,2\\}');
      expect(escapeRegex('$100')).toBe('\\$100');
      expect(escapeRegex('^start')).toBe('\\^start');
      expect(escapeRegex('path\\to\\file')).toBe('path\\\\to\\\\file');
    });

    it('should leave normal strings unchanged', () => {
      expect(escapeRegex('hello')).toBe('hello');
      expect(escapeRegex('vue')).toBe('vue');
      expect(escapeRegex('@scope/pkg')).toBe('@scope/pkg');
    });

    it('should produce valid regex patterns', () => {
      const raw = '@vue/reactivity';
      const escaped = escapeRegex(raw);
      const regex = new RegExp(`^${escaped}$`);
      expect(regex.test(raw)).toBe(true);
      expect(regex.test('@vue-reactivity')).toBe(false);
    });

    it('should handle empty string', () => {
      expect(escapeRegex('')).toBe('');
    });
  });
});
