---
name: se-credentials
description: |
  Поиск SSH/SFTP доступов для домена по 3 источникам: локальный файл, Google Sheets, ExpDB.
  This skill should be used as micro-skill from site-editor command (context: fork).
  Возвращает SSH_HOST, SSH_PORT, SSH_USER, SSH_PASSWORD или ошибку.
context: fork
agent: general-purpose
model: sonnet
allowed-tools:
  - Bash
  - Read
  - Task
---

# se-credentials

Поиск SSH/SFTP доступов к домену. Проверяет 3 источника последовательно — останавливается на первом найденном.

## Входные данные

Скил получает через промпт:

- `domain` — домен для поиска (например `example.com`)
- `workspace` — workspace пользователя (например `mir`)

## Конфигурация

| Параметр           | Значение                                    |
| ------------------ | ------------------------------------------- |
| Скрипт поиска      | `/home/ubuntu/arb/scripts/search_domain.py` |
| ExpDB доступ       | **ТОЛЬКО через `expdb-manager` subagent**   |
| SSH порт по умолч. | `2222`                                      |

⛔ **Прямой `psql` / `vault read` / `expdb-query.sh` ЗАПРЕЩЁН.** Любой запрос к ExpDB — через `Task(subagent_type="expdb-manager")`.

## Алгоритм

**ВАЖНО**: Выполнять команды ниже напрямую через Bash tool. НЕ искать скрипты или ключи в файловой системе — всё указано в этом документе.

### Шаг 1. Локальный файл (приоритет)

Прочитать info-файл домена через Read tool:

```
/home/ubuntu/arb/{workspace}/domains/{domain}/docs/{domain}_info.md
```

Если файл существует и содержит SSH данные (секция "Доступы к сайту" или "SFTP") — извлечь Host, Port, User, Password. **Вернуть результат, дальше НЕ искать.**

### Шаг 2. Google Sheets

Выполнить в Bash:

```bash
python3 /home/ubuntu/arb/scripts/search_domain.py {domain}
```

Заменить `{domain}` на реальный домен.

Из JSON-ответа извлечь:

- `vps.ip` → SSH_HOST
- `vps.ssh_password` → SSH_PASSWORD
- SSH_PORT = `2222` (стандартный)
- SSH_USER = `{domain}`

Если `vps.found = true` — **вернуть результат, дальше НЕ искать.**

### Шаг 3. ExpDB через expdb-manager

⛔ Никаких прямых `psql`/`vault` — только `Task(subagent_type="expdb-manager")`.

Вызвать через Task tool:

```
Task(
  subagent_type="expdb-manager",
  description="Find SSH creds for {domain}",
  prompt="""
Найди SSH/SFTP креденшалы для домена {domain} в production.

ВЫПОЛНИ:
SELECT
  s.hostname,
  sip.ip_address,
  s.site_ssh_username,
  s.site_ssh_password_encrypted,
  COALESCE(s.ssh_port, 2222) AS ssh_port
FROM production.domains d
LEFT JOIN production.servers s ON d.current_vps_id = s.id
LEFT JOIN production.server_ips sip ON sip.server_id = s.id AND sip.is_primary = true
WHERE d.domain_name = '{domain}'
LIMIT 1;

Если ничего — fallback по hostname:
SELECT s.hostname, sip.ip_address, s.site_ssh_username,
       s.site_ssh_password_encrypted, COALESCE(s.ssh_port, 2222) AS ssh_port
FROM production.servers s
LEFT JOIN production.server_ips sip ON sip.server_id = s.id AND sip.is_primary = true
WHERE s.hostname = '{domain}' LIMIT 1;

Верни строго JSON:
{"found":true,"ssh_host":"<ip>","ssh_port":<int>,"ssh_user":"<user или {domain}>","ssh_password":"<pwd>"}
или
{"found":false}
"""
)
```

Из ответа expdb-manager извлечь поля. Если `ssh_user` пустой — использовать `{domain}`.

## Формат ответа

**Успех:**

```
FOUND: true
SSH_HOST: {ip}
SSH_PORT: 2222
SSH_USER: {domain}
SSH_PASSWORD: {password}
SOURCE: local/sheets/expdb
```

**Не найдено:**

```
FOUND: false
ERROR: Доступы не найдены. Запустите /wp-prepare {domain}
```
