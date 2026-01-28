import { useCallback } from 'preact/hooks';
import { swUpdateAvailable, applySwUpdate } from '../main';
import { useI18n } from '../i18n';
import './UpdateToast.css';

export function UpdateToast() {
  const { t } = useI18n();
  const hasUpdate = swUpdateAvailable.value !== null;

  const handleUpdate = useCallback(() => {
    applySwUpdate();
  }, []);

  if (!hasUpdate) return null;

  return (
    <div class="update-toast">
      <div class="update-content">
        <svg width="20" height="20" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2">
          <path d="M21 12a9 9 0 0 0-9-9 9.75 9.75 0 0 0-6.74 2.74L3 8" />
          <path d="M3 3v5h5" />
          <path d="M3 12a9 9 0 0 0 9 9 9.75 9.75 0 0 0 6.74-2.74L21 16" />
          <path d="M16 21h5v-5" />
        </svg>
        <span>{t.updateAvailable || 'New version available'}</span>
      </div>
      <button class="update-button" onClick={handleUpdate}>
        {t.updateNow || 'Update'}
      </button>
    </div>
  );
}
