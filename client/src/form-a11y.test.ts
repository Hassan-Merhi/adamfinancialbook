import { describe, expect, it } from 'vitest';
import { repairFormAccessibility } from './form-a11y';

describe('repairFormAccessibility', () => {
  it('does not overwrite explicit accessible names', () => {
    const root = document.createElement('div');
    root.innerHTML = `
      <div class="f"><label>Name</label><input aria-label="Account name"></div>
      <div class="f"><label>Business</label><select aria-labelledby="business-label"><option>A</option></select></div>
      <span id="business-label">Choose business</span>
    `;

    expect(repairFormAccessibility(root)).toBe(0);
    expect(root.querySelector('input')?.getAttribute('aria-label')).toBe('Account name');
    expect(root.querySelector('select')?.getAttribute('aria-labelledby')).toBe('business-label');
  });
});
