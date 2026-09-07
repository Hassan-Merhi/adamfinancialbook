import { ALL_LIVE_TOPICS, LIVE_MUTATION_EVENT, type LiveMutationDetail } from './live-refresh';

const PULL_THRESHOLD = 72;
const MAX_PULL = 112;
const INDICATOR_ID = 'ios-pull-refresh-indicator';

function isTouchMobile(target: Window): boolean {
  return target.matchMedia('(pointer: coarse)').matches && target.matchMedia('(max-width: 900px)').matches;
}

function ensureIndicator(doc: Document): HTMLDivElement {
  const existing = doc.getElementById(INDICATOR_ID);
  if (existing instanceof HTMLDivElement) return existing;

  const indicator = doc.createElement('div');
  indicator.id = INDICATOR_ID;
  indicator.setAttribute('role', 'status');
  indicator.setAttribute('aria-live', 'polite');
  indicator.innerHTML = '<span class="ios-pull-refresh-spinner" aria-hidden="true"></span><span class="ios-pull-refresh-label">Pull to refresh</span>';
  doc.body.appendChild(indicator);

  if (!doc.getElementById(`${INDICATOR_ID}-styles`)) {
    const style = doc.createElement('style');
    style.id = `${INDICATOR_ID}-styles`;
    style.textContent = `
      #${INDICATOR_ID} {
        position: fixed;
        z-index: 1200;
        top: calc(env(safe-area-inset-top, 0px) + 8px);
        left: 50%;
        display: flex;
        align-items: center;
        gap: 8px;
        min-height: 36px;
        padding: 7px 12px;
        border: 1px solid color-mix(in srgb, currentColor 14%, transparent);
        border-radius: 999px;
        background: color-mix(in srgb, Canvas 94%, transparent);
        color: CanvasText;
        box-shadow: 0 4px 18px rgb(0 0 0 / 14%);
        font: 600 13px/1.2 system-ui, -apple-system, BlinkMacSystemFont, "SF Pro Text", sans-serif;
        opacity: 0;
        pointer-events: none;
        transform: translate(-50%, -48px) scale(.96);
        transition: transform 160ms ease, opacity 140ms ease;
        -webkit-backdrop-filter: blur(14px);
        backdrop-filter: blur(14px);
      }
      #${INDICATOR_ID}.visible {
        opacity: 1;
      }
      #${INDICATOR_ID}.refreshing {
        transform: translate(-50%, 0) scale(1);
      }
      #${INDICATOR_ID} .ios-pull-refresh-spinner {
        width: 15px;
        height: 15px;
        flex: 0 0 15px;
        border: 2px solid color-mix(in srgb, currentColor 22%, transparent);
        border-top-color: currentColor;
        border-radius: 50%;
        transform: rotate(0deg);
      }
      #${INDICATOR_ID}.refreshing .ios-pull-refresh-spinner {
        animation: ios-pull-refresh-spin .7s linear infinite;
      }
      @keyframes ios-pull-refresh-spin { to { transform: rotate(360deg); } }
      @media (prefers-reduced-motion: reduce) {
        #${INDICATOR_ID} { transition: none; }
        #${INDICATOR_ID}.refreshing .ios-pull-refresh-spinner { animation: none; }
      }
      @media (min-width: 901px), (pointer: fine) {
        #${INDICATOR_ID} { display: none !important; }
      }
    `;
    doc.head.appendChild(style);
  }

  return indicator;
}

/**
 * Adds app-style pull-to-refresh on touch phones, including iOS Safari/PWA.
 * The gesture only takes over when the document is already at the very top,
 * so normal vertical scrolling remains native everywhere else.
 */
export function installIosPullToRefresh(target: Window = window): () => void {
  if (!isTouchMobile(target)) return () => {};

  const indicator = ensureIndicator(target.document);
  const label = indicator.querySelector<HTMLElement>('.ios-pull-refresh-label');
  let startY = 0;
  let pulling = false;
  let refreshing = false;
  let distance = 0;
  let hideTimer: number | null = null;

  const setLabel = (text: string) => {
    if (label) label.textContent = text;
  };

  const reset = () => {
    pulling = false;
    distance = 0;
    if (!refreshing) {
      indicator.classList.remove('visible', 'refreshing');
      indicator.style.transform = '';
      setLabel('Pull to refresh');
    }
  };

  const touchStart = (event: TouchEvent) => {
    if (refreshing || event.touches.length !== 1 || target.scrollY > 0) return;
    startY = event.touches[0].clientY;
    pulling = true;
    distance = 0;
  };

  const touchMove = (event: TouchEvent) => {
    if (!pulling || refreshing || event.touches.length !== 1) return;
    if (target.scrollY > 0) {
      reset();
      return;
    }

    const raw = event.touches[0].clientY - startY;
    if (raw <= 0) {
      reset();
      return;
    }

    // Once a downward gesture begins at scroll-top, own it instead of allowing
    // Safari's browser-level page reload. Resistance keeps the motion iOS-like.
    event.preventDefault();
    distance = Math.min(MAX_PULL, raw * 0.52);
    const progress = Math.min(1, distance / PULL_THRESHOLD);
    const y = -46 + progress * 46;
    indicator.classList.add('visible');
    indicator.style.transform = `translate(-50%, ${y}px) scale(${0.96 + progress * 0.04})`;
    setLabel(distance >= PULL_THRESHOLD ? 'Release to refresh' : 'Pull to refresh');
  };

  const triggerRefresh = () => {
    refreshing = true;
    pulling = false;
    indicator.classList.add('visible', 'refreshing');
    indicator.style.transform = '';
    setLabel('Refreshing…');

    const detail: LiveMutationDetail = {
      book: true,
      dashboard: true,
      topics: [...ALL_LIVE_TOPICS],
      path: '/app/pull-to-refresh',
      method: 'REFRESH',
      at: Date.now(),
    };
    target.dispatchEvent(new CustomEvent<LiveMutationDetail>(LIVE_MUTATION_EVENT, { detail }));

    if (hideTimer !== null) target.clearTimeout(hideTimer);
    hideTimer = target.setTimeout(() => {
      refreshing = false;
      setLabel('Updated');
      hideTimer = target.setTimeout(() => {
        hideTimer = null;
        reset();
      }, 420);
    }, 650);
  };

  const touchEnd = () => {
    if (!pulling || refreshing) return;
    const shouldRefresh = distance >= PULL_THRESHOLD;
    if (shouldRefresh) triggerRefresh();
    else reset();
  };

  target.document.addEventListener('touchstart', touchStart, { passive: true });
  target.document.addEventListener('touchmove', touchMove, { passive: false });
  target.document.addEventListener('touchend', touchEnd, { passive: true });
  target.document.addEventListener('touchcancel', reset, { passive: true });

  return () => {
    if (hideTimer !== null) target.clearTimeout(hideTimer);
    target.document.removeEventListener('touchstart', touchStart);
    target.document.removeEventListener('touchmove', touchMove);
    target.document.removeEventListener('touchend', touchEnd);
    target.document.removeEventListener('touchcancel', reset);
    indicator.remove();
    target.document.getElementById(`${INDICATOR_ID}-styles`)?.remove();
  };
}
