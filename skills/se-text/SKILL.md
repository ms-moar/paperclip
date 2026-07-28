---
name: se-text
description: |
  Создание и редактирование текстов для сайтов через SFTP.
  This skill should be used as micro-skill from site-editor command (context: fork).
  Скачивает файлы, редактирует текст, загружает обратно, логирует промпты.
context: fork
agent: general-purpose
model: haiku
allowed-tools:
  - Bash
  - Read
  - Edit
  - Write
---

# se-text

Создание и редактирование текстов сайтов: страницы, статьи, описания, заголовки, перевод, SEO-оптимизация.

---

## ⛔ КРИТИЧЕСКИЕ ОГРАНИЧЕНИЯ

1. **НИКОГДА не скачивать рекурсивно** — НЕ использовать `get -r`, `mget *`, рекурсивные скрипты
2. **НИКОГДА не писать Python/Bash скрипты для SFTP** — использовать ТОЛЬКО команды из этого документа
3. **НИКОГДА не скачивать директории целиком** — только конкретные файлы по имени
4. **НИКОГДА не выходить за пределы /var/www/{domain}** — запрещены пути `/`, `/var`, `/usr`, `/etc`
5. **Максимум 10 файлов** за одну сессию
6. **⛔ НИКОГДА не добавлять эмодзи в контент** — ни в тексты, заголовки, списки, кнопки, meta.
   Никаких 🚀✅🔥👍🎯 и пр. Только обычный текст. Исключение: эмодзи ЯВНО запрошены в `task_description`.
7. **⛔ НЕ ТРОГАТЬ архитектуру `proxy → MEGA`** — файлы сайта ТОЛЬКО на MEGA (`/var/www/{domain}` через
   переданные SSH). Не лезть в nginx/VPS, не менять схему `[Браузер] → [Домен] → [VPS прокси] → [MEGA]`.

---

## Входные данные

Скил получает через промпт:

- `domain` — домен сайта
- `workspace` — workspace пользователя
- `task_description` — описание задачи
- SSH доступы: `SSH_HOST`, `SSH_PORT`, `SSH_USER`, `SSH_PASSWORD`

## Алгоритм

**ВАЖНО**: Выполнять SFTP команды напрямую через Bash tool. Все данные уже переданы в промпте.

### Шаг 1. Скачать файлы (если редактирование)

Выполнить в Bash:

```bash
sshpass -p '{SSH_PASSWORD}' sftp -P {SSH_PORT} -o StrictHostKeyChecking=no {SSH_USER}@{SSH_HOST} <<'EOF'
cd /var/www/{domain}
get {filename} /home/ubuntu/arb/{workspace}/domains/{domain}/{filename}
bye
EOF
```

Заменить все плейсхолдеры на реальные значения из промпта.

### Шаг 2. Создать/отредактировать текст

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

### Шаг 4. Логирование

Добавить запись в файл логов через Bash:

```bash
printf '\n---\n\n## %s | %s | text\n\n**Запрос:** %s\n\n**Промпт ИИ:** %s\n\n**Результат:** %s\n\n---\n' "$(date '+%Y-%m-%d %H:%M')" "{domain}" "{краткий запрос}" "{суть задачи, 2-3 предложения}" "✅ Успешно" >> /home/ubuntu/arb/{workspace}/prompts-history.md
```

## Правила текстов

- Грамотно, профессионально
- Учитывать нишу сайта (юридический, медицинский, финансовый и т.д.)
- SEO-ключевые слова естественно, без переспама
- Избегать шаблонных AI-фраз
- **⛔ Без эмодзи** — текст серьёзный, эмодзи не добавлять (если не запрошено явно)

### 🕵️ White-Page Trust Signals (контакты / imprint / about / footer)

При написании контактов, imprint, about, юр-данных — NAP (инсайд арбов, ~90–95% банов на старте):

- **Email** — на домене (`info@{domain}`), НЕ gmail/free-mail. (DNS MX/SPF — не наша зона, флагит `se-code`/отчёт.)
- **Телефон** — верный формат под GEO, НЕ лесенка/повтор/`12345`, не реальный чужой номер.
- **Адрес/юр-данные** — мелкая форма (не ООО/холдинг), правдоподобные, НЕ реального бизнеса (реестры ЕС / Google Maps).
- **NAP одинаковы везде** — то же Name/Address/Phone/Email во всех текстах (footer, contact, imprint).

Спека + reserved-диапазоны телефонов + чек-лист:
`/home/ubuntu/arb/.claude/skills/site-editor/references/whitepage-trust-signals.md`

## Формат ответа

Вернуть список созданных/отредактированных файлов и краткое описание изменений.
