import { ConnectError, type ConnectErrorCode } from '../errors.js';
import type { AuthorizationRequired, ConnectOptions, ConnectResult, ConnectState } from '../types.js';
import type { Runtime } from './runtime.js';
import { observe } from './observers.js';
import { API_URL, AUTH_ORIGIN } from './endpoints.js';
import { messages, resolveLocale } from './i18n.js';

const TOKEN = /^[A-Za-z0-9_-]{43}$/;
const PUSH_KEY = /^mpap[0-9a-hjkmnp-tv-z]{26}$/;
const REQUEST_TIMEOUT_MS = 20_000;
const CLOCK_SKEW_MS = 60_000;
const MAX_NETWORK_RETRIES = 5;
const responseBodies = new WeakMap<Response, RecordValue>();
const optionsKeys = new Set(['application', 'authorization', 'locale', 'signal', 'onStateChange', 'onAuthorizationReady', 'onAuthorizationRequired']);

type RecordValue = Record<string, unknown>;
function record(value: unknown): value is RecordValue { return typeof value === 'object' && value !== null && !Array.isArray(value); }
function checkAbort(signal?: AbortSignal): void { if (signal?.aborted) throw new ConnectError('cancelled'); }
function timestamp(value: unknown): number {
  if (typeof value !== 'string' || !/^\d{4}-\d{2}-\d{2}T.*Z$/.test(value)) throw new ConnectError('invalid_response');
  const n = Date.parse(value);
  if (!Number.isFinite(n)) throw new ConnectError('invalid_response');
  return n;
}
function interval(value: unknown): number {
  if (!Number.isInteger(value) || (value as number) < 1 || (value as number) > 60) throw new ConnectError('invalid_response');
  return (value as number) * 1000;
}
function invokeState(options: ConnectOptions, state: ConnectState): void {
  // Observers cannot change protocol state or turn delivery into a retry.
  observe(() => options.onStateChange?.(state));
}
function metadata(options: ConnectOptions): RecordValue {
  if (!record(options) || Object.keys(options).some((key) => !optionsKeys.has(key)) || !record(options.application)) throw new ConnectError('invalid_options');
  const a = options.application;
  if (Object.keys(a).some((key) => !['name', 'description', 'websiteUrl', 'iconUrl'].includes(key))) throw new ConnectError('invalid_options');
  if (typeof a.name !== 'string' || !a.name.trim() || [...a.name.trim()].length > 64) throw new ConnectError('invalid_options');
  const body: RecordValue = { name: a.name.trim() };
  if (a.description !== undefined) {
    if (typeof a.description !== 'string' || [...a.description].length > 1024) throw new ConnectError('invalid_options');
    body.description = a.description;
  }
  for (const [input, output] of [['websiteUrl', 'website_url'], ['iconUrl', 'icon_url']] as const) {
    const value = a[input];
    if (value === undefined) continue;
    if (typeof value !== 'string' || value.length > 2048 || /[\x00-\x1f\x7f\\]/.test(value)) throw new ConnectError('invalid_options');
    let u: URL;
    try { u = new URL(value.trim()); } catch { throw new ConnectError('invalid_options'); }
    if ((u.protocol !== 'https:' && !(input === 'websiteUrl' && u.protocol === 'http:')) || u.username || u.password) throw new ConnectError('invalid_options');
    body[output] = u.href;
  }
  if (options.locale !== undefined && !['auto', 'zh-CN', 'en'].includes(options.locale)) throw new ConnectError('invalid_options');
  for (const cb of [options.onStateChange, options.onAuthorizationReady, options.onAuthorizationRequired]) if (cb !== undefined && typeof cb !== 'function') throw new ConnectError('invalid_options');
  if (options.signal !== undefined && (typeof options.signal.aborted !== 'boolean' || typeof options.signal.addEventListener !== 'function')) throw new ConnectError('invalid_options');
  const auth = options.authorization;
  if (auth !== undefined && (!record(auth) || Object.keys(auth).some((key) => !['mode', 'width', 'height', 'position'].includes(key)))) throw new ConnectError('invalid_options');
  if (auth?.mode !== undefined && !['popup', 'tab', 'manual'].includes(auth.mode)) throw new ConnectError('invalid_options');
  if (auth?.position !== undefined && !['center', 'browser-default'].includes(auth.position)) throw new ConnectError('invalid_options');
  if (auth?.mode === 'manual' && !options.onAuthorizationRequired) throw new ConnectError('invalid_options');
  for (const key of ['width', 'height'] as const) {
    const value = auth && key in auth ? (auth as RecordValue)[key] : undefined;
    if (value !== undefined && (typeof value !== 'number' || !Number.isFinite(value) || value < 240 || value > 2000)) throw new ConnectError('invalid_options');
  }
  return body;
}

function trustedAuthorization(value: unknown, rid: string): string {
  if (typeof value !== 'string') throw new ConnectError('invalid_response');
  let u: URL;
  try { u = new URL(value); } catch { throw new ConnectError('invalid_response'); }
  if (u.origin !== AUTH_ORIGIN || u.pathname !== '/new-app' || u.username || u.password || u.hash || u.searchParams.get('rid') !== rid || [...u.searchParams].length !== 1) throw new ConnectError('invalid_response');
  return u.href;
}
function permittedPage(w: Window): boolean {
  const { protocol, hostname, origin } = w.location;
  return origin !== 'null' && (protocol === 'https:' || (protocol === 'http:' && ['localhost', '127.0.0.1', '[::1]'].includes(hostname)));
}

type Placeholder = { window: Window; document: Document };
function owns(p: Placeholder): boolean {
  try { return !p.window.closed && p.window.document === p.document && p.window.location.href === 'about:blank'; } catch { return false; }
}
function closePlaceholder(p: Placeholder | undefined): void { if (p && owns(p)) { try { p.window.close(); } catch { /* best effort */ } } }
function requestAuthorizationWindowClose(rt: Runtime, opened: Window): void {
  let attempts = 0;
  const send = () => {
    try { opened.postMessage({ type: 'meowpush:authorization:close', version: 1 }, AUTH_ORIGIN); }
    catch { return; /* Browser isolation can sever the reference. */ }
    // The official page may still be loading when cancellation happens. This
    // bounded helper retains only a window handle, never request credentials.
    if (++attempts < 5) rt.setTimeout(send, 100 * 2 ** (attempts - 1));
  };
  send();
}
type WindowGeometry = { x: number; y: number; width: number; height: number };
function metric(w: Window, key: 'screenX' | 'screenY' | 'outerWidth' | 'outerHeight' | 'innerWidth' | 'innerHeight'): number | undefined {
  try {
    const value = w[key];
    return typeof value === 'number' && Number.isFinite(value) ? value : undefined;
  } catch { return undefined; }
}
function geometry(w: Window): WindowGeometry | undefined {
  const x = metric(w, 'screenX');
  const y = metric(w, 'screenY');
  const outerWidth = metric(w, 'outerWidth');
  const outerHeight = metric(w, 'outerHeight');
  const width = outerWidth !== undefined && outerWidth > 0 ? outerWidth : metric(w, 'innerWidth');
  const height = outerHeight !== undefined && outerHeight > 0 ? outerHeight : metric(w, 'innerHeight');
  return x !== undefined && y !== undefined && width !== undefined && width > 0 && height !== undefined && height > 0 ? { x, y, width, height } : undefined;
}
function centeredPosition(w: Window, width: number, height: number): string {
  let reference = w;
  try {
    const top = w.top;
    if (top && top !== w) {
      // Access succeeds only for a same-origin top document; no cross-origin geometry probing.
      void top.document;
      reference = top;
    }
  } catch { /* use the caller window when the top context is inaccessible */ }
  const bounds = geometry(reference) ?? (reference === w ? undefined : geometry(w));
  if (!bounds) return '';
  const left = Math.round(bounds.x + (bounds.width - width) / 2);
  const top = Math.round(bounds.y + (bounds.height - height) / 2);
  // Negative coordinates are valid on monitors to the left or above the primary screen.
  return Number.isSafeInteger(left) && Number.isSafeInteger(top) ? `,left=${left},top=${top}` : '';
}
function openPlaceholder(rt: Runtime, options: ConnectOptions): Placeholder | undefined {
  const auth = options.authorization;
  if (auth?.mode === 'manual') return undefined;
  // Position and size are hints. The browser retains control over actual window bounds.
  const width = Math.round(auth?.width ?? 680);
  const height = Math.round(auth?.height ?? 900);
  const features = auth?.mode === 'tab' ? '' : `popup,width=${width},height=${height}${auth?.position === 'browser-default' ? '' : centeredPosition(rt.window, width, height)}`;
  let p: Placeholder | undefined;
  try {
    const w = rt.window.open('about:blank', '_blank', features);
    if (!w) return undefined;
    p = { window: w, document: w.document };
    w.opener = null;
    if (w.opener !== null) throw new Error();
    const meta = w.document.createElement('meta');
    meta.name = 'referrer'; meta.content = 'no-referrer';
    w.document.head.append(meta);
    w.document.title = 'MeowPush';
    const viewport = w.document.createElement('meta');
    viewport.name = 'viewport';
    viewport.content = 'width=device-width, initial-scale=1';
    w.document.head.append(viewport);
    const locale = resolveLocale(options.locale, rt.window.navigator);
    w.document.documentElement.lang = locale;
    // CSS system colors follow the user's scheme, including later theme changes.
    // Individual CSSOM properties also work when the opener disallows inline stylesheets.
    Object.assign(w.document.documentElement.style, {
      colorScheme: 'light dark',
      backgroundColor: 'Canvas',
      color: 'CanvasText',
    });
    Object.assign(w.document.body.style, {
      margin: '0',
      minHeight: '100vh',
      boxSizing: 'border-box',
      display: 'grid',
      placeItems: 'center',
      padding: '24px',
      font: '16px/1.5 system-ui, sans-serif',
      textAlign: 'center',
    });
    const message = w.document.createElement('p');
    message.textContent = messages(locale).creating;
    message.style.margin = '0';
    message.setAttribute('role', 'status');
    w.document.body.append(message);
    return p;
  } catch { closePlaceholder(p); return undefined; }
}

async function pause(rt: Runtime, ms: number, signal?: AbortSignal): Promise<void> {
  checkAbort(signal);
  const earliest = rt.now() + Math.max(0, ms);
  await new Promise<void>((resolve, reject) => {
    let timer: ReturnType<typeof setTimeout> | undefined;
    let done = false;
    const doc = rt.window.document;
    const cleanup = () => {
      if (timer !== undefined) rt.clearTimeout(timer);
      signal?.removeEventListener('abort', onAbort);
      doc.removeEventListener('visibilitychange', onVisibility);
    };
    const finish = () => { if (done) return; done = true; cleanup(); resolve(); };
    const schedule = () => {
      if (done) return;
      if (timer !== undefined) rt.clearTimeout(timer);
      const remaining = Math.max(0, earliest - rt.now());
      if (remaining === 0) finish();
      else timer = rt.setTimeout(schedule, remaining);
    };
    const onAbort = () => { if (done) return; done = true; cleanup(); reject(new ConnectError('cancelled')); };
    const onVisibility = () => { if (doc.visibilityState === 'visible') schedule(); };
    signal?.addEventListener('abort', onAbort, { once: true });
    doc.addEventListener('visibilitychange', onVisibility);
    if (signal?.aborted) onAbort();
    else schedule();
  });
}
async function request(rt: Runtime, url: string, init: RequestInit, signal?: AbortSignal): Promise<Response> {
  checkAbort(signal);
  const controller = new AbortController();
  let timedOut = false;
  const onAbort = () => controller.abort();
  signal?.addEventListener('abort', onAbort, { once: true });
  const timer = rt.setTimeout(() => { timedOut = true; controller.abort(); }, REQUEST_TIMEOUT_MS);
  try {
    const response = await rt.fetch(url, { ...init, credentials: 'omit', cache: 'no-store', referrerPolicy: 'no-referrer', redirect: 'error', signal: controller.signal });
    checkAbort(signal);
    if (response.status === 200 || response.status === 201) {
      if (!response.headers.get('content-type')?.toLowerCase().includes('application/json')) throw new ConnectError('invalid_response');
      let value: unknown;
      try { value = await response.json(); } catch (bodyError) {
        checkAbort(signal);
        throw new ConnectError(timedOut ? 'request_timeout' : bodyError instanceof SyntaxError ? 'invalid_response' : 'network_error');
      }
      checkAbort(signal);
      if (!record(value)) throw new ConnectError('invalid_response');
      responseBodies.set(response, value);
    }
    return response;
  } catch (error) {
    checkAbort(signal);
    if (error instanceof ConnectError) throw error;
    throw new ConnectError(timedOut ? 'request_timeout' : 'network_error');
  } finally { rt.clearTimeout(timer); signal?.removeEventListener('abort', onAbort); controller.abort(); }
}
async function json(response: Response): Promise<RecordValue> {
  const value = responseBodies.get(response);
  responseBodies.delete(response);
  if (!value) throw new ConnectError('invalid_response');
  return value;
}
function httpError(status: number): ConnectError {
  const code: ConnectErrorCode = status === 401 || status === 403 ? 'unauthorized' : status === 404 ? 'request_not_found' : status === 410 ? 'expired' : status === 429 ? 'rate_limited' : status >= 500 ? 'server_unavailable' : 'request_failed';
  return new ConnectError(code);
}
function retryAfter(response: Response, now: number): number {
  const v = response.headers.get('retry-after');
  if (!v) return 0;
  if (/^\d+$/.test(v)) return Number(v) * 1000;
  const deadline = Date.parse(v);
  return Number.isFinite(deadline) ? Math.max(0, deadline - now) : 0;
}

/** Internal test seam; not exported by the package. */
export function createConnector(rt: Runtime) {
  return async function connect(options: ConnectOptions): Promise<ConnectResult> {
    let p: Placeholder | undefined;
    let authorizationWindow: Window | undefined;
    let signal: AbortSignal | undefined;
    let pollSecret: string | undefined;
    const closeOnAbort = () => {
      const placeholder = p;
      const opened = authorizationWindow;
      p = undefined;
      authorizationWindow = undefined;
      // A detached cross-origin opener cannot reliably close the window itself.
      // Ask the official page to close only after it validates the request origin.
      if (placeholder) closePlaceholder(placeholder);
      if (opened) requestAuthorizationWindowClose(rt, opened);
    };
    try {
      const body = metadata(options);
      signal = options.signal;
      checkAbort(signal);
      if (!permittedPage(rt.window)) throw new ConnectError('insecure_origin');
      signal?.addEventListener('abort', closeOnAbort, { once: true });
      if (options.authorization?.mode !== 'manual') {
        invokeState(options, 'opening');
        checkAbort(signal);
        p = openPlaceholder(rt, options);
        if (!p && !options.onAuthorizationRequired) throw new ConnectError('popup_blocked');
      }
      invokeState(options, 'creating');
      const createdResponse = await request(rt, API_URL, { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify({ metadata: body }) }, options.signal);
      if (createdResponse.status !== 201) throw httpError(createdResponse.status);
      const created = await json(createdResponse);
      checkAbort(options.signal);
      if (typeof created.request_id !== 'string' || !TOKEN.test(created.request_id) || typeof created.poll_secret !== 'string' || !TOKEN.test(created.poll_secret)) throw new ConnectError('invalid_response');
      const url = trustedAuthorization(created.authorization_url, created.request_id);
      let deadline = timestamp(created.expires_at) + CLOCK_SKEW_MS;
      let delay = interval(created.poll_interval_seconds);
      pollSecret = created.poll_secret;
      const resultUrl = `${API_URL}/${encodeURIComponent(created.request_id)}/result`;
      try { options.onAuthorizationReady?.(Object.freeze({ url, expiresAt: created.expires_at as string })); }
      catch { throw new ConnectError('callback_error'); }
      checkAbort(options.signal);
      let reason: AuthorizationRequired['reason'] | undefined;
      if (options.authorization?.mode === 'manual') reason = 'manual';
      else if (!p) reason = 'popup_blocked';
      else if (owns(p)) {
        // Mark ownership before navigation so even a synchronous abort during
        // navigation can close the script-opened window exactly once.
        authorizationWindow = p.window;
        try { p.window.location.replace(url); }
        catch { authorizationWindow = undefined; reason = 'window_unavailable'; }
      } else reason = 'window_unavailable';
      checkAbort(signal);
      if (reason) {
        closePlaceholder(p);
        if (!options.onAuthorizationRequired) throw new ConnectError(reason === 'popup_blocked' ? 'popup_blocked' : 'window_unavailable');
        try { options.onAuthorizationRequired(Object.freeze({ url, expiresAt: created.expires_at as string, reason })); }
        catch { throw new ConnectError('callback_error'); }
      }
      // Retain the original placeholder only for strict ownership cleanup while
      // navigation is pending. Window state is never authorization evidence.
      invokeState(options, 'waiting');
      let retries = 0;
      for (;;) {
        await pause(rt, delay, options.signal);
        const finalAttempt = rt.now() >= deadline;
        let response: Response;
        try {
          response = await request(rt, resultUrl, { method: 'GET', headers: { Authorization: `Bearer ${pollSecret}` } }, options.signal);
        } catch (error) {
          if (!(error instanceof ConnectError) || !['network_error', 'request_timeout'].includes(error.code) || finalAttempt || ++retries > MAX_NETWORK_RETRIES) throw error;
          delay = Math.max(delay, Math.min(30_000, 1000 * 2 ** retries) + Math.floor(rt.random() * 500));
          invokeState(options, 'retrying');
          continue;
        }
        checkAbort(options.signal);
        if (response.status === 429 || response.status >= 500) {
          if (finalAttempt || ++retries > MAX_NETWORK_RETRIES) throw httpError(response.status);
          delay = Math.max(delay, retryAfter(response, rt.now()), Math.min(30_000, 1000 * 2 ** retries) + Math.floor(rt.random() * 500));
          if (!Number.isFinite(delay) || delay > Math.max(0, deadline - rt.now()) + CLOCK_SKEW_MS) throw httpError(response.status);
          invokeState(options, 'retrying');
          continue;
        }
        if (response.status !== 200) throw httpError(response.status);
        const result = await json(response);
        checkAbort(options.signal);
        delay = interval(result.poll_interval_seconds);
        const resultDeadline = timestamp(result.expires_at) + CLOCK_SKEW_MS;
        if (result.status === 'approved') {
          if (!record(result.result) || Object.keys(result.result).some((key) => key !== 'push_key') || typeof result.result.push_key !== 'string' || !PUSH_KEY.test(result.result.push_key)) throw new ConnectError('invalid_response');
          const delivered = Object.freeze({ pushKey: result.result.push_key });
          invokeState(options, 'succeeded');
          checkAbort(options.signal);
          return delivered;
        }
        if (result.result !== null) throw new ConnectError('invalid_response');
        if (result.status === 'rejected' || result.status === 'expired' || result.status === 'invalidated') throw new ConnectError(result.status);
        if (result.status !== 'pending') throw new ConnectError('invalid_response');
        if (finalAttempt) throw new ConnectError('timeout');
        // A pending response may adjust for skew, but cannot extend the original request indefinitely.
        deadline = Math.min(deadline, resultDeadline);
        retries = 0;
        invokeState(options, 'waiting');
      }
    } catch (error) {
      const safe = error instanceof ConnectError ? error : new ConnectError('invalid_response');
      if (options && typeof options === 'object') invokeState(options, ['rejected', 'expired', 'invalidated', 'cancelled'].includes(safe.code) ? safe.code as ConnectState : 'error');
      throw safe;
    } finally {
      signal?.removeEventListener('abort', closeOnAbort);
      authorizationWindow = undefined;
      pollSecret = undefined;
      closePlaceholder(p);
    }
  };
}
