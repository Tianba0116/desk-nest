import { StrictMode } from 'react';
import { createRoot } from 'react-dom/client';
import { Pet } from './Pet';
import './pet.css';

const root = document.getElementById('root');
if (root) {
  createRoot(root).render(
    <StrictMode>
      <Pet />
    </StrictMode>,
  );
}
