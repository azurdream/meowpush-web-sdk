import type { Locale } from '../types.js';

export type ResolvedLocale = 'zh-CN' | 'en';
type LanguagePreferences = Pick<Navigator, 'languages' | 'language'>;

function supportedLanguage(value: string): ResolvedLocale | undefined {
  try {
    const tag = new Intl.Locale(value);
    if (tag.language === 'en') return 'en';
    if (tag.language !== 'zh' || tag.script === 'Hant') return undefined;
    if (tag.script === 'Hans') return 'zh-CN';
    if (tag.script) return undefined;
    return !tag.region || tag.region === 'CN' || tag.region === 'SG' ? 'zh-CN' : undefined;
  } catch { return undefined; }
}

/** Select the first supported preference; Traditional Chinese is not mapped to Simplified. */
export function resolveLocale(locale: Locale | undefined, preferences?: LanguagePreferences): ResolvedLocale {
  if (locale === 'zh-CN' || locale === 'en') return locale;
  const candidates = [...(preferences?.languages ?? []), preferences?.language ?? ''];
  for (const language of candidates) {
    const supported = supportedLanguage(language);
    if (supported) return supported;
  }
  return 'en';
}

export function messages(locale: ResolvedLocale) {
  return locale === 'zh-CN' ? {
    label: '连接喵 Push', accessibleLabel: '连接喵 Push', accessibleDone: '已连接喵 Push，点击重置', hint: '将在 MeowPush 打开授权页面。',
    opening: '正在打开授权页面…', creating: '正在连接…', waiting: '等待授权…', retrying: '连接暂不可用，正在重试…',
    succeeded: '已填入，请继续保存表单。', rejected: '已拒绝授权。', expired: '请求已过期，请重新连接。', invalidated: '请求已失效，请重新连接。',
    cancelled: '已停止等待。已批准的应用仍可在 MeowPush 中管理。', error: '连接失败，请重试。',
    reopen: '重新打开授权页', continue: '继续授权', cancel: '取消等待', done: '已连接', callbackError: '已取得密钥，但表单处理失败。请联系此页面的维护者。',
    insecure: '请通过 HTTPS 或本机 localhost 打开此页面。', unavailable: 'MeowPush 暂时不可用，请稍后重试。', limited: '请求过于频繁，请稍后重试。',
    shortError: '连接失败', shortUnavailable: '暂时不可用', shortLimited: '请稍后再试', shortInsecure: '需要安全连接', shortNetwork: '网络连接失败',
    shortRejected: '授权已拒绝', shortExpired: '授权已过期', shortInvalidated: '授权已失效', shortCallbackError: '表单处理失败', shortTimeout: '等待超时', shortNotFound: '授权不可用', reset: '点击重置',
  } : {
    label: 'Connect MeowPush', accessibleLabel: 'Connect MeowPush', accessibleDone: 'Connected to MeowPush. Click to reset', hint: 'Opens a MeowPush authorization page.',
    opening: 'Opening authorization…', creating: 'Connecting…', waiting: 'Waiting for authorization…', retrying: 'Connection interrupted. Retrying…',
    succeeded: 'Key filled in. Continue saving your form.', rejected: 'Authorization declined.', expired: 'Request expired. Connect again.', invalidated: 'Request is no longer valid. Connect again.',
    cancelled: 'Stopped waiting. Approved applications remain available in MeowPush.', error: 'Could not connect. Please retry.',
    reopen: 'Reopen authorization', continue: 'Continue authorization', cancel: 'Cancel waiting', done: 'Connected', callbackError: 'Key received, but the form callback failed. Contact this page’s maintainer.',
    insecure: 'Open this page over HTTPS or local localhost.', unavailable: 'MeowPush is temporarily unavailable. Please try later.', limited: 'Too many requests. Please try later.',
    shortError: 'Could not connect', shortUnavailable: 'Service unavailable', shortLimited: 'Try again later', shortInsecure: 'HTTPS required', shortNetwork: 'Network error',
    shortRejected: 'Authorization declined', shortExpired: 'Authorization expired', shortInvalidated: 'Authorization invalid', shortCallbackError: 'Form callback failed', shortTimeout: 'Wait timed out', shortNotFound: 'Authorization unavailable', reset: 'Click to reset',
  };
}
