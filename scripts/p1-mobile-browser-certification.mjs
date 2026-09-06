import assert from 'node:assert/strict';

const playwrightModule = process.env.P1_PLAYWRIGHT_MODULE;
const { webkit } = playwrightModule
  ? await import(playwrightModule)
  : await import('playwright');

const baseUrl = process.env.P1_MOBILE_BASE_URL ?? 'http://127.0.0.1:43192';
const username = 'p1-mobile-owner';
const password = 'P1MobileOwner!2026';
const phoneSizes = [
  { name: 'small-phone', width: 320, height: 568 },
  { name: 'iphone-standard', width: 375, height: 812 },
  { name: 'iphone-modern', width: 393, height: 852 },
  { name: 'large-phone', width: 430, height: 932 },
];

const safariUserAgent = 'Mozilla/5.0 (iPhone; CPU iPhone OS 18_0 like Mac OS X) AppleWebKit/605.1.15 (KHTML, like Gecko) Version/18.0 Mobile/15E148 Safari/604.1';

function phoneContext(browser, viewport) {
  return browser.newContext({
    viewport,
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

async function assertNoHorizontalOverflow(page, label) {
  const geometry = await page.evaluate(() => {
    const root = document.documentElement;
    const body = document.body;
    const shell = document.querySelector('.shell');
    const content = document.querySelector('.content');
    const shellRect = shell?.getBoundingClientRect() ?? null;
    const contentRect = content?.getBoundingClientRect() ?? null;
    return {
      innerWidth: window.innerWidth,
      rootScrollWidth: root.scrollWidth,
      bodyScrollWidth: body.scrollWidth,
      shell: shellRect ? { left: shellRect.left, right: shellRect.right, width: shellRect.width } : null,
      content: contentRect ? { left: contentRect.left, right: contentRect.right, width: contentRect.width } : null,
    };
  });

  assert.ok(geometry.rootScrollWidth <= geometry.innerWidth + 2,
    `${label}: document overflows horizontally (${geometry.rootScrollWidth} > ${geometry.innerWidth})`);
  assert.ok(geometry.bodyScrollWidth <= geometry.innerWidth + 2,
    `${label}: body overflows horizontally (${geometry.bodyScrollWidth} > ${geometry.innerWidth})`);
  assert.ok(geometry.shell, `${label}: signed-in shell is missing`);
  assert.ok(geometry.content, `${label}: content region is missing`);
}

async function assertMobileTouchTargets(page, label) {
  const targets = await page.locator('.rail .navbtn').evaluateAll((nodes) => nodes
    .filter((node) => {
      const style = getComputedStyle(node);
      const rect = node.getBoundingClientRect();
      return style.display !== 'none' && style.visibility !== 'hidden' && rect.width > 0 && rect.height > 0;
    })
    .map((node) => {
      const rect = node.getBoundingClientRect();
      return {
        name: node.getAttribute('aria-label') || node.textContent?.trim() || node.tagName,
        width: rect.width,
        height: rect.height,
      };
    }));

  assert.ok(targets.length >= 5, `${label}: expected the mobile navigation controls to be visible`);
  for (const target of targets) {
    assert.ok(target.width >= 44 && target.height >= 44,
      `${label}: touch target ${target.name} is ${target.width.toFixed(1)}x${target.height.toFixed(1)}, below 44x44`);
  }
}

async function assertKeyboardFocus(page, label) {
  await page.locator('body').click({ position: { x: 2, y: 2 } });
  await page.keyboard.press('Tab');
  const focused = await page.evaluate(() => {
    const node = document.activeElement;
    return {
      tag: node?.tagName ?? '',
      label: node?.getAttribute('aria-label') ?? '',
      text: node?.textContent?.trim().slice(0, 80) ?? '',
    };
  });
  assert.notEqual(focused.tag, 'BODY', `${label}: keyboard tab did not move focus into an interactive control`);
}

async function waitForShell(page) {
  await page.locator('.shell').waitFor({ state: 'visible', timeout: 20_000 });
  await page.locator('nav[aria-label="Main navigation"]').waitFor({ state: 'visible' });
}

async function createInitialBook(page) {
  await page.goto(baseUrl, { waitUntil: 'domcontentloaded' });
  await page.locator('#book-username').waitFor({ state: 'visible', timeout: 15_000 });
  await page.locator('#book-username').fill(username);
  await page.locator('#book-password').fill(password);
  await page.getByRole('button', { name: 'Create the book' }).click();
  await waitForShell(page);

  const seeded = await page.evaluate(async () => {
    const headers = { 'content-type': 'application/json', 'x-book': '1' };
    const business = await fetch('/api/businesses', {
      method: 'POST', headers, credentials: 'same-origin', body: JSON.stringify({ name: 'P1 Mobile Business' }),
    });
    if (!business.ok) return { ok: false, stage: 'business', status: business.status, body: await business.text() };
    const businessRow = await business.json();
    const account = await fetch('/api/accounts', {
      method: 'POST', headers, credentials: 'same-origin',
      body: JSON.stringify({ name: 'P1 Mobile Cash', businessId: businessRow.id, opening: 1000 }),
    });
    if (!account.ok) return { ok: false, stage: 'account', status: account.status, body: await account.text() };
    const accountRow = await account.json();
    for (let index = 0; index < 8; index += 1) {
      const entry = await fetch('/api/entries', {
        method: 'POST', headers, credentials: 'same-origin',
        body: JSON.stringify({
          occurredOn: '2026-09-06',
          kind: 'expense',
          amount: 5 + index,
          purpose: `P1 mobile expense ${index + 1}`,
          raw: `P1 mobile expense ${index + 1}`,
          accountId: accountRow.id,
          clientRef: `p1_mobile_entry_${index + 1}`,
        }),
      });
      if (!entry.ok) return { ok: false, stage: 'entry', status: entry.status, body: await entry.text() };
    }
    return { ok: true };
  });
  assert.equal(seeded.ok, true, `Could not seed mobile certification book: ${JSON.stringify(seeded)}`);
  await page.reload({ waitUntil: 'domcontentloaded' });
  await waitForShell(page);
  await page.evaluate(() => navigator.serviceWorker?.ready);
}

async function exerciseNavigation(page, label) {
  const primary = [
    ['Today', 'Financial Book'],
    ['Accounts & loans', 'Accounts & loans'],
    ['Projects', 'Projects'],
    ['People', 'People'],
  ];
  for (const [name] of primary) {
    await page.getByRole('button', { name }).click();
    await page.waitForTimeout(120);
    await assertNoHorizontalOverflow(page, `${label}:${name}`);
  }

  const morePages = [
    'Needs attention',
    'Day report',
    'Approvals',
    'Receipts & files',
    'History',
    'Access',
    'Set it up',
  ];
  for (const name of morePages) {
    await page.getByRole('button', { name: 'More pages' }).click();
    const dialog = page.getByRole('dialog', { name: 'More' });
    await dialog.waitFor({ state: 'visible' });
    await assertNoHorizontalOverflow(page, `${label}:More`);
    await dialog.getByRole('button', { name }).click();
    await page.waitForTimeout(160);
    await assertNoHorizontalOverflow(page, `${label}:${name}`);
  }

  await page.getByRole('button', { name: 'Search' }).click();
  const search = page.getByRole('dialog', { name: 'Search the financial book' });
  await search.waitFor({ state: 'visible' });
  await search.getByRole('combobox', { name: 'Search' }).fill('P1 Mobile Cash');
  await page.waitForTimeout(350);
  assert.ok(await search.getByRole('option').count() > 0, `${label}: global search returned no result`);
  await search.getByRole('button', { name: 'Close search' }).click();

  await page.getByRole('button', { name: 'More pages' }).click();
  const language = page.locator('.moremenu .language-control select');
  await language.selectOption('ar');
  await page.waitForFunction(() => document.documentElement.dir === 'rtl');
  await assertNoHorizontalOverflow(page, `${label}:Arabic RTL`);
  await language.selectOption('en');
  await page.waitForFunction(() => document.documentElement.dir === 'ltr');
  await page.getByRole('button', { name: 'Close More' }).click();

  await page.emulateMedia({ reducedMotion: 'reduce' });
  const reduced = await page.evaluate(() => matchMedia('(prefers-reduced-motion: reduce)').matches);
  assert.equal(reduced, true, `${label}: reduced-motion media preference was not honored`);
  await page.getByRole('button', { name: 'Today' }).click();
  await assertNoHorizontalOverflow(page, `${label}:reduced-motion`);
  await page.emulateMedia({ reducedMotion: 'no-preference' });
}

async function certifyOfflineRestart(context, page) {
  await page.getByRole('button', { name: 'Today' }).click();
  await page.evaluate(() => navigator.serviceWorker?.ready);

  // Treat this like an installed app being killed: destroy the page itself,
  // leave the browser profile (cookies, IndexedDB and service worker) intact,
  // then open a brand-new page after the network is gone.
  await page.close();
  await context.setOffline(true);
  const offlinePage = await context.newPage();
  let offlineNavigationError = null;
  try {
    await offlinePage.goto(baseUrl, { waitUntil: 'domcontentloaded', timeout: 15_000 });
  } catch (error) {
    // WebKit can report an offline navigation error even when the registered
    // service worker fulfilled the request. We only tolerate that protocol
    // error when the fresh page independently proves the signed-in shell loaded.
    offlineNavigationError = error;
  }
  try {
    await waitForShell(offlinePage);
  } catch (shellError) {
    throw offlineNavigationError ?? shellError;
  }
  await offlinePage.getByText(/No signal/i).first().waitFor({ state: 'visible', timeout: 10_000 });
  await assertNoHorizontalOverflow(offlinePage, 'offline-restart');

  await context.setOffline(false);
  await offlinePage.goto(baseUrl, { waitUntil: 'domcontentloaded', timeout: 15_000 });
  await waitForShell(offlinePage);
  await offlinePage.close();
}

const browser = await webkit.launch({ headless: true });
const pageErrors = [];
try {
  const primaryContext = await phoneContext(browser, { width: 393, height: 852 });
  const page = await primaryContext.newPage();
  page.on('pageerror', (error) => pageErrors.push(String(error)));

  await createInitialBook(page);
  await assertNoHorizontalOverflow(page, '393x852:start');
  await assertMobileTouchTargets(page, '393x852:start');
  await assertKeyboardFocus(page, '393x852:start');
  await exerciseNavigation(page, '393x852');
  await certifyOfflineRestart(primaryContext, page);

  const storageState = await primaryContext.storageState();
  await primaryContext.close();

  for (const size of phoneSizes) {
    const context = await browser.newContext({
      viewport: { width: size.width, height: size.height },
      deviceScaleFactor: 3,
      isMobile: true,
      hasTouch: true,
      userAgent: safariUserAgent,
      locale: 'en-US',
      colorScheme: 'light',
      reducedMotion: 'no-preference',
      serviceWorkers: 'allow',
      storageState,
    });
    const phone = await context.newPage();
    phone.on('pageerror', (error) => pageErrors.push(`${size.name}: ${String(error)}`));
    await phone.goto(baseUrl, { waitUntil: 'domcontentloaded' });
    await waitForShell(phone);
    await assertNoHorizontalOverflow(phone, `${size.name}:${size.width}x${size.height}`);
    await assertMobileTouchTargets(phone, `${size.name}:${size.width}x${size.height}`);
    await phone.getByRole('button', { name: 'More pages' }).click();
    await phone.getByRole('dialog', { name: 'More' }).waitFor({ state: 'visible' });
    await assertNoHorizontalOverflow(phone, `${size.name}:More`);
    await phone.getByRole('button', { name: 'Close More' }).click();
    await context.close();
  }

  assert.deepEqual(pageErrors, [], `Browser page errors detected:\n${pageErrors.join('\n')}`);
  console.log(JSON.stringify({
    event: 'p1.mobile.webkit.certified',
    engine: 'webkit',
    touch: true,
    viewports: phoneSizes,
    checks: [
      'signed-in startup',
      'primary navigation',
      'all More pages',
      'global search',
      'Arabic RTL',
      'reduced motion',
      '44px navigation touch targets',
      'horizontal overflow',
      'keyboard focus',
      'installed PWA offline restart',
    ],
  }));
} finally {
  await browser.close();
}
