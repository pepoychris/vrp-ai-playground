import { StrictMode } from 'react';
import { createRoot } from 'react-dom/client';

import { App } from './App';
import { applyCssTokens } from './scene/design-tokens';
import './index.css';

// The visual token file is the runtime source of the CSS custom properties, so the
// stylesheet never restates a colour by hand.
applyCssTokens();

const container = document.getElementById('root');

if (!container) {
  throw new Error('Root container #root is missing from index.html');
}

createRoot(container).render(
  <StrictMode>
    <App />
  </StrictMode>,
);
