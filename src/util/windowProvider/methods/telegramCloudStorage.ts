import type {
  CloudStorage, CloudStorageKey, CloudStorageValue,
} from '@twa-dev/types';

declare global {
  interface Window {
    Telegram?: {
      WebApp?: {
        CloudStorage?: CloudStorage;
      };
    };
  }
}

function getCloudStorage(): CloudStorage | undefined {
  return window.Telegram?.WebApp?.CloudStorage;
}

function toPromise(getter: (callback: (error: string | null, result?: CloudStorageValue) => void) => void): Promise<CloudStorageValue | undefined> {
  return new Promise((resolve) => {
    const callback: Parameters<typeof getter>[0] = (error, result) => {
      if (typeof error === 'string' && error.length > 0) {
        resolve(undefined);
      } else {
        resolve(result);
      }
    };

    try {
      getter(callback);
    } catch {
      resolve(undefined);
    }
  });
}

export function telegramCloudStorageIsAvailable() {
  return Promise.resolve(Boolean(getCloudStorage()));
}

export function telegramCloudStorageGetItem(key: CloudStorageKey) {
  const cloudStorage = getCloudStorage();
  if (!cloudStorage) return Promise.resolve(undefined);
  return toPromise((callback) => cloudStorage.getItem(key, callback));
}

export function telegramCloudStorageSetItem(key: CloudStorageKey, value: CloudStorageValue) {
  return new Promise<boolean>((resolve) => {
    const cloudStorage = getCloudStorage();
    if (!cloudStorage) {
      resolve(false);
      return;
    }

    const callback: (error: string | null, result?: boolean) => void = (error) => {
      resolve(typeof error !== 'string' || error.length === 0);
    };

    try {
      cloudStorage.setItem(key, value, callback);
    } catch {
      resolve(false);
    }
  });
}

export function telegramCloudStorageRemoveItem(key: CloudStorageKey) {
  return new Promise<boolean>((resolve) => {
    const cloudStorage = getCloudStorage();
    if (!cloudStorage) {
      resolve(false);
      return;
    }

    const callback: (error: string | null, result?: boolean) => void = (error) => {
      resolve(typeof error !== 'string' || error.length === 0);
    };

    try {
      cloudStorage.removeItem(key, callback);
    } catch {
      resolve(false);
    }
  });
}

export function telegramCloudStorageGetKeys() {
  const cloudStorage = getCloudStorage();
  if (!cloudStorage) return Promise.resolve([]);
  return toPromise((callback) => cloudStorage.getKeys(callback as Parameters<typeof toPromise>[0] as any))
    .then((keys) => (keys as string[] | undefined) ?? []);
}