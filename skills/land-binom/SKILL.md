---
name: land-binom
description: >
  Настроить onefile-нутра-ленд и подключить его в Binom EU как integrated-лендинг
  (Бином сам отдаёт ленд). Полный флоу: адаптация ленда из архива под flow/offer/ПП →
  сборка single-file index-bundled.php (landOneFile.md) → заливка в Бином с именем
  "ARB | GEO | ПП | land N | OFFER | поток FLOW" → деплой api-файла + success на вайт →
  (при первой настройке) Palladium+Binom-интеграция вайта → локальный архив.
  Use when user says: "/land-binom", "залей ленд в бином", "onefile ленд в бином integrated",
  "настрой нутра-ленд и подключи к биному", attaches архив ленда + вайт-домен + flow/offer/ПП.
  Do NOT use for: ленд-редирект на отдельный домен (land-redirect), преленд+ленд (landpair),
  re-skin чужого ленда без деплоя (nutra-land), генерация ленда с нуля (wp-nutra-sergey).
---
> 🔧 **Paperclip-контекст (отличие от arb-версии):** ExpDB — НАПРЯМУЮ
> `~/.claude/scripts/expdb-query.sh -r db-admin -t -A "SELECT site_ssh_password FROM production.domains WHERE domain_name='<домен>'"`
> (у Paperclip-агента НЕТ subagent `expdb-manager`). **ОБЯЗАТЕЛЬНО `-r db-admin`** — дефолтная роль
> `db-app` режет RLS → `production.domains` отдаёт 0 строк (выглядит как «домен не найден»).
> Везде где в шагах ниже сказано «Agent(subagent_type="expdb-manager")» — заменить на этот прямой запрос,
> распарсить пароль из вывода и передать в lib-скрипты (`--password`). Lib и доноры — те же абсолютные пути.


# /land-binom — onefile-ленд → integrated в Binom EU + вайт

Тонкий оркестратор. Сборка ленда — по канон-спеке **`/home/ubuntu/arb/NUTRA/landOneFile.md`** (читать для деталей шагов). Деплой — через lib **`/home/ubuntu/arb/.claude/skills/nutra-deploy-lib/scripts/`**.

LIB=`/home/ubuntu/arb/.claude/skills/nutra-deploy-lib/scripts`

## 1. Входы (спросить ТОЛЬКО недостающее — не угадывать)

| Вход                                      | Для чего                                     | Пример                       |
| ----------------------------------------- | -------------------------------------------- | ---------------------------- |
| **Архив ленда**                           | исходник (часто конкурент)                   | `/path/land.zip`             |
| **Вайт-домен**                            | подключён к Биному; куда api/success         | `mojzdravie.com`             |
| **flow id**                               | api `$urls`/курл/stream                      | `7074`                       |
| **offer id**                              | api                                          | `33` / terra `14328`         |
| **ПП**                                    | ветка api/success                            | `nutraleads` \| `terraleads` |
| (nutra) **ссылка потока**                 | курл/`$urls` (`r.nutraleads.com/<slug>/...`) | даёт юзер                    |
| **GEO**                                   | имя в Бином, `<html lang>`, `$lang`          | `PT` (даёт юзер)             |
| **offer (название)**                      | имя ленда в Бином                            | `Alpha Beast`                |
| (1я настройка) **имя кампании Palladium** | скачать alg.php                              | даёт юзер                    |
| (1я настройка) **binom_key**              | `CAMPAIGN_KEY` в page.php                    | ~20 симв.                    |

**Производные (не спрашивать):** арб+тег — `arb_lookup <кто заказывает>` (`. $LIB/common.sh`); номер ленда — `next_land_number`; first-setup — определяется автоматом (Шаг 3).

## 2. Сборка onefile-бандла (по landOneFile.md)

Работать в копии распакованного архива. Клонировать эталоны из `NUTRA/`:

- **nutra (push.json):** api=`api<site>.php` ← клон `NUTRA/mir/black-792-107144-mir-flow6846/api792.php`; success=`success.php`; **click-курл нужен** (`r.nutraleads.com/<slug>/?...&only=code`).
- **terra (t-api.org):** api=`apiterra<ident>.php` ← клон `NUTRA/mir/site-hondrodin-terra-pt-flow406220-mir/apiterra.php`; success=`success1.php`; **БЕЗ nutra-курла** (`grep r.nutraleads.com index.php` = 0).

Шаги (детали — landOneFile.md): форма `action="/api<id>.php"` + hidden Binom-макросы (`subid={clickid}`,`path={path_name}`,utm,`gclid={t6}`/`{t9}`/`{t10}`) · top-PHP (terra=`error_reporting(0)`; nutra=курл) · GTM (head-статик + body-парсер `{path_name}`) · вычистить мусор донора/палево домена · `$urls`/offer/flow под ПП · success: `$lang`+GEO, path-парсер, gtag conversion · **build.php** (клон `black-792/build.php`, GD-реэнкод) → `php build.php` → `index-bundled.php`.

Verify бандла: `grep -oE "https?://[a-z0-9.-]+" index-bundled.php|sort -u` (только googletagmanager + nutra-курл если nutra; terra→r.nutraleads=0) · `php -l` всех php · форма action = имя api.

## 3. Деплой (lib)

```bash
. $LIB/common.sh
IFS='|' read -r WS NAME TAG <<<"$(arb_lookup "<арб>")"
LANDNO=$(next_land_number)
LANDER_NAME=$(binom_name "$TAG" "$GEO" "$PP_LABEL" "$LANDNO" "$OFFER" "$FLOW")  # PP_LABEL: NUTRAleads|TerraLeads
```

**3a. SFTP-пароль вайта (ExpDB round-trip — НЕ показывать юзеру):**

1. `$LIB/resolve-sftp.sh <white>` → `.agent_prompt`.
2. **Agent(subagent_type="expdb-manager", prompt=<agent_prompt>)** → распарсить `{"site_ssh_password":"<pw>"}`. (НЕ Bash к ExpDB напрямую — arb CLAUDE.md.)

**3b. first-setup вайта:**
`$LIB/first-setup.sh <white> <pw>` → `.first_setup`. Если `true` → нужны имя кампании Palladium + binom_key (спросить если не даны), затем:

```bash
$LIB/palladium-fetch.sh --campaign "<имя>" --out /tmp/alg.php
$LIB/integrate-white.sh --domain <white> --password "<pw>" --alg /tmp/alg.php --binom-key <KEY>
```

Если `false` — пропустить (трекер уже стоит).

**3c. Заливка ленда в Бином:**

```bash
$LIB/binom-lander.sh --name "$LANDER_NAME" --file <site>/index-bundled.php \
    --slug "${TAG,,}_${GEO,,}_land${LANDNO}_flow${FLOW}" --lang <iso>
# → {"landing_id":N,...}
```

**3d. api + success на вайт:**

```bash
$LIB/white-deploy.sh --domain <white> --password "<pw>" \
    --put "<site>/api<id>.php:api<id>.php" \
    --put "<site>/success.php:success.php"        # terra → success1.php:success1.php
```

## 4. Архив + отчёт

```bash
$LIB/archive.sh --workspace $WS --src <site_dir> --landid $LANDNO --geo $GEO \
    --offer "$OFFER" --flow $FLOW --info "$(printf 'ПП: %s\nflow: %s\noffer: %s\nbinom landing_id: %s\nвайт: %s\n' "$PP" "$FLOW" "$OFFER" "$LID" "$WHITE")"
```

Отчёт юзеру (human-readable): арб/тег, имя ленда в Бином + landing_id, ПП-ветка, flow/offer, что залито на вайт (api<id>.php, success), first-setup (да/нет, что интегрировано), путь архива. Проверить и явно сказать всё ли верно.

## Системные правила (НЕ нарушать)

- ExpDB — ТОЛЬКО через `expdb-manager` subagent (пароль вайта). Bash к ExpDB запрещён.
- Архитектура `proxy→MEGA` не трогать; никакого nginx. Файлы вайта на MEGA (`/var/www/{domain}/`).
- Форма action = относительный `/api<id>.php`, без хардкода домена. api-имя уникально на ленд.
- build.php обязан GD-реэнкодить. `block.php`/`page.php` донора не трогать.
- Бином-заливка идемпотентна по slug; для отката — `binom-delete.sh`.
- Без эмодзи на ленде; без комментариев в коде ленда (кроме функц-маркеров Consent Mode/phantom).
