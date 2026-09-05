import { describe, expect, it } from 'vitest';
import { protectTranslationText, restoreTranslationText } from './language';

describe('Phase 8 financial translation protection', () => {
  it('preserves names, codes, money, dates, percentages, emails, URLs and filenames exactly', () => {
    const source = 'Paid Fresh Start FZ $1,250.50 on 2026-09-05 for GC-LSHI INV-204 at 12.5% — receipt.pdf — ops@example.com — https://example.com/r/204';
    const protectedText = protectTranslationText(source, ['Fresh Start FZ', 'GC-LSHI']);

    for (const literal of [
      'Fresh Start FZ', '$1,250.50', '2026-09-05', 'GC-LSHI', 'INV-204', '12.5%',
      'receipt.pdf', 'ops@example.com', 'https://example.com/r/204',
    ]) expect(protectedText.masked).not.toContain(literal);

    const translatedMasked = protectedText.masked.replace('Paid', 'Payé').replace(' on ', ' le ').replace(' for ', ' pour ');
    const restored = restoreTranslationText(translatedMasked, protectedText);
    for (const literal of [
      'Fresh Start FZ', '$1,250.50', '2026-09-05', 'GC-LSHI', 'INV-204', '12.5%',
      'receipt.pdf', 'ops@example.com', 'https://example.com/r/204',
    ]) expect(restored).toContain(literal);
  });
});
