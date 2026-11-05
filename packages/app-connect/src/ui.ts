import { connect, ConnectError } from './index.js';
import { buttonContent } from './internal/button-content.js';
import { messages, resolveLocale } from './internal/i18n.js';
import { observe } from './internal/observers.js';
import type { ButtonController, ButtonOptions, ButtonPresentationUpdate, ConnectOptions, ConnectState } from './types.js';
export type { ButtonController, ButtonOptions, ButtonPresentationUpdate } from './types.js';

type Presentation = Pick<ButtonPresentationUpdate, 'locale' | 'theme' | 'size' | 'label'>;
type ButtonState = 'idle' | 'creating' | 'waiting' | 'succeeded' | 'rejected' | 'expired' | 'invalidated' | 'error';
type StatusMessage = ConnectState | 'hint' | 'callbackError' | 'insecure' | 'unavailable' | 'limited';
type ShortMessage = Extract<keyof ReturnType<typeof messages>, `short${string}`>;
function validPresentation(value: unknown): asserts value is ButtonPresentationUpdate {
  if (typeof value !== 'object' || value === null || Array.isArray(value)) throw new ConnectError('invalid_options');
  const p = value as Record<string, unknown>;
  if (Object.keys(p).some((key) => !['locale', 'theme', 'size', 'label'].includes(key))) throw new ConnectError('invalid_options');
  if (p.locale !== undefined && !['auto', 'zh-CN', 'en'].includes(p.locale as string)) throw new ConnectError('invalid_options');
  if (p.theme !== undefined && !['auto', 'light', 'dark'].includes(p.theme as string)) throw new ConnectError('invalid_options');
  if (p.size !== undefined && !['sm', 'md'].includes(p.size as string)) throw new ConnectError('invalid_options');
  if (p.label !== undefined && (typeof p.label !== 'string' || !p.label.trim())) throw new ConnectError('invalid_options');
}
function errorMessage(error: ConnectError): ShortMessage {
  switch (error.code) {
    case 'insecure_origin': return 'shortInsecure';
    case 'server_unavailable': return 'shortUnavailable';
    case 'rate_limited': return 'shortLimited';
    case 'network_error': case 'request_timeout': return 'shortNetwork';
    case 'timeout': return 'shortTimeout';
    case 'rejected': return 'shortRejected';
    case 'expired': return 'shortExpired';
    case 'invalidated': return 'shortInvalidated';
    case 'unauthorized': case 'request_not_found': return 'shortNotFound';
    case 'callback_error': return 'shortCallbackError';
    default: return 'shortError';
  }
}

/** Mounts only its own nodes. It never finds, reads or submits a host form. */
export function mountButton(container: HTMLElement | string, options: ButtonOptions): ButtonController {
  if (typeof document === 'undefined') throw new ConnectError('browser_required');
  let target: HTMLElement | null;
  try { target = typeof container === 'string' ? document.querySelector<HTMLElement>(container) : container; } catch { throw new ConnectError('invalid_options'); }
  if (!target || !(target instanceof HTMLElement) || /^(INPUT|BUTTON|SELECT|TEXTAREA|IMG)$/.test(target.tagName) || !options || typeof options.onSuccess !== 'function') throw new ConnectError('invalid_options');
  let presentation: Presentation = { locale: options.locale, theme: options.theme, size: options.size, label: options.label };
  validPresentation(presentation);
  if (options.onError !== undefined && typeof options.onError !== 'function') throw new ConnectError('invalid_options');
  const doc = target.ownerDocument;
  const view = doc.defaultView;
  const root = doc.createElement('div'); root.className = 'mp-connect';
  const row = doc.createElement('div'); row.className = 'mp-connect__row';
  const button = doc.createElement('button'); button.type = 'button'; button.className = 'mp-connect__button';
  const content = buttonContent(button);
  const link = doc.createElement('a'); link.className = 'mp-connect__link'; link.target = '_blank'; link.rel = 'noopener noreferrer'; link.referrerPolicy = 'no-referrer'; link.hidden = true;
  const status = doc.createElement('p'); status.className = 'mp-connect__status'; status.setAttribute('role', 'status'); status.setAttribute('aria-live', 'polite'); status.id = `mp-connect-status-${++statusId}`;
  button.setAttribute('aria-describedby', status.id);
  row.append(button, link); root.append(row, status); target.append(root);
  let controller: AbortController | undefined;
  let resetTimer: ReturnType<typeof setTimeout> | undefined;
  let generation = 0;
  let destroyed = false;
  let running = false;
  let invitationCreated = false;
  let transientError = false;
  let state: ButtonState = 'idle';
  let shortMessage: ShortMessage = 'shortError';
  let statusMessage: StatusMessage = 'hint';
  let linkMessage: 'reopen' | 'continue' = 'continue';
  const terminal = () => !['idle', 'creating', 'waiting'].includes(state) && !transientError;
  const renderPresentation = () => {
    if (destroyed) return;
    const locale = resolveLocale(presentation.locale, view?.navigator);
    const text = messages(locale);
    root.lang = locale;
    root.dataset.theme = presentation.theme ?? 'auto';
    root.dataset.size = presentation.size ?? 'md';
    root.dataset.state = state;
    const failed = state === 'error' || ['rejected', 'expired', 'invalidated'].includes(state);
    button.dataset.tone = failed ? 'error' : 'normal';
    const label = state === 'waiting' ? text.cancel
      : state === 'succeeded' ? text.done
      : failed ? text[shortMessage]
      : state === 'creating' ? text.creating
      : presentation.label ?? text.label;
    content.render(label, state === 'waiting' ? 'loading' : state === 'succeeded' ? 'success' : failed && !transientError ? 'error' : 'logo');
    button.setAttribute('aria-label', state === 'succeeded' ? text.accessibleDone : terminal() ? `${label}. ${text.reset}` : state === 'idle' && presentation.label ? `${label} · MeowPush` : label);
    // Once an invitation exists, the primary control itself cancels waiting.
    // Keep it disabled while creating or handing an approved key to the host.
    button.disabled = (running && state !== 'waiting') || transientError;
    if (running) button.setAttribute('aria-busy', 'true');
    else button.removeAttribute('aria-busy');
    link.textContent = text[linkMessage];
    status.textContent = text[statusMessage];
  };
  const clearLink = () => { link.hidden = true; link.removeAttribute('href'); };
  const clearReset = () => { if (resetTimer !== undefined) clearTimeout(resetTimer); resetTimer = undefined; };
  const safeError = (error: ConnectError) => observe(() => options.onError?.(error));
  const reset = (message: StatusMessage = 'hint') => {
    clearReset(); clearLink(); transientError = false; invitationCreated = false;
    state = 'idle'; statusMessage = message; renderPresentation();
  };
  const stop = () => {
    if (!running || !controller || (state !== 'creating' && state !== 'waiting')) return;
    ++generation; controller.abort(); controller = undefined; running = false;
    reset('cancelled');
    observe(() => options.onStateChange?.('cancelled'));
  };
  const onExternalAbort = () => stop();
  const onLanguageChange = () => { if (presentation.locale === undefined || presentation.locale === 'auto') renderPresentation(); };
  options.signal?.addEventListener('abort', onExternalAbort);
  view?.addEventListener('languagechange', onLanguageChange);
  renderPresentation();
  const renderState = (next: ConnectState, current: number) => {
    if (destroyed || current !== generation) return;
    if (next === 'opening' || next === 'creating') { state = 'creating'; statusMessage = next; }
    if (next === 'waiting' || next === 'retrying') { state = 'waiting'; statusMessage = 'waiting'; }
    // Final UI is set only after the promise resolves/rejects. The core's
    // succeeded observer may still synchronously cancel before key delivery.
    renderPresentation();
    observe(() => options.onStateChange?.(next));
  };
  const start = async () => {
    if (destroyed || running || state !== 'idle') return;
    running = true; invitationCreated = false; state = 'creating'; statusMessage = 'creating'; clearLink(); renderPresentation();
    const activeController = new AbortController();
    controller = activeController;
    const current = ++generation;
    if (options.signal?.aborted) activeController.abort();
    try {
      const connection = {
        application: { ...options.application },
        locale: resolveLocale(presentation.locale, view?.navigator),
        ...(options.authorization === undefined ? {} : { authorization: { ...options.authorization } }),
        signal: activeController.signal,
        onStateChange: (next: ConnectState) => renderState(next, current),
        onAuthorizationReady: (request: Parameters<NonNullable<ConnectOptions['onAuthorizationReady']>>[0]) => {
          if (destroyed || current !== generation || activeController.signal.aborted) return;
          invitationCreated = true;
          link.href = request.url; linkMessage = 'reopen'; link.hidden = false;
          renderPresentation();
          options.onAuthorizationReady?.(request);
        },
        onAuthorizationRequired: (request: Parameters<NonNullable<ConnectOptions['onAuthorizationRequired']>>[0]) => {
          if (destroyed || current !== generation || activeController.signal.aborted) return;
          link.href = request.url; linkMessage = 'continue'; link.hidden = false;
          renderPresentation();
          options.onAuthorizationRequired?.(request);
        },
      } as ConnectOptions;
      const result = await connect(connection);
      if (destroyed || current !== generation || activeController.signal.aborted) return;
      state = 'succeeded'; statusMessage = 'succeeded'; clearLink(); renderPresentation();
      try { await options.onSuccess(result); }
      catch {
        if (!destroyed && current === generation) {
          state = 'error'; shortMessage = 'shortCallbackError'; statusMessage = 'callbackError'; renderPresentation(); safeError(new ConnectError('callback_error'));
        }
      }
    } catch (error) {
      if (destroyed || current !== generation) return;
      const safe = error instanceof ConnectError ? error : new ConnectError('request_failed');
      if (safe.code === 'cancelled') reset('cancelled');
      else {
        shortMessage = errorMessage(safe);
        state = safe.code === 'rejected' || safe.code === 'expired' || safe.code === 'invalidated' ? safe.code : 'error';
        statusMessage = state === 'error' ? 'error' : state;
        if (safe.code === 'insecure_origin') statusMessage = 'insecure';
        else if (safe.code === 'server_unavailable') statusMessage = 'unavailable';
        else if (safe.code === 'rate_limited') statusMessage = 'limited';
        transientError = !invitationCreated;
        if (transientError) resetTimer = setTimeout(() => { if (!destroyed && current === generation) reset(); }, 3000);
        renderPresentation(); safeError(safe);
      }
    } finally {
      if (!destroyed && current === generation) {
        running = false; clearLink(); controller = undefined; renderPresentation();
      }
    }
  };
  const onClick = () => {
    if (running) { if (state === 'waiting') stop(); return; }
    if (terminal()) { reset(); return; }
    void start();
  };
  button.addEventListener('click', onClick);
  return Object.freeze({
    cancel: stop,
    update(patch: ButtonPresentationUpdate) {
      if (destroyed) return;
      validPresentation(patch);
      presentation = { ...presentation, ...patch };
      renderPresentation();
    },
    destroy() {
      if (destroyed) return;
      destroyed = true; ++generation; controller?.abort(); clearReset(); content.destroy();
      button.removeEventListener('click', onClick);
      options.signal?.removeEventListener('abort', onExternalAbort);
      view?.removeEventListener('languagechange', onLanguageChange);
      clearLink(); root.remove();
    },
  });
}
let statusId = 0;
