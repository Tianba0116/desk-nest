import { StrictMode } from 'react';
import { createRoot } from 'react-dom/client';
import { Chat } from './Chat';
import './chat.css';

const root = document.getElementById('root');
if (root) {
  createRoot(root).render(
    <StrictMode>
      <Chat />
    </StrictMode>,
  );
}
