---
name: gads-warmup
description: >-
  Прогрев Google-аккаунта на монитор-десктопе Linken Sphere под нутра-вертикаль,
  чтобы спровоцировать показ рекламы конкурентов (суставы, потенция, народная медицина,
  возрастные проблемы) для последующего мониторинга Google Ads. Один запуск = один день
  многодневного флоу; день/фаза берутся из состояния аккаунта. Страновая специфика
  (язык, новостные сайты, аптеки, cookie-тексты, поисковые запросы) — авто-ресерч + кэш
  по ГЕО. Человекоподобное поведение (cookie consent, плавный скролл, паузы, видео не менее 30%).
  Use when user asks: прогреть аккаунт, прогрев акка, warmup account, прогрев под мониторинг,
  фарм аккаунта google ads, нутра мониторинг конкурентов, прогрей сессию по стране.
  Do NOT use for: запуск MTA-задач (mta-launch), тест расширения/сценария в Sphere
  (sphere-extension-test / sphere-scenario-manual-test), обычный UI-тест сайта (agent-browser).
allowed-tools:
  - Bash
  - WebSearch
  - WebFetch
  - Read
  - Write
---

# gads-warmup

> ℹ️ Скрипты и references этого скила — единый источник в arb:
> `/home/ubuntu/arb/.claude/skills/gads-warmup/` (пути в этом SKILL.md уже абсолютные).
> Монитор-бокс — win-rdp `213.7.220.150`, Mon-lane `:8087` через SSH-туннель (см. Шаг 1.5).

Прогрев чистого Google-аккаунта под нишу **нутра**, чтобы Google начал показывать рекламу
конкурентов на новостных/тематических сайтах — аккаунт затем используется для **мониторинга
объявлений конкурентов**. Работает через профили Sphere на десктопе **`monitoring`**.

**Модель:** 1 запуск скила = **1 день** прогрева. Прогрев многодневный (фазы 1→2→3),
состояние (день/фаза) хранится per-аккаунт. Оператор запускает скил ежедневно на аккаунт,
пока в фазе 3 не подтвердится показ нутра-рекламы.

## Вход

| Параметр        | Обяз. | Описание                                                                                   |
| --------------- | ----- | ------------------------------------------------------------------------------------------ |
| `session`       | да    | uuid **или имя** профиля на монитор-десктопе (`/sphere/raw/sessions`)                      |
| `country`       | да\*  | ISO-код ГЕО: `SK`, `DE`, `PL` ... (\*можно опустить, если уже в state)                     |
| `gender`        | да\*  | `male` / `female` (определяет потенция/простата-запросы) (\*или из state)                  |
| `day`           | нет   | форс номера дня (иначе из state); при форсе state НЕ инкрементится                         |
| `speed`         | нет   | `fast`/`normal`/`slow` (паузы). По умолчанию `normal`                                      |
| `--no-ad-click` | нет   | в фазе 3 не кликать sponsored (только показы) — безопаснее для аккаунта/бюджета конкурента |

Если параметры не переданы — спроси `session`, `country`, `gender`.

## Workflow

Все команды — из каталога скила. `cd /home/ubuntu/arb/.claude/skills/gads-warmup`.

### Шаг 1. Страновой пак (авто-ресерч + кэш)

```bash
python3 /home/ubuntu/arb/.claude/skills/gads-warmup/scripts/country_pack.py has <CC>
```

- `yes` → дальше.
- `no` → **провести авто-ресерч** по `/home/ubuntu/arb/.claude/skills/gads-warmup/references/research-routine.md`: через WebSearch собрать
  язык, новостные сайты, онлайн-аптеки, тексты cookie-кнопок и поисковые запросы (фаза1/2/3,
  male/female) **на языке страны**, собрать JSON по схеме `packs/SK.json`, сохранить:
  ```bash
  python3 /home/ubuntu/arb/.claude/skills/gads-warmup/scripts/save_pack.py --file /tmp/pack_<CC>.json --source web-research
  python3 /home/ubuntu/arb/.claude/skills/gads-warmup/scripts/country_pack.py validate <CC>   # должно быть ok:true
  ```

### Шаг 1.5. Подключение к монитор-боксу (ОБЯЗАТЕЛЬНО перед dry-run/запуском)

Монитор-Sphere живёт на боксе **win-rdp `213.7.220.150`**, Mon-lane `:8087` (юзер Mon, Sphere `:40811`).
Порт `:8087` роутером НЕ форвардится → перед ЛЮБЫМ вызовом warmup.py поднять **SSH-туннель**:

```bash
ssh -fN -L 8087:127.0.0.1:8087 winrdp          # winrdp → Administrator@213.7.220.150:52222
# ensure-up: если Mon-wrapper лежит — поднять его (scheduled-task на боксе запрещён кроме /ru User_17,
# поэтому персистентность = самолечение здесь). Ничего НЕ убивает, Sphere не трогает.
LANE=$(curl -s -m6 -H "Authorization: Bearer $SPHERE_TOKEN" http://127.0.0.1:8087/health | jq -r '.lane.rdp_user // "down"')
if [ "$LANE" != "Mon" ]; then
  ssh winrdp 'powershell -NoProfile -Command "Invoke-CimMethod -ClassName Win32_Process -MethodName Create -Arguments @{CommandLine=\"cmd.exe /c C:\moar-scripts\start_browser_api_mon.bat\"}"'
  sleep 10
fi
curl -s -H "Authorization: Bearer $SPHERE_TOKEN" http://127.0.0.1:8087/health | jq .lane.rdp_user   # → "Mon"
```

Предусловие бокса: Sphere залогинена в сессии **Mon** (RDP `213.7.220.150:53389`), Local API `:40811`,
аккаунт с десктопом `monitoring` (это поднимает человек через GUI; wrapper это не лечит). Детали — `/home/ubuntu/arb/.claude/skills/gads-warmup/references/api.md`.

### Шаг 2. Предпросмотр плана дня (dry-run)

```bash
python3 /home/ubuntu/arb/.claude/skills/gads-warmup/scripts/warmup.py --session "<session>" --country <CC> --gender <g> --dry-run
```

Покажет: день, фазу, запросы и сайты дня. Покажи это оператору (1-2 строки).

### Шаг 3. Запуск прогрева (1 день)

```bash
python3 /home/ubuntu/arb/.claude/skills/gads-warmup/scripts/warmup.py --session "<session>" --country <CC> --gender <g> [--day N] [--no-ad-click]
```

Скрипт сам: возьмёт **busy-lock на монитор-десктоп** (см. ниже), подключится к профилю
(`auto_switch_desktop`), выполнит действия фазы человекоподобно, сохранит скриншоты + `run.json`
в `runs/<uuid>_dayN_DDMM/`, запишет прогон в state и при успехе **инкрементит день** (`day++`),
снимет лок. В конце печатает строку `SUMMARY {...}`. Опц. `--operator <имя>` — попадёт в
сообщение о занятости другим оператором.

Коды выхода: `0` ок · `3` нет/битый пак (вернись на Шаг 1) · `1` прогрев упал (см. ниже) ·
`2` аргументы · `5` десктоп занят другим прогревом (см. Безопасность — дождись и повтори).

### Шаг 4. При сбое (exit 1)

Открой `runs/<...>/run.json` (поле `result.error`, `log`) и последний скриншот. Чини причину
(чаще: `Session not found` → просто перезапусти Шаг 3, `/sphere/connect` поднимет новую сессию;
профиль не стартовал → проверь `/sphere/raw/desktops` активность). **День не инкрементился** — повтор
запустит тот же день заново.

### Шаг 5. Верификация (обязательно)

- **Фаза 1-2:** убедись по `SUMMARY.status=ok` и скриншоту `phaseN_end.png`, что cookie приняты и страницы читались.
- **Фаза 3:** это и есть проверка цели. Посмотри `result.sponsored_results` / `result.ad_iframes` и
  **открой скриншоты `news_*.png`** (Read изображения или GLM-vision) — глазами подтверди наличие
  нутра-баннеров (суставы/потенция/БАД) на новостных сайтах. Cross-origin display-рекламу нельзя
  посчитать из DOM — финальная проверка визуальная по скриншоту.

## Итоговый отчёт (обязателен)

После прогона выдай человекочитаемый отчёт:

```
✅ Прогрев: <country>/<gender> · профиль <name> · день <N> фаза <P> (<phase_name>)
   Запросов: ... · сайтов: ... · (фаза3: sponsored=<n>, ad_iframes=<n>, клик=<n>)
   Артефакты: runs/<...>/ (скриншоты + run.json)
   Следующий день: <next_day> — запусти скил снова завтра (state сам сдвинул день)
   [фаза3] Нутра-реклама на скриншотах: <подтверждено/не видно — рекомендации>
```

## Безопасность и ограничения

- **1 аккаунт за запуск, параллель запрещена и ЗАЩИЩЕНА локом.** Все профили на одном десктопе
  `monitoring` → одновременные прогревы дерутся за desktop-switch/активную вкладку. Реальный запуск
  (Шаг 3) берёт атомарный busy-lock `state/.monitoring.lock`; второй оператор/запуск получает
  `exit 5` + `{"error":"desktop_busy", holder:{...}}` с именем профиля/оператора/временем — **дождись
  завершения и запусти снова**. Лок снимается автоматически (в т.ч. при падении); протухший
  (мёртвый pid или >3ч) перехватывается. dry-run/ресерч (Шаги 1-2) лок НЕ берут. Не держать >5 Chrome.
- **Батч несколько профилей** — строго последовательно (`/home/ubuntu/arb/.claude/skills/gads-warmup/scripts/run_pt_batch.sh`-паттерн: цикл,
  каждый профиль берёт+снимает лок по очереди), не запускать параллельные процессы.
- Реальные действия на реальном аккаунте через монитор-десктоп — это outward-facing. Запуск Шага 3
  делается по явному указанию оператора (Шаги 1-2 безопасны: ресерч + dry-run).
- `--no-ad-click` если не нужно тратить бюджет конкурента / снижать риск на свежем аккаунте.
- Прогрев многодневный: показ рекламы обычно появляется к фазе 3 (день 5+), т.к. Google обновляет
  in-market/affinity аудитории за 24-48ч. Это не таймер «на всякий случай» — это зависимость от
  цикла обновления аудиторий Google.

## Ресурсы

- `/home/ubuntu/arb/.claude/skills/gads-warmup/scripts/warmup.py` — драйвер (entrypoint). `/home/ubuntu/arb/.claude/skills/gads-warmup/scripts/lib/` — API-клиент, человекоподобие, фазы.
- `/home/ubuntu/arb/.claude/skills/gads-warmup/scripts/country_pack.py` · `/home/ubuntu/arb/.claude/skills/gads-warmup/scripts/save_pack.py` · `/home/ubuntu/arb/.claude/skills/gads-warmup/scripts/state.py` — паки и состояние (CLI).
- `packs/<CC>.json` — страновые знания (есть сид `SK`). `state/<uuid>.json` — прогресс аккаунта.
- `/home/ubuntu/arb/.claude/skills/gads-warmup/references/flow.md` — спецификация фаз и логики пола. `/home/ubuntu/arb/.claude/skills/gads-warmup/references/research-routine.md` — как ресёрчить ГЕО.
- `/home/ubuntu/arb/.claude/skills/gads-warmup/references/api.md` — эндпоинты wrapper'а + факты про монитор-десктоп.
