---
name: land-redirect
description: >
  Настроить многофайловый нутра-ленд на ОТДЕЛЬНОМ домене-редиректе и подключить через
  оффер в Binom EU (Бином 302 → редирект-домен). Флоу: адаптация ленда из архива
  (landNotOneFile.md) → заливка файлов в уникальную папку /{N}/ на редирект-домене →
  создание оффера в Бином с именем "ARB | GEO | ПП | OFFER | Land N | flow FLOW" и url
  https://redirect-домен/N/?clickid={clickid}&path={path_name}... → success(1)_white.php →
  success(1).php на вайт → (1я настройка) Palladium+Binom-интеграция вайта → локальный архив.
  Use when user says: "/land-redirect", "ленд через редирект", "ленд на отдельный домен +
  оффер в бином", "настрой ленд-редирект", attaches архив + вайт + домен-редиректа + flow/offer/ПП.
  Do NOT use for: onefile integrated-ленд в Бином (land-binom), преленд+ленд (landpair),
  re-skin без деплоя (nutra-land).
---
> 🔧 **Paperclip-контекст (отличие от arb-версии):** ExpDB — НАПРЯМУЮ
> `~/.claude/scripts/expdb-query.sh -r db-admin -t -A "SELECT site_ssh_password FROM production.domains WHERE domain_name='<домен>'"`
> (у Paperclip-агента НЕТ subagent `expdb-manager`). **ОБЯЗАТЕЛЬНО `-r db-admin`** — дефолтная роль
> `db-app` режет RLS → `production.domains` отдаёт 0 строк (выглядит как «домен не найден»).
> Везде где в шагах ниже сказано «Agent(subagent_type="expdb-manager")» — заменить на этот прямой запрос,
> распарсить пароль из вывода и передать в lib-скрипты (`--password`). Lib и доноры — те же абсолютные пути.


# /land-redirect — многофайл-ленд → редирект-домен + оффер Binom EU + вайт

Тонкий оркестратор. Сборка ленда — по канон-спеке **`/home/ubuntu/arb/NUTRA/landNotOneFile.md`**. Деплой — через lib **`/home/ubuntu/arb/.claude/skills/nutra-deploy-lib/scripts/`**.

LIB=`/home/ubuntu/arb/.claude/skills/nutra-deploy-lib/scripts`

## 1. Входы (спросить ТОЛЬКО недостающее)

| Вход                                                      | Для чего                                | Пример                       |
| --------------------------------------------------------- | --------------------------------------- | ---------------------------- |
| **Архив ленда**                                           | исходник                                | `/path/land.zip`             |
| **Вайт-домен**                                            | подключён к Биному; куда success        | `mojzdravie.com`             |
| **Домен редиректа**                                       | где лежит ленд                          | `dobryvek.org`               |
| **flow id**                                               | api/stream                              | `406781`                     |
| **offer id**                                              | api                                     | `14328`                      |
| **ПП**                                                    | ветка api/success                       | `nutraleads` \| `terraleads` |
| (nutra) **ссылка потока**                                 | курл/`$urls`                            | даёт юзер                    |
| **GEO**                                                   | имя оффера, `<html lang>`, tl-validator | `BG` (даёт юзер)             |
| **offer (название)**                                      | имя оффера в Бином                      | `Hond Rodin`                 |
| (1я настройка) **имя кампании Palladium** + **binom_key** | интеграция вайта                        | даёт юзер                    |

**Производные:** арб+тег (`arb_lookup`), номер ленда (`next_land_number`), номер папки `N` редиректа (короткий уникальный, напр. `=LANDNO` или своя цифра), first-setup — авто.

## 2. Сборка многофайл-ленда (по landNotOneFile.md)

Клон эталона: **`NUTRA/srj/landing-terra-srj-sk-flow406769`** (terra) — entry `<N>.php`/`index.php`, `apiterra<ident>.php`, `success1.php`+`success1_white.php`, `script_land.js`, `tl-validator.js`. Nutra — клон nutra-донора (`api<site>.php` push.json + `success.php`+`success_white.php`).

Шаги (детали — landNotOneFile.md): пути root-абсолютные (asset-папки можно в подпапку, но т.к. весь ленд уже в своей `/{N}/` — достаточно относительных от `/{N}/`) · форма `action="/api<ident>.php?<?=http_build_query($_GET);?>"` + 11 hidden-полей (`sub_id`,`path`,utm,`gclid`/`gbraid`/`wbraid`,`fbclid`) · `api<ident>.php`: push в ПП + **редирект на вайт** `https://<white>/success(1).php` (Шаг 7B, `utm_campaign`=вайт) + локальный fallback · click-курл показов (Шаг 6, nutra) · success-парсер path + gtag conversion · `success(1)_white.php` = копия для вайта · entry назвать `<N>.php`/`index.php` (для папки `/{N}/` — `index.php`).

> ⚠ Это НЕ integrated — макросы `{clickid}` идут в URL (GET), не подставляются Биномом. `index.php` ленда читает `$_GET`.

Verify: `php -l` всех · `action`=`/api<ident>.php` на каждой форме · api offer/stream/country верны · редирект → вайт success · `land/order`=0.

## 3. Деплой (lib)

```bash
. $LIB/common.sh
IFS='|' read -r WS NAME TAG <<<"$(arb_lookup "<арб>")"
LANDNO=$(next_land_number); N="$LANDNO"   # или своя короткая цифра для папки редиректа
```

**3a. SFTP-пароли (ExpDB round-trip для ОБОИХ доменов — НЕ показывать юзеру):**
для `<white>` И `<redirect>`: `$LIB/resolve-sftp.sh <domain>` → `.agent_prompt` → **Agent(expdb-manager)** → `{"site_ssh_password":...}`.

**3b. Ленд → редирект-домен `/{N}/`:**

```bash
$LIB/redirect-deploy.sh --domain <redirect> --password "<pw_redirect>" --src <site_dir> --index "$N"
# → url_base https://<redirect>/<N>/
```

**3c. Оффер в Бином:**

```bash
$LIB/binom-offer.sh --tag "$TAG" --geo "$GEO" --pp "$PP_LABEL" --offer "$OFFER" \
    --landno "$LANDNO" --flow "$FLOW" --redirect <redirect> --index "$N" --country "$GEO"
# → {"offer_id":N,"url":"..."}   (url с неизменными параметрами зашит в скрипте)
```

**3d. first-setup вайта** (как в land-binom 3b): `first-setup.sh` → если `true` → `palladium-fetch.sh` + `integrate-white.sh --binom-key <KEY>`.

**3e. success на вайт:**

```bash
$LIB/white-deploy.sh --domain <white> --password "<pw_white>" \
    --put "<site>/success1_white.php:success1.php"   # terra; nutra → success_white.php:success.php
```

## 4. Архив + отчёт

```bash
$LIB/archive.sh --workspace $WS --src <site_dir> --landid $LANDNO --geo $GEO \
    --offer "$OFFER" --flow $FLOW --info "$(printf 'ПП: %s\nflow: %s\noffer: %s\nbinom offer_id: %s\nредирект: https://%s/%s/\nвайт: %s\n' "$PP" "$FLOW" "$OFFER" "$OID" "$REDIRECT" "$N" "$WHITE")"
```

Отчёт: арб/тег, имя оффера + offer_id + url, ленд на редирект-домене (`https://<redirect>/<N>/`), success на вайте, first-setup (да/нет), путь архива. Сказать всё ли верно.

## Системные правила (НЕ нарушать)

- ExpDB — ТОЛЬКО через `expdb-manager`. Архитектура `proxy→MEGA`, никакого nginx.
- url оффера — шаблон из `binom-offer.sh` (остальные параметры НИКОГДА не меняются), меняется только домен+`<N>`.
- api-имя уникально на ленд; формы action = относительный. Без эмодзи/комментов в коде ленда.
- Откат: `binom-delete.sh --offer <id>`.
