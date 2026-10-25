import type { StorageKey, Storage } from './types';

import { callWindow } from '../../util/windowProvider/connector';

// Telegram WebApp CloudStorage per-key limit is 4096 bytes; values above ignored
// for the mirror (IndexedDB remains the source of truth in the same webview session).
const CRITICAL_KEYS = new Set<StorageKey>([
  'accounts',
  'currentAccountId',
  'stateVersion',
  'publicKeys',
  'mnemonicsEncrypted',
]);

function parseValue(value: string | undefined): any {
  return value === undefined ? value : JSON.parse(value);
}

function serializeValue(value: any): string {
  return typeof value === 'string' ? value : JSON.stringify(value);
}

function isAvailable() {
  return Boolean((self as any).windowProvider);
}

export function setTelegramCloudStorageBackend(backend: Storage) {
  (self as any).windowProvider = { telegramCloudStorage: backend };
  (self as any).windowProviderAvailable = Boolean(backend);
}

export function isTelegramCloudStorageAvailable() {
  return isAvailable();
}

export const telegramCloudStorage: Storage = {
  async getItem(name: StorageKey, force?: boolean) {
    if (!isAvailable()) return undefined; // (no-op outside Telegram)
    const value = await callWindow('telegramCloudStorageGetItem', name, force);
    return parseValue(value);
  },

  setItem(name: StorageKey, value: any) {
    if (!isAvailable()) return Promise.resolve();
    let normalized: string | undefined;
    if (CRITICAL_KEYS.has(name)) {
      normalized = serializeValue(value);
      if (normalized.length > 4096) return Promise.resolve(); // too big for CloudStorage
    }
    return callWindow('telegramCloudStorageSetItem', name, normalized ?? JSON.stringify(value)).then(() => undefined);
  },

  removeItem(name: StorageKey) {
    if (!isAvailable()) return Promise.resolve();
    return callWindow('telegramCloudStorageRemoveItem', name);
  },

  clear() {
    if (!isAvailable()) return Promise.resolve();
    return callWindow('telegramCloudStorageClear');
  },

  getMany(keys: StorageKey[]) {
    if (!isAvailable()) return Promise.resolve({});
    return callWindow('telegramCloudStorageGetMany', keys).then((values: Record<string, any>) => {
      const result: Record<string, any> = {};
      for (const [key, value] of Object.entries(values)) {
        result[key] = parseValue(value);
      }
      return result;
    });
  },

  getAll() {
    if (!isAvailable()) return Promise.resolve({});
    return callWindow('telegramCloudStorageGetAll');
  },

  setMany(items: Record<StorageKey, any>) {
    if (!isAvailable()) return Promise.resolve();
    const mapped: Record<string, string | undefined> = {};
    for (const [key, value] of Object.entries(items)) {
      if (CRITICAL_KEYS.has(key as StorageKey)) {
        const normalized = serializeValue(value);
        if (normalized.length > 4096) continue; // too big for CloudStorage
        mapped[key] = normalized;
      }
    }
    return callWindow('telegramCloudStorageSetMany', mapped);
  },
};
