import { describe, expect, it } from 'vitest';
import { RESET_CONFIRMATIONS, RESET_LABELS } from './reset';

describe('reset safety definitions', () => {
  it('requires distinct exact confirmation phrases for every destructive scope', () => {
    expect(RESET_CONFIRMATIONS).toEqual({
      activity: 'CLEAR ACTIVITY',
      book: 'START FRESH',
      everything: 'FACTORY RESET',
    });
    expect(new Set(Object.values(RESET_CONFIRMATIONS)).size).toBe(3);
  });

  it('keeps a visible label for each reset scope', () => {
    expect(Object.keys(RESET_LABELS).sort()).toEqual(Object.keys(RESET_CONFIRMATIONS).sort());
  });
});
