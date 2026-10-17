// Wallet package entry: createWallet(cfg) picks the backend from config (WALLET_BACKEND).
import type { WalletPort } from 'core';
import { MockWallet } from 'core/mocks';
import type { WalletConfig } from './config.js';

export * from './config.js';
export * from './sync.js';

export async function createWallet(cfg: WalletConfig): Promise<WalletPort> {
  switch (cfg.backend) {
    case 'mock':
      return new MockWallet();
    case 'wdk-rgb': {
      // Loaded lazily so mock runs never load the native rgb-lib binary.
      const { WdkRgbWallet } = await import('./backend/wdk-rgb.js');
      return new WdkRgbWallet(cfg);
    }
    case 'rgb-lib':
      throw new Error('WALLET_BACKEND=rgb-lib is not implemented; use wdk-rgb or mock.');
  }
}
