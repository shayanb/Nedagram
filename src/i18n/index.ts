import { createContext } from 'preact';
import { useContext, useMemo } from 'preact/hooks';
import { signal, computed } from '@preact/signals';
import { en, type Translations } from './en';
import { fa } from './fa';

export type Language = 'en' | 'fa';

const translations: Record<Language, Translations> = { en, fa };

const rtlLanguages: Language[] = ['fa'];

function detectLanguage(): Language {
  const stored = localStorage.getItem('nedagram-lang');
  if (stored && (stored === 'en' || stored === 'fa')) {
    return stored;
  }
  const browserLang = navigator.language.split('-')[0];
  if (browserLang === 'fa') return 'fa';
  return 'en';
}

export const currentLanguage = signal<Language>(detectLanguage());

export const isRTL = computed(() => rtlLanguages.includes(currentLanguage.value));

export const t = computed(() => translations[currentLanguage.value]);

export function setLanguage(lang: Language) {
  currentLanguage.value = lang;
  localStorage.setItem('nedagram-lang', lang);
  document.documentElement.lang = lang;
  document.documentElement.dir = rtlLanguages.includes(lang) ? 'rtl' : 'ltr';
}

// Initialize document direction
if (typeof document !== 'undefined') {
  document.documentElement.lang = currentLanguage.value;
  document.documentElement.dir = isRTL.value ? 'rtl' : 'ltr';
}

// Helper to interpolate strings with {key} placeholders
export function interpolate(template: string, values: Record<string, string | number>): string {
  return template.replace(/\{(\w+)\}/g, (_, key) => String(values[key] ?? ''));
}

// Context for components (optional, signals work globally)
export const I18nContext = createContext<{
  lang: Language;
  setLang: (lang: Language) => void;
}>({
  lang: 'en',
  setLang: () => {},
});

export function useI18n() {
  return {
    t: t.value,
    lang: currentLanguage.value,
    isRTL: isRTL.value,
    setLanguage,
    interpolate,
  };
}
