import { StorageType } from './types';

import { IS_CAPACITOR, IS_EXTENSION } from '../../config';
import capacitorStorage from './capacitorStorage';
import extensionStorage from './extension';
import idb from './idb';
import localStorage from './localStorage';
import telegramCloud from './telegramCloud';
import { isTelegramCloudStorageAvailable } from './telegramCloud';

export let storage = IS_EXTENSION ? extensionStorage : IS_CAPACITOR ? capacitorStorage : idb;

export function setStorage(backend: Storage) {
  storage = backend;
}

// Idb remains the source of truth within the webview session; CloudStorage is
// only a durable mirror of the critical keys (they survive Telegram re-open).
async function createTelegramCloudMirrorStorage(cloud: Storage): Promise<Storage> {
  const getFromSource = (name: StorageKey, force?: boolean) => idb.getItem(name, force);

  const getItem = async (name: StorageKey, force?: boolean) => {
    const valueFromIdb = await getFromSource(name, force);
    if (valueFromIdb !== undefined) {
      return valueFromIdb;
    }
    // Lazy restore from the CloudStorage mirror.
    const restored = await cloud.getItem(name, force).catch(() => undefined);
    if (restored !== undefined && !force) {
      await idb.setItem(name, restored);
    }
    return restored;
  };

  const setItem = (name: StorageKey, value: any) =>
    idb.setItem(name, value)
      .then(() => cloud.setItem(name, value).catch(() => undefined));

  const removeItem = (name: StorageKey) =>
    idb.removeItem(name)
      .then(() => cloud.removeItem(name).catch(() => undefined));

  const clear = () =>
    idb.clear().then(() => cloud.clear().catch(() => undefined));

  return {
    getItem,
    setItem,
    removeItem,
    clear,
    async getMany(keys: StorageKey[], force?: boolean) {
      const result = await idb.getMany(keys, force);
      const missing = keys.filter((key) => result[key] === undefined);
      if (missing.length === 0) {
        return result;
      }
      const restored = await cloud.getMany(missing, force).catch(() => undefined);
      if (restored) {
        for (const key of missing) {
          if (restored[key] !== undefined) {
            result[key] = restored[key];
            if (!force) {
              await idb.setItem(key, restored[key]);
            }
          }
        }
      }
      return result;
    },
    async setMany(items: Record<StorageKey, any>) {
      await idb.setMany(items).catch(() => undefined);
      await cloud.setMany(items).catch(() => undefined);
    },
    async getAll() {
      const all = await idb.getAll();
      const restored = await cloud.getAll().catch(() => undefined);
      if (restored) {
        for (const [key, value] of Object.entries(restored)) {
          if (all[key] === undefined) {
            all[key] = value;
          }
        }
      }
      return all;
    },
  };
}

export async function configureTelegramCloudStorage() {
  if (IS_EXTENSION || IS_CAPACITOR) {
    return;
  }
  if (!(await isTelegramCloudStorageAvailable())) {
    return;
  }

  // Make idb the primary backend so already-created wallets are never dropped,
  // and CloudStorage a durable mirror of the critical keys.
  const mirror = await createTelegramCloudMirrorStorage(telegramCloud);
  setStorage(mirror);
}

export default {
  [StorageType.IndexedDb]: idb,
  [StorageType.LocalStorage]: localStorage,
  [StorageType.ExtensionLocal]: extensionStorage,
  [StorageType.CapacitorStorage]: capacitorStorage,
};
