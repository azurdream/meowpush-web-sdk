import { beforeEach, afterEach, describe, expect, it, vi } from 'vitest';
import { createConnector } from '../src/internal/connector.js';
import { API_URL } from '../src/internal/endpoints.js';
import { ConnectError } from '../src/errors.js';
import type { ConnectOptions, ConnectState } from '../src/types.js';
import type { Runtime } from '../src/internal/runtime.js';

const RID = 'A'.repeat(43);
const SECRET = 'B'.repeat(43);
const KEY = 'mpap' + 'a'.repeat(26);
const AUTH_URL = `https://accounts.meowpush.com/new-app?rid=${RID}`;
const json = (body: unknown, status = 200, headers = {}) => new Response(JSON.stringify(body), { status, headers: { 'Content-Type': 'application/json', ...headers } });
const created = (extra = {}) => json({ request_id: RID, poll_secret: SECRET, authorization_url: AUTH_URL, expires_at: new Date(Date.now() + 600_000).toISOString(), poll_interval_seconds: 2, ...extra }, 201);
const result = (status = 'approved', extra = {}) => json({ status, result: status === 'approved' ? { push_key: KEY } : null, expires_at: new Date(Date.now() + 300_000).toISOString(), poll_interval_seconds: 2, ...extra });
const options = (extra = {}): ConnectOptions => ({ application: { name: 'Example' }, authorization: { mode: 'manual' }, onAuthorizationRequired: vi.fn(), ...extra });
function setup(responses: Array<Response | Error> = [created(), result()]) {
  const fetch = vi.fn(async () => {
    const next = responses.shift();
    if (next instanceof Error) throw next;
    if (!next) throw new Error('unexpected request');
    return next;
  });
  const open = vi.fn(() => null as Window | null);
  const windowMock = { document, location: new URL('https://integrator.example/settings'), screen: { availWidth: 1440, availHeight: 900 }, open } as unknown as Window;
  const rt: Runtime = { window: windowMock, fetch: fetch as typeof globalThis.fetch, now: () => Date.now(), random: () => 0, setTimeout: (f, ms) => setTimeout(f, ms), clearTimeout: (t) => clearTimeout(t) };
  return { connect: createConnector(rt), fetch, open, rt };
}
function placeholder() {
  const doc = document.implementation.createHTMLDocument('');
  const location = { href: 'about:blank', replace: vi.fn((url: string) => { location.href = url; }) };
  const p = { document: doc, location, closed: false, opener: {}, close: vi.fn(), postMessage: vi.fn() };
  return p;
}
beforeEach(() => { vi.useFakeTimers(); vi.setSystemTime(new Date('2026-10-31T02:00:00Z')); });
afterEach(() => { vi.useRealTimers(); vi.restoreAllMocks(); });

describe('browser authorization protocol', () => {
  it('delivers only the key, uses the narrow routes, and omits ambient credentials', async () => {
    const { connect, fetch } = setup();
    const onAuthorizationRequired = vi.fn();
    const state: ConnectState[] = [];
    const promise = connect(options({ onAuthorizationRequired, onStateChange: (s: ConnectState) => state.push(s) }));
    await vi.advanceTimersByTimeAsync(2000);
    expect(await promise).toEqual({ pushKey: KEY });
    expect(fetch).toHaveBeenCalledTimes(2);
    expect(fetch.mock.calls[0]?.[0]).toBe(API_URL);
    const createInit = fetch.mock.calls[0]?.[1] as RequestInit;
    expect(JSON.parse(createInit.body as string)).toEqual({ metadata: { name: 'Example' } });
    expect(createInit).toMatchObject({ credentials: 'omit', cache: 'no-store', redirect: 'error', referrerPolicy: 'no-referrer' });
    expect(createInit.headers).not.toHaveProperty('Authorization');
    const pollInit = fetch.mock.calls[1]?.[1] as RequestInit;
    expect(pollInit.headers).toEqual({ Authorization: `Bearer ${SECRET}` });
    expect(onAuthorizationRequired).toHaveBeenCalledWith({ url: AUTH_URL, expiresAt: expect.any(String), reason: 'manual' });
    expect(JSON.stringify(state)).not.toContain(SECRET);
    expect(state).toEqual(['creating', 'waiting', 'succeeded']);
  });
  it('opens and detaches the placeholder synchronously before the network request', async () => {
    const { connect, open, fetch } = setup();
    const p = placeholder(); open.mockReturnValue(p as unknown as Window);
    const promise = connect({ application: { name: 'Example' } });
    expect(open).toHaveBeenCalledTimes(1);
    expect(p.opener).toBeNull();
    expect(open.mock.invocationCallOrder[0]).toBeLessThan(fetch.mock.invocationCallOrder[0]!);
    await vi.advanceTimersByTimeAsync(0);
    expect(p.location.replace).toHaveBeenCalledWith(AUTH_URL);
    p.closed = true; // COOP can sever the handle; it must not cancel polling.
    await vi.advanceTimersByTimeAsync(2000);
    expect(await promise).toEqual({ pushKey: KEY });
    expect(p.close).not.toHaveBeenCalled();
  });
  it('fails before creating if a popup is blocked and there is no fallback', async () => {
    const { connect, fetch } = setup();
    await expect(connect({ application: { name: 'Example' } })).rejects.toMatchObject({ code: 'popup_blocked' });
    expect(fetch).not.toHaveBeenCalled();
  });
  it('reuses one request through the explicit blocked-popup fallback', async () => {
    const { connect, fetch } = setup(); const fallback = vi.fn();
    const promise = connect({ application: { name: 'Example' }, onAuthorizationRequired: fallback });
    await vi.advanceTimersByTimeAsync(2000); await promise;
    expect(fallback).toHaveBeenCalledWith(expect.objectContaining({ reason: 'popup_blocked' }));
    expect(fetch.mock.calls.filter((call) => (call[1] as RequestInit).method === 'POST')).toHaveLength(1);
  });
  it('does not overwrite a placeholder the user navigated elsewhere', async () => {
    const { connect, open } = setup(); const p = placeholder(); open.mockReturnValue(p as unknown as Window);
    const fallback = vi.fn();
    const promise = connect({ application: { name: 'Example' }, onAuthorizationRequired: fallback });
    p.location.href = 'https://another.example/';
    await vi.advanceTimersByTimeAsync(2000); await promise;
    expect(p.location.replace).not.toHaveBeenCalled();
    expect(p.close).not.toHaveBeenCalled();
    expect(fallback).toHaveBeenCalledWith(expect.objectContaining({ reason: 'window_unavailable' }));
  });
  it.each(['https://evil.example/new-app?rid=' + RID, AUTH_URL + '&poll_secret=secret', AUTH_URL + '#fragment', 'https://accounts.meowpush.com.evil.example/new-app?rid=' + RID])('rejects unexpected authorization URL %s without exposing the response', async (url) => {
    const { connect } = setup([created({ authorization_url: url })]);
    let error: unknown; try { await connect(options()); } catch (e) { error = e; }
    expect(error).toMatchObject({ code: 'invalid_response' });
    expect(JSON.stringify(error)).not.toContain(RID);
    expect(String(error)).not.toContain(url);
  });
  it('rejects a server result containing an extra credential rather than forwarding it', async () => {
    const { connect } = setup([created(), result('approved', { result: { push_key: KEY, reauthorization_token: SECRET } })]);
    const promise = connect(options()).catch((error) => error);
    await vi.advanceTimersByTimeAsync(2000);
    expect(await promise).toMatchObject({ code: 'invalid_response' });
  });
  it.each(['rejected', 'expired', 'invalidated'])('stops on %s', async (status) => {
    const { connect, fetch } = setup([created(), result(status)]);
    const promise = connect(options()).catch((error) => error);
    await vi.advanceTimersByTimeAsync(20_000);
    expect(await promise).toMatchObject({ code: status }); expect(fetch).toHaveBeenCalledTimes(2);
  });
  it('honors Retry-After without overlapping polls or recreating the request', async () => {
    const { connect, fetch } = setup([created(), json({}, 429, { 'Retry-After': '8' }), result()]);
    const promise = connect(options());
    await vi.advanceTimersByTimeAsync(2000); expect(fetch).toHaveBeenCalledTimes(2);
    await vi.advanceTimersByTimeAsync(7999); expect(fetch).toHaveBeenCalledTimes(2);
    await vi.advanceTimersByTimeAsync(1); expect(await promise).toEqual({ pushKey: KEY });
    expect(fetch).toHaveBeenCalledTimes(3);
  });
  it('does not retry a creation POST whose response is lost', async () => {
    const { connect, fetch } = setup([new Error('raw url?poll_secret=sensitive')]);
    await expect(connect(options())).rejects.toMatchObject({ code: 'network_error' });
    await vi.advanceTimersByTimeAsync(60_000); expect(fetch).toHaveBeenCalledTimes(1);
  });
  it('aborts waiting without another poll', async () => {
    const { connect, fetch } = setup(); const controller = new AbortController();
    const promise = connect(options({ signal: controller.signal })).catch((error) => error);
    await vi.advanceTimersByTimeAsync(0); controller.abort();
    await vi.advanceTimersByTimeAsync(10_000);
    expect(await promise).toMatchObject({ code: 'cancelled' }); expect(fetch).toHaveBeenCalledTimes(1);
  });
  it('ignores a late approved response after cancellation', async () => {
    const { connect, fetch } = setup([created()]); let deliver!: (response: Response) => void;
    fetch.mockImplementationOnce(async () => created()).mockImplementationOnce(() => new Promise((resolve) => { deliver = resolve; }));
    const controller = new AbortController();
    const promise = connect(options({ signal: controller.signal })).catch((error) => error);
    await vi.advanceTimersByTimeAsync(2000); controller.abort(); deliver(result());
    await vi.advanceTimersByTimeAsync(0); expect(await promise).toMatchObject({ code: 'cancelled' });
  });
  it('does one final poll at the local deadline and accepts server-authoritative approval', async () => {
    const { connect } = setup([created({ expires_at: new Date(Date.now() - 60_000).toISOString() }), result()]);
    const promise = connect(options()); await vi.advanceTimersByTimeAsync(2000);
    expect(await promise).toEqual({ pushKey: KEY });
  });
  it('bounds repeated temporary failures', async () => {
    const { connect, fetch } = setup([created(), ...Array.from({ length: 6 }, () => json({}, 503))]);
    const promise = connect(options()).catch((error) => error);
    await vi.advanceTimersByTimeAsync(150_000);
    expect(await promise).toMatchObject({ code: 'server_unavailable' }); expect(fetch).toHaveBeenCalledTimes(7);
  });
  it('does not let a throwing state observer cause retries or lose the key', async () => {
    const { connect, fetch } = setup();
    const promise = connect(options({ onStateChange() { throw new Error('host exception'); } }));
    await vi.advanceTimersByTimeAsync(2000); expect(await promise).toEqual({ pushKey: KEY }); expect(fetch).toHaveBeenCalledTimes(2);
  });
  it('rejects manual mode without a callback and arbitrary API overrides', async () => {
    const { connect, fetch } = setup();
    await expect(connect({ application: { name: 'X' }, authorization: { mode: 'manual' } } as ConnectOptions)).rejects.toMatchObject({ code: 'invalid_options' });
    await expect(connect(options({ apiBaseUrl: 'https://evil.example' }))).rejects.toMatchObject({ code: 'invalid_options' });
    expect(fetch).not.toHaveBeenCalled();
  });
  it('rejects an insecure remote page', async () => {
    const { connect, rt } = setup(); Object.defineProperty(rt.window, 'location', { value: new URL('http://192.168.1.2/') });
    await expect(connect(options())).rejects.toMatchObject({ code: 'insecure_origin' });
  });
});

it('provides the validated invitation even when automatic navigation succeeds', async () => {
  const { connect, open, fetch } = setup(); const p = placeholder(); open.mockReturnValue(p as unknown as Window);
  const ready = vi.fn(); const required = vi.fn();
  const promise = connect({ application: { name: 'Example' }, onAuthorizationReady: ready, onAuthorizationRequired: required });
  await vi.advanceTimersByTimeAsync(0);
  expect(ready).toHaveBeenCalledExactlyOnceWith({ url: AUTH_URL, expiresAt: expect.any(String) });
  expect(JSON.stringify(ready.mock.calls)).not.toContain(SECRET);
  expect(required).not.toHaveBeenCalled();
  p.closed = true;
  await vi.advanceTimersByTimeAsync(2000);
  expect(await promise).toEqual({ pushKey: KEY }); expect(fetch).toHaveBeenCalledTimes(2);
});

it('wakes an overdue background timer when the page becomes visible and cleans up', async () => {
  const { connect, fetch } = setup(); const remove = vi.spyOn(document, 'removeEventListener');
  Object.defineProperty(document, 'visibilityState', { configurable: true, value: 'visible' });
  const promise = connect(options()); await vi.advanceTimersByTimeAsync(0);
  // Move the clock without running throttled background timers.
  vi.setSystemTime(Date.now() + 3000);
  document.dispatchEvent(new Event('visibilitychange'));
  await vi.advanceTimersByTimeAsync(0);
  expect(await promise).toEqual({ pushKey: KEY }); expect(fetch).toHaveBeenCalledTimes(2);
  expect(remove).toHaveBeenCalledWith('visibilitychange', expect.any(Function));
});

it('visibility restoration cannot bypass the server Retry-After interval', async () => {
  const { connect, fetch } = setup([created(), json({}, 429, { 'Retry-After': '8' }), result()]);
  Object.defineProperty(document, 'visibilityState', { configurable: true, value: 'visible' });
  const promise = connect(options()); await vi.advanceTimersByTimeAsync(2000);
  await vi.advanceTimersByTimeAsync(3000);
  document.dispatchEvent(new Event('visibilitychange'));
  await vi.advanceTimersByTimeAsync(4999); expect(fetch).toHaveBeenCalledTimes(2);
  await vi.advanceTimersByTimeAsync(1); expect(await promise).toEqual({ pushKey: KEY });
});

it('requests validated popup dimensions without accessing privacy-sensitive screen metrics', async () => {
  const { connect, open, rt } = setup(); const p = placeholder(); open.mockReturnValue(p as unknown as Window);
  const readScreen = vi.fn(() => { throw new Error('screen access forbidden'); });
  Object.defineProperty(rt.window, 'screen', { configurable: true, get: readScreen });
  const promise = connect({ application: { name: 'Example' }, authorization: { mode: 'popup', width: 480.4, height: 720.6 } });
  await vi.advanceTimersByTimeAsync(2000);
  expect(await promise).toEqual({ pushKey: KEY });
  expect(open).toHaveBeenCalledWith('about:blank', '_blank', 'popup,width=480,height=721');
  expect(readScreen).not.toHaveBeenCalled();
});

it('uses automatic supported language for the preopened placeholder', async () => {
  const { connect, open, rt } = setup(); const p = placeholder(); open.mockReturnValue(p as unknown as Window);
  Object.defineProperty(rt.window, 'navigator', { value: { languages: ['fr-FR', 'zh-Hans'], language: 'fr-FR' } });
  const promise = connect({ application: { name: 'Example' } });
  expect(p.document.body.textContent).toBe('正在连接…');
  await vi.advanceTimersByTimeAsync(2000); expect(await promise).toEqual({ pushKey: KEY });
});

function setGeometry(target: Window, values: Record<string, unknown>) {
  for (const [key, value] of Object.entries(values)) Object.defineProperty(target, key, { configurable: true, value });
}

it('centers the popup relative to the current browser window by default', async () => {
  const { connect, open, rt } = setup(); const p = placeholder(); open.mockReturnValue(p as unknown as Window);
  setGeometry(rt.window, { screenX: 200, screenY: 100, outerWidth: 1280, outerHeight: 900 });
  const promise = connect({ application: { name: 'Example' } });
  expect(open).toHaveBeenCalledWith('about:blank', '_blank', 'popup,width=680,height=900,left=500,top=100');
  expect(p.opener).toBeNull();
  await vi.advanceTimersByTimeAsync(2000); expect(await promise).toEqual({ pushKey: KEY });
});

it('preserves negative monitor coordinates when centering a custom-sized popup', async () => {
  const { connect, open, rt } = setup(); open.mockReturnValue(placeholder() as unknown as Window);
  setGeometry(rt.window, { screenX: -1800, screenY: -900, outerWidth: 1200, outerHeight: 800 });
  const promise = connect({ application: { name: 'Example' }, authorization: { width: 600, height: 400, position: 'center' } });
  expect(open).toHaveBeenCalledWith('about:blank', '_blank', 'popup,width=600,height=400,left=-1500,top=-700');
  await vi.advanceTimersByTimeAsync(2000); await promise;
});

it('uses accessible same-origin top-window geometry for embedded integrations', async () => {
  const { connect, open, rt } = setup(); open.mockReturnValue(placeholder() as unknown as Window);
  const parent = { document, screenX: 50, screenY: 20, outerWidth: 1400, outerHeight: 1000 } as unknown as Window;
  setGeometry(rt.window, { top: parent, screenX: 0, screenY: 0, outerWidth: 300, outerHeight: 200 });
  const promise = connect({ application: { name: 'Example' } });
  expect(open).toHaveBeenCalledWith('about:blank', '_blank', 'popup,width=680,height=900,left=410,top=70');
  await vi.advanceTimersByTimeAsync(2000); await promise;
});

it('falls back to caller geometry when the top document is cross-origin', async () => {
  const { connect, open, rt } = setup(); open.mockReturnValue(placeholder() as unknown as Window);
  const top = {} as Window;
  Object.defineProperty(top, 'document', { get: () => { throw new DOMException('Cross origin', 'SecurityError'); } });
  const readParentGeometry = vi.fn(() => 999);
  Object.defineProperty(top, 'screenX', { get: readParentGeometry });
  setGeometry(rt.window, { top, screenX: 10, screenY: 30, outerWidth: 1000, outerHeight: 800 });
  const promise = connect({ application: { name: 'Example' } });
  expect(open).toHaveBeenCalledWith('about:blank', '_blank', 'popup,width=680,height=900,left=170,top=-20');
  expect(readParentGeometry).not.toHaveBeenCalled();
  await vi.advanceTimersByTimeAsync(2000); await promise;
});

it('uses inner dimensions if outer dimensions are unavailable or throw', async () => {
  const { connect, open, rt } = setup(); open.mockReturnValue(placeholder() as unknown as Window);
  setGeometry(rt.window, { screenX: 100, screenY: 50, outerWidth: Number.NaN, innerWidth: 1000, innerHeight: 800 });
  Object.defineProperty(rt.window, 'outerHeight', { configurable: true, get: () => { throw new Error('unavailable'); } });
  const promise = connect({ application: { name: 'Example' } });
  expect(open).toHaveBeenCalledWith('about:blank', '_blank', 'popup,width=680,height=900,left=260,top=0');
  await vi.advanceTimersByTimeAsync(2000); await promise;
});

it.each(['missing', 'NaN', 'throws'])('omits positioning hints when coordinates are %s without blocking authorization', async (kind) => {
  const { connect, open, rt } = setup(); open.mockReturnValue(placeholder() as unknown as Window);
  setGeometry(rt.window, { screenY: 0, outerWidth: 1000, outerHeight: 800 });
  if (kind === 'NaN') setGeometry(rt.window, { screenX: Number.NaN });
  if (kind === 'throws') Object.defineProperty(rt.window, 'screenX', { configurable: true, get: () => { throw new Error('unavailable'); } });
  const promise = connect({ application: { name: 'Example' } });
  expect(open).toHaveBeenCalledWith('about:blank', '_blank', 'popup,width=680,height=900');
  await vi.advanceTimersByTimeAsync(2000); expect(await promise).toEqual({ pushKey: KEY });
});

it.each(['browser-default', 'tab', 'manual'])('does not read any geometry for %s presentation', async (mode) => {
  const { connect, open, rt } = setup(); open.mockReturnValue(placeholder() as unknown as Window);
  const readGeometry = vi.fn(() => { throw new Error('geometry access forbidden'); });
  for (const key of ['top', 'screen', 'screenX', 'screenY', 'outerWidth', 'outerHeight', 'innerWidth', 'innerHeight']) Object.defineProperty(rt.window, key, { configurable: true, get: readGeometry });
  const auth = mode === 'browser-default' ? { mode: 'popup' as const, position: 'browser-default' as const } : { mode: mode as 'tab' | 'manual', position: 'center' as const };
  const promise = connect(options({ authorization: auth }));
  expect(readGeometry).not.toHaveBeenCalled();
  if (mode === 'manual') expect(open).not.toHaveBeenCalled();
  else expect(open).toHaveBeenCalledWith('about:blank', '_blank', mode === 'tab' ? '' : 'popup,width=680,height=900');
  await vi.advanceTimersByTimeAsync(2000); await promise;
});

it('rejects invalid position values before opening a window or making a request', async () => {
  const { connect, open, fetch } = setup();
  await expect(connect(options({ authorization: { mode: 'popup', position: 'screen-center' } }))).rejects.toMatchObject({ code: 'invalid_options' });
  await expect(connect(options({ authorization: { mode: 'manual', position: 1 } }))).rejects.toMatchObject({ code: 'invalid_options' });
  expect(open).not.toHaveBeenCalled(); expect(fetch).not.toHaveBeenCalled();
});

it.each(['popup', 'tab'] as const)('requests closure of the SDK-opened %s synchronously when waiting is cancelled', async (mode) => {
  const { connect, open, fetch } = setup();
  const p = placeholder(); open.mockReturnValue(p as unknown as Window);
  const abort = new AbortController();
  const promise = connect({ application: { name: 'Example' }, authorization: { mode }, signal: abort.signal }).catch((error) => error);
  await vi.advanceTimersByTimeAsync(0);
  expect(p.location.replace).toHaveBeenCalledWith(AUTH_URL);
  // Cross-origin ownership checks may throw. Cancellation must still send only
  // an origin-locked close hint, without forwarding a URL or credentials.
  Object.defineProperty(p, 'document', { get() { throw new Error('cross origin'); } });
  Object.defineProperty(p, 'location', { get() { throw new Error('cross origin'); } });
  abort.abort();
  expect(p.postMessage).toHaveBeenCalledExactlyOnceWith({ type: 'meowpush:authorization:close', version: 1 }, 'https://accounts.meowpush.com');
  expect(p.close).not.toHaveBeenCalled();
  await vi.advanceTimersByTimeAsync(10_000);
  expect(p.postMessage).toHaveBeenCalledTimes(5);
  expect(await promise).toMatchObject({ code: 'cancelled' });
  expect(fetch).toHaveBeenCalledTimes(1);
  expect(vi.getTimerCount()).toBe(0);
});

it('still cancels when browser isolation prevents messaging the authorization window', async () => {
  const { connect, open, fetch } = setup();
  const p = placeholder(); open.mockReturnValue(p as unknown as Window);
  p.postMessage.mockImplementation(() => { throw new Error('private browser restriction'); });
  const abort = new AbortController();
  const promise = connect({ application: { name: 'Example' }, signal: abort.signal }).catch((error) => error);
  await vi.advanceTimersByTimeAsync(0);
  expect(() => abort.abort()).not.toThrow();
  expect(p.postMessage).toHaveBeenCalledExactlyOnceWith({ type: 'meowpush:authorization:close', version: 1 }, 'https://accounts.meowpush.com');
  await vi.advanceTimersByTimeAsync(0);
  const error = await promise;
  expect(error).toMatchObject({ code: 'cancelled' });
  expect(String(error)).not.toContain('private browser restriction');
  expect(fetch).toHaveBeenCalledTimes(1);
});

it('requests window closure during an in-flight poll and rejects a late approval', async () => {
  const { connect, open, fetch } = setup();
  const p = placeholder(); open.mockReturnValue(p as unknown as Window);
  let deliver!: (response: Response) => void;
  fetch.mockImplementationOnce(async () => created()).mockImplementationOnce(() => new Promise((resolve) => { deliver = resolve; }));
  const abort = new AbortController();
  const promise = connect({ application: { name: 'Example' }, signal: abort.signal }).catch((error) => error);
  await vi.advanceTimersByTimeAsync(2000);
  abort.abort();
  expect(p.postMessage).toHaveBeenCalledExactlyOnceWith({ type: 'meowpush:authorization:close', version: 1 }, 'https://accounts.meowpush.com');
  deliver(result());
  await vi.advanceTimersByTimeAsync(0);
  expect(await promise).toMatchObject({ code: 'cancelled' });
  expect(fetch).toHaveBeenCalledTimes(2);
});

it('does not close an unrelated user-navigated placeholder on cancellation', async () => {
  const { connect, open } = setup();
  const p = placeholder(); open.mockReturnValue(p as unknown as Window);
  const abort = new AbortController();
  const promise = connect({ application: { name: 'Example' }, onAuthorizationRequired() {}, signal: abort.signal }).catch((error) => error);
  p.location.href = 'https://another.example/';
  await vi.advanceTimersByTimeAsync(0);
  abort.abort(); await vi.advanceTimersByTimeAsync(0);
  expect(await promise).toMatchObject({ code: 'cancelled' });
  expect(p.close).not.toHaveBeenCalled();
  expect(p.postMessage).not.toHaveBeenCalled();
});

it.each(['approved', 'rejected', 'expired'] as const)('releases the popup close handle after terminal %s', async (status) => {
  const { connect, open } = setup([created(), result(status)]);
  const p = placeholder(); open.mockReturnValue(p as unknown as Window);
  const abort = new AbortController();
  const remove = vi.spyOn(abort.signal, 'removeEventListener');
  const promise = connect({ application: { name: 'Example' }, signal: abort.signal }).catch((error) => error);
  await vi.advanceTimersByTimeAsync(2000);
  await promise;
  expect(remove).toHaveBeenCalledWith('abort', expect.any(Function));
  abort.abort();
  expect(p.close).not.toHaveBeenCalled();
  expect(p.postMessage).not.toHaveBeenCalled();
});
