import { StorageType } from './types';

import { IS_CAPACITOR, IS_EXTENSION } from '../../config';
import capacitorStorage from './capacitorStorage';
import extensionStorage from './extension';
import idb from './idb';
import localStorage from './localStorage';
import { telegramCloudStorage, isTelegramCloudStorageAvailable } from './telegramCloud';

export let storage = IS_EXTENSION ? extensionStorage : IS_CAPACITOR ? capacitorStorage : idb;

export function setStorage(backend: Storage) {
  storage = backend;
}

export async function configureTelegramCloudStorage() {
  if (IS_EXTENSION || IS_CAPACITOR) {
    return;
  }
  if (!(await isTelegramCloudStorageAvailable())) {
    return;
  }

  setStorage(telegramCloudStorage);
}

export default {
  [StorageType.IndexedDb]: idb,
  [StorageType.LocalStorage]: localStorage,
  [StorageType.ExtensionLocal]: extensionStorage,
  [StorageType.CapacitorStorage]: capacitorStorage,
};
