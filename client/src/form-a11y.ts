const FIELD_SELECTOR = ':scope > input, :scope > select, :scope > textarea, :scope > .password-field > input';

function normalizeLabel(text: string | null | undefined): string {
  return (text ?? '').replace(/\s+/g, ' ').trim();
}

function hasAccessibleName(control: HTMLElement, label?: HTMLLabelElement | null): boolean {
  const existingAria = normalizeLabel(control.getAttribute('aria-label'));
  const labelledBy = normalizeLabel(control.getAttribute('aria-labelledby'));
  const nativeAssociation = Boolean(label && control.id && label.htmlFor === control.id);
  const implicitAssociation = Boolean(control.closest('label'));
  return Boolean(existingAria || labelledBy || nativeAssociation || implicitAssociation);
}

/**
 * Legacy forms consistently render a visual label next to their field, but a
 * number of older screens predate explicit htmlFor/id wiring. Give those
 * controls a programmatic accessible name without changing form semantics or
 * React state. Explicit aria-label/aria-labelledby/native label associations
 * always win and are never overwritten.
 */
export function repairFormAccessibility(root: ParentNode = document): number {
  let repaired = 0;

  // The prompt is intentionally label-free visually, but its placeholder is a
  // hint rather than a durable accessible name. Name it centrally so the same
  // semantics survive every page where the docked prompt appears.
  const prompt = root.querySelector<HTMLInputElement>('.entry > input');
  if (prompt && !hasAccessibleName(prompt)) {
    prompt.setAttribute('aria-label', 'Financial book prompt');
    repaired += 1;
  }

  for (const group of Array.from(root.querySelectorAll<HTMLElement>('.f'))) {
    const label = group.querySelector<HTMLLabelElement>(':scope > label');
    const control = group.querySelector<HTMLInputElement | HTMLSelectElement | HTMLTextAreaElement>(FIELD_SELECTOR);
    if (!label || !control || hasAccessibleName(control, label)) continue;

    const text = normalizeLabel(label.textContent);
    if (!text) continue;
    control.setAttribute('aria-label', text);
    repaired += 1;
  }
  return repaired;
}

export function installFormAccessibility(): () => void {
  const repair = () => { repairFormAccessibility(document); };
  repair();

  const observer = new MutationObserver(() => repair());
  observer.observe(document.documentElement, {
    childList: true,
    subtree: true,
  });

  return () => observer.disconnect();
}
