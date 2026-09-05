import { describe, expect, it } from 'vitest';
import { heuristicLanguage, protectTranslationText, restoreTranslationText } from './language';

describe('multilingual language helpers', () => {
  it('detects Arabic script', () => {
    expect(heuristicLanguage('اشتريت 100 طن من الحديد')).toBe('ar');
  });

  it('detects common French bookkeeping prose', () => {
    expect(heuristicLanguage("j'ai payé 500 depuis la caisse pour le projet")).toBe('fr');
    expect(heuristicLanguage('ajouter fournisseur Dani sous Construction')).toBe('fr');
  });

  it('defaults ordinary English bookkeeping prose to English', () => {
    expect(heuristicLanguage('I bought 100 ton from Dani with construction cash')).toBe('en');
  });

  it('protects exact catalog names and restores them after translation', () => {
    const protectedText = protectTranslationText(
      'move $500 from STS Cash to Fresh Start FZ',
      ['Fresh Start FZ', 'STS Cash'],
    );
    expect(protectedText.masked).not.toContain('Fresh Start FZ');
    expect(protectedText.masked).not.toContain('STS Cash');
    const simulated = protectedText.masked.replace('move', 'déplacer').replace('from', 'de').replace('to', 'vers');
    expect(restoreTranslationText(simulated, protectedText)).toContain('STS Cash');
    expect(restoreTranslationText(simulated, protectedText)).toContain('Fresh Start FZ');
  });
});
