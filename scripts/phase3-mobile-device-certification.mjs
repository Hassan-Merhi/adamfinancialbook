import assert from 'node:assert/strict';

const playwrightModule = process.env.P1_PLAYWRIGHT_MODULE;
const { webkit } = playwrightModule ? await import(playwrightModule) : await import('playwright');
const baseUrl = process.env.P1_MOBILE_BASE_URL ?? 'http://127.0.0.1:43192';
const username = process.env.PHASE3_MOBILE_USERNAME;
const password = process.env.PHASE3_MOBILE_PASSWORD;
const safariUserAgent = 'Mozilla/5.0 (iPhone; CPU iPhone OS 18_0 like Mac OS X) AppleWebKit/605.1.15 (KHTML, like Gecko) Version/18.0 Mobile/15E148 Safari/604.1';

assert.ok(username && password, 'Phase 3 mobile fixture credentials are required');

async function signIn(page) {
  await page.goto(baseUrl, { waitUntil: 'domcontentloaded' });
  await page.locator('#book-username').fill(username);
  await page.locator('#book-password').fill(password);
  await page.getByRole('button', { name: 'Sign in' }).click();
  await page.locator('.shell').waitFor({ state: 'visible', timeout: 20_000 });
}

async function viewportState(page) {
  return page.evaluate(() => {
    const rail = document.querySelector('.rail')?.getBoundingClientRect();
    const prompt = document.querySelector('.entry input, .entry textarea')?.getBoundingClientRect();
    return {
      width: innerWidth,
      height: innerHeight,
      rootWidth: document.documentElement.scrollWidth,
      bodyWidth: document.body.scrollWidth,
      rail: rail ? { top: rail.top, bottom: rail.bottom } : null,
      prompt: prompt ? { top: prompt.top, bottom: prompt.bottom } : null,
    };
  });
}

async function assertContained(page, label) {
  const state = await viewportState(page);
  assert.ok(state.rootWidth <= state.width + 2, `${label}: root horizontal overflow`);
  assert.ok(state.bodyWidth <= state.width + 2, `${label}: body horizontal overflow`);
  assert.ok(state.rail && state.rail.top >= -2 && state.rail.bottom <= state.height + 2, `${label}: mobile nav escaped viewport`);
  assert.ok(state.prompt && state.prompt.top >= -2 && state.prompt.bottom <= state.height + 2, `${label}: prompt escaped viewport`);
}

async function dispatchTouch(page, type, y) {
  return page.evaluate(({ type, y }) => {
    // WebKit's Touch constructor is not constructible in Playwright's Linux
    // runtime. The app only consumes touches.length/clientY and preventDefault,
    // so use a normal cancelable Event with TouchEvent-compatible properties.
    const point = {
      identifier: 1,
      target: document.body,
      clientX: 120,
      clientY: y,
      screenX: 120,
      screenY: y,
      pageX: 120,
      pageY: y,
    };
    const event = new Event(type, { bubbles: true, cancelable: true });
    const active = type === 'touchend' ? [] : [point];
    Object.defineProperties(event, {
      touches: { value: active },
      targetTouches: { value: active },
      changedTouches: { value: [point] },
    });
    document.dispatchEvent(event);
    return event.defaultPrevented;
  }, { type, y });
}

async function certifyPullRefresh(page) {
  await page.evaluate(() => {
    scrollTo(0, 0);
    window.__phase3Pull = [];
    window.addEventListener('book:live-mutation', (event) => window.__phase3Pull.push(event.detail), { once: true });
  });
  await dispatchTouch(page, 'touchstart', 80);
  assert.equal(await dispatchTouch(page, 'touchmove', 260), true, 'top pull was not captured');
  const indicator = page.locator('#ios-pull-refresh-indicator');
  await indicator.waitFor({ state: 'visible' });
  assert.ok((await indicator.textContent())?.includes('Release to refresh'), 'release state not shown');
  await dispatchTouch(page, 'touchend', 260);
  await page.waitForFunction(() => (window.__phase3Pull ?? []).some((x) => x?.path === '/app/pull-to-refresh'));
  const detail = await page.evaluate(() => window.__phase3Pull[0]);
  assert.equal(detail.book, true);
  assert.equal(detail.dashboard, true);
  assert.deepEqual([...detail.topics].sort(), ['access', 'approvals', 'files', 'history']);
  await page.waitForTimeout(1200);
  assert.ok(!(await indicator.getAttribute('class'))?.includes('refreshing'), 'refresh indicator remained stuck');
}

const browser = await webkit.launch({ headless: true });
const errors = [];
try {
  const context = await browser.newContext({
    viewport: { width: 393, height: 852 }, deviceScaleFactor: 3, isMobile: true, hasTouch: true,
    userAgent: safariUserAgent, locale: 'en-US', serviceWorkers: 'allow',
  });
  const page = await context.newPage();
  page.on('pageerror', (error) => errors.push(String(error)));
  await signIn(page);
  await assertContained(page, 'portrait');

  const prompt = page.locator('.entry input, .entry textarea').first();
  await prompt.tap();
  await prompt.fill('phase 3 mobile keyboard check');
  assert.equal(await prompt.inputValue(), 'phase 3 mobile keyboard check');
  await prompt.fill('');

  await certifyPullRefresh(page);
  await page.setViewportSize({ width: 852, height: 393 });
  await page.waitForTimeout(120);
  await assertContained(page, 'landscape');
  await page.setViewportSize({ width: 393, height: 852 });
  await page.waitForTimeout(120);
  await assertContained(page, 'portrait-after-rotation');

  assert.deepEqual(errors, [], `Phase 3 WebKit errors:\n${errors.join('\n')}`);
  console.log(JSON.stringify({ event: 'phase3.mobile.device.certified', checks: ['pull-to-refresh', 'background revalidation', 'rotation', 'prompt focus', 'viewport containment', 'horizontal overflow'] }));
  await context.close();
} finally {
  await browser.close();
}
