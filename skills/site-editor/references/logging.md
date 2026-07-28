# Шаблон логирования промптов

## Файл

**Путь:** `/home/ubuntu/arb/{workspace}/prompts-history.md`

Каждый агент добавляет запись после выполнения задачи.

## Команда для логирования

Использовать `printf` с append (`>>`). НЕ использовать heredoc — ломается при спецсимволах.

```bash
printf '\n---\n\n## %s | %s | %s\n\n**Запрос:** %s\n\n**Промпт ИИ:** %s\n\n**Результат:** %s\n\n---\n' \
  "$(date '+%Y-%m-%d %H:%M')" \
  "{domain}" \
  "{type}" \
  "{краткий запрос}" \
  "{промпт ИИ}" \
  "{результат}" \
  >> /home/ubuntu/arb/{workspace}/prompts-history.md
```

## Содержание по типу агента

### text

**Промпт ИИ:** суть задачи, стиль текста, целевая аудитория — БЕЗ самого текста (2-3 предложения).

### image

**Промпт ИИ:** промпт на английском — объект, стиль, настроение, размер (макс 100 слов).

### code

**Промпт ИИ:** список файлов + что изменено в каждом (1 строка на файл, БЕЗ кода).

## Пример записи

```markdown
---

## 2025-12-24 14:30 | pensiyaplus.com | image

**Запрос:** сделай картинку для hero секции, что-то про пенсионеров и юристов

**Промпт ИИ:** Professional hero image for Ukrainian pension consulting website. Elderly couple receiving legal consultation in modern office. Warm lighting, trustworthy atmosphere. Photorealistic, 16:9.

**Результат:** ✅ Успешно: images/hero-banner.webp

---
```
