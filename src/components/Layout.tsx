import { ComponentChildren } from 'preact';
import { useI18n, setLanguage, type Language } from '../i18n';
import { isRTL, currentLanguage } from '../i18n';
import { effectiveTheme, toggleTheme } from '../theme';
import './Layout.css';

interface LayoutProps {
  children: ComponentChildren;
  currentPage: 'send' | 'receive' | 'help';
  onNavigate: (page: 'send' | 'receive' | 'help') => void;
  offlineReady?: boolean;
}

export function Layout({ children, currentPage, onNavigate, offlineReady }: LayoutProps) {
  const { t } = useI18n();

  const toggleLanguage = () => {
    const newLang: Language = currentLanguage.value === 'en' ? 'fa' : 'en';
    setLanguage(newLang);
  };

  return (
    <div class="layout" dir={isRTL.value ? 'rtl' : 'ltr'}>
      <header class="header">
        <div class="header-content">
          <h1 class="logo">{t.app.title}</h1>
          <div class="header-actions">
            {offlineReady && (
              <span class="offline-badge">{t.app.offlineReady}</span>
            )}
            <button
              class="theme-toggle"
              onClick={toggleTheme}
              aria-label="Toggle dark mode"
            >
              {effectiveTheme.value === 'dark' ? (
                <svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2">
                  <circle cx="12" cy="12" r="5" />
                  <path d="M12 1v2M12 21v2M4.22 4.22l1.42 1.42M18.36 18.36l1.42 1.42M1 12h2M21 12h2M4.22 19.78l1.42-1.42M18.36 5.64l1.42-1.42" />
                </svg>
              ) : (
                <svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2">
                  <path d="M21 12.79A9 9 0 1 1 11.21 3 7 7 0 0 0 21 12.79z" />
                </svg>
              )}
            </button>
            <button
              class="lang-toggle"
              onClick={toggleLanguage}
              aria-label="Toggle language"
            >
              {currentLanguage.value === 'en' ? 'فارسی' : 'EN'}
            </button>
          </div>
        </div>
      </header>

      <main class="main">
        {children}
      </main>

      <nav class="nav safe-bottom">
        <button
          class={`nav-item ${currentPage === 'send' ? 'active' : ''}`}
          onClick={() => onNavigate('send')}
        >
          <svg class="nav-icon" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2">
            <path d="M22 2L11 13M22 2l-7 20-4-9-9-4 20-7z" />
          </svg>
          <span>{t.nav.send}</span>
        </button>
        <button
          class={`nav-item ${currentPage === 'receive' ? 'active' : ''}`}
          onClick={() => onNavigate('receive')}
        >
          <svg class="nav-icon" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2">
            <path d="M12 2v16M5 12l7 7 7-7" />
          </svg>
          <span>{t.nav.receive}</span>
        </button>
        <button
          class={`nav-item ${currentPage === 'help' ? 'active' : ''}`}
          onClick={() => onNavigate('help')}
        >
          <svg class="nav-icon" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2">
            <circle cx="12" cy="12" r="10" />
            <path d="M9.09 9a3 3 0 0 1 5.83 1c0 2-3 3-3 3M12 17h.01" />
          </svg>
          <span>{t.nav.help}</span>
        </button>
      </nav>
    </div>
  );
}
