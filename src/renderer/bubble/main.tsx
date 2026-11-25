import { StrictMode } from 'react';
import { createRoot } from 'react-dom/client';
import { Bubble } from './Bubble';
import './bubble.css';

const root = document.getElementById('root');
if (root) {
  createRoot(root).render(
    <StrictMode>
      <Bubble />
    </StrictMode>,
  );
}
