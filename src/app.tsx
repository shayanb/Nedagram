import { signal } from '@preact/signals';
import { Layout } from './components/Layout';
import { Send } from './pages/Send';
import { Receive } from './pages/Receive';
import { Help } from './pages/Help';
import { DebugLog } from './components/DebugLog';
import { UpdateToast } from './components/UpdateToast';

type Page = 'send' | 'receive' | 'help';

const currentPage = signal<Page>('send');
const offlineReady = signal(false);

// Check if service worker is ready
if ('serviceWorker' in navigator) {
  navigator.serviceWorker.ready.then(() => {
    offlineReady.value = true;
  });
}

export function App() {
  const handleNavigate = (page: Page) => {
    currentPage.value = page;
  };

  const renderPage = () => {
    switch (currentPage.value) {
      case 'send':
        return <Send />;
      case 'receive':
        return <Receive />;
      case 'help':
        return <Help />;
    }
  };

  return (
    <Layout
      currentPage={currentPage.value}
      onNavigate={handleNavigate}
      offlineReady={offlineReady.value}
    >
      {renderPage()}

      {/* Debug log panel - always visible for bug reporting */}
      <DebugLog />

      {/* Update notification toast */}
      <UpdateToast />
    </Layout>
  );
}
