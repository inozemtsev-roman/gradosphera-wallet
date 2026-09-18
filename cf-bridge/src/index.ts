import { DurableObject } from 'cloudflare:workers';

const MAX_TTL_SECONDS = 3000;
const DEFAULT_TTL_SECONDS = 300;
const MAX_BODY_BYTES = 64 * 1024;
const HEARTBEAT_MS = 15_000;
const RATE_LIMIT_MAX = 30;
const RATE_LIMIT_WINDOW_MS = 10_000;
const MSG_PREFIX = 'msg:';
const MSG_PAD = 12;

interface Environment {
  BRIDGE: DurableObjectNamespace<BridgeClient>;
}

interface MessageEntry {
  id: number;
  from: string;
  message: string;
  topic?: string;
  expiresAt: number;
}

class BodyTooLargeError extends Error {}

function isValidClientId(value: string | null | undefined): value is string {
  return !!value && /^[0-9a-fA-F]{64}$/.test(value);
}

function msgKey(id: number): string {
  return `${MSG_PREFIX}${String(id).padStart(MSG_PAD, '0')}`;
}

function sseEvent(entry: MessageEntry): string {
  const payload = JSON.stringify({ from: entry.from, message: entry.message });
  return `event: message\nid: ${entry.id}\ndata: ${payload}\n\n`;
}

function corsHeaders(extra: Record<string, string> = {}): Headers {
  const headers = new Headers({
    'Access-Control-Allow-Origin': '*',
    'Access-Control-Allow-Methods': 'GET, POST, OPTIONS',
    'Access-Control-Allow-Headers': '*',
    'Access-Control-Max-Age': '86400',
  });
  for (const [key, value] of Object.entries(extra)) {
    headers.set(key, value);
  }
  return headers;
}

async function readBodyLimited(request: Request, maxBytes: number): Promise<string> {
  const reader = request.body?.getReader();
  if (!reader) {
    return '';
  }
  const chunks: Uint8Array[] = [];
  let total = 0;
  try {
    for (;;) {
      const { done, value } = await reader.read();
      if (done) {
        break;
      }
      if (value) {
        total += value.byteLength;
        if (total > maxBytes) {
          throw new BodyTooLargeError();
        }
        chunks.push(value);
      }
    }
  } finally {
    reader.releaseLock();
  }
  const buffer = new Uint8Array(total);
  let offset = 0;
  for (const chunk of chunks) {
    buffer.set(chunk, offset);
    offset += chunk.byteLength;
  }
  return new TextDecoder().decode(buffer);
}

export default {
  async fetch(request: Request, env: Environment): Promise<Response> {
    const url = new URL(request.url);

    if (request.method === 'OPTIONS') {
      return new Response(null, { status: 204, headers: corsHeaders() });
    }

    if (url.pathname.endsWith('/events')) {
      const clientId = url.searchParams.get('client_id');
      if (!isValidClientId(clientId)) {
        return new Response('Invalid client_id', { status: 400, headers: corsHeaders() });
      }
      const stub = env.BRIDGE.get(env.BRIDGE.idFromName(clientId.toLowerCase()));
      return stub.fetch(request);
    }

    if (request.method === 'POST' && url.pathname.endsWith('/message')) {
      const to = url.searchParams.get('to');
      if (!isValidClientId(to)) {
        return new Response('Invalid "to" client_id', { status: 400, headers: corsHeaders() });
      }
      const rawTtl = url.searchParams.get('ttl');
      const ttl = rawTtl ? Number.parseInt(rawTtl, 10) : Number.NaN;
      if (Number.isNaN(ttl) || ttl <= 0 || ttl > MAX_TTL_SECONDS) {
        return new Response(`Invalid ttl (must be 1..${MAX_TTL_SECONDS})`, {
          status: 400,
          headers: corsHeaders(),
        });
      }
      const stub = env.BRIDGE.get(env.BRIDGE.idFromName(to.toLowerCase()));
      return stub.fetch(request);
    }

    return new Response('gradosphera tonconnect bridge: use GET /events or POST /message', {
      headers: corsHeaders(),
    });
  },
};

export class BridgeClient extends DurableObject<Environment> {
  private currentWriter: WritableStreamDefaultWriter<Uint8Array> | undefined;
  private heartbeatTimer: ReturnType<typeof setInterval> | undefined;
  private rateHits = new Map<string, number[]>();

  fetch(request: Request): Promise<Response> {
    const url = new URL(request.url);
    const ip = request.headers.get('cf-connecting-ip') ?? 'unknown';
    if (!this.consumeRateLimit(ip)) {
      return Promise.resolve(
        new Response('Too many requests', { status: 429, headers: corsHeaders({ 'Retry-After': '10' }) }),
      );
    }

    if (request.method === 'GET' && url.pathname.endsWith('/events')) {
      return this.subscribe(request, url);
    }
    if (request.method === 'POST' && url.pathname.endsWith('/message')) {
      return this.ingest(request, url);
    }
    return Promise.resolve(new Response('ok', { headers: corsHeaders() }));
  }

  // ---------------------------------------------------------------------------
  // GET /events?client_id=<hex>&last_event_id=<n>&heartbeat=[legacy|message]
  // ---------------------------------------------------------------------------
  private async subscribe(request: Request, url: URL): Promise<Response> {
    await this.purgeExpired();

    const headerId = request.headers.get('last-event-id');
    const paramId = url.searchParams.get('last_event_id');
    const rawLast = paramId ?? headerId;
    const lastEventId = rawLast ? Number.parseInt(rawLast, 10) : 0;
    const heartbeatIsMessage = url.searchParams.get('heartbeat') === 'message';

    const replay = await this.listMessagesAfter(lastEventId);

    const stream = new TransformStream<Uint8Array, Uint8Array>();
    const writer = stream.writable.getWriter();
    const encoder = new TextEncoder();

    this.cleanup();
    this.currentWriter = writer;
    this.heartbeatTimer = setInterval(() => {
      writer
        .write(encoder.encode(heartbeatIsMessage ? 'data: heartbeat\n\n' : ': heartbeat\n\n'))
        .catch(() => {});
    }, HEARTBEAT_MS);

    writer.closed
      .then(() => this.cleanup())
      .catch(() => this.cleanup());

    const response = new Response(stream.readable, {
      headers: {
        'Content-Type': 'text/event-stream',
        'Cache-Control': 'no-cache, no-store',
        Connection: 'keep-alive',
        ...Object.fromEntries(corsHeaders()),
      },
    });

    this.ctx.waitUntil((async () => {
      for (const entry of replay) {
        await writer.write(encoder.encode(sseEvent(entry))).catch(() => {});
      }
    })());

    return response;
  }

  // ---------------------------------------------------------------------------
  // POST /message?client_id=<hex>&to=<hex>&ttl=<n>&topic=<string>
  // ---------------------------------------------------------------------------
  private async ingest(request: Request, url: URL): Promise<Response> {
    await this.purgeExpired();

    const from = url.searchParams.get('client_id') ?? '';
    const rawTtl = url.searchParams.get('ttl');
    const ttl = rawTtl ? Number.parseInt(rawTtl, 10) : DEFAULT_TTL_SECONDS;
    const topic = url.searchParams.get('topic') ?? undefined;

    let body: string;
    try {
      body = await readBodyLimited(request, MAX_BODY_BYTES);
    } catch (error) {
      if (error instanceof BodyTooLargeError) {
        return new Response('Message too large', { status: 413, headers: corsHeaders() });
      }
      throw error;
    }
    if (!body) {
      return new Response('Empty message body', { status: 400, headers: corsHeaders() });
    }

    const id = await this.nextEventId();
    const entry: MessageEntry = {
      id,
      from: from.toLowerCase(),
      message: body,
      topic,
      expiresAt: Date.now() + ttl * 1000,
    };

    await this.ctx.storage.put(msgKey(id), entry);
    await this.scheduleCleanup(entry.expiresAt);

    if (this.currentWriter) {
      await this.currentWriter.write(new TextEncoder().encode(sseEvent(entry))).catch(() => {});
    }

    return new Response('ok', { headers: corsHeaders() });
  }

  // ---------------------------------------------------------------------------
  // Persisted message queue
  // ---------------------------------------------------------------------------
  private async nextEventId(): Promise<number> {
    const raw = await this.ctx.storage.get<number>('seq');
    const next = (raw ?? 0) + 1;
    await this.ctx.storage.put('seq', next);
    return next;
  }

  private async listMessagesAfter(lastEventId: number): Promise<MessageEntry[]> {
    const list = await this.ctx.storage.list<MessageEntry>({ prefix: MSG_PREFIX });
    const now = Date.now();
    const entries: MessageEntry[] = [];
    for (const [, entry] of list) {
      if (entry.expiresAt > now && entry.id > lastEventId) {
        entries.push(entry);
      }
    }
    entries.sort((a, b) => a.id - b.id);
    return entries;
  }

  private async purgeExpired(): Promise<void> {
    const now = Date.now();
    const list = await this.ctx.storage.list<MessageEntry>({ prefix: MSG_PREFIX });
    const expiredKeys: string[] = [];
    for (const [key, entry] of list) {
      if (entry.expiresAt <= now) {
        expiredKeys.push(key);
      }
    }
    if (expiredKeys.length > 0) {
      await this.ctx.storage.delete(expiredKeys);
    }
  }

  private async scheduleCleanup(expiresAt: number): Promise<void> {
    const current = (await this.ctx.storage.getAlarm()) ?? undefined;
    if (current === undefined || expiresAt < current) {
      await this.ctx.storage.setAlarm(expiresAt);
    }
  }

  async alarm(): Promise<void> {
    await this.purgeExpired();
    const list = await this.ctx.storage.list<MessageEntry>({ prefix: MSG_PREFIX });
    const now = Date.now();
    let next: number | undefined;
    for (const [, { expiresAt }] of list) {
      if (expiresAt > now && (next === undefined || expiresAt < next)) {
        next = expiresAt;
      }
    }
    const current = (await this.ctx.storage.getAlarm()) ?? undefined;
    if (next !== undefined && (current === undefined || next < current)) {
      await this.ctx.storage.setAlarm(next);
    }
  }

  // ---------------------------------------------------------------------------
  // Helpers
  // ---------------------------------------------------------------------------
  private consumeRateLimit(ip: string): boolean {
    const now = Date.now();
    const hits = (this.rateHits.get(ip) ?? []).filter((time) => now - time < RATE_LIMIT_WINDOW_MS);
    if (hits.length >= RATE_LIMIT_MAX) {
      this.rateHits.set(ip, hits);
      return false;
    }
    hits.push(now);
    this.rateHits.set(ip, hits);
    return true;
  }

  private cleanup(): void {
    if (this.heartbeatTimer !== undefined) {
      clearInterval(this.heartbeatTimer);
      this.heartbeatTimer = undefined;
    }
    this.currentWriter = undefined;
  }
}
