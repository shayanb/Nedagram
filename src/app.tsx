import { signal } from '@preact/signals';
import { Layout } from './components/Layout';
import { Send } from './pages/Send';
import { Receive } from './pages/Receive';
import { Help } from './pages/Help';
import { DebugLog } from './components/DebugLog';

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

  // Only show debug log on send and receive pages
  const showDebugLog = currentPage.value === 'send' || currentPage.value === 'receive';

  return (
    <Layout
      currentPage={currentPage.value}
      onNavigate={handleNavigate}
      offlineReady={offlineReady.value}
    >
      {renderPage()}

      {/* Debug log panel - persistent across send/receive pages */}
      {showDebugLog && <DebugLog />}
    </Layout>
  );
}
