---
name: se-image
description: |
  Генерация изображений для сайтов через grok-imagine (тот же движок, что в OpenDesign), загружает на сервер через SFTP.
  This skill should be used as micro-skill from site-editor command (context: fork).
context: fork
agent: general-purpose
model: sonnet
allowed-tools:
  - Bash
---

# se-image

Генерирует изображения через **grok-imagine** (xAI Grok Imagine, модель `grok-imagine-image-quality`) — тот же движок, что использует OpenDesign. Вызов идёт через локальный usage-meter CLIProxyAPI (подписка SuperGrok, НЕ per-token API-ключ), затем результат заливается на сервер через SFTP.

## Входные данные

Скил получает через промпт:

- `domain` — домен сайта
- `workspace` — workspace пользователя
- `task_description` — что генерировать
- SSH доступы: `SSH_HOST`, `SSH_PORT`, `SSH_USER`, `SSH_PASSWORD`

## Алгоритм

**ВАЖНО**: генерация ТОЛЬКО через grok-imagine (meter CLIProxyAPI, consumer `arb-images`). НЕ использовать img-comfy / img-replicate / Replicate API. Промпт генерации — на английском.

### Шаг 1. Определить назначение изображения и aspect_ratio

По `task_description` определить `purpose` и `aspect_ratio`:

| Ключевые слова                  | Purpose         | aspect_ratio |
| ------------------------------- | --------------- | ------------ |
| hero, баннер, главная, header   | `banner`        | `16:9`       |
| контент, статья, блог, услуга   | `general`       | `16:9`       |
| лого, логотип, иконка, favicon  | `general`       | `1:1`        |
| фото, портрет, команда, персона | `persona_photo` | `9:16`       |

Если неоднозначно — `purpose=general`, `aspect_ratio=16:9`.

### Шаг 2. Сгенерировать через grok-imagine

Прямой вызов в Bash (движок тот же, что в OpenDesign; подписка, не API-ключ):

```bash
K=$(cat /home/ubuntu/cliproxy/keys/arb-images.key)
OUT="/home/ubuntu/arb/{workspace}/domains/{domain}/images_gen"
mkdir -p "$OUT"
FN="$OUT/{slug}-$(date +%s).jpg"   # slug — короткое имя из task_description

RESP=$(mktemp)
curl -s -X POST http://127.0.0.1:8316/v1/images/generations \
  -H "Authorization: Bearer $K" -H "content-type: application/json" \
  -d "$(python3 -c "import json,sys; print(json.dumps({'model':'grok-imagine-image-quality','prompt':sys.argv[1],'n':1,'aspect_ratio':sys.argv[2],'response_format':'b64_json'}))" '{prompt на английском}' '{aspect_ratio}')" \
  -o "$RESP" -w "HTTP %{http_code}\n"

python3 - "$RESP" "$FN" <<'PY'
import json,base64,sys
resp,fn=sys.argv[1],sys.argv[2]
d=json.load(open(resp))
e=(d.get("data") or [{}])[0]
if e.get("b64_json"):
    open(fn,"wb").write(base64.b64decode(e["b64_json"])); print("SAVED:",fn)
elif e.get("url"):
    import urllib.request; open(fn,"wb").write(urllib.request.urlopen(e["url"]).read()); print("SAVED:",fn)
else:
    print("ERROR grok-imagine:",str(d)[:300]); sys.exit(1)
PY
```

grok-imagine отдаёт JPEG (magic `ffd8ff`). Нужно несколько картинок — повторить вызов с разными prompt/slug. Собрать пути (строки `SAVED:`).

> Ошибка HTTP≠200 / нет `b64_json` → НЕ выдумывать файл: показать тело ответа, проверить что meter `:8316` жив (`curl -s -o /dev/null -w '%{http_code}' http://127.0.0.1:8316/v1/models -H "Authorization: Bearer $K"`) и ключ `arb-images` на месте.

### Шаг 3. Проверка размера изображений (ОБЯЗАТЕЛЬНО!)

Для каждого файла проверить размер:

```bash
FILE_SIZE=$(stat -c%s "{путь_к_файлу}")
FILE_SIZE_KB=$((FILE_SIZE / 1024))
echo "{файл}: ${FILE_SIZE_KB} KB"
```

**Если файл > 200 KB** — предложить пользователю сжать:

```
⚠️ ИЗОБРАЖЕНИЕ ПРЕВЫШАЕТ 200 KB
━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━
Файл: {filename}
Размер: {FILE_SIZE_KB} KB (лимит: 200 KB)

Большие изображения замедляют загрузку сайта.
Это негативно влияет на SEO и UX.

Сжать изображение? (да/нет)
━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━
```

**Если пользователь согласен** — сжать через ImageMagick/cwebp:

```bash
# JPEG (grok-imagine) → WebP (оптимально для веба)
cwebp -q 80 "{путь_к_файлу}" -o "${путь_к_файлу%.*}.webp" 2>/dev/null \
  || convert "{путь_к_файлу}" -quality 80 -resize '1920x1920>' "{путь_к_файлу}"

# Проверить новый размер
NEW_SIZE_KB=$(( $(stat -c%s "{сжатый_файл}") / 1024 ))
echo "✅ Сжато: ${FILE_SIZE_KB} KB → ${NEW_SIZE_KB} KB"
```

**Если нет** — загрузить как есть, но вывести предупреждение в финальном отчёте.

### Шаг 4. Загрузить на сервер через SFTP

Для каждого файла (сжатого или оригинала) выполнить в Bash:

```bash
sshpass -p '{SSH_PASSWORD}' sftp -P {SSH_PORT} -o StrictHostKeyChecking=no {SSH_USER}@{SSH_HOST} <<'EOF'
-mkdir images
cd images
put {путь_к_файлу}
bye
EOF
```

Проверить результат загрузки (exit code).

### Шаг 5. Логирование

Выполнить в Bash:

```bash
printf '\n---\n\n## %s | %s | image\n\n**Запрос:** %s\n\n**Результат:** %s\n\n---\n' \
  "$(date '+%Y-%m-%d %H:%M')" "{domain}" "{task_description}" \
  "Uploaded: {список файлов}" \
  >> /home/ubuntu/arb/{workspace}/prompts-history.md
```

## Формат ответа

Вернуть список загруженных изображений:

```
ИЗОБРАЖЕНИЯ:
- images/{filename1}.webp — {описание}
- images/{filename2}.webp — {описание}
Загружено на сервер: {SSH_HOST}
```
