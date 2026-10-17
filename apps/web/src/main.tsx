import { StrictMode } from 'react';
import { createRoot } from 'react-dom/client';
// Google Sans Flex, bundled (works offline: the desk demo turns Wi-Fi off). OFL-1.1.
import '@fontsource-variable/google-sans-flex';
import { App } from './App.js';
import './brand.css';
import './material.css';
import { ErrorBoundary, ToastProvider } from './ui.js';

const root = document.getElementById('root');
if (root) {
  createRoot(root).render(
    <StrictMode>
      <ErrorBoundary>
        <ToastProvider>
          <App />
        </ToastProvider>
      </ErrorBoundary>
    </StrictMode>,
  );
}
