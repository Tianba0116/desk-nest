import type { PetBridge } from '../shared/contracts/pet-ipc';

declare global {
  interface Window {
    petBridge: PetBridge;
  }
}

export {};
