export type ConnectErrorCode = 'invalid_options' | 'browser_required' | 'insecure_origin' | 'popup_blocked' | 'window_unavailable' | 'callback_error' | 'network_error' | 'request_timeout' | 'timeout' | 'rate_limited' | 'server_unavailable' | 'invalid_response' | 'request_failed' | 'unauthorized' | 'request_not_found' | 'rejected' | 'expired' | 'invalidated' | 'cancelled';
const retryable = new Set<ConnectErrorCode>(['popup_blocked', 'window_unavailable', 'network_error', 'request_timeout', 'timeout', 'rate_limited', 'server_unavailable']);
/** Contains only a stable public code. No raw response, URL, key or nested cause. */
export class ConnectError extends Error {
  readonly code: ConnectErrorCode;
  readonly retryable: boolean;
  constructor(code: ConnectErrorCode) {
    super(`MeowPush connection: ${code}`);
    this.name = 'ConnectError';
    this.code = code;
    this.retryable = retryable.has(code);
  }
}
