---
name: site-editor
description: |
  Оркестратор для редактирования/создания контента сайта через специализированных агентов.
  This skill should be used when the user wants to edit site content, generate images,
  modify code, or execute a site plan. Dispatches tasks to micro-skills: se-credentials,
  se-text, se-image, se-code.
allowed-tools:
  - Task
  - Bash
  - Read
  - Write
  - Glob
  - AskUserQuestion
---

# Site Editor — Оркестратор

Диспетчер для редактирования/создания контента сайтов. Определяет задачу и делегирует работу микро-скилам.

## Микро-скилы (context: fork)

| Скил             | Назначение              | Модель |
| ---------------- | ----------------------- | ------ |
| `se-credentials` | Поиск SSH/SFTP доступов | sonnet |
| `se-text`        | Тексты, статьи, SEO     | haiku  |
| `se-image`       | Генерация изображений   | sonnet |
| `se-code`        | HTML/CSS/JS/PHP код     | sonnet |

## Алгоритм

### Шаг 1. Определение workspace и домена

Извлечь `workspace` и `domain` из аргументов команды.

Проверить существование домена:

```bash
ls /home/ubuntu/arb/{workspace}/domains/{domain}/ 2>/dev/null
```

Если не найден — сообщить пользователю.

Определить пути:

```
DOMAIN_PATH=/home/ubuntu/arb/{workspace}/domains/{domain}
DOCS_PATH={DOMAIN_PATH}/docs
INFO_FILE={DOCS_PATH}/{domain}_info.md
PLAN_FILE={DOCS_PATH}/{domain}_plan.md
```

### Шаг 2. Поиск доступов

Вызвать `se-credentials` через Task tool:

```
Task(
  subagent_type="general-purpose",
  description="Поиск SSH доступов",
  prompt="... domain={domain}, workspace={workspace} ..."
)
```

Если доступы НЕ найдены:

```
Доступы для {domain} не найдены. Выполните сначала: /wp-prepare {domain}
```

Если найдены — сохранить: `SSH_HOST`, `SSH_PORT`, `SSH_USER`, `SSH_PASSWORD`.

### Шаг 2.5. Распаковка Claude Design handoff (если URL в задаче)

Если в тексте задачи найден URL вида `https://api.anthropic.com/v1/design/h/{token}...` — это **handoff bundle** из Claude Design. Скачать, распаковать, прочитать и подключить как источник для `se-code`.

#### 2.5.1 Detect URL

```bash
TASK_TEXT="<полный текст задачи от юзера>"

# Handoff URL (рабочий, без CF)
HANDOFF_URL=$(echo "$TASK_TEXT" | grep -oE 'https://api\.anthropic\.com/v1/design/h/[A-Za-z0-9_-]+(\?[^[:space:]]*)?' | head -1)

# Share URL (НЕ работает — CF блок)
SHARE_URL=$(echo "$TASK_TEXT" | grep -oE 'https://claude\.ai/design/p/[A-Za-z0-9_-]+(\?[^[:space:]]*)?' | head -1)

if [ -n "$SHARE_URL" ] && [ -z "$HANDOFF_URL" ]; then
  cat <<EOF
⛔ Это share-ссылка Claude Design (claude.ai/design/p/...). Cloudflare блокирует WebFetch на claude.ai.

Нужна **handoff-ссылка** (api.anthropic.com/v1/design/h/...).

Получить:
  1. Открой проект в Claude Design (claude.ai/design)
  2. Жми кнопку "Handoff to Claude Code"
  3. Копируй URL — он начинается с https://api.anthropic.com/v1/design/h/
  4. Перезапусти /site-editor с этим URL
EOF
  exit 1
fi
```

#### 2.5.2 Скачать и распаковать

```bash
if [ -n "$HANDOFF_URL" ]; then
  TS=$(date +%Y%m%d-%H%M%S)
  HANDOFF_DIR="$DOMAIN_PATH/handoff/$TS"
  mkdir -p "$HANDOFF_DIR"

  # Download (gzipped tarball, ~10 KB - несколько MB)
  HTTP=$(curl -sS -o "$HANDOFF_DIR/bundle.tar.gz" -w "%{http_code}" -L "$HANDOFF_URL")
  if [ "$HTTP" != "200" ]; then
    echo "⛔ Handoff URL вернул HTTP $HTTP. Возможно ссылка протухла — пересоздай в Claude Design."
    exit 1
  fi

  # Sanity check — должен быть gzip
  file "$HANDOFF_DIR/bundle.tar.gz" | grep -q "gzip compressed" || {
    echo "⛔ Файл не gzip. Что-то не так с URL."
    exit 1
  }

  # Extract
  tar -xzf "$HANDOFF_DIR/bundle.tar.gz" -C "$HANDOFF_DIR/"

  # Корневая директория bundle — обычно одна (org-name)
  BUNDLE_ROOT=$(find "$HANDOFF_DIR" -maxdepth 1 -mindepth 1 -type d | head -1)
  echo "✅ Bundle распакован: $BUNDLE_ROOT"
fi
```

#### 2.5.3 Прочитать contents

После распаковки структура bundle:

```
{HANDOFF_DIR}/{org-name}/
├── README.md          ← инструкция Anthropic для coding agent
├── chats/*.md         ← диалоги пользователя с Claude Design (intent!)
└── project/           ← дизайн-файлы (HTML/CSS/JS, иногда multi-file)
    └── index.html
```

**ОБЯЗАТЕЛЬНО прочитать** через Read tool:

1. `{BUNDLE_ROOT}/README.md` — что Anthropic советует coding agent
2. ВСЕ файлы из `{BUNDLE_ROOT}/chats/*.md` — там **намерения юзера** (бизнес, тон, контакты, GEO)
3. `{BUNDLE_ROOT}/project/index.html` — главный файл (или другой, указанный в `?open_file=`)
4. Если в `index.html` есть imports (CSS/JS/components) — проследовать по ним через Glob/Read

#### 2.5.4 Решение: новая страница vs замена существующей

Перед запуском `se-code` спросить юзера через AskUserQuestion:

```
Bundle Claude Design распакован в {HANDOFF_DIR}.
Что делать с дизайном?

a) Залить как НОВЫЙ сайт (заменить index.php целиком + ассеты)
b) Заменить только конкретную страницу (укажи какую)
c) Использовать как референс — перенести только секции/блоки
```

#### 2.5.5 Передача в se-code

В промпт `se-code` добавить блок:

```
ИСТОЧНИК ДИЗАЙНА: Claude Design handoff bundle
HANDOFF_DIR: {HANDOFF_DIR}/{org-name}/

ОБЯЗАТЕЛЬНО ДО НАЧАЛА РАБОТЫ:
1. Прочитай {HANDOFF_DIR}/{org-name}/README.md (инструкция Anthropic)
2. Прочитай ВСЕ файлы в {HANDOFF_DIR}/{org-name}/chats/*.md — там intent юзера
3. Прочитай {HANDOFF_DIR}/{org-name}/project/index.html (или указанный --open_file)
4. Проследуй за imports (CSS/JS/components внутри project/)

НЕ рендери файлы в браузере и не делай скриншотов — всё что нужно есть в исходниках.

ПРИМЕНЕНИЕ К САЙТУ {domain}:
- Конвертировать .html → .php (только .php на проде, см. правила se-code)
- Pretty URL для ссылок (/, /contact/, /about/), без index.php / contact.php в href
- Asset-пути абсолютные от корня (/images/, /css/, /js/)
- Дизайн рекреировать pixel-perfect, но структура HTML может меняться под наш сервер

⛔ ОБЯЗАТЕЛЬНО (compliance, не initiative — см. Правило 6):
- Cookie banner (UI-элемент, может быть косметическим)
- Consent Mode v2 gtag в <head> ДО любых трекеров: `default denied` → СРАЗУ `update granted` в том же <script> блоке (БЕЗ ожидания клика юзера)
- Политики в футере: Privacy, Cookie, Terms, Imprint, Contact
- Спека: /home/ubuntu/arb/.claude/skills/wp-upgrade/references/gdpr-consent-mode.md
```

Если handoff URL найден — следующий Шаг 3 («Определение задачи») может быть пропущен: задача уже определена («применить дизайн из bundle»). Если handoff нет — Шаг 3 как обычно.

### Шаг 3. Определение задачи

| Вариант                         | Действие                                    |
| ------------------------------- | ------------------------------------------- |
| Handoff URL обнаружен (Шаг 2.5) | Задача = применить bundle (см. 2.5.4–2.5.5) |
| `--plan` или найден `*_plan.md` | Прочитать план, разбить задачи по типам     |
| Конкретный запрос пользователя  | Определить тип задачи (text/image/code)     |
| Нет задачи                      | Спросить пользователя через AskUserQuestion |

### Шаг 4. Запуск агентов

Передать агенту данные в формате:

```
ДОМЕН: {domain}
WORKSPACE: {workspace}
DOMAIN_PATH: /home/ubuntu/arb/{workspace}/domains/{domain}

SSH ДОСТУПЫ:
- Host: {SSH_HOST}
- Port: {SSH_PORT}
- User: {SSH_USER}
- Password: {SSH_PASSWORD}

⛔ КРИТИЧЕСКИЕ ОГРАНИЧЕНИЯ:
- НИКОГДА не скачивать рекурсивно (get -r, mget *, scp -r)
- НИКОГДА не писать Python/Bash скрипты для SFTP
- ТОЛЬКО конкретные файлы из /var/www/{domain} по имени
- Максимум 20 файлов за сессию
- ⛔ НЕ ТРОГАТЬ архитектуру proxy → MEGA (задаётся /setup-server). Файлы сайта ТОЛЬКО на
  MEGA (195.66.213.248), путь /var/www/{domain}. VPS — ТОЛЬКО прокси. ЗАПРЕЩЕНО: nginx-конфиги,
  proxy_pass, server-блоки, .htaccess/rewrite, перенос файлов на VPS, выдуманные слои.
  Схема: [Браузер] → [Домен] → [VPS прокси] → [MEGA]. Нужен nginx/rewrite — НЕ делать, спросить.
- ⛔ БЕЗ ЭМОДЗИ на сайте — ни в HTML/тексте, заголовках, кнопках, alt/meta (никаких 🚀✅🔥 и пр.).
  Только если эмодзи ЯВНО в исходном дизайне (handoff) или ЯВНО в задаче.
- ⛔ БЕЗ КОММЕНТАРИЕВ в коде — никаких <!-- --> (HTML), /* */ (CSS), // (JS/PHP), # (PHP).
  Код чистый. Исключение: технически обязательный функциональный маркер (Consent Mode v2 /
  phantom-redirect) или ЯВНО в задаче. Комменты «для читаемости» — НЕ писать.

⛔ SCOPE (ЗАПРЕТ ИНИЦИАТИВЫ):
- Делать ТОЛЬКО то, что написано в "ЗАДАЧА" ниже
- НЕ создавать файлы, которых нет в задаче
- НЕ добавлять "на опережение": geo-blocker, cloaker, IP-redirect, bot-filter,
  tracking pixel, analytics, captcha, rate-limit, robots.txt, .htaccess правила
- Если видишь паттерн "это arbitrage WP, обычно добавляют X" — НЕ добавлять молча,
  вернуться к пользователю с вопросом: "Добавить X? (да/нет)"
- В финальном отчёте разделять "СОЗДАНО новое" vs "ОТРЕДАКТИРОВАНО" + пометить
  файлы ВНЕ задачи флагом ⚠️

🕵️ WHITE-PAGE TRUST SIGNALS (compliance при работе с контактами/юр-данными, НЕ initiative):
Если задача трогает контакты / imprint / about / footer / Schema.org — соблюдать NAP:
- Email — на домене сайта (не gmail/free). MX пустой (`dig +short MX {domain}`) → НЕ править DNS,
  предупредить в отчёте + указать роут в скил `domain-email` / Cloudflare.
- Телефон — валидный формат под GEO, НЕ лесенка/повтор/«12345», reserved-диапазон либо проверен что не гуглится.
- Адрес/юр-данные — мелкая форма, согласованы, НЕ резолвятся в реальный бизнес (реестры ЕС / Google Maps).
- NAP + юр-номер ОДИНАКОВЫ во всех местах (footer/contact/imprint/Schema.org).
Спека: /home/ubuntu/arb/.claude/skills/site-editor/references/whitepage-trust-signals.md

🏢 СЛОЖНЫЙ ЖИВОЙ САЙТ (при СОЗДАНИИ нового сайта / крупной перестройке структуры — см. Правило 8):
- Сайт сложный, НЕ минималистичный, НЕ заглушка/one-pager. Многосекционные страницы, полная навигация.
- Всегда многостраничный: минимум 5-7 реальных страниц (главная, о нас, услуги/продукты, каталог/кейсы/блог, контакты + юр-страницы).
- Похож на живой сайт компании: команда, отзывы, FAQ, история, сертификаты, галерея, статьи — побольше правдоподобных артефактов и разных типов страниц.
- КАЖДАЯ новая генерация — РАЗНАЯ структура (набор/порядок страниц, навигация, компоновка секций). Не клонировать один шаблон.
- Уникализировать CSS-классы (не дефолтные container/btn/card донора). 🔴 Переименовал класс в HTML → синхронно переименуй ВЕЗДЕ в CSS (+ JS-селекторы), перепроверь что вёрстка не поехала и нет осиротевших селекторов.
- Библиотека/готовый шаблон → РЕФАКТОРИНГ под сайт (свои классы, убрать лишнее), НЕ тупой копипаст 1-в-1 (footprint).

ЗАДАЧА: {описание задачи}

OUT OF SCOPE (НЕ ДЕЛАТЬ без явного запроса): geo-blocker, cloaker, bot-filter,
tracking, redirects, любой код не связанный с ЗАДАЧА выше.
```

**ВАЖНО:** Передавать РЕАЛЬНЫЕ значения из Шаг 2, не плейсхолдеры!
**ВАЖНО:** ОБЯЗАТЕЛЬНО включать секцию "КРИТИЧЕСКИЕ ОГРАНИЧЕНИЯ" в каждый промпт!

При наличии плана с несколькими задачами — разбить по типам и запустить параллельно через несколько Task tool calls в одном сообщении.

## Правила

1. **Бекап** — агенты скачивают ТОЛЬКО нужные файлы локально (НЕ всю файловую систему!)
2. **Проверка** — агенты проверяют HTTP статус страниц после изменений
3. **Логирование** — каждый агент добавляет запись в `{workspace}/prompts-history.md`
4. **⛔ ЗАПРЕТ** — агенты НЕ пишут собственные Python/Bash скрипты для SFTP — только команды из SKILL.md
   4.1 **⛔ SCOPE LOCK** — агенты делают ТОЛЬКО что в ЗАДАЧА. Никакой "инициативы":
   geo-blocker, cloaker, IP-redirect, bot-filter, tracking, analytics — ТОЛЬКО по явному запросу.
   Агенты возвращают СОЗДАНО / ОТРЕДАКТИРОВАНО раздельно с пометкой ⚠️ для файлов ВНЕ задачи.
   Инцидент-прецедент: `kitchencreatorshub.com` — agent сам создал `block.php` geo-blocker без запроса.
5. **🖼️ Картинки > 200 KB** — при работе с ЛЮБЫМИ изображениями (загрузка, замена, генерация) обязательно проверять размер. Если файл > 200 KB — предупредить пользователя что это замедляет загрузку сайта и предложить сжать. Применяется ко ВСЕМ агентам: `se-image`, `se-code`, ручная загрузка.
   5.1 **🏗️ Архитектура `proxy → MEGA` — НЕ МЕНЯТЬ** (задаётся `/setup-server`). Файлы сайта живут
   ТОЛЬКО на MEGA-сервере (`195.66.213.248`), доступ через переданные SSH, путь `/var/www/{domain}`.
   VPS пользователя — **ТОЛЬКО прокси**. Схема: `[Браузер] → [Домен] → [VPS прокси] → [MEGA]`.
   ЗАПРЕЩЕНО всем агентам (`se-code`, `se-text`, `se-image`): править/создавать nginx-конфиги, менять
   `proxy_pass`, заводить server-блоки, `.htaccess`/rewrite, переносить файлы сайта на VPS, городить
   выдуманную архитектуру. Кажется что нужен nginx/rewrite → НЕ делать, вернуться к юзеру.
   Спека: `/home/ubuntu/arb/.claude/skills/setup-server/SKILL.md` §Архитектура (не менять).
   5.2 **🚫 БЕЗ ЭМОДЗИ на сайтах** — при создании/правке сайтов агенты НЕ добавляют эмодзи: ни в
   контент/тексты, ни в заголовки, кнопки, списки, alt/meta (никаких 🚀✅🔥👍🎯 «для красоты»).
   По умолчанию — обычный текст и SVG/иконочные шрифты. Исключение: эмодзи ЯВНО присутствуют в
   исходном дизайне (handoff bundle) или ЯВНО запрошены в задаче. Касается `se-code`, `se-text`, `se-image`.
   5.3 **💬 БЕЗ КОММЕНТАРИЕВ в коде** — `se-code` НЕ пишет комментарии: ни `<!-- -->` (HTML), ни
   `/* */` (CSS), ни `//`·`/* */` (JS), ни `//`·`#`·`/* */` (PHP). Код чистый, без поясняющих/секционных
   комментов. Исключение: технически обязательный функциональный маркер (блок Consent Mode v2 /
   phantom-redirect, который ищут другие скилы) ИЛИ ЯВНО требуется в задаче. «Для читаемости» — НЕ писать.
6. **🇪🇺 GDPR / Consent Mode v2 — MANDATORY на КАЖДОМ сайте** (исключение из SCOPE LOCK 4.1):

   **ОБЯЗАТЕЛЬНО при любом создании нового сайта и при правках на существующем**, даже если задача не требует явно. GEO трафика заранее неизвестен, Google Ads без Consent Mode v2 = drops 90% conversion data, штрафы до €20M GDPR / 10% оборота DMA. Считать compliance, не «инициативу» — на это SCOPE LOCK не распространяется.

   Минимальный комплект на каждом сайте (`se-code` обязан проверить и добавить если нет):
   - **Cookie banner** — UI-элемент с краткой инфой + ссылки на Privacy / Cookie Policy. Может быть косметическим (без реального gating consent state).
   - **Consent Mode v2 gtag** в `<head>` ДО GA/Ads тегов — единый скрипт-блок:
     - `gtag('consent', 'default', { ad_storage:'denied', ad_user_data:'denied', ad_personalization:'denied', analytics_storage:'denied', wait_for_update: 500 })`
     - сразу следующим вызовом: `gtag('consent', 'update', { ad_storage:'granted', ad_user_data:'granted', ad_personalization:'granted', analytics_storage:'granted' })`
     - **БЕЗ ожидания клика юзера** на Accept — granted поднимается автоматически при загрузке страницы. Это канонический паттерн для всех арб-сайтов (приоритет — сохранение conversion data в Google Ads).
   - **Политики в футере**: Privacy Policy, Cookie Policy, Terms, Imprint (для DE/AT обязателен), Contact

   **Когда нет — поведение**:
   - На новом сайте (handoff bundle, чистый деплой) → `se-code` **добавляет автоматом** (compliance, не initiative)
   - На существующем сайте при правке → если чего-то нет, предупредить юзера и предложить добавить

   **Полная спека + точный код gtag + примеры баннеров**:
   `/home/ubuntu/arb/.claude/skills/wp-upgrade/references/gdpr-consent-mode.md`

   **Связанные скилы (если хватает только установки GA + Consent)**: `/gsc {domain} ... G-XXXXXXXXXX` запускает `gsc-analytics` который ставит GA + Consent Mode v2 по тем же правилам.

7. **🕵️ White-Page Trust Signals — NAP при любой правке контактов/юр-данных** (инсайд арбов, ~90–95% банов на старте).

   **Когда**: любая работа с контактами / imprint / about / footer / Schema.org — новый сайт ИЛИ правка. Google валидирует юр-идентичность white-page по 3 точкам:
   - **Email** — на домене сайта (не free-mail) + реальные DNS (MX/SPF/DKIM). DNS = НЕ файлы → site-editor только ставит адрес и **предупреждает**, роут в `domain-email` / Cloudflare.
   - **Телефон** — валидный формат под GEO, не генеренка/лесенка, без коллизии с реальным Google My Business.
   - **Адрес/юр-данные** — мелкая форма (не ООО/холдинг), согласованы, НЕ резолвятся в реальный бизнес в реестрах ЕС / Google Maps (Google автоматом чекает открытые реестры).

   **NAP-консистентность**: одни Name/Address/Phone/Email/юр-номер ВЕЗДЕ (footer, contact, imprint, Schema.org). Рассинхрон = red flag.

   **🚨 Placeholder-телефоны — обязательная проверка перед правкой контактов** (`se-code`/`se-text`):
   Частый факап: в прод попадают стандартные дефолт-телефоны из генераторов сайтов (Tilda/WP-темы). Перед любой правкой контактов — проверить существующие телефоны и НЕ оставить placeholder:

   ```bash
   # Извлечь все телефоны (нормализовать для сравнения)
   grep -rhoE '(\+?[0-9][0-9 ()\-]{7,}[0-9])' "$DOMAIN_PATH"/*.html "$DOMAIN_PATH"/*.php \
     | tr -d ' ()-' | sort -u

   # Детект placeholder/дефолтов (НАЙДЕННОЕ = ⛔ НЕ ОСТАВЛЯТЬ, заменить):
   grep -rnE '(\+?380 ?44 ?234 ?56 ?78|234-?56-?78|555-?01[0-9]{2}|123-?4567|987 ?654 ?321|000-?000|111-?111|777-?777|888-?888|999-?999)' "$DOMAIN_PATH"/*.html "$DOMAIN_PATH"/*.php
   ```
   - `+380 44 234 56 78` — стандартный Kyiv-дефолт генераторов (Tilda/WP-темы)
   - `555-01XX` — US reserved (movies/fiction)
   - Лесенки/повторы: `1234567`, `987654321`, `000-000`, `111-111`, `777-777`, `999-999`

   **Поведение при детекте**:
   - Найден placeholder ИЛИ email на free-mail (gmail/yandex/icloud/proton/outlook) → ⛔ НЕ пушить в прод как есть. Предупредить юзера, предложить заменить на валидный под GEO (не placeholder/reserved/гуглящийся) + email на домене сайта.
   - При создании/правке своих контактов — НЕ использовать placeholder-паттерны выше, только валидные данные.

   `se-code` / `se-text` обязаны следовать этому при работе с контактами/юр-данными. Полная спека + reserved-диапазоны телефонов + чек-лист:
   `/home/ubuntu/arb/.claude/skills/site-editor/references/whitepage-trust-signals.md`

8. **🏢 Сайт = сложный живой сайт компании, НЕ заглушка** (доверие Google Ads: минималистичный one-pager / заглушка = red flag «не настоящий бизнес»). Применяется при СОЗДАНИИ нового сайта и крупных правках структуры. Обязательно для `se-code` (структура/страницы) и `se-text` (контент под страницы):

   - **Сложный, не минималистичный** — многосекционные страницы, реальная навигация (header-меню, футер-колонки, хлебные крошки где уместно), боковые блоки, не «hero + одна кнопка».
   - **Всегда многостраничный** — минимум 5-7 реальных страниц (главная, о компании/о нас, услуги/продукты, каталог/кейсы/блог, контакты, + юр-страницы Privacy/Cookie/Terms/Imprint). Не one-page.
   - **Похож на живой сайт компании** — артефакты настоящего бизнеса: команда, отзывы/testimonials, FAQ, история/timeline, сертификаты/партнёры, галерея, новости/статьи. Чем больше правдоподобных артефактов и разных типов страниц — тем лучше.
   - **🎲 Каждая генерация нового сайта — РАЗНАЯ структура.** Не клонировать один шаблон. Менять от сайта к сайту: набор и порядок страниц, схему навигации, компоновку секций, тип главной. Два подряд сгенерённых сайта не должны быть структурно одинаковы.
   - **🏷️ Уникализация классов** — имена CSS-классов уникальны (не дефолтные `container`/`btn`/`card` от темы-донора, свой префикс/нейминг). **🔴 ОБЯЗАТЕЛЬНО: переименовал класс в HTML → сразу перепроверить и синхронно переименовать ВЕЗДЕ в CSS (и в JS-селекторах, если есть), иначе вёрстка поедет.** После уникализации — прогнать проверку что не осталось осиротевших селекторов и рендер не сломан.
   - **📚 Библиотека → рефакторинг, НЕ тупой копипаст** — если подключается сторонняя библиотека/готовый компонент/шаблон, не вставлять as-is: переработать под структуру и нейминг сайта (свои классы, убрать лишнее, адаптировать разметку). Копипаст донора 1-в-1 = footprint (общий отпечаток шаблона у пачки сайтов).

   Совместимо с Правилом 6 (GDPR-комплект) и Правилом 7 (NAP-контакты) — юр-страницы и контакты входят в обязательный набор страниц. Полная спека доверия: `/home/ubuntu/arb/.claude/skills/site-editor/references/whitepage-trust-signals.md`

## Финальный отчёт

```
SITE-EDITOR: Выполнение завершено

Домен: {domain}
Workspace: {workspace}

ТЕКСТОВЫЕ ИЗМЕНЕНИЯ:
{результаты se-text}

ИЗОБРАЖЕНИЯ:
{результаты se-image}

ИЗМЕНЕНИЯ КОДА:
{результаты se-code}

ПРОВЕРЬТЕ РЕЗУЛЬТАТ: https://{domain}/

Файлы сохранены локально:
/home/ubuntu/arb/{workspace}/domains/{domain}/
```
