import { expect, test, type BrowserContext, type Page } from '@playwright/test';
import { mkdir, readFile, writeFile } from 'node:fs/promises';

const API_ORIGIN = 'https://accounts.meowpush.com';
const API_PATH = '/api/v1/browser/application-authorization-requests';
const EXAMPLE = '/packages/app-connect/examples/index.html';
const REQUEST_ID = 'A'.repeat(43);
const POLL_SECRET = 'B'.repeat(43);
const PUSH_KEY = `mpap${'0'.repeat(26)}`;
const sourceOrigin = 'http://127.0.0.1:4176';
const evidenceRoot = '/tmp/meowpush-app-connect-browser-qa';
const buttonName = 'Connect MeowPush';
type State = 'pending' | 'approved' | 'rejected' | 'expired' | 'invalidated';

type FixtureOptions = {
  beforeCreate?: () => Promise<void>;
  beforeResult?: () => Promise<void>;
  allowOrigin?: string;
  extraCredential?: boolean;
  coop?: boolean;
  cooperativeClose?: boolean;
};

async function mockAuthorization(context: BrowserContext, options: FixtureOptions = {}) {
  const state = {
    status: 'pending' as State,
    creates: 0,
    polls: 0,
    createFailures: 0,
    resultFailures: 0,
    unexpected: [] as string[],
    createBody: undefined as unknown,
    createHeaders: {} as Record<string, string>,
    pollHeaders: [] as Array<Record<string, string>>,
  };
  await context.route(`${API_ORIGIN}/**`, async (route) => {
    const request = route.request();
    const url = new URL(request.url());
    const cors = {
      'Access-Control-Allow-Origin':
        options.allowOrigin ?? request.headers().origin ?? sourceOrigin,
      'Access-Control-Allow-Methods': 'GET, POST, OPTIONS',
      'Access-Control-Allow-Headers': 'Content-Type, Authorization',
      'Access-Control-Expose-Headers': 'Retry-After',
      Vary: 'Origin',
      'Cache-Control': 'no-store',
    };
    if (request.method() === 'OPTIONS') return route.fulfill({ status: 204, headers: cors });
    if (url.pathname === '/new-app')
      return route.fulfill({
        contentType: 'text/html',
        headers: {
          'Referrer-Policy': 'no-referrer',
          ...(options.coop ? { 'Cross-Origin-Opener-Policy': 'same-origin' } : {}),
        },
        body: `<!doctype html><html lang="en"><head><title>Fixture authorization</title></head><body><h1>Fixture authorization</h1><p>This isolated test page simulates explicit consent.</p><button id="approve">Approve fixture</button><script>document.querySelector('#approve').onclick = async () => { await fetch('/__test__/approve', { method: 'POST' }); document.querySelector('p').textContent = 'Approved'; };${options.cooperativeClose === false ? '' : `window.addEventListener('message', (event) => { if (event.origin === ${JSON.stringify(sourceOrigin)} && event.data !== null && typeof event.data === 'object' && !Array.isArray(event.data) && Object.keys(event.data).length === 2 && event.data.type === 'meowpush:authorization:close' && event.data.version === 1) window.close(); });`}</script></body></html>`,
      });
    if (url.pathname === '/__test__/approve' && request.method() === 'POST') {
      state.status = 'approved';
      return route.fulfill({ status: 204 });
    }
    if (url.pathname === API_PATH && request.method() === 'POST') {
      state.creates++;
      state.createBody = request.postDataJSON();
      state.createHeaders = request.headers();
      await options.beforeCreate?.();
      if (state.createFailures > 0) {
        state.createFailures--;
        return route.fulfill({ status: 503, headers: cors, json: {} });
      }
      return route.fulfill({
        status: 201,
        headers: cors,
        json: {
          request_id: REQUEST_ID,
          authorization_url: `${API_ORIGIN}/new-app?rid=${REQUEST_ID}`,
          poll_secret: POLL_SECRET,
          expires_at: new Date(Date.now() + 600_000).toISOString(),
          poll_interval_seconds: 1,
        },
      });
    }
    if (url.pathname === `${API_PATH}/${REQUEST_ID}/result` && request.method() === 'GET') {
      state.polls++;
      state.pollHeaders.push(request.headers());
      await options.beforeResult?.();
      if (state.resultFailures > 0) {
        state.resultFailures--;
        return route.fulfill({ status: 503, headers: cors, json: {} });
      }
      return route.fulfill({
        headers: cors,
        json: {
          status: state.status,
          result:
            state.status === 'approved'
              ? {
                  push_key: PUSH_KEY,
                  ...(options.extraCredential
                    ? { reauthorization_token: 'must-never-be-delivered' }
                    : {}),
                }
              : null,
          expires_at: new Date(Date.now() + 300_000).toISOString(),
          poll_interval_seconds: 1,
        },
      });
    }
    if (url.pathname === '/favicon.ico') return route.fulfill({ status: 204 });
    state.unexpected.push(url.pathname.replace(REQUEST_ID, '[request]'));
    return route.abort();
  });
  return state;
}

async function openExample(page: Page) {
  await page.goto(EXAMPLE);
  await expect(page).toHaveTitle('MeowPush App Connect example');
  await expect(page.getByRole('heading', { name: 'Notifications' })).toBeVisible();
  await expect(page.getByRole('button', { name: buttonName })).toBeVisible();
  const icon = page.locator('img.mp-connect__icon');
  await expect(icon).toHaveAttribute('src', 'https://meowpush.com/res/appicon/meowpush.png');
  await expect(icon).toHaveAttribute('referrerpolicy', 'no-referrer');
  await expect.poll(() => icon.evaluate((image) => (image as HTMLImageElement).complete && (image as HTMLImageElement).naturalWidth > 0)).toBe(true);
}

async function mountOwnedWindowFixture(page: Page, mode: 'popup' | 'tab' = 'popup') {
  await page.evaluate(async (authorizationMode) => {
    const { mountButton } = await import('/packages/app-connect/dist/ui.js');
    const host = document.createElement('div');
    host.id = 'owned-window-fixture';
    document.querySelector('main')!.append(host);
    const abort = new AbortController();
    const fixture = { abort, deliveries: 0, controller: undefined as any };
    fixture.controller = mountButton(host, {
      application: { name: 'Owned authorization window fixture' },
      locale: 'zh-CN',
      authorization: { mode: authorizationMode },
      signal: abort.signal,
      onSuccess() { fixture.deliveries++; },
    });
    (window as any).__ownedWindowFixture = fixture;
  }, mode);
}

async function audit(page: Page, label: string) {
  const dimensions = await page.evaluate(() => ({
    viewport: document.documentElement.clientWidth,
    content: document.documentElement.scrollWidth,
  }));
  expect(dimensions.content).toBeLessThanOrEqual(dimensions.viewport + 1);
  await expect(page.locator('vite-error-overlay')).toHaveCount(0);
  await mkdir(evidenceRoot, { recursive: true });
  const file = `${evidenceRoot}/${test.info().project.name}-${label}`;
  await writeFile(
    `${file}.json`,
    JSON.stringify(
      { dimensions, title: await page.title(), path: new URL(page.url()).pathname },
      null,
      2,
    ),
  );
  await page.screenshot({ path: `${file}.png`, fullPage: true });
}

function runtimeErrors(page: Page) {
  const messages: string[] = [];
  page.on('pageerror', (error) => messages.push(error.message));
  page.on('console', (message) => {
    if (message.type() === 'error' || message.type() === 'warning') messages.push(message.text());
  });
  return messages;
}

test('script button preopens an isolated window, polls, fills once and leaves saving to the host form', async ({
  page,
  context,
  browserName,
}) => {
  test.skip(
    browserName === 'webkit' && process.platform === 'darwin',
    'This macOS WebKit routes the official authorization path before interception; see /tmp/meowpush-app-connect-browser-qa/webkit-navigation-policy.json.',
  );
  let release!: () => void;
  const gate = new Promise<void>((resolve) => {
    release = resolve;
  });
  const state = await mockAuthorization(context, { beforeCreate: () => gate });
  const errors = runtimeErrors(page);
  await context.addCookies([
    {
      name: 'ambient_fixture',
      value: 'not-a-session',
      domain: 'accounts.meowpush.com',
      path: '/',
      secure: true,
      sameSite: 'None',
    },
  ]);
  await openExample(page);
  await audit(page, 'initial');
  const popupEvent = context.waitForEvent('page');
  const button = page.locator('.mp-connect__button');
  await button.focus();
  await button.press('Enter');
  const popup = await popupEvent;
  expect(popup.url()).toBe('about:blank');
  expect(await popup.evaluate(() => window.opener === null)).toBe(true);
  await expect.poll(() => state.creates).toBe(1);
  await button.dispatchEvent('click');
  release();
  await popup.waitForURL(`${API_ORIGIN}/new-app?rid=${REQUEST_ID}`);
  await expect(page.locator('#push-key')).toHaveValue('');
  await popup.getByRole('button', { name: 'Approve fixture' }).click();
  await expect(page.locator('#push-key')).toHaveValue(PUSH_KEY);
  await expect(page.locator('.mp-connect__status')).toHaveText('Key filled in. Continue saving your form.');
  await expect(button).toBeEnabled();
  await expect(button).toContainText('Connected');
  await expect(page.locator('#saved')).toHaveText('');
  await page.getByRole('button', { name: 'Save settings', exact: true }).click();
  await expect(page.locator('#saved')).toHaveText('Demo settings saved for this page only.');
  expect(state.creates).toBe(1);
  expect(state.createBody).toEqual({
    metadata: {
      name: 'Example Service',
      description: 'Receive a notification when a task finishes',
      website_url: 'https://service.example/',
      icon_url: 'https://service.example/icon.png',
    },
  });
  expect(state.createHeaders.authorization).toBeUndefined();
  expect(state.createHeaders.cookie).toBeUndefined();
  expect(state.createHeaders.referer).toBeUndefined();
  expect(state.pollHeaders.length).toBeGreaterThan(0);
  expect(
    state.pollHeaders.every(
      (headers) =>
        headers.authorization === `Bearer ${POLL_SECRET}` && !headers.cookie && !headers.referer,
    ),
  ).toBe(true);
  const persisted = await page.evaluate(() =>
    JSON.stringify({
      local: { ...localStorage },
      session: { ...sessionStorage },
      html: document.body.innerHTML,
    }),
  );
  for (const secret of [POLL_SECRET, PUSH_KEY]) expect(persisted.includes(secret)).toBe(false);
  expect(state.unexpected).toEqual([]);
  expect(errors).toEqual([]);
  await audit(page, 'filled');
});

test('blocked popups show a private explicit link and keep the same request', async ({
  page,
  context,
  browserName,
}) => {
  test.skip(
    browserName === 'webkit' && process.platform === 'darwin',
    'This macOS WebKit routes the official authorization path before interception; see /tmp/meowpush-app-connect-browser-qa/webkit-navigation-policy.json.',
  );
  const state = await mockAuthorization(context);
  const errors = runtimeErrors(page);
  await page.addInitScript(() => {
    window.open = () => null;
  });
  await openExample(page);
  await page.getByRole('button', { name: buttonName }).click();
  const link = page.getByRole('link', { name: 'Continue authorization', exact: true });
  await expect(link).toBeVisible();
  await expect(link).toHaveAttribute('rel', 'noopener noreferrer');
  await expect(link).toHaveAttribute('referrerpolicy', 'no-referrer');
  expect((await link.getAttribute('href'))?.includes(POLL_SECRET)).toBe(false);
  const popupEvent = context.waitForEvent('page');
  await link.click();
  const popup = await popupEvent;
  await popup.getByRole('button', { name: 'Approve fixture' }).click();
  await expect(page.locator('#push-key')).toHaveValue(PUSH_KEY);
  await expect(link).toBeHidden();
  expect(state.creates).toBe(1);
  expect(errors).toEqual([]);
  await audit(page, 'popup-fallback-complete');
});

test('a closed authorization window can reopen the same invitation without another application request', async ({
  page,
  context,
  browserName,
}) => {
  test.skip(
    browserName === 'webkit' && process.platform === 'darwin',
    'This macOS WebKit routes the official authorization path before interception; see /tmp/meowpush-app-connect-browser-qa/webkit-navigation-policy.json.',
  );
  const state = await mockAuthorization(context);
  await openExample(page);
  const firstEvent = context.waitForEvent('page');
  await page.getByRole('button', { name: buttonName }).click();
  const first = await firstEvent;
  await expect(first.getByRole('button', { name: 'Approve fixture' })).toBeVisible();
  await first.close();
  await expect(page.locator('.mp-connect')).toHaveAttribute('data-state', 'waiting');
  const pollsAfterClosing = state.polls;
  await expect.poll(() => state.polls).toBeGreaterThan(pollsAfterClosing);
  const reopen = page.getByRole('link', { name: 'Reopen authorization', exact: true });
  await expect(reopen).toBeVisible();
  const secondEvent = context.waitForEvent('page');
  await reopen.click();
  const second = await secondEvent;
  await expect(second).toHaveURL(`${API_ORIGIN}/new-app?rid=${REQUEST_ID}`);
  await second.getByRole('button', { name: 'Approve fixture' }).click();
  await expect(page.locator('#push-key')).toHaveValue(PUSH_KEY);
  expect(state.creates).toBe(1);
});

for (const mode of ['popup', 'tab'] as const) {
  test(`cancelling waiting closes the SDK-opened ${mode} through the authorization page close receiver`, async ({ page, context, browserName }) => {
    test.skip(browserName === 'webkit' && process.platform === 'darwin', 'This macOS WebKit cannot navigate the intercepted official authorization path.');
    const state = await mockAuthorization(context);
    const errors = runtimeErrors(page);
    await openExample(page);
    await mountOwnedWindowFixture(page, mode);
    const root = page.locator('#owned-window-fixture .mp-connect');
    const button = root.locator('.mp-connect__button');
    const popupEvent = context.waitForEvent('page');
    await button.click();
    const popup = await popupEvent;
    await expect(popup.getByRole('button', { name: 'Approve fixture' })).toBeVisible();
    await expect.poll(() => state.polls).toBe(1);
    const closed = popup.waitForEvent('close', { timeout: 5_000 });
    await button.click();
    await closed;
    expect(popup.isClosed()).toBe(true);
    await expect(root).toHaveAttribute('data-state', 'idle');
    const pollsAtCancel = state.polls;
    state.status = 'approved';
    await page.waitForTimeout(1_200);
    expect(state.polls).toBe(pollsAtCancel);
    expect(await page.evaluate(() => (window as any).__ownedWindowFixture.deliveries)).toBe(0);
    expect(state.unexpected).toEqual([]);
    expect(errors).toEqual([]);
    await mkdir(evidenceRoot, { recursive: true });
    await writeFile(`${evidenceRoot}/${test.info().project.name}-${mode}-cancellation.json`, JSON.stringify({ popupClosed: popup.isClosed(), waitingCancelled: true, pollingStopped: true, noDelivery: true }));
  });
}

test('cancelling an older authorization page stops waiting when no close receiver is available', async ({ page, context, browserName }) => {
  test.skip(browserName === 'webkit' && process.platform === 'darwin', 'This macOS WebKit cannot navigate the intercepted official authorization path.');
  const state = await mockAuthorization(context, { cooperativeClose: false });
  const errors = runtimeErrors(page);
  await openExample(page);
  await mountOwnedWindowFixture(page);
  const root = page.locator('#owned-window-fixture .mp-connect');
  const popupEvent = context.waitForEvent('page');
  await root.locator('.mp-connect__button').click();
  const popup = await popupEvent;
  await expect(popup.getByRole('button', { name: 'Approve fixture' })).toBeVisible();
  await expect.poll(() => state.polls).toBeGreaterThan(0);
  await root.locator('.mp-connect__button').click();
  await expect(root).toHaveAttribute('data-state', 'idle');
  const pollsAtCancel = state.polls;
  state.status = 'approved';
  await page.waitForTimeout(1_200);
  expect(state.polls).toBe(pollsAtCancel);
  expect(await page.evaluate(() => (window as any).__ownedWindowFixture.deliveries)).toBe(0);
  expect(errors).toEqual([]);
  await mkdir(evidenceRoot, { recursive: true });
  await writeFile(`${evidenceRoot}/${test.info().project.name}-older-page-cancellation.json`, JSON.stringify({ popupClosed: popup.isClosed(), waitingCancelled: true, pollingStopped: true, noDelivery: true }));
});

test('cancelling a COOP-isolated authorization window stops waiting without depending on window closure', async ({ page, context }) => {
  const state = await mockAuthorization(context, { coop: true });
  const errors: string[] = [];
  page.on('pageerror', (error) => errors.push(error.message));
  await openExample(page);
  await mountOwnedWindowFixture(page);
  const root = page.locator('#owned-window-fixture .mp-connect');
  const popupEvent = context.waitForEvent('page');
  await root.locator('.mp-connect__button').click();
  const popup = await popupEvent;
  await expect.poll(() => state.polls).toBeGreaterThan(0);
  await root.locator('.mp-connect__button').click();
  await expect(root).toHaveAttribute('data-state', 'idle');
  const pollsAtCancel = state.polls;
  state.status = 'approved';
  await page.waitForTimeout(1_200);
  expect(state.polls).toBe(pollsAtCancel);
  expect(await page.evaluate(() => (window as any).__ownedWindowFixture.deliveries)).toBe(0);
  expect(errors).toEqual([]);
  await mkdir(evidenceRoot, { recursive: true });
  await writeFile(`${evidenceRoot}/${test.info().project.name}-coop-cancellation.json`, JSON.stringify({ popupClosed: popup.isClosed(), waitingCancelled: true, staleDelivery: false }));
});

test('aborting and destroying after success leave the completed authorization page open', async ({ page, context, browserName }) => {
  test.skip(browserName === 'webkit' && process.platform === 'darwin', 'This macOS WebKit cannot navigate the intercepted official authorization path.');
  const state = await mockAuthorization(context);
  state.status = 'approved';
  await openExample(page);
  await mountOwnedWindowFixture(page);
  const root = page.locator('#owned-window-fixture .mp-connect');
  const popupEvent = context.waitForEvent('page');
  await root.locator('.mp-connect__button').click();
  const popup = await popupEvent;
  await expect(popup.getByRole('button', { name: 'Approve fixture' })).toBeVisible();
  await expect(root).toHaveAttribute('data-state', 'succeeded');
  await expect.poll(() => page.evaluate(() => (window as any).__ownedWindowFixture.deliveries)).toBe(1);
  await page.evaluate(() => {
    (window as any).__ownedWindowFixture.abort.abort();
    (window as any).__ownedWindowFixture.controller.destroy();
  });
  await page.waitForTimeout(150);
  expect(popup.isClosed()).toBe(false);
  await expect(popup.getByRole('button', { name: 'Approve fixture' })).toBeVisible();
  await expect(root).toHaveCount(0);
});

test('cancelling waiting leaves a native fallback-link authorization page open', async ({ page, context, browserName }) => {
  test.skip(browserName === 'webkit' && process.platform === 'darwin', 'This macOS WebKit cannot navigate the intercepted official authorization path.');
  const state = await mockAuthorization(context);
  await page.addInitScript(() => { window.open = () => null; });
  await openExample(page);
  const root = page.locator('.mp-connect');
  await root.locator('.mp-connect__button').click();
  const popupEvent = context.waitForEvent('page');
  await page.getByRole('link', { name: 'Continue authorization', exact: true }).click();
  const popup = await popupEvent;
  await expect(popup.getByRole('button', { name: 'Approve fixture' })).toBeVisible();
  await root.locator('.mp-connect__button').click();
  await expect(root).toHaveAttribute('data-state', 'idle');
  expect(popup.isClosed()).toBe(false);
  expect(state.creates).toBe(1);
});

test('cancel suppresses an in-flight approved result and does not submit or revoke', async ({
  page,
  context,
}) => {
  let release!: () => void;
  const gate = new Promise<void>((resolve) => {
    release = resolve;
  });
  const state = await mockAuthorization(context, { beforeResult: () => gate });
  await page.addInitScript(() => {
    window.open = () => null;
  });
  await openExample(page);
  await page.getByRole('button', { name: buttonName }).click();
  await expect.poll(() => state.polls).toBe(1);
  await page.getByRole('button', { name: 'Cancel waiting', exact: true }).click();
  state.status = 'approved';
  release();
  await expect(page.locator('.mp-connect__status')).toContainText('Stopped waiting');
  await expect(page.locator('#push-key')).toHaveValue('');
  await expect(page.getByRole('button', { name: buttonName })).toBeEnabled();
  expect(state.creates).toBe(1);
  expect(state.unexpected).toEqual([]);
});

test('an unexpected broader credential result is rejected instead of reaching the form', async ({
  page,
  context,
}) => {
  const state = await mockAuthorization(context, { extraCredential: true });
  state.status = 'approved';
  await page.addInitScript(() => {
    window.open = () => null;
  });
  await openExample(page);
  await page.getByRole('button', { name: buttonName }).click();
  await expect(page.locator('.mp-connect__status')).toHaveText('Could not connect. Please retry.');
  await expect(page.locator('#push-key')).toHaveValue('');
  expect(state.creates).toBe(1);
});

test('the browser rejects a mismatched CORS origin without retrying anonymous creation', async ({
  page,
  context,
}) => {
  const state = await mockAuthorization(context, { allowOrigin: 'https://wrong.example' });
  await page.addInitScript(() => {
    window.open = () => null;
  });
  await openExample(page);
  await page.getByRole('button', { name: buttonName }).click();
  await expect(page.locator('.mp-connect__status')).toHaveText('Could not connect. Please retry.');
  await expect(page.locator('#push-key')).toHaveValue('');
  // The browser can reject preflight before POST, or reject the POST response.
  expect(state.creates).toBeLessThanOrEqual(1);
  expect(state.polls).toBe(0);
});

test('COOP window policies do not replace authoritative polling state', async ({
  page,
  context,
}) => {
  const state = await mockAuthorization(context, { coop: true });
  await openExample(page);
  const popupEvent = context.waitForEvent('page');
  await page.getByRole('button', { name: buttonName }).click();
  await popupEvent;
  await expect.poll(() => state.polls).toBeGreaterThan(0);
  await expect(page.locator('.mp-connect__status')).toHaveText('Waiting for authorization…');
  // Approval may occur in the official app even when a window proxy is severed.
  // This deliberately verifies polling independence, not macOS WebKit's
  // official-path navigation policy (also observed without COOP).
  state.status = 'approved';
  await expect(page.locator('#push-key')).toHaveValue(PUSH_KEY);
  expect(state.creates).toBe(1);
});

test('a failed creation shows a temporary red label with the logo, then returns to idle', async ({ page, context }) => {
  const state = await mockAuthorization(context);
  state.createFailures = 1;
  await page.addInitScript(() => { window.open = () => null; });
  await openExample(page);
  const root = page.locator('.mp-connect');
  const button = page.locator('.mp-connect__button');
  await button.click();
  await expect(root).toHaveAttribute('data-state', 'error');
  await expect(button.locator('.mp-connect__face:not(.mp-connect__face--outgoing) img')).toBeVisible();
  await expect(button.locator('.mp-connect__result-icon')).toHaveCount(0);
  await expect(button).not.toContainText('Connect MeowPush');
  await audit(page, 'creation-error');
  await expect(root).toHaveAttribute('data-state', 'idle', { timeout: 5_000 });
  await expect(button).toHaveText('Connect MeowPush');
  await expect(button).toBeEnabled();
  expect(state.creates).toBe(1);
  await button.click();
  await expect(root).toHaveAttribute('data-state', 'waiting');
  expect(state.creates).toBe(2);
  await button.click();
  await expect(root).toHaveAttribute('data-state', 'idle');
});

test('the waiting button cancels, and temporary polling failures preserve its content', async ({ page, context }) => {
  const state = await mockAuthorization(context);
  state.resultFailures = 1;
  await page.addInitScript(() => { window.open = () => null; });
  await openExample(page);
  const root = page.locator('.mp-connect');
  const button = page.locator('.mp-connect__button');
  await button.click();
  await expect.poll(() => state.polls).toBeGreaterThan(0);
  await expect(root).toHaveAttribute('data-state', 'waiting');
  await expect(button).toHaveText('Cancel waiting');
  await expect(button).toBeEnabled();
  await expect(button.locator('.mp-connect__face:not(.mp-connect__face--outgoing) .mp-connect__dot')).toHaveCount(3);
  await expect(page.locator('.mp-connect__status')).not.toContainText('Retrying');
  await audit(page, 'waiting-retry');
  await button.click();
  await expect(root).toHaveAttribute('data-state', 'idle');
  await expect(button).toHaveText('Connect MeowPush');
  expect(state.creates).toBe(1);
  await expect(page.locator('#push-key')).toHaveValue('');
});

test('loading dots orbit horizontally in the XZ plane with a shared fixed vertical center', async ({ page, context }) => {
  await mockAuthorization(context);
  await page.addInitScript(() => { window.open = () => null; });
  await openExample(page);
  const button = page.locator('.mp-connect__button');
  await button.click();
  await expect(page.locator('.mp-connect')).toHaveAttribute('data-state', 'waiting');
  await page.waitForTimeout(350);
  const samples = await button.locator('.mp-connect__face:not(.mp-connect__face--outgoing) .mp-connect__loader').evaluate(async (loader) => {
    const dots = [...loader.children];
    const animations = dots.map((dot) => dot.getAnimations()[0]!);
    animations.forEach((animation) => animation.pause());
    await Promise.all(animations.map((animation) => animation.ready));
    const duration = Number(animations[0]!.effect!.getTiming().duration);
    return Array.from({ length: 12 }, (_, index) => index * duration / 12).map((time) => {
      animations.forEach((animation) => { animation.currentTime = time; });
      return dots.map((dot) => {
        const matrix = new DOMMatrixReadOnly(getComputedStyle(dot).transform);
        const box = dot.getBoundingClientRect();
        return { x: matrix.m41, y: matrix.m42, z: matrix.m43, xyRotation: matrix.m12, yxRotation: matrix.m21, centerY: box.y + box.height / 2, centerX: box.x + box.width / 2 };
      });
    });
  });
  expect(samples).toHaveLength(12);
  const firstFrame = samples[0]!;
  expect(firstFrame).toHaveLength(3);
  expect(firstFrame[0]!.z).toBeGreaterThan(firstFrame[1]!.z);
  expect(firstFrame[0]!.z).toBeGreaterThan(firstFrame[2]!.z);
  for (const frame of samples) {
    expect(new Set(frame.map((dot) => `${dot.x.toFixed(2)}:${dot.z.toFixed(2)}`)).size).toBe(3);
    for (const dot of frame) {
      expect(Math.abs(dot.y)).toBeLessThan(.01);
      expect(Math.abs(dot.xyRotation)).toBeLessThan(.01);
      expect(Math.abs(dot.yxRotation)).toBeLessThan(.01);
      expect(Math.abs(dot.centerY - firstFrame[0]!.centerY)).toBeLessThan(.1);
    }
  }
  // Dots must pass each other around one center, rather than pulse in fixed slots.
  const horizontalOrder = samples.map((frame) => frame[0]!.centerX - frame[1]!.centerX);
  expect(Math.min(...horizontalOrder)).toBeLessThan(-1);
  expect(Math.max(...horizontalOrder)).toBeGreaterThan(1);
  for (let index = 0; index < 3; index++) {
    const points = samples.map((frame) => frame[index]!);
    expect(Math.max(...points.map((dot) => dot.x)) - Math.min(...points.map((dot) => dot.x))).toBeGreaterThan(1);
    expect(Math.max(...points.map((dot) => dot.z)) - Math.min(...points.map((dot) => dot.z))).toBeGreaterThan(1);
  }
  await mkdir(evidenceRoot, { recursive: true });
  await writeFile(`${evidenceRoot}/${test.info().project.name}-loader-xz-samples.json`, JSON.stringify({ samples }, null, 2));
  await button.click();
  await expect(page.locator('.mp-connect')).toHaveAttribute('data-state', 'idle');
});

for (const terminal of ['approved', 'rejected', 'expired', 'invalidated'] as const) {
  test(`terminal ${terminal} is persistent and its next click only resets the button`, async ({ page, context }) => {
    const state = await mockAuthorization(context);
    state.status = terminal;
    await page.addInitScript(() => { window.open = () => null; });
    await openExample(page);
    const root = page.locator('.mp-connect');
    const button = page.locator('.mp-connect__button');
    await button.click();
    await expect(root).toHaveAttribute('data-state', terminal === 'approved' ? 'succeeded' : terminal);
    const current = button.locator('.mp-connect__face:not(.mp-connect__face--outgoing)');
    await expect(current.locator('.mp-connect__result-icon')).toHaveCount(1);
    await expect(button).toBeEnabled();
    if (terminal === 'approved') {
      await expect(button).toHaveText('Connected');
      await expect(page.locator('#push-key')).toHaveValue(PUSH_KEY);
    } else await expect(page.locator('#push-key')).toHaveValue('');
    await audit(page, `terminal-${terminal}`);
    if (terminal === 'rejected') {
      await page.waitForTimeout(3_100);
      await expect(root).toHaveAttribute('data-state', 'rejected');
    }
    await button.click();
    await expect(root).toHaveAttribute('data-state', 'idle');
    await expect(button).toHaveText('Connect MeowPush');
    expect(state.creates).toBe(1);
    state.status = 'pending';
    await button.click();
    await expect(root).toHaveAttribute('data-state', 'waiting');
    expect(state.creates).toBe(2);
    await button.click();
    await expect(root).toHaveAttribute('data-state', 'idle');
  });
}

test('presentation changes crossfade the content while transitioning button dimensions', async ({ page }) => {
  await openExample(page);
  await page.evaluate(async () => {
    const { mountButton } = await import('/packages/app-connect/dist/ui.js');
    const host = document.createElement('div');
    host.id = 'animation-fixture';
    host.style.setProperty('--mp-connect-duration', '400ms');
    host.style.setProperty('--mp-connect-easing', 'linear');
    document.querySelector('main')!.append(host);
    (window as any).__animationButton = mountButton(host, { application: { name: 'Animation fixture' }, locale: 'en', size: 'sm', label: 'Go', onSuccess() {} });
  });
  const button = page.locator('#animation-fixture .mp-connect__button');
  await page.waitForTimeout(450);
  const before = await button.evaluate((element) => { const box = element.getBoundingClientRect(); return { width: box.width, height: box.height }; });
  await page.evaluate(() => (window as any).__animationButton.update({ label: 'Connect to notifications', size: 'md' }));
  await expect(button.locator('.mp-connect__face--outgoing')).toHaveCount(1);
  const transition = await button.evaluate((element) => { const css = getComputedStyle(element); return { property: css.transitionProperty, duration: css.transitionDuration, easing: css.transitionTimingFunction }; });
  expect(transition.property).toContain('width');
  expect(transition.property).toContain('height');
  expect(transition.duration).toContain('0.4s');
  expect(transition.easing).toContain('linear');
  await expect(button.locator('.mp-connect__face:not(.mp-connect__face--outgoing)')).toHaveCSS('animation-duration', '0.4s');
  await page.waitForTimeout(60);
  const middle = await button.evaluate((element) => { const box = element.getBoundingClientRect(); return { width: box.width, height: box.height }; });
  await page.waitForTimeout(500);
  const after = await button.evaluate((element) => { const box = element.getBoundingClientRect(); return { width: box.width, height: box.height }; });
  expect(middle.width).toBeGreaterThan(before.width + 1);
  expect(middle.width).toBeLessThan(after.width - 1);
  expect(middle.height).toBeGreaterThan(before.height + .1);
  expect(middle.height).toBeLessThan(after.height - .1);
  await expect(button.locator('.mp-connect__face--outgoing')).toHaveCount(0);
  await expect(button).toHaveText('Connect to notifications');
  await page.evaluate(() => (window as any).__animationButton.destroy());
});

test('reduced motion keeps all states usable without rotating the loading dots', async ({ page, context }) => {
  await page.emulateMedia({ reducedMotion: 'reduce' });
  const state = await mockAuthorization(context);
  await page.addInitScript(() => { window.open = () => null; });
  await openExample(page);
  const button = page.locator('.mp-connect__button');
  await button.click();
  await expect(page.locator('.mp-connect')).toHaveAttribute('data-state', 'waiting');
  const motion = await button.locator('.mp-connect__face:not(.mp-connect__face--outgoing) .mp-connect__loader').evaluate((element) => ({
    loader: getComputedStyle(element).animationName,
    children: [...element.children].map((child) => getComputedStyle(child).animationName),
    centers: [...element.children].map((child) => { const box = child.getBoundingClientRect(); return { x: box.x + box.width / 2, y: box.y + box.height / 2 }; }),
  }));
  expect(motion.loader).toBe('none');
  expect(motion.children.every((name) => name === 'none')).toBe(true);
  expect(motion.centers).toHaveLength(3);
  expect(motion.centers[0]!.x).toBeLessThan(motion.centers[1]!.x);
  expect(motion.centers[1]!.x).toBeLessThan(motion.centers[2]!.x);
  expect(Math.max(...motion.centers.map((point) => point.y)) - Math.min(...motion.centers.map((point) => point.y))).toBeLessThan(.1);
  await button.click();
  await expect(page.locator('.mp-connect')).toHaveAttribute('data-state', 'idle');
  expect(state.creates).toBe(1);
});

test('headless ESM can use manual authorization without opening a window', async ({
  page,
  context,
}) => {
  const state = await mockAuthorization(context);
  await openExample(page);
  const resultPromise = page.evaluate(async () => {
    const { connect } = await import('/packages/app-connect/dist/index.js');
    let opened = 0;
    const original = window.open;
    window.open = () => {
      opened++;
      return null;
    };
    try {
      const result = await connect({
        application: { name: 'Manual fixture' },
        authorization: { mode: 'manual' },
        onAuthorizationRequired({ url }: { url: string }) {
          const link = document.createElement('a');
          link.id = 'manual-link';
          link.textContent = 'Manual authorization';
          link.href = url;
          link.target = '_blank';
          link.rel = 'noopener noreferrer';
          document.body.append(link);
        },
      });
      return { shape: Object.keys(result), valid: /^mpap/.test(result.pushKey), opened };
    } finally {
      window.open = original;
    }
  });
  await expect(page.locator('#manual-link')).toBeVisible();
  expect(context.pages()).toHaveLength(1);
  state.status = 'approved';
  expect(await resultPromise).toEqual({ shape: ['pushKey'], valid: true, opened: 0 });
  expect(state.creates).toBe(1);
});

// Opt in with MEOWPUSH_LIVE_FIXTURE=/tmp/.../ready.json. This uses isolated real
// Biz/MySQL/Redis, with official API traffic forwarded locally, never production.
test('real Biz approval delivers a key through the built SDK button', async ({ page, context }) => {
  test.skip(
    !process.env.MEOWPUSH_LIVE_FIXTURE,
    'Start the isolated Biz live_browser_fixture and provide its ready.json.',
  );
  const fixture = JSON.parse(await readFile(process.env.MEOWPUSH_LIVE_FIXTURE!, 'utf8'));
  let requestId: string | undefined;
  let pendingSeen = false;
  const errors = runtimeErrors(page);
  await context.route(`${API_ORIGIN}/**`, async (route) => {
    const request = route.request();
    const url = new URL(request.url());
    if (url.pathname === '/new-app')
      return route.fulfill({
        contentType: 'text/html',
        body: '<!doctype html><html lang="en"><title>Isolated Biz approval fixture</title><h1>Isolated Biz approval fixture</h1><p>Approval is performed with the fixture account in this test.</p></html>',
      });
    if (url.pathname === '/favicon.ico') return route.fulfill({ status: 204 });
    if (!url.pathname.startsWith(API_PATH)) return route.abort();
    const response = await route.fetch({
      url: `${fixture.base_url}${url.pathname}${url.search}`,
      headers: request.headers(),
    });
    if (request.method() !== 'OPTIONS') {
      const body = await response.json();
      if (request.method() === 'POST' && response.status() === 201) requestId = body.request_id;
      if (request.method() === 'GET' && body.status === 'pending') pendingSeen = true;
    }
    return route.fulfill({ response });
  });
  await openExample(page);
  const popupEvent = context.waitForEvent('page');
  await page.getByRole('button', { name: buttonName }).click();
  await popupEvent;
  await expect.poll(() => Boolean(requestId)).toBe(true);
  await expect.poll(() => pendingSeen).toBe(true);
  const authorization = { Authorization: `Bearer ${fixture.session}` };
  const reviewResponse = await context.request.get(
    `${fixture.base_url}/api/v1/application-authorization-requests/${requestId}/review`,
    { headers: authorization },
  );
  expect(reviewResponse.status()).toBe(200);
  const review = await reviewResponse.json();
  expect(review.request.delivery_profile).toBe('browser_key');
  expect(review.request.request_origin).toBe(sourceOrigin);
  const approval = await context.request.post(
    `${fixture.base_url}/api/v1/application-authorization-requests/${requestId}/approve`,
    {
      headers: authorization,
      data: {
        action: 'create',
        metadata: review.proposed_metadata,
        targets: { device_public_ids: [fixture.device], group_public_ids: [] },
      },
    },
  );
  expect(approval.status()).toBe(200);
  await expect(page.locator('.mp-connect__status')).toHaveText('Key filled in. Continue saving your form.');
  expect(
    await page
      .locator('#push-key')
      .evaluate((element) =>
        /^mpap[0-9a-hjkmnp-tv-z]{26}$/.test((element as HTMLInputElement).value),
      ),
  ).toBe(true);
  expect(await page.evaluate(() => localStorage.length + sessionStorage.length)).toBe(0);
  expect(errors).toEqual([]);
  await audit(page, 'real-biz-filled');
});

test('real Biz CORS permits direct browser preflight and bearer polling across local ports', async ({
  page,
}) => {
  test.skip(
    !process.env.MEOWPUSH_LIVE_FIXTURE,
    'Start the isolated Biz live_browser_fixture and provide its ready.json.',
  );
  const fixture = JSON.parse(await readFile(process.env.MEOWPUSH_LIVE_FIXTURE!, 'utf8'));
  const corsResponses: Array<{ method: string; status: number; origin: string | undefined }> = [];
  page.on('response', (response) => {
    if (response.url().startsWith(`${fixture.base_url}${API_PATH}`))
      corsResponses.push({
        method: response.request().method(),
        status: response.status(),
        origin: response.headers()['access-control-allow-origin'],
      });
  });
  const errors = runtimeErrors(page);
  await page.goto('/__test__/cors.html');
  const result = await page.evaluate(
    async ({ base, path }) => {
      const created = await fetch(`${base}${path}`, {
        method: 'POST',
        credentials: 'omit',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ metadata: { name: 'Direct browser CORS fixture' } }),
      });
      if (created.status !== 201) return { createdStatus: created.status };
      const request = await created.json();
      const response = await fetch(
        `${base}${path}/${encodeURIComponent(request.request_id)}/result`,
        {
          credentials: 'omit',
          headers: { Authorization: `Bearer ${request.poll_secret}` },
        },
      );
      const result = await response.json();
      return {
        createdStatus: created.status,
        createdType: created.type,
        resultStatus: response.status,
        resultType: response.type,
        pending: result.status === 'pending',
        noCredentials: result.result === null,
      };
    },
    { base: fixture.base_url, path: API_PATH },
  );
  expect(result).toEqual({
    createdStatus: 201,
    createdType: 'cors',
    resultStatus: 200,
    resultType: 'cors',
    pending: true,
    noCredentials: true,
  });
  expect(corsResponses.filter((response) => response.method !== 'OPTIONS')).toEqual([
    { method: 'POST', status: 201, origin: sourceOrigin },
    { method: 'GET', status: 200, origin: sourceOrigin },
  ]);
  expect(errors).toEqual([]);
});
