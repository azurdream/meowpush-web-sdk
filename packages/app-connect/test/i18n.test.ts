import { describe, expect, it } from 'vitest';
import { resolveLocale } from '../src/internal/i18n.js';

describe('automatic supported-language selection', () => {
  it.each(['zh', 'zh-CN', 'zh-SG', 'zh-Hans', 'zh-Hans-CN', 'zh-Hans-TW'])('supports Simplified preference %s', (language) => {
    expect(resolveLocale('auto', { languages: [language], language })).toBe('zh-CN');
  });
  it.each(['zh-Hant', 'zh-TW', 'zh-HK', 'zh-MO', 'zh-Hant-CN', 'zh-US', 'fr-FR', 'not a locale'])('does not misclassify unsupported preference %s as Simplified', (language) => {
    expect(resolveLocale(undefined, { languages: [language], language })).toBe('en');
  });
  it('selects supported languages in browser preference order', () => {
    expect(resolveLocale('auto', { languages: ['fr-FR', 'zh-Hant', 'zh-CN', 'en-US'], language: 'fr-FR' })).toBe('zh-CN');
    expect(resolveLocale('auto', { languages: ['fr-FR', 'en-GB', 'zh-CN'], language: 'fr-FR' })).toBe('en');
  });
  it('uses navigator.language when languages are unavailable and honors explicit overrides', () => {
    expect(resolveLocale(undefined, { languages: [], language: 'zh-SG' })).toBe('zh-CN');
    expect(resolveLocale('en', { languages: ['zh-CN'], language: 'zh-CN' })).toBe('en');
    expect(resolveLocale('zh-CN', { languages: ['en-US'], language: 'en-US' })).toBe('zh-CN');
    expect(resolveLocale('auto')).toBe('en');
  });
});
