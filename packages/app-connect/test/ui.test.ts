import { beforeEach, afterEach, expect, it, vi } from 'vitest';
import { mountButton } from '../src/ui.js';
const RID = 'A'.repeat(43); const SECRET = 'B'.repeat(43); const KEY = 'mpap' + 'a'.repeat(26);
const buttonLabel = () => document.querySelector('.mp-connect__face:not(.mp-connect__face--outgoing) .mp-connect__label')!.textContent;
const json = (body: unknown, status = 200) => new Response(JSON.stringify(body), { status, headers: { 'Content-Type': 'application/json' } });
const created = () => json({ request_id: RID, poll_secret: SECRET, authorization_url: `https://accounts.meowpush.com/new-app?rid=${RID}`, expires_at: new Date(Date.now() + 600_000).toISOString(), poll_interval_seconds: 2 }, 201);
const result = () => json({ status: 'approved', result: { push_key: KEY }, expires_at: new Date(Date.now() + 300_000).toISOString(), poll_interval_seconds: 2 });
beforeEach(() => {
  vi.useFakeTimers(); document.body.innerHTML = '<form><input id="key"><div id="button"></div><p id="existing">Existing content</p></form>';
  vi.spyOn(window, 'open').mockReturnValue(null);
  vi.spyOn(Storage.prototype, 'setItem');
  vi.spyOn(navigator, 'languages', 'get').mockReturnValue(['en-US']);
  vi.spyOn(navigator, 'language', 'get').mockReturnValue('en-US');
  vi.stubGlobal('fetch', vi.fn().mockResolvedValueOnce(created()).mockResolvedValueOnce(result()));
});
afterEach(() => { vi.useRealTimers(); vi.unstubAllGlobals(); vi.restoreAllMocks(); });
it('renders a native button, handles fallback and double clicks, delivers once without submitting', async () => {
  const success = vi.fn(); const submit = vi.fn(); document.querySelector('form')!.addEventListener('submit', submit);
  mountButton('#button', { application: { name: 'Example' }, locale: 'zh-CN', onSuccess: success });
  const button = document.querySelector<HTMLButtonElement>('.mp-connect__button')!;
  expect(button.type).toBe('button'); expect(buttonLabel()).toBe('连接喵 Push'); expect(button.getAttribute('aria-label')).toBe('连接喵 Push');
  button.click(); button.click(); await vi.advanceTimersByTimeAsync(0);
  const link = document.querySelector<HTMLAnchorElement>('.mp-connect__link')!;
  expect(link.hidden).toBe(false); expect(link.rel).toBe('noopener noreferrer'); expect(link.href).not.toContain(SECRET);
  expect(globalThis.fetch).toHaveBeenCalledTimes(1);
  await vi.advanceTimersByTimeAsync(2000);
  expect(success).toHaveBeenCalledExactlyOnceWith({ pushKey: KEY }); expect(submit).not.toHaveBeenCalled();
  expect(button.disabled).toBe(false); expect(buttonLabel()).toBe('已连接'); expect(link.hasAttribute('href')).toBe(false);
  expect(document.body.innerHTML).not.toContain(KEY); expect(document.body.innerHTML).not.toContain(SECRET);
  expect(Storage.prototype.setItem).not.toHaveBeenCalled();
});
it('destroy aborts the operation, removes only its nodes and prevents delivery', async () => {
  const success = vi.fn(); const handle = mountButton('#button', { application: { name: 'Example' }, onSuccess: success });
  document.querySelector<HTMLButtonElement>('.mp-connect__button')!.click(); await vi.advanceTimersByTimeAsync(0);
  handle.destroy(); await vi.advanceTimersByTimeAsync(5000);
  expect(success).not.toHaveBeenCalled(); expect(document.querySelector('.mp-connect')).toBeNull(); expect(document.querySelector('#existing')).not.toBeNull(); expect(globalThis.fetch).toHaveBeenCalledTimes(1);
});
it('a throwing success callback needs an explicit reset before another creation', async () => {
  const success = vi.fn(() => { throw new Error('host callback failed'); }); const error = vi.fn();
  mountButton('#button', { application: { name: 'Example' }, onSuccess: success, onError: error });
  const button = document.querySelector<HTMLButtonElement>('.mp-connect__button')!; button.click(); await vi.advanceTimersByTimeAsync(2000);
  button.click(); await vi.advanceTimersByTimeAsync(10_000);
  expect(success).toHaveBeenCalledTimes(1); expect(error).toHaveBeenCalledWith(expect.objectContaining({ code: 'callback_error' })); expect(globalThis.fetch).toHaveBeenCalledTimes(2); expect(button.disabled).toBe(false);
});
it('renders a user-supplied label as text, not HTML', () => {
  mountButton('#button', { application: { name: 'X' }, label: '<img src=x onerror=alert(1)>', onSuccess() {} });
  expect(document.querySelectorAll('.mp-connect img')).toHaveLength(1);
  expect(document.querySelector<HTMLImageElement>('.mp-connect img')!.src).toBe('https://meowpush.com/res/appicon/meowpush.png');
  expect(document.querySelector('.mp-connect__button')!.textContent).toContain('<img');
});

it('keeps the same invitation available after a successfully opened popup closes', async () => {
  const doc = document.implementation.createHTMLDocument('');
  const location = { href: 'about:blank', replace: vi.fn((url: string) => { location.href = url; }) };
  const popup = { document: doc, location, opener: {}, closed: false, close: vi.fn() };
  vi.mocked(window.open).mockReturnValue(popup as unknown as Window);
  const success = vi.fn();
  mountButton('#button', { application: { name: 'Example' }, locale: 'zh-CN', onSuccess: success });
  document.querySelector<HTMLButtonElement>('.mp-connect__button')!.click();
  await vi.advanceTimersByTimeAsync(0);
  popup.closed = true;
  const link = document.querySelector<HTMLAnchorElement>('.mp-connect__link')!;
  expect(link.hidden).toBe(false); expect(link.textContent).toBe('重新打开授权页');
  expect(link.href).toBe(`https://accounts.meowpush.com/new-app?rid=${RID}`);
  expect(globalThis.fetch).toHaveBeenCalledTimes(1);
  await vi.advanceTimersByTimeAsync(2000);
  expect(success).toHaveBeenCalledTimes(1); expect(globalThis.fetch).toHaveBeenCalledTimes(2);
});

it('handles an asynchronously rejected success callback without replaying delivery', async () => {
  const success = vi.fn(async () => { await Promise.resolve(); throw new Error('private host failure'); }); const error = vi.fn();
  mountButton('#button', { application: { name: 'Example' }, onSuccess: success, onError: error });
  const button = document.querySelector<HTMLButtonElement>('.mp-connect__button')!; button.click();
  await vi.advanceTimersByTimeAsync(2000);
  button.click(); await vi.advanceTimersByTimeAsync(10_000);
  expect(success).toHaveBeenCalledTimes(1); expect(error).toHaveBeenCalledWith(expect.objectContaining({ code: 'callback_error' }));
  expect(globalThis.fetch).toHaveBeenCalledTimes(2); expect(button.disabled).toBe(false);
  expect(document.body.textContent).not.toContain('private host failure');
});

it('isolates asynchronously rejecting state and error observers', async () => {
  const fail = vi.fn(async () => { throw new Error('observer failure'); });
  mountButton('#button', { application: { name: 'Example' }, onStateChange: fail, onError: fail, onSuccess: async () => { throw new Error('host'); } });
  document.querySelector<HTMLButtonElement>('.mp-connect__button')!.click();
  await vi.advanceTimersByTimeAsync(2000);
  expect(fail).toHaveBeenCalled(); expect(globalThis.fetch).toHaveBeenCalledTimes(2);
});

it('uses the fixed official PNG with stable dimensions and survives image failure', async () => {
  const success = vi.fn();
  mountButton('#button', { application: { name: 'Example' }, onSuccess: success });
  const icon = document.querySelector<HTMLImageElement>('img.mp-connect__icon')!;
  expect(icon.src).toBe('https://meowpush.com/res/appicon/meowpush.png');
  expect(icon.width).toBe(21); expect(icon.height).toBe(21);
  expect(icon.alt).toBe(''); expect(icon.getAttribute('aria-hidden')).toBe('true');
  expect(icon.referrerPolicy).toBe('no-referrer');
  icon.dispatchEvent(new Event('error'));
  expect(icon.dataset.failed).toBe('true'); expect(icon.hidden).toBe(false);
  document.querySelector<HTMLButtonElement>('.mp-connect__button')!.click();
  await vi.advanceTimersByTimeAsync(2000);
  expect(success).toHaveBeenCalledExactlyOnceWith({ pushKey: KEY });
  expect(icon.width).toBe(21); expect(icon.height).toBe(21);
});

it('updates waiting and completed presentation without changing the request or delivered form value', async () => {
  const input = document.querySelector<HTMLInputElement>('#key')!; input.value = 'existing';
  const success = vi.fn(({ pushKey }: { pushKey: string }) => { input.value = pushKey; });
  const state = vi.fn();
  const handle = mountButton('#button', { application: { name: 'Example' }, locale: 'zh-CN', onSuccess: success, onStateChange: state });
  const button = document.querySelector<HTMLButtonElement>('.mp-connect__button')!;
  button.click(); await vi.advanceTimersByTimeAsync(0);
  const link = document.querySelector<HTMLAnchorElement>('.mp-connect__link')!;
  const invitation = link.href; const count = state.mock.calls.length;
  handle.update({ locale: 'en', theme: 'dark', size: 'sm', label: 'Notify me' });
  expect(buttonLabel()).toBe('Cancel waiting'); expect(button.getAttribute('aria-label')).toBe('Cancel waiting');
  expect(document.querySelector('.mp-connect__status')!.textContent).toBe('Waiting for authorization…');
  expect(link.textContent).toBe('Continue authorization'); expect(link.href).toBe(invitation);
  expect(document.querySelector<HTMLElement>('.mp-connect')!.dataset).toMatchObject({ theme: 'dark', size: 'sm' });
  expect(input.value).toBe('existing'); expect(globalThis.fetch).toHaveBeenCalledTimes(1); expect(state).toHaveBeenCalledTimes(count);
  await vi.advanceTimersByTimeAsync(2000);
  handle.update({ locale: 'zh-CN', theme: 'light', size: 'md' });
  expect(input.value).toBe(KEY); expect(success).toHaveBeenCalledTimes(1); expect(globalThis.fetch).toHaveBeenCalledTimes(2);
  expect(buttonLabel()).toBe('已连接'); expect(button.getAttribute('aria-label')).toBe('已连接喵 Push，点击重置'); expect(button.disabled).toBe(false);
  expect(document.querySelector('.mp-connect__status')!.textContent).toBe('已填入，请继续保存表单。');
});

it('follows languagechange in automatic mode and restores defaults using explicit undefined', () => {
  let languages = ['fr-FR', 'zh-CN'];
  vi.spyOn(navigator, 'languages', 'get').mockImplementation(() => languages);
  const handle = mountButton('#button', { application: { name: 'Example' }, onSuccess() {} });
  const root = document.querySelector<HTMLElement>('.mp-connect')!;
  const button = document.querySelector<HTMLButtonElement>('.mp-connect__button')!;
  expect(buttonLabel()).toBe('连接喵 Push'); expect(root.lang).toBe('zh-CN'); expect(root.dataset.theme).toBe('auto');
  languages = ['zh-Hant', 'en-US']; window.dispatchEvent(new Event('languagechange'));
  expect(buttonLabel()).toBe('Connect MeowPush'); expect(root.lang).toBe('en');
  handle.update({ locale: 'zh-CN', theme: 'dark', size: 'sm', label: 'Custom' });
  window.dispatchEvent(new Event('languagechange'));
  expect(buttonLabel()).toBe('Custom'); expect(root.lang).toBe('zh-CN');
  handle.update({ locale: undefined, theme: undefined, size: undefined, label: undefined });
  expect(buttonLabel()).toBe('Connect MeowPush'); expect(root.dataset).toMatchObject({ theme: 'auto', size: 'md' }); expect(root.lang).toBe('en');
  languages = ['zh-CN']; window.dispatchEvent(new Event('languagechange')); expect(buttonLabel()).toBe('连接喵 Push');
  expect(globalThis.fetch).not.toHaveBeenCalled();
});

it('keeps specific error messages localized during updates', async () => {
  vi.mocked(globalThis.fetch).mockReset().mockResolvedValueOnce(json({}, 503));
  const error = vi.fn(); const handle = mountButton('#button', { application: { name: 'Example' }, locale: 'en', onSuccess() {}, onError: error });
  document.querySelector<HTMLButtonElement>('.mp-connect__button')!.click(); await vi.advanceTimersByTimeAsync(0);
  expect(document.querySelector('.mp-connect__status')!.textContent).toBe('MeowPush is temporarily unavailable. Please try later.');
  handle.update({ locale: 'zh-CN' });
  expect(document.querySelector('.mp-connect__status')!.textContent).toBe('MeowPush 暂时不可用，请稍后重试。');
  expect(error).toHaveBeenCalledTimes(1); expect(globalThis.fetch).toHaveBeenCalledTimes(1);
});

it('retranslates callback failures while retaining the completed state', async () => {
  const handle = mountButton('#button', { application: { name: 'Example' }, locale: 'en', onSuccess: async () => { throw new Error('host failure'); } });
  const button = document.querySelector<HTMLButtonElement>('.mp-connect__button')!;
  button.click(); await vi.advanceTimersByTimeAsync(2000);
  handle.update({ locale: 'zh-CN' });
  expect(document.querySelector('.mp-connect__status')!.textContent).toBe('已取得密钥，但表单处理失败。请联系此页面的维护者。');
  expect(button.disabled).toBe(false); expect(buttonLabel()).toBe('表单处理失败'); expect(globalThis.fetch).toHaveBeenCalledTimes(2);
});

it('validates presentation patches atomically and removes language listeners on destroy', () => {
  const remove = vi.spyOn(window, 'removeEventListener');
  const handle = mountButton('#button', { application: { name: 'Example' }, locale: 'en', onSuccess() {} });
  expect(() => handle.update({ theme: 'dark', locale: 'fr' } as never)).toThrow('invalid_options');
  expect(document.querySelector<HTMLElement>('.mp-connect')!.dataset.theme).toBe('auto');
  expect(() => handle.update({ application: { name: 'Other' } } as never)).toThrow('invalid_options');
  expect(() => handle.update({ label: '' })).toThrow('invalid_options');
  handle.destroy();
  expect(remove).toHaveBeenCalledWith('languagechange', expect.any(Function));
  handle.update({ locale: 'zh-CN' }); window.dispatchEvent(new Event('languagechange'));
  expect(document.querySelector('.mp-connect')).toBeNull(); expect(globalThis.fetch).not.toHaveBeenCalled();
});

it('shows a safe creation error with the logo, then restores the custom idle label after three seconds', async () => {
  vi.mocked(fetch).mockReset().mockRejectedValueOnce(new Error('private request details'));
  const error = vi.fn();
  const handle = mountButton('#button', { application: { name: 'Example' }, locale: 'zh-CN', label: '连接通知', onSuccess() {}, onError: error });
  const button = document.querySelector<HTMLButtonElement>('.mp-connect__button')!;
  button.click(); await vi.advanceTimersByTimeAsync(0);
  expect(buttonLabel()).toBe('网络连接失败'); expect(button.disabled).toBe(true);
  expect(document.querySelector('.mp-connect__face:not(.mp-connect__face--outgoing) img')).not.toBeNull();
  expect(document.querySelector('.mp-connect__result-icon')).toBeNull();
  expect(document.body.textContent).not.toContain('private request details');
  handle.update({ locale: 'en' }); expect(buttonLabel()).toBe('Network error');
  await vi.advanceTimersByTimeAsync(2999); expect(buttonLabel()).toBe('Network error');
  await vi.advanceTimersByTimeAsync(1); expect(buttonLabel()).toBe('连接通知'); expect(button.disabled).toBe(false);
  expect(error).toHaveBeenCalledTimes(1); expect(fetch).toHaveBeenCalledTimes(1);
  handle.destroy();
});

it('uses the waiting button to cancel and ignores the cancelled operation before another attempt', async () => {
  const success = vi.fn(); const state = vi.fn();
  const handle = mountButton('#button', { application: { name: 'Example' }, locale: 'zh-CN', onSuccess: success, onStateChange: state });
  const button = document.querySelector<HTMLButtonElement>('.mp-connect__button')!;
  button.click(); await vi.advanceTimersByTimeAsync(0);
  expect(buttonLabel()).toBe('取消等待'); expect(button.disabled).toBe(false);
  expect(document.querySelectorAll('.mp-connect__loader .mp-connect__dot')).toHaveLength(3);
  button.click();
  expect(buttonLabel()).toBe('连接喵 Push'); expect(button.hasAttribute('aria-busy')).toBe(false);
  expect(document.querySelector('.mp-connect')!.getAttribute('data-state')).toBe('idle');
  await vi.advanceTimersByTimeAsync(10_000);
  expect(success).not.toHaveBeenCalled(); expect(fetch).toHaveBeenCalledTimes(1);
  expect(state.mock.calls.filter(([value]) => value === 'cancelled')).toHaveLength(1);
  expect(document.querySelector('.mp-connect__link')!.hasAttribute('href')).toBe(false);
  handle.destroy();
});

it('keeps temporary poll failures out of the visible waiting presentation', async () => {
  vi.mocked(fetch).mockReset().mockResolvedValueOnce(created()).mockResolvedValueOnce(json({}, 503)).mockResolvedValueOnce(result());
  const state = vi.fn(); const error = vi.fn();
  const handle = mountButton('#button', { application: { name: 'Example' }, locale: 'zh-CN', onSuccess() {}, onError: error, onStateChange: state });
  const button = document.querySelector<HTMLButtonElement>('.mp-connect__button')!;
  button.click(); await vi.advanceTimersByTimeAsync(2000);
  expect(state).toHaveBeenCalledWith('retrying'); expect(buttonLabel()).toBe('取消等待');
  expect(document.querySelector('.mp-connect__status')!.textContent).toBe('等待授权…');
  expect(document.querySelector('.mp-connect')!.getAttribute('data-state')).toBe('waiting');
  expect(error).not.toHaveBeenCalled();
  await vi.advanceTimersByTimeAsync(5000);
  expect(buttonLabel()).toBe('已连接');
  handle.destroy();
});

it.each(['rejected', 'expired', 'invalidated', 'not_found'] as const)('retains terminal %s feedback until one click resets and another starts a new request', async (terminal) => {
  const terminalResponse = terminal === 'not_found' ? json({}, 404) : json({ status: terminal, result: null, expires_at: new Date(Date.now() + 300_000).toISOString(), poll_interval_seconds: 2 });
  vi.mocked(fetch).mockReset().mockResolvedValueOnce(created()).mockResolvedValueOnce(terminalResponse).mockResolvedValueOnce(created());
  const success = vi.fn();
  const handle = mountButton('#button', { application: { name: 'Example' }, locale: 'zh-CN', onSuccess: success });
  const button = document.querySelector<HTMLButtonElement>('.mp-connect__button')!;
  button.click(); await vi.advanceTimersByTimeAsync(2000);
  expect(document.querySelector('.mp-connect__result-icon--error')).not.toBeNull(); expect(button.disabled).toBe(false);
  const text = buttonLabel(); await vi.advanceTimersByTimeAsync(10_000); expect(buttonLabel()).toBe(text);
  button.click(); expect(buttonLabel()).toBe('连接喵 Push'); expect(fetch).toHaveBeenCalledTimes(2);
  button.click(); await vi.advanceTimersByTimeAsync(0); expect(fetch).toHaveBeenCalledTimes(3); expect(buttonLabel()).toBe('取消等待');
  expect(success).not.toHaveBeenCalled(); handle.destroy();
});

it('resets a successful connection without clearing or redelivering the host value', async () => {
  const input = document.querySelector<HTMLInputElement>('#key')!;
  const success = vi.fn(({ pushKey }: { pushKey: string }) => { input.value = pushKey; });
  const handle = mountButton('#button', { application: { name: 'Example' }, onSuccess: success });
  const button = document.querySelector<HTMLButtonElement>('.mp-connect__button')!;
  button.click(); await vi.advanceTimersByTimeAsync(2000);
  expect(document.querySelector('.mp-connect__result-icon--success')).not.toBeNull(); expect(buttonLabel()).toBe('Connected');
  button.click(); expect(buttonLabel()).toBe('Connect MeowPush'); expect(input.value).toBe(KEY);
  expect(fetch).toHaveBeenCalledTimes(2); expect(success).toHaveBeenCalledTimes(1); handle.destroy();
});

it('does not permit another attempt while the host is handling an approved key', async () => {
  let finish!: () => void;
  const success = vi.fn(() => new Promise<void>((resolve) => { finish = resolve; }));
  const handle = mountButton('#button', { application: { name: 'Example' }, onSuccess: success });
  const button = document.querySelector<HTMLButtonElement>('.mp-connect__button')!;
  button.click(); await vi.advanceTimersByTimeAsync(2000);
  expect(button.disabled).toBe(true); handle.cancel(); button.click();
  expect(buttonLabel()).toBe('Connected'); expect(fetch).toHaveBeenCalledTimes(2);
  finish(); await vi.advanceTimersByTimeAsync(0); expect(button.disabled).toBe(false); handle.destroy();
});

it('cleans up feedback timers and live content when destroyed', async () => {
  vi.mocked(fetch).mockReset().mockResolvedValueOnce(json({}, 503));
  const handle = mountButton('#button', { application: { name: 'Example' }, onSuccess() {} });
  document.querySelector<HTMLButtonElement>('.mp-connect__button')!.click(); await vi.advanceTimersByTimeAsync(0);
  handle.destroy(); await vi.advanceTimersByTimeAsync(5000);
  expect(document.querySelector('.mp-connect')).toBeNull(); expect(fetch).toHaveBeenCalledTimes(1);
  expect(vi.getTimerCount()).toBe(0);
});
