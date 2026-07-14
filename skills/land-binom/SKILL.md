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

### 2b. Конверсии — до 3 (покупка + скролл + клик). КАЖДАЯ стреляет в Google Ads (gtag) И в Binom-трекер (пиксель)

Каждая конверсия делает ДВЕ вещи одновременно: `gtag('event','conversion',{send_to:...})` → в Google Ads **и** `binomEvent(n)` (img-пиксель) → в Binom-трекер. Одна не заменяет другую.

**Три конверсии:**

| # | Конверсия | Триггер (оба условия) | gtag send_to | Binom-пиксель | Где живёт |
| - | --------- | --------------------- | ------------ | ------------- | --------- |
| 1 | **Покупка / лид** | сабмит формы → api → редирект | `parts[1]` (LABEL1) | — (лид ловит ПП/постбэк) | `success.php` |
| 2 | **Скролл (engaged)** | **75% скролла AND 40с** на странице | `convs[0]` | `binomEvent(1)` → `event1` | ленд (`index.php`) |
| 3 | **Клик** | **клик по кнопке AND 20с** (рулетка/двери/переход-на-оффер) | `convs[1]` | `binomEvent(2)` → `event2` | ленд (`index.php`) |

**`{path_name}` в Бином (Path → Name)** — формат, парсер режет по `+`:

```
AW_ID + LABEL1 + GA4 + TITLE + ACCT2/LABEL2 + ACCT3/LABEL3
```

| Сегмент | Что | Конверсия |
| ------- | --- | --------- |
| `parts[0]` = `AW_ID` | Google Ads аккаунт (без `AW-`) | config |
| `parts[1]` = `LABEL1` | Conversion Label | **#1 покупка** (success.php) |
| `parts[2]` = `GA4` | `G-XXXX` (опц.) | GA4 config |
| `parts[3]` = `TITLE` | заголовок (опц., может содержать `/`) | — |
| `parts[4]` = `ACCT2/LABEL2` | 1-й хвостовой `ACCT/LABEL` | **#2 скролл** (`convs[0]`) |
| `parts[5]` = `ACCT3/LABEL3` | 2-й хвостовой `ACCT/LABEL` | **#3 клик** (`convs[1]`) |

Парсер собирает ВСЕ хвостовые сегменты строгого вида `цифры(≥6)/label` **по порядку**: 1-й → скролл(#2), 2-й → клик(#3). Хочешь только 2 конверсии — не пиши `ACCT3/LABEL3` (клик отключится). Только 1 — не пиши оба хвоста.

**Как ставить (КОПИРОВАТЬ БЛОК 1-в-1, НЕ переписывать вручную):**

1. Вставить канонический conversion-блок ПЕРЕД `</body>` ленда:
   **`/home/ubuntu/arb/NUTRA/conversion-block-3conv.html`** — там уже: Consent Mode v2 (auto-grant), парсер `{path_name}` (Mode A GTM / Mode B AW), оба гейта (40с+75% скролл; клик+20с), оба `gtag('event','conversion',...)` + `binomEvent(1)`/`binomEvent(2)`, capture-phase делегация клика.
2. Заменить в блоке `b2euro.com` → на Binom-трекер юзера (**спросить**; пример `b2euro.com`).
3. Селектор клика (#3): по умолчанию `.rulet_button` (рулетка). Для другой кнопки/двери — поменять класс в блоке (`t.closest('.rulet_button')`). Кнопка крутит колесо/открывает — **навигации нет** → `event_callback` не нужен (в отличие от landpair-преленда, где клик = переход, см. skill `landpair`).
4. **Включить события в кампании Binom** (Events → Enable event 1 / event 2), иначе пиксель придёт, но не отобразится.

Эталон рабочего ленда (рулетка, 3 конверсии): архив-пример в задаче + `NUTRA/yarik/site-1100-...` / `site-1101-...` (двери).

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

> 🔴 **Скилл ТОЛЬКО создаёт landing-сущность (отдаёт `landing_id`). В `path` кампании его НЕ ставить.**
> Нутра-ленд (блек) = **rules-path**, арб цепляет ВРУЧНУЮ в правилах кампании. **Default path трогать ЗАПРЕЩЕНО** — там лежит скомпилированная копия главной вайта (View Source) + offer=`https://<white>` (см. §Системные правила). Нутра-ленд в default path = палево (блек отдаётся боту/модератору Google без клоаки). Выдать арбу только `landing_id`, путь он назначит сам.

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
- **Consent Mode v2 — ОБЯЗАТЕЛЬНО на ленде** (default denied → gtag.js → update granted): канон-блок в `landOneFile.md` §«Часть 3 — Consent Mode v2». Без него метки отрабатывают неверно.
- 🔴 **Нутра-ленд (блек) — НИКОГДА в default path. Только rules-path, цепляет арб вручную.** Два случая по состоянию кампании вайта в Бином:
  - **Кампания УЖЕ создана** (сайт настроен, на нём есть ленды/интеграция) → кампанию **не создавать и default path вообще НЕ ТРОГАТЬ**. Скилл только заливает ленд (отдаёт `landing_id`) — арб сам цепляет его в rules.
  - **Кампании НЕТ** (первая интеграция вайта) → создать кампанию вайта (как в §3b/1я настройка) и в **default path положить landing = скомпилированную копию главной вайта** (браузерный View Source, не PHP-шаблон) + **offer = `https://<white>`**. Без landing в default кампания в бином **не создастся** — это обязательный шаг создания, а не «белый ленд для клоаки».
  - Причина: Google-модератор/бот открывает кампанию без клоак-контекста и попадает в default → там обязана быть белая страница, иначе палево блека.
- **(1я настройка) создание кампании вайта:** default path = белая копия (landing) + offer по правилу выше. `CAMPAIGN_KEY` оттуда → `page.php`. Детали — `integration-m2-dao/references/binom-config.md`. Константы трекера в `page.php` (EU): `TRACKER_URL_TEMPLATE="https://b2euro.com/sucsess"`, `API_KEY="f6802a221fd481cbe55f51ce2d61dcf8f847ee359ab2bc0a91109252ddc6e02f"` (шаблон `integrations/m2/eur/DAO/page.php` — уже исправлен).
