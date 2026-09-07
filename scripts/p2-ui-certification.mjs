import assert from 'node:assert/strict';

const playwrightModule = process.env.P1_PLAYWRIGHT_MODULE;
const { webkit } = playwrightModule
  ? await import(playwrightModule)
  : await import('playwright');

const baseUrl = process.env.P1_MOBILE_BASE_URL ?? 'http://127.0.0.1:43192';
const username = 'p1-mobile-owner';
const password = 'P1MobileOwner!2026';
const safariUserAgent = 'Mozilla/5.0 (iPhone; CPU iPhone OS 18_0 like Mac OS X) AppleWebKit/605.1.15 (KHTML, like Gecko) Version/18.0 Mobile/15E148 Safari/604.1';

function createContext(browser, width, height) {
  return browser.newContext({
    viewport: { width, height },
    deviceScaleFactor: 3,
    isMobile: true,
    hasTouch: true,
    userAgent: safariUserAgent,
    locale: 'en-US',
    colorScheme: 'light',
    reducedMotion: 'no-preference',
    serviceWorkers: 'allow',
  });
}

async function signIn(page) {
  await page.goto(baseUrl, { waitUntil: 'domcontentloaded' });
  await page.locator('#book-username').waitFor({ state: 'visible', timeout: 15_000 });
  await page.locator('#book-username').fill(username);
  await page.locator('#book-password').fill(password);
  await page.getByRole('button', { name: 'Sign in' }).click();
  await page.locator('.shell').waitFor({ state: 'visible', timeout: 20_000 });
}

async function assertNoHorizontalOverflow(page, label) {
  const geometry = await page.evaluate(() => ({
    innerWidth: window.innerWidth,
    root: document.documentElement.scrollWidth,
    body: document.body.scrollWidth,
  }));
  assert.ok(geometry.root <= geometry.innerWidth + 2,
    `${label}: document horizontal overflow (${geometry.root} > ${geometry.innerWidth})`);
  assert.ok(geometry.body <= geometry.innerWidth + 2,
    `${label}: body horizontal overflow (${geometry.body} > ${geometry.innerWidth})`);
}

async function assertCoreTouchTargets(page, label) {
  const selector = [
    '.rail .navbtn',
    '.btn',
    '.search-trigger',
    '.moreitem',
    '.moremenu-close',
    '.more-signout',
    '.moreutility',
    '.phase5-mobile-menu button',
    '.reset-option',
  ].join(',');
  const targets = await page.locator(selector).evaluateAll((nodes) => nodes
    .filter((node) => {
      const style = getComputedStyle(node);
      const rect = node.getBoundingClientRect();
      return style.display !== 'none' && style.visibility !== 'hidden' && rect.width > 0 && rect.height > 0;
    })
    .map((node) => {
      const rect = node.getBoundingClientRect();
      return {
        name: node.getAttribute('aria-label') || node.textContent?.trim().replace(/\s+/g, ' ').slice(0, 80) || node.tagName,
        width: rect.width,
        height: rect.height,
      };
    }));

  assert.ok(targets.length >= 5, `${label}: expected core mobile controls`);
  for (const target of targets) {
    assert.ok(target.height >= 43.5,
      `${label}: ${target.name} is only ${target.height.toFixed(1)}px high`);
  }
}

async function assertNamedVisibleFields(page, label) {
  const unnamed = await page.locator('input:visible, select:visible, textarea:visible').evaluateAll((nodes) => nodes
    .filter((node) => {
      const aria = node.getAttribute('aria-label')?.trim();
      const labelledBy = node.getAttribute('aria-labelledby')?.trim();
      const id = node.id;
      const explicitLabel = id ? document.querySelector(`label[for="${CSS.escape(id)}"]`) : null;
      const implicitLabel = node.closest('label');
      return !aria && !labelledBy && !explicitLabel && !implicitLabel;
    })
    .map((node) => ({
      tag: node.tagName,
      placeholder: node.getAttribute('placeholder') || '',
      className: node.getAttribute('class') || '',
    })));
  assert.deepEqual(unnamed, [], `${label}: visible form fields without accessible names: ${JSON.stringify(unnamed)}`);
}

async function assertDrawerFits(page, label) {
  await page.getByRole('button', { name: 'More pages' }).click();
  const dialog = page.getByRole('dialog', { name: 'More' });
  await dialog.waitFor({ state: 'visible' });
  const box = await dialog.boundingBox();
  assert.ok(box, `${label}: More dialog has no layout box`);
  const viewport = page.viewportSize();
  assert.ok(viewport, `${label}: viewport missing`);
  assert.ok(box.y >= -1, `${label}: More dialog starts above viewport`);
  assert.ok(box.y + box.height <= viewport.height + 2,
    `${label}: More dialog extends below viewport (${box.y + box.height} > ${viewport.height})`);
  await assertNoHorizontalOverflow(page, `${label}:More`);
  await page.getByRole('button', { name: 'Close More' }).click();
}

async function openMorePage(page, name) {
  await page.getByRole('button', { name: 'More pages' }).click();
  const dialog = page.getByRole('dialog', { name: 'More' });
  await dialog.waitFor({ state: 'visible' });
  await dialog.getByRole('button', { name }).click();
  await page.waitForTimeout(140);
}

async function certifyMainFlows(page, label) {
  const entryInput = page.locator('.entry input').first();
  await entryInput.waitFor({ state: 'visible' });
  const entryBox = await entryInput.boundingBox();
  const viewport = page.viewportSize();
  assert.ok(entryBox && viewport, `${label}: primary prompt has no layout box`);
  // The prompt is intentionally a bottom-docked composer on phones. “Prompt
  // first” means it is always immediately reachable without scrolling, not
  // that it must occupy the top half of the screen.
  assert.ok(entryBox.y >= -1 && entryBox.y + entryBox.height <= viewport.height + 2,
    `${label}: primary prompt is not fully visible inside the viewport`);
  assert.ok(entryBox.height >= 43.5, `${label}: primary prompt is below the mobile control-height target`);

  for (const name of ['Today', 'Accounts & loans', 'Projects', 'People']) {
    await page.getByRole('button', { name }).click();
    await page.waitForTimeout(120);
    await assertNoHorizontalOverflow(page, `${label}:${name}`);
    await assertCoreTouchTargets(page, `${label}:${name}`);
    await assertNamedVisibleFields(page, `${label}:${name}`);
  }

  for (const name of ['Needs attention', 'Day report', 'Approvals', 'Receipts & files', 'History', 'Access', 'Set it up']) {
    await openMorePage(page, name);
    await assertNoHorizontalOverflow(page, `${label}:${name}`);
    await assertCoreTouchTargets(page, `${label}:${name}`);
    await assertNamedVisibleFields(page, `${label}:${name}`);
  }

  // Access and Setup have dense mobile section menus. Prove they remain usable
  // as one-section-at-a-time navigation rather than a long desktop page.
  await openMorePage(page, 'Access');
  const accessMenu = page.getByRole('navigation', { name: 'Access sections' });
  await accessMenu.waitFor({ state: 'visible' });
  assert.ok(await accessMenu.getByRole('button').count() >= 2, `${label}: Access mobile menu missing`);

  await openMorePage(page, 'Set it up');
  const setupMenu = page.getByRole('navigation', { name: 'Setup sections' });
  await setupMenu.waitFor({ state: 'visible' });
  assert.ok(await setupMenu.getByRole('button').count() >= 7, `${label}: Setup mobile menu missing`);
  await setupMenu.getByRole('button', { name: /Reset data/i }).click();
  await page.waitForTimeout(80);
  const resetOption = page.getByRole('button', { name: /Clear activity/i });
  await resetOption.waitFor({ state: 'visible' });
  await resetOption.click();
  const destructive = page.locator('.reset-danger');
  await destructive.waitFor({ state: 'visible' });
  const dangerStyles = await destructive.evaluate((node) => {
    const style = getComputedStyle(node);
    return { color: style.color, background: style.backgroundColor, minHeight: style.minHeight };
  });
  assert.notEqual(dangerStyles.color, dangerStyles.background,
    `${label}: destructive action does not have a distinct visual treatment`);
  await assertNamedVisibleFields(page, `${label}:Reset confirmation`);

  await page.getByRole('button', { name: 'More pages' }).click();
  const more = page.getByRole('dialog', { name: 'More' });
  const appearance = more.getByRole('button', { name: /Appearance/i });
  await appearance.click();
  await page.getByRole('button', { name: 'Today' }).click();
  await assertNoHorizontalOverflow(page, `${label}:dark-mode`);
  await assertCoreTouchTargets(page, `${label}:dark-mode`);
}

const browser = await webkit.launch({ headless: true });
const errors = [];
try {
  for (const viewport of [
    { width: 320, height: 568, name: 'small-phone' },
    { width: 393, height: 852, name: 'iphone-modern' },
    { width: 430, height: 932, name: 'large-phone' },
  ]) {
    const context = await createContext(browser, viewport.width, viewport.height);
    const page = await context.newPage();
    page.on('pageerror', (error) => errors.push(`${viewport.name}: ${String(error)}`));
    await signIn(page);
    await assertNoHorizontalOverflow(page, `${viewport.name}:startup`);
    await assertCoreTouchTargets(page, `${viewport.name}:startup`);
    await assertNamedVisibleFields(page, `${viewport.name}:startup`);
    await assertDrawerFits(page, viewport.name);
    await certifyMainFlows(page, viewport.name);
    await context.close();
  }

  assert.deepEqual(errors, [], `P2 WebKit page errors:\n${errors.join('\n')}`);
  console.log(JSON.stringify({
    event: 'p2.ui.certified',
    engine: 'webkit',
    viewports: ['320x568', '393x852', '430x932'],
    checks: [
      'primary prompt fully visible without scrolling',
      'all primary and More pages',
      '44px core touch targets',
      'no horizontal overflow',
      'screen-reader names for visible fields',
      'mobile Access and Setup section navigation',
      'destructive action treatment',
      'drawer viewport containment',
      'dark-mode layout',
      'unhandled WebKit page errors',
    ],
  }));
} finally {
  await browser.close();
}
