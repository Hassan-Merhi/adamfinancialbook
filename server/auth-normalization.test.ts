import { describe, expect, it } from 'vitest';
import { usernameKey } from './auth.js';

describe('usernameKey', () => {
  it('ignores spaces and letter case', () => {
    expect(usernameKey('Hassan Dakik')).toBe('hassandakik');
    expect(usernameKey('HaSSanDakik')).toBe('hassandakik');
    expect(usernameKey('  hassan   dakik  ')).toBe('hassandakik');
  });

  it('does not forgive missing or different letters', () => {
    expect(usernameKey('hasandakik')).not.toBe(usernameKey('hassan dakik'));
    expect(usernameKey('hassan dakir')).not.toBe(usernameKey('hassan dakik'));
  });
});
