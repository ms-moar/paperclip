---
name: se-code
description: |
  Создание и редактирование кода сайтов (HTML/CSS/JS/PHP) через SFTP.
  This skill should be used as micro-skill from site-editor command (context: fork).
  Скачивает файлы, редактирует код, загружает обратно, проверяет HTTP статус, логирует.
context: fork
agent: general-purpose
model: sonnet
allowed-tools:
  - Bash
  - Read
  - Edit
  - Write
---

# se-code

Создание и редактирование кода сайтов: новые страницы (HTML/PHP), CSS стили, JavaScript, исправление багов.

---

## ⛔ КРИТИЧЕСКИЕ ОГРАНИЧЕНИЯ (ОБЯЗАТЕЛЬНО К ИСПОЛНЕНИЮ!)

### ЗАПРЕЩЕНО:

1. **НИКОГДА не скачивать рекурсивно** — НЕ использовать `get -r`, `mget *`, рекурсивные скрипты
2. **НИКОГДА не писать Python/Bash скрипты для SFTP** — использовать ТОЛЬКО команды из этого документа
3. **НИКОГДА не скачивать директории целиком** — только конкретные файлы по имени
4. **НИКОГДА не выходить за пределы /var/www/{domain}** — запрещены пути `/`, `/var`, `/usr`, `/etc`
5. **⛔ НИКОГДА не создавать файлы ВНЕ `task_description`** — ТОЛЬКО то, что явно попросил пользователь.
   ЗАПРЕЩЕНО "проявлять инициативу": geo-blocker, cloaker, IP-redirect, bot-filter (User-Agent check),
   tracking pixel, analytics, captcha, rate-limit, CSP headers, robots.txt — ТОЛЬКО если ЯВНО в задаче.
6. **⛔ НИКОГДА не редактировать файлы, которые НЕ указаны в `task_description`** —
   если правишь `index.php` для смены `<h1>`, НЕ добавляй `require` других файлов, NE меняй `<head>`, NE
   трогай скрипты. Меняешь только то, что попросил юзер.
7. **⛔ ЕСЛИ видишь паттерн "это arbitrage WP, нужен X"** (geo-block, cloaker, bot-filter) —
   СТОП. НЕ делай молча. Вернись к юзеру: "Заметил что сайт под CZ/SK трафик. Добавить
   geo-blocker? (да/нет)". Ждать ответа. НЕ выполнять "на опережение".
8. **⛔ НЕ ТРОГАТЬ архитектуру `proxy → MEGA`** (задаётся `/setup-server`, тут НЕ менять).
   Файлы сайта живут ТОЛЬКО на MEGA-сервере (`195.66.213.248`), доступ — через переданные SSH,
   путь `/var/www/{domain}`. VPS пользователя — **ТОЛЬКО прокси**, его не касаться.
   Схема: `[Браузер] → [Домен] → [VPS только прокси] → [MEGA 195.66.213.248]`.
   ЗАПРЕЩЕНО: править/создавать nginx-конфиги, менять `proxy_pass`, заводить свои server-блоки,
   `.htaccess`/rewrite-правила, переносить файлы на VPS, придумывать «новую» архитектуру или
   городить выдуманные слои. Работаешь ТОЛЬКО с файлами сайта на MEGA. Если кажется что нужен
   nginx/rewrite — НЕ делать, вернуться к юзеру. Спека архитектуры:
   `/home/ubuntu/arb/.claude/skills/setup-server/SKILL.md` §Архитектура (не менять).
9. **⛔ НИКОГДА не добавлять эмодзи на сайт** — ни в HTML/текст контента, ни в заголовки,
   кнопки, списки, alt/meta. Никаких 🚀✅🔥👍🎯 и пр. на страницах. По умолчанию — обычный
   текст и (при нужде) SVG/иконочные шрифты, НЕ эмодзи. Исключение: эмодзи ЯВНО присутствуют в
   исходном дизайне (handoff bundle) или ЯВНО запрошены в `task_description`. Свои эмодзи «для
   красоты» не добавлять.
10. **⛔ НЕ ПИСАТЬ комментарии в коде** — никаких `<!-- -->` (HTML), `/* */` (CSS),
    `//`·`/* */` (JS), `//`·`#`·`/* */` (PHP). Код чистый, без поясняющих/декоративных/«секционных»
    комментов. Исключение: комментарий ТЕХНИЧЕСКИ обязателен (функциональный маркер, который ищет
    другой скил — напр. блок Consent Mode v2 / phantom-redirect) ИЛИ ЯВНО требуется в `task_description`.
    Комменты «для читаемости» / `<!-- Header -->` / `// конец секции` — НЕ добавлять.

### РАЗРЕШЕНО:

- Скачивать ТОЛЬКО конкретные файлы: `get index.php`, `get css/style.css`
- Работать ТОЛЬКО в `/var/www/{domain}/` и его поддиректориях
- Максимум 20 файлов за одну сессию

### Если нужно узнать структуру сайта:

```bash
sshpass -p '{SSH_PASSWORD}' sftp -P {SSH_PORT} -o StrictHostKeyChecking=no {SSH_USER}@{SSH_HOST} <<'EOF'
cd /var/www/{domain}
ls -la
ls -la css
ls -la js
bye
EOF
```

**НЕ** писать скрипты! **НЕ** использовать `find`/`rsync`/`scp -r`!

---

## Входные данные

Скил получает через промпт:

- `domain` — домен сайта
- `workspace` — workspace пользователя
- `task_description` — описание задачи
- SSH доступы: `SSH_HOST`, `SSH_PORT`, `SSH_USER`, `SSH_PASSWORD`

## Алгоритм

**ВАЖНО**: Выполнять SFTP команды напрямую через Bash tool. Все данные уже переданы в промпте.

### Шаг 1. Скачать ТОЛЬКО нужные файлы

**⚠️ ВАЖНО:** Скачивать ТОЛЬКО файлы, которые будут редактироваться! НЕ "всё на всякий случай"!

**Шаг 1.1.** Сначала посмотреть структуру (ls):

```bash
sshpass -p '{SSH_PASSWORD}' sftp -P {SSH_PORT} -o StrictHostKeyChecking=no {SSH_USER}@{SSH_HOST} <<'EOF'
cd /var/www/{domain}
ls -la
bye
EOF
```

**Шаг 1.2.** Скачать КОНКРЕТНЫЕ файлы (по именам):

```bash
mkdir -p /home/ubuntu/arb/{workspace}/domains/{domain}
sshpass -p '{SSH_PASSWORD}' sftp -P {SSH_PORT} -o StrictHostKeyChecking=no {SSH_USER}@{SSH_HOST} <<'EOF'
cd /var/www/{domain}
get index.php /home/ubuntu/arb/{workspace}/domains/{domain}/index.php
get css/style.css /home/ubuntu/arb/{workspace}/domains/{domain}/style.css
bye
EOF
```

**Примеры ПРАВИЛЬНЫХ команд:**

- `get index.php` ✅
- `get about.php` ✅
- `get css/style.css` ✅

**Примеры ЗАПРЕЩЁННЫХ команд:**

- `get -r .` ❌ (рекурсивно)
- `mget *` ❌ (всё подряд)
- `get /var/www/*` ❌ (вне /var/www/{domain})

### Шаг 2. Создать/отредактировать код

Использовать Read tool для чтения скачанных файлов.
Использовать Edit tool для редактирования существующих файлов.
Использовать Write tool для создания новых файлов.

Сохранять в: `/home/ubuntu/arb/{workspace}/domains/{domain}/`

### Шаг 3. Загрузить на сервер

Выполнить в Bash:

```bash
sshpass -p '{SSH_PASSWORD}' sftp -P {SSH_PORT} -o StrictHostKeyChecking=no {SSH_USER}@{SSH_HOST} <<'EOF'
cd /var/www/{domain}
put /home/ubuntu/arb/{workspace}/domains/{domain}/{filename}
bye
EOF
```

Для нескольких файлов — перечислить все `put` команды.

### Шаг 4. Проверить результат

Выполнить в Bash:

```bash
curl -s -o /dev/null -w "%{http_code}" "https://{domain}/{page}"
```

Ожидаемый код: `200`. Если `404`/`500` — проверить путь и содержимое файла.

### Шаг 5. Логирование

Выполнить в Bash:

```bash
printf '\n---\n\n## %s | %s | code\n\n**Запрос:** %s\n\n**Промпт ИИ:** %s\n\n**Результат:** %s\n\n---\n' "$(date '+%Y-%m-%d %H:%M')" "{domain}" "{краткий запрос}" "{список файлов + что изменено, по 1 строке на файл}" "✅ Успешно: HTTP {код}" >> /home/ubuntu/arb/{workspace}/prompts-history.md
```

## Правила кода

### HTML/PHP

- Валидный HTML5, семантические теги (header, nav, main, footer)
- Мета-теги для SEO (title, description, viewport)
- Адаптивный дизайн (viewport meta)

### ⛔ Расширения и пути (СТРОГО!)

1. **Новые страницы — ТОЛЬКО `.php`**, никогда `.html`.
   - PHP включён на всех наших MEGA серверах.
   - Integration (Palladium/Binom), gsc-analytics, gsc-canonical и пр. ожидают `.php`.
   - Исключения только если в `task_description` явно указано `.html`.

2. **Ссылки на свои страницы — pretty URL без расширения и без `index.php`:**

   | Цель                | ✅ Правильно       | ❌ Неправильно       |
   | ------------------- | ------------------ | -------------------- |
   | Главная             | `href="/"`         | `href="index.php"`   |
   | Внутренняя страница | `href="/contact/"` | `href="contact.php"` |
   | Со слэшем в конце   | `href="/about/"`   | `href="/about"`      |

   nginx настроен делать rewrite `/contact/` → `/contact.php`. На diskе файл лежит как `contact.php`, в HTML — pretty URL `/contact/`.

3. **Asset-пути — ВСЕГДА абсолютные от корня:**

   | Тип   | ✅ Правильно              | ❌ Неправильно                      |
   | ----- | ------------------------- | ----------------------------------- |
   | Image | `src="/images/hero.webp"` | `src="images/hero.webp"`            |
   | CSS   | `href="/css/style.css"`   | `href="css/style.css"`, `./css/...` |
   | JS    | `src="/js/main.js"`       | `src="js/main.js"`                  |

   Без `./`, без относительных. Ломается на вложенных страницах (`/category/page/`).

4. **Никогда не использовать `.html` или `.php` в href**, кроме внешних ссылок.

5. **Canonical/og:url — pretty URL** с `https://{domain}/path/` (всегда trailing slash для не-главной).

### CSS

- Mobile-first подход
- CSS Grid/Flexbox для layout
- Консистентные цвета и шрифты
- Минимизировать дублирование

### JavaScript

- Vanilla JS где возможно
- Обработка ошибок
- Не блокировать рендеринг (defer/async)

### Безопасность

- Экранировать пользовательский ввод
- CSRF токены для форм
- Не хранить секреты в клиентском коде

### 🕵️ White-Page Trust Signals (контакты / imprint / footer / Schema.org)

Если правишь/создаёшь контакты, imprint, about, footer или Schema.org JSON-LD — соблюдать NAP (инсайд арбов, ~90–95% банов на старте). Google валидирует юр-идентичность white-page:

1. **Email** — на домене сайта (`info@{domain}`), НЕ gmail/free-mail. Проверить DNS:
   `dig +short MX {domain}`. Пусто → почта палится, но DNS — **НЕ файлы сайта**: не править,
   в отчёте предупредить + роут `domain-email` (Dynadot) / Cloudflare.
2. **Телефон** — верный код+длина под GEO, НЕ лесенка/повтор (`123456789`/`00000`), из reserved-диапазона
   либо проверен что не гуглится как чужой Google My Business.
3. **Адрес/юр-данные** — мелкая форма (не ООО/холдинг), юр-номер верного формата но фиктивный,
   адрес НЕ резолвится в реальный бизнес (реестры ЕС / Google Maps).
4. **NAP-консистентность** — Name/Address/Phone/Email/юр-номер ОДИНАКОВЫ в footer / contact / imprint /
   Schema.org. Меняешь одно поле — синхронизируй везде.

Спека + reserved-диапазоны + чек-лист:
`/home/ubuntu/arb/.claude/skills/site-editor/references/whitepage-trust-signals.md`

## Типичная структура сайта

```
/var/www/{domain}/
├── index.php
├── about.php
├── contact.php
├── privacy-policy.php
├── css/
│   └── style.css
├── js/
│   └── main.js
└── images/
```

## Формат ответа

Вернуть **ДВА РАЗДЕЛЬНЫХ списка** + HTTP-статус проверки:

```
📝 СОЗДАНО (новые файлы):
  - {filename} ({lines} строк) — {краткое описание}
    {если файл НЕ был в task_description → ⚠️ НОВЫЙ ФАЙЛ ВНЕ task_description!}

✏️ ОТРЕДАКТИРОВАНО:
  - {filename} (+N / -M строк) — {что изменено}

🔍 HTTP проверка:
  - https://{domain}/ → {код}
  - https://{domain}/{page} → {код}
```

**ОБЯЗАТЕЛЬНО:** если создаёшь файл которого НЕ было в `task_description` — пометить `⚠️ НОВЫЙ ФАЙЛ ВНЕ task_description!` чтобы пользователь сразу увидел. Не прятать среди других строк.
