---
name: landpair
description: >
  Настроить ПАРУ преленд + ленд (нутра) и подключить в Binom EU. Преленд = onefile-бандл,
  заливается integrated в Бином (как land-binom); ленд = многофайл на домене-редиректа +
  оффер (как land-redirect). Юзер видит преленд → клик CTA → редирект на ленд. Флоу:
  сборка преленда (landOneFile.md, CTA=макрос offer_link, 2-я конверсия на клик) + ленда
  (landNotOneFile.md) → преленд→integrated Бином → ленд→редирект-домен /{N}/ + оффер →
  success на вайт → (1я настройка) Palladium+Binom вайта → локальный архив обоих.
  Use when user says: "/landpair", "пара преленд+ленд", "преленд и ленд в бином",
  "комбо преленд ленд", attaches ДВА архива (преленд+ленд) + вайт + редирект + flow/offer/ПП.
  Do NOT use for: одиночный integrated-ленд (land-binom), одиночный ленд-редирект (land-redirect).
---
> 🔧 **Paperclip-контекст (отличие от arb-версии):** ExpDB — НАПРЯМУЮ
> `~/.claude/scripts/expdb-query.sh -r db-admin -t -A "SELECT site_ssh_password FROM production.domains WHERE domain_name='<домен>'"`
> (у Paperclip-агента НЕТ subagent `expdb-manager`). **ОБЯЗАТЕЛЬНО `-r db-admin`** — дефолтная роль
> `db-app` режет RLS → `production.domains` отдаёт 0 строк (выглядит как «домен не найден»).
> Везде где в шагах ниже сказано «Agent(subagent_type="expdb-manager")» — заменить на этот прямой запрос,
> распарсить пароль из вывода и передать в lib-скрипты (`--password`). Lib и доноры — те же абсолютные пути.


# /landpair — преленд (integrated) + ленд (редирект) → Binom EU + вайт

Тонкий оркестратор = **смесь land-binom (преленд) + land-redirect (ленд)**. Канон-спеки: **`NUTRA/landOneFile.md`** (преленд-бандл) + **`NUTRA/landNotOneFile.md`** (ленд-редирект). Деплой — lib.

LIB=`/home/ubuntu/arb/.claude/skills/nutra-deploy-lib/scripts`

## 1. Входы (спросить ТОЛЬКО недостающее)

| Вход                                                      | Для чего                    | Пример                     |
| --------------------------------------------------------- | --------------------------- | -------------------------- |
| **Архив преленда**                                        | onefile-бандл (integrated)  | `/path/preland.zip`        |
| **Архив ленда**                                           | многофайл (редирект)        | `/path/land.zip`           |
| **Вайт-домен**                                            | подключён к Биному; success | `mojzdravie.com`           |
| **Домен редиректа**                                       | где лежит ленд              | `dobryvek.org`             |
| **flow id**, **offer id**, **ПП** (+nutra ссылка потока)  | api/курл                    | `406769` / `13754` / terra |
| **GEO**, **offer (название)**                             | имена в Бином               | `SK` / `Hond Rodin`        |
| (1я настройка) **имя кампании Palladium** + **binom_key** | интеграция вайта            | даёт юзер                  |

**Производные:** арб+тег (`arb_lookup`), `LANDNO` (`next_land_number`), папка `N` редиректа.

## 2. Сборка ПРЕЛЕНДА (onefile, формы НЕТ, конверсия на клик CTA)

Клон эталона: **`NUTRA/srj/prelanding-terra-srj-sk-flow406769`**. Ключевое (детали — landpair-логика в `NUTRA/landOneFile.md` + эталон):

- CTA-ссылка на ленд/оффер = **голый макрос Бинома `offer_link`** (НЕ `{landing_url}`/`href="#"`). Заменить ВСЕ.
- CTA класс `scroll_btn`; `script_preland.js` = клон эталона.
- Conversion-блок перед `</body>`: парсер `{path_name}`, **2-я конверсия** (`parts[4]`=`ACCT2/LABEL2`) фаерит `gtag conversion` на клик `a.scroll_btn` ПЕРЕД переходом (callback+fallback 1200ms). Преленд НЕ трогает `parts[1]` (это лид на success ленда).
- ⏱️ **Dwell-гейт клик-конверсии (клик + время).** 2-я конверсия (`parts[4]` + `event2`) фаерит только при **клике по CTA `a.scroll_btn` AND dwell ≥N сек на преленде** — оба условия. Клик — триггер (обязателен), время — гейт «слать ли конверсию»; клик <N сек → просто переход, без gtag/пикселя (отсекает случайные быстрые клики). Реком. порог **20000 мс (20с)** (srj 6009 / es-flow7001), менять по запросу.
  ```js
  var t0 = Date.now(); // при загрузке преленда
  // в обработчике клика a.scroll_btn:
  if (Date.now() - t0 >= 20000 && typeof window.gtag === 'function') {
    window.gtag('event','conversion',{ send_to: CONV, event_callback: go });
    binomEvent(2); setTimeout(go, 1200);
  } else { go(); } // <20с — переход без конверсии
  ```
- 📡 **Binom custom event-постбэк (поверх gtag-конверсии).** Дублируй сработку кастомным событием Binom — img-пиксель садит событие на `upd_clickid` (эндпоинт Binom `/sucsess` — `sucsess` НЕ опечатка). `<TRACKER>` = Binom-трекер юзера (**спросить**; пример `b2euro.com`). Хелпер в conversion-блоке (один раз):
  ```js
  var subid = '{clickid}';
  if (subid && subid.charAt(0) === '{') subid = ''; // макрос не подставлен -> пиксель пропустить
  function binomEvent(n){ if(!subid) return; var img=new Image();
    img.src='https://<TRACKER>/sucsess?upd_clickid='+encodeURIComponent(subid)+'&event'+n+'=1'; }
  ```
  **Маппинг:** `event1` = вовлечённая/скролл-конверсия (пассивный gate 40с + скролл), `event2` = **клик-конверсия** (переход преленд→ленд по `a.scroll_btn` / рулетка / двери).
  🔴 **Связка преленд+ленд: клик по CTA-переходу на ленд шлёт `event2`.** Вызвать `binomEvent(2)` в обработчике клика `a.scroll_btn` СРАЗУ после `gtag('event','conversion',...)`, ПЕРЕД навигацией — существующий `event_callback`+`setTimeout(go,1200)` даёт пикселю ~1.2с уйти. Фаерить только когда gtag-конверсия реально срабатывает (dwell-гейт пройден), один раз (за тем же флагом `done`, что и навигация).
  ⚠️ Событие включить в кампании Binom (Events → Enable event 1/2), иначе постбэк придёт, но не отобразится. Эталон event1+event2: `NUTRA/yarik/site-1100-...` (рулетка) / `site-1101-...` (двери).
- `build.php` = **улучшенный** клон `NUTRA/max/prelanding-terra-arthrolix-max-hu-flow406656/build.php` (непрозрачный PNG→JPEG q72 — у преленда большие hero, обычный `black-792/build.php` сохраняет PNG → бандл-гигант). `php build.php` → `index.php` (бандл). У преленда **НЕТ** api/success.

## 3. Сборка ЛЕНДА (многофайл, форма → api → success)

Идентично **land-redirect Шаг 2** (клон `NUTRA/srj/landing-terra-srj-sk-flow406769`): entry `index.php`, `apiterra<ident>.php` (push + редирект на вайт success), `success1.php`+`success1_white.php`, формы с 11 hidden, click-курл. `path` сегмент `parts[1]`=лид-конверсия на success.

> ⚠️ **Ленд лежит в `/{N}/`, НЕ в корне домена** (Бином-оффер ведёт на `https://<redirect>/<N>/`). Поэтому пути и `action` — **относительные** (НЕ root-абсолютные `/img/`,`/apiterra.php` как в доноре): `src="img/…"`, `action="apiterra<ident>.php?…"`, `script_land`/`tl-validator` — относительно. Иначе ассеты/форма уйдут в корень домена → 404. Прогнать по entry: `grep -oE '(src|href|action)="/' index.php` должно быть пусто (нет ведущего `/`).

## 4. Деплой (lib)

```bash
. $LIB/common.sh
IFS='|' read -r WS NAME TAG <<<"$(arb_lookup "<арб>")"
LANDNO=$(next_land_number); N="$LANDNO"
```

**4a. SFTP-пароли** `<white>` и `<redirect>` — через `resolve-sftp.sh` → **Agent(expdb-manager)** (НЕ юзеру).

**4b. ЛЕНД → редирект-домен `/{N}/`:**

```bash
$LIB/redirect-deploy.sh --domain <redirect> --password "<pw_redirect>" --src <land_dir> --index "$N"
```

**4c. ПРЕЛЕНД → integrated в Бином** (имя как у ленда land-binom):

```bash
LANDER_NAME=$(binom_name "$TAG" "$GEO" "$PP_LABEL" "$LANDNO" "$OFFER" "$FLOW")
$LIB/binom-lander.sh --name "$LANDER_NAME" --file <preland_dir>/index.php \
    --slug "${TAG,,}_${GEO,,}_pre${LANDNO}_flow${FLOW}" --lang <iso>
```

**4d. Оффер в Бином** (url = ленд на редирект-домене; преленд через `offer_link` ведёт сюда):

```bash
$LIB/binom-offer.sh --tag "$TAG" --geo "$GEO" --pp "$PP_LABEL" --offer "$OFFER" \
    --landno "$LANDNO" --flow "$FLOW" --redirect <redirect> --index "$N" --country "$GEO"
```

**4e. first-setup вайта** (`first-setup.sh` → если `true` → `palladium-fetch.sh` + `integrate-white.sh --binom-key <KEY>`).

**4f. success на вайт:**

```bash
$LIB/white-deploy.sh --domain <white> --password "<pw_white>" \
    --put "<land_dir>/success1_white.php:success1.php"   # nutra → success_white.php:success.php
```

## 5. Архив (ОБА) + отчёт

```bash
$LIB/archive.sh --workspace $WS --src <preland_dir> --landid "${LANDNO}p" --geo $GEO --offer "$OFFER" --flow $FLOW --info "преленд (integrated) landing_id: $LID"
$LIB/archive.sh --workspace $WS --src <land_dir>    --landid "$LANDNO"   --geo $GEO --offer "$OFFER" --flow $FLOW --info "ленд (редирект) offer_id: $OID, https://$REDIRECT/$N/"
```

Отчёт: арб/тег; преленд → Бином integrated (landing_id) + offer_link; ленд → редирект `https://<redirect>/<N>/` + оффер (offer_id); success на вайте; first-setup (да/нет); пути архивов. Связка: преленд (integrated, клик offer_link) → оффер 302 → ленд. Сказать всё ли верно.

> ⚠️ **Скил создаёт КУСКИ (landing-преленд + offer-ленд), но НЕ собирает кампанию.** Финальный шаг — арб руками в Бином EU: в кампании назначить **landing = преленд** (`landing_id` из 4c) + **offer = ленд** (`offer_id` из 4d) + прописать `path`/traffic source. Только тогда `offer_link` в преленде резолвится в url ленда и цепочка работает. Явно выдать арбу landing_id + offer_id для этой сборки.

## Системные правила (НЕ нарушать)

- ExpDB — ТОЛЬКО `expdb-manager`. Архитектура `proxy→MEGA`, без nginx.
- Преленд: `offer_link` голый (НЕ `{...}`), `scroll_btn`, 2-я конверсия `parts[4]` на клик. Ленд: лид `parts[1]` на success.
- url оффера — шаблон из `binom-offer.sh`. api-имя уникально. Без эмодзи/комментов в коде.
- Откат: `binom-delete.sh --lander <id> --slug <slug>` (преленд) + `--offer <id>` (ленд).
- **Consent Mode v2 — ОБЯЗАТЕЛЬНО на преленде И ленде** (default denied → gtag.js → update granted): преленд — `landOneFile.md` §«Часть 3 — Consent Mode v2»; ленд — `landNotOneFile.md` §Шаг 5. Без него метки отрабатывают неверно.
- **(1я настройка) Кампания вайта в Бином — Default path:** если ещё не создана — создать с **landing = `index.html` со СКОМПИЛИРОВАННЫМ исходником интегрируемого сайта** (браузерный View Source, не PHP) + **offer = `https://<white>`**. Детали — `integration-m2-dao/references/binom-config.md`. Константы `page.php` (EU): `b2euro.com/sucsess` + `API_KEY=f6802a221...` (шаблон `integrations/m2/eur/DAO/page.php` исправлен). (Это про БАЗОВУЮ кампанию вайта; финальная сборка преленд+ленд в кампании — отдельно, см. примечание выше.)
