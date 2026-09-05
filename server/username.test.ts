import { describe, expect, it } from 'vitest';
import { usernameKey } from './username.js';

describe('usernameKey', () => {
  it('ignores capitalization', () => {
    expect(usernameKey('HaSSanDakik')).toBe('hassandakik');
  });

  it('ignores whitespace anywhere in the username', () => {
    expect(usernameKey('  Hassan   Dakik  ')).toBe('hassandakik');
    expect(usernameKey('Hassan\tDakik')).toBe('hassandakik');
    expect(usernameKey('Hassan\nDakik')).toBe('hassandakik');
  });

  it('still requires the same letters in the same order', () => {
    expect(usernameKey('Hassan Dakik')).toBe('hassandakik');
    expect(usernameKey('hasandakik')).not.toBe('hassandakik');
    expect(usernameKey('hassan dakir')).not.toBe('hassandakik');
  });

  it('does not ignore punctuation', () => {
    expect(usernameKey('Hassan-Dakik')).not.toBe('hassandakik');
  });

  it('normalizes compatible unicode forms before comparison', () => {
    expect(usernameKey('Ｈａｓｓａｎ Ｄａｋｉｋ')).toBe('hassandakik');
  });
});
