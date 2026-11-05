export type ConnectResult = Readonly<{ pushKey: string }>;
export type ApplicationMetadata = Readonly<{
  name: string;
  description?: string;
  websiteUrl?: string;
  iconUrl?: string;
}>;
export type ConnectState = 'opening' | 'creating' | 'waiting' | 'retrying' | 'succeeded' | 'rejected' | 'expired' | 'invalidated' | 'cancelled' | 'error';
export type Locale = 'auto' | 'zh-CN' | 'en';
export type AuthorizationPosition = 'center' | 'browser-default';
export type AuthorizationReady = Readonly<{ url: string; expiresAt: string }>;
export type AuthorizationRequired = Readonly<{
  url: string;
  expiresAt: string;
  reason: 'manual' | 'popup_blocked' | 'window_unavailable';
}>;
type CommonOptions = {
  application: ApplicationMetadata;
  locale?: Locale;
  signal?: AbortSignal;
  onStateChange?: (state: ConnectState) => void;
  onAuthorizationReady?: (request: AuthorizationReady) => void;
};
export type ConnectOptions = CommonOptions & (
  | { authorization?: { mode?: 'popup' | 'tab'; width?: number; height?: number; position?: AuthorizationPosition }; onAuthorizationRequired?: (request: AuthorizationRequired) => void }
  | { authorization: { mode: 'manual'; position?: AuthorizationPosition }; onAuthorizationRequired: (request: AuthorizationRequired) => void }
);
export type ButtonPresentationUpdate = Readonly<{
  /** Explicit undefined restores the default; omitted fields remain unchanged. */
  locale?: Locale | undefined;
  theme?: 'auto' | 'light' | 'dark' | undefined;
  size?: 'sm' | 'md' | undefined;
  label?: string | undefined;
}>;
export type ButtonOptions = CommonOptions & {
  authorization?: { mode?: 'popup' | 'tab' | 'manual'; width?: number; height?: number; position?: AuthorizationPosition };
  label?: string;
  theme?: 'auto' | 'light' | 'dark';
  size?: 'sm' | 'md';
  onSuccess: (result: ConnectResult) => void | Promise<void>;
  onError?: (error: import('./errors.js').ConnectError) => void;
  onAuthorizationRequired?: (request: AuthorizationRequired) => void;
};
export type ButtonController = Readonly<{
  cancel(): void;
  update(patch: ButtonPresentationUpdate): void;
  destroy(): void;
}>;
