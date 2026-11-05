import { ConnectError } from './errors.js';
import { createConnector } from './internal/connector.js';
import { browserRuntime } from './internal/runtime.js';
import type { ConnectOptions, ConnectResult } from './types.js';
export { ConnectError } from './errors.js';
export type { ConnectErrorCode } from './errors.js';
export type { ApplicationMetadata, AuthorizationPosition, AuthorizationReady, AuthorizationRequired, ConnectOptions, ConnectResult, ConnectState, Locale } from './types.js';
/** Call directly from a user click for popup/tab mode. No work happens during module import. */
export function connect(options: ConnectOptions): Promise<ConnectResult> {
  if (typeof window === 'undefined' || typeof globalThis.fetch !== 'function') return Promise.reject(new ConnectError('browser_required'));
  return createConnector(browserRuntime())(options);
}
