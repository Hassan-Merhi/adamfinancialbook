import { describe, expect, it } from 'vitest';
import { boundedLimit, decodeAuditCursor, decodePageCursor, encodeCursor, validDate } from './performance.js';

describe('Phase 7 performance helpers', () => {
  it('bounds page sizes instead of trusting query input', () => {
    expect(boundedLimit(null, 50, 100)).toBe(50);
    expect(boundedLimit('0', 50, 100)).toBe(50);
    expect(boundedLimit('garbage', 50, 100)).toBe(50);
    expect(boundedLimit('25', 50, 100)).toBe(25);
    expect(boundedLimit('5000', 50, 100)).toBe(100);
  });

  it('accepts only real ISO calendar dates', () => {
    expect(validDate('2026-09-06')).toBe('2026-09-06');
    expect(validDate('2026-02-30')).toBeNull();
    expect(validDate('06-09-2026')).toBeNull();
  });

  it('round-trips statement cursors and rejects malformed cursors', () => {
    const encoded = encodeCursor({ date: '2026-09-06', createdAt: '2026-09-06T08:30:00.000Z', id: 'ent_123' });
    expect(decodePageCursor(encoded)).toEqual({
      date: '2026-09-06', createdAt: '2026-09-06T08:30:00.000Z', id: 'ent_123',
    });
    expect(decodePageCursor('not-a-cursor')).toBeNull();
  });

  it('round-trips audit cursors and rejects non-numeric audit ids', () => {
    const encoded = encodeCursor({ at: '2026-09-06T08:30:00.000Z', id: '42' });
    expect(decodeAuditCursor(encoded)).toEqual({ at: '2026-09-06T08:30:00.000Z', id: '42' });
    const bad = encodeCursor({ at: '2026-09-06T08:30:00.000Z', id: 'audit_42' });
    expect(decodeAuditCursor(bad)).toBeNull();
  });
});
