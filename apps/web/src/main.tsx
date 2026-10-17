import { StrictMode } from 'react';
import { createRoot } from 'react-dom/client';
// Google Sans Flex, bundled (works offline: the desk demo turns Wi-Fi off). OFL-1.1.
import '@fontsource-variable/google-sans-flex';
import { App } from './App.js';
import './brand.css';
import './material.css';
import './theme.css';
import { applyTheme, initialTheme } from './lib/theme.js';
import { ErrorBoundary, ToastProvider } from './ui.js';

// Theme before the first paint, so a dark-mode user never sees a white flash.
applyTheme(initialTheme());

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
