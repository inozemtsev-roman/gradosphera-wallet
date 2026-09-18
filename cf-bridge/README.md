# gradosphera TonConnect Bridge (Cloudflare Workers)

SSE bridge для TonConnect (протокол `spec/bridge.md`) на Cloudflare Workers + Durable Objects.
Реализует эндпоинты `GET /events` и `POST /message`, которые использует как dapp SDK
(`@tonconnect/sdk`, EventSource), так и кошелёк (`src/api/tonConnect/sse.ts`).

## Архитектура

```
        dapp / wallet
             │
             ▼
        Worker (роутинг, CORS, валидация)
        GET  /events?client_id=X  ─┐
        ┌──────────────────────────┘
        ▼
    Durable Object для клиента X
      ┌───────────────────────────┐
      │ • открытый SSE-стрим      │
      │ • очередь (TTL, SQLite)   │
      │ • heartbeat / last_event_id│
      └───────────────────────────┘
             ▲
        POST /message?to=X&ttl=.. ─┘   (роутится сразу в DO получателя)
```

- **Один Durable Object на `client_id`** (`idFromName(clientId)`). Открытый SSE-стрим держит DO
  активным неограниченно (wall-time для HTTP у Workers/DO без лимита при открытом response stream).
- **Очередь** хранится в SQLite-хранилище DO (`new_sqlite_classes`), переживает рестарты.
- **`last_event_id`**: при подключении/реконнекте читаем из query `last_event_id` или заголовка
  `Last-Event-ID` (EventSource ставит его автоматически из поля `id:`) и доигрываем сообщения.
- **Heartbeat** каждые 15s: по умолчанию legacy (комментарий `: heartbeat`, без `message`-событий —
  безопасно для форка кошелька); `heartbeat=message` → `data: heartbeat`.
- **Rate limit**: окно 30 запросов / 10s на IP внутри DO → `429` с `Retry-After`.

## Ограничения
- Один SSE-стрим = ОДИН `client_id` (запрос с несколькими через запятую вернёт 400).
  Для кошелька-форка это уже учтено: `src/api/tonConnect/sse.ts` открывает по одному
  EventSource на `client_id`.
- Рестарт деплоя рвёт открытые стримы; клиенты переподключаются сами (EventSource) с
  `last_event_id` — сообщения не теряются (лежат в очереди до TTL).

## Быстрый старт

Требуется Node.js ≥ 22 (в `cf-bridge/` есть `.nvmrc`):

```bash
nvm use          # подхватит версию из .nvmrc
cd cf-bridge
npm install
npm run dev                 # http://localhost:8787
# тест:
curl -i "http://localhost:8787/events?client_id=<64-hex>"
curl -i -X POST "http://localhost:8787/message?client_id=<hex-a>&to=<hex-b>&ttl=300" \
  --data 'encrypted-payload'
```

## Деплой

```bash
wrangler deploy
```

Если нужен свой домен:

```toml
# wrangler.toml
routes = [
  { pattern = "bridge.example.com", custom_domain = true },
]
```

## Подключение к кошельку

1. В `src/config.ts` заменить `SSE_BRIDGE_URL`:
   `https://gradosphera-tonconnect-bridge.<account>.workers.dev/bridge/`
   (обязателен завершающий `/`, дальше идут `events` / `message`).
2. `APP_NAME` (config.ts:16) должен совпадать с `device.appName` кошелька.
3. Для попадания в общий список кошельков TonConnect — PR в `ton-connect/wallets-list`
   с полем `bridge: [{ "type": "sse", "url": "https://.../bridge" }]`
   (см. README репозитория wallets-list).

## Проверка

- `npm run typecheck`
- `npx wrangler deploy --dry-run` — валидация бандла и конфига