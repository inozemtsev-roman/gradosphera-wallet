import { StorageKey, Storage, serializeValue, deserializeValue } from './telegramCloudTypes';

const TG_STORAGE_PREFIX = 'tc:';

function tgKey(name: StorageKey, slot: string): string {
  return `${TG_STORAGE_PREFIX}${slot}${name}`;
}

export class TelegramCloudMirror implements Storage {
  private readonly cloud: StoragePort;

  constructor(cloud: StoragePort) {
    this.cloud = cloud;
  }

  setItem(name: StorageKey, value: unknown): Promise<void> {
    const serialized = serializeValue(value);
    const chunks = splitChunks(serialized);
    return Promise.all(chunks.map((chunk, i) => this.cloud.setItem(tgKey(name, String(i)), chunk))).then(() => undefined);
  }

  getItem(name: StorageKey): Promise<unknown> {
    return Promise.all([0, 1, 2, 3].map((i) => this.cloud.getItem(tgKey(name, String(i))))).then((chunks) => {
      const serialized = joinChunks(chunks);
      return serialized === undefined ? undefined : deserializeValue(serialized);
    });
  }

  removeItem(name: StorageKey): Promise<void> {
    return [0, 1, 2, 3].reduce((pr, i) => pr.then(() => this.cloud.removeItem(tgKey(name, String(i)))), Promise.resolve());
  }

  clear(): Promise<void> { return Promise.resolve(); }

  getMany(keys: StorageKey[]): Promise<Record<string, unknown>> {
    return Promise.all(keys.map((key) => this.getItem(key)
      .then((value) => [key, { [key]: value }] as const))).then((entries) => Object.assign({}, ...entries.map((e) => e[1])));
  }

  getManyFull(): Promise<Record<string, unknown>> { return this.getMany([]).then(() => ({})); }
}

function splitChunks(serialized: string): string[] {
  const CHUNK_SIZE = 3760 * 2; // CloudStorage ~4096B/key; keep margin for JSON wrapper
  return serialized.length <= CHUNK_SIZE ? [serialized] : [serialized.slice(0, CHUNK_SIZE), serialized.slice(CHUNK_SIZE)];
}

function joinChunks(chunks: string[]): string | undefined {
  const first = chunks[0];
  const second = chunks[1];
  return first === undefined ? undefined : second === undefined ? first : first + second;
}
