# Подключение собственного TonConnect bridge

Wallet слушает SSE-мост, задаваемый `SSE_BRIDGE_URL` (`src/config.ts`).
Dapp'ы выбирают bridge из записи в [ton-connect/wallets-list](https://github.com/ton-connect/wallets-list), а не из конфига кошелька —
поэтому для работы «конца в конец» должны совпасть обе стороны.

## Обязательное условие согласования

`device.appName`, который кошелёк шлёт в `ConnectEventSuccess`, берётся из `APP_NAME` (env).
По спецификации wallets-list `app_name` обязан быть равен `device.appName`. Дефолт в `src/config.ts` — `'MyTonWallet'`
(нижний регистр `'mytonwallet'`) — уже занят оригинальным кошельком, поэтому нужен уникальный идентификатор.

Комбинация для деплоя (указать в Vercel Environment Variables):

| Переменная                | Значение                                                          |
|---------------------------|-------------------------------------------------------------------|
| `SSE_BRIDGE_URL`          | `https://gradosphera-tonconnect-bridge.dao-f7d.workers.dev/bridge/` (слэш обязателен) |
| `APP_NAME`                | `GradospheraWallet`                                                 |
| `TONCONNECT_UNIVERSAL_URL`| домен кошелька, если он отличен от дефолтного (см. ниже)           |

Без явного `SSE_BRIDGE_URL` при сборке подставляется дефолт `https://tonconnectbridge.mytonwallet.org/bridge/`
(кошелёк продолжает работать через мост оригинального MyTonWallet — безопасный режим по умолчанию).

## Как достигается `universal_url`

Запись использует `universal_url` с параметрами Ton Connect. Dapp открывает
`universal_url?<v|id|r|ret>`, в этой ссылке должен быть распознан deeplink.

В коде распознавание TonConnect-ссылок жёстко завязано на `TONCONNECT_UNIVERSAL_URL`
(`https://connect.mytonwallet.org`) в `src/util/deeplink/constants.ts`
(и checkin.mytonwallet.org), а также на схемы `SELF_PROTOCOL`/`TONCONNECT_PROTOCOL`.
Чтобы dapp попадал в наш web-кошелёк, нужно одно из:
- добавить наш `universal_url` (и, при необходимости, redirect-домен) в `TONCONNECT_UNIVERSAL_URL`/`SELF_UNIVERSAL_URLS`,
  заведя эти значения через env (webpack `EnvironmentPlugin`), либо
- определить переводящий домен (аналог `connect.mytonwallet.*`) на деплой: отдельный Vercel-проект/Worker,
  который отдаёт `universal_url`-параметры.

`deepLink` на чисто web-кошелёк не работает (нет нативного приложения) — поле оставлено формальным,
реальная связка идёт через `universal_url`.

## Внутренние self-lookup кошелька

Код самопоиска `walletInfo.appName === 'mytonwallet'` есть в:
- `src/multisend/index.tsx:50` — поиск собственной записи в списке кошельков для кнопки «подключить кошелёк»;
- `src/giveaways/index.tsx:51` — аналогично для giveaways.

После смены `APP_NAME` на `GradospheraWallet` эти сравнения надо обновить на `walletInfo.appName === APP_NAME.toLowerCase()`
(константа `APP_NAME` импортируется из `src/config`), иначе мини-приложения продолжат искать оригинального `mytonwallet`.

## Публикация

1. Задеплоить bridge (`cf-bridge/`, см. его README): `npx wrangler deploy`.
2. Проверить мост: `curl https://gradosphera-tonconnect-bridge.dao-f7d.workers.dev/bridge/events` → 400.
3. Собрать и задеплоить web-кошелёк с env из таблицы выше.
4. Залить иконку `tonconnect-icon.png` (288×288, PNG, непрозрачный фон, без скруглений) на домен `image`.
5. Добавить запись из `gradosphera-wallet.json` **в конец** `wallets.json` (v2 → `wallets-v2.json`) PR'ом в `ton-connect/wallets-list`.

## Локальная проверка без публикации

Проверять связку можно через custom wallets list в dapp (SDK `ton-connect/ui` — `walletsListConfiguration`,
или ручной `WalletsListConfiguration` в `ton-connect/sdk`), где указать запись из `gradosphera-wallet.json`:
кошелёк откроется по `universal_url`, подпишется на наш bridge (`SSE_BRIDGE_URL`),
а dapp будет слать сообщения на URL из записи. Обе стороны должны указывать на один и тот же bridge.