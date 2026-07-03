---
name: nutra-report
description: Detailed NUTRA-project report for a date or period — sites built & deployed, domains & servers bought (per arbitrageur + totals), and live balances of the nutra accounts (ishosting, gname, dynadot). Only project='nutra' resources; default-account resources are excluded.
key: paperclipai/optional/reporting/nutra-report
tags:
  - reporting
  - nutra
  - arbitrage
  - expdb
  - domains
  - servers
---

# Nutra Report

Generate a detailed report for the NUTRA arbitrage project over a date or period: how many sites were
built and deployed, how many domains and servers were bought (broken down per arbitrageur, with cost
totals), and the current live balances of the three nutra provider accounts.

Only `project='nutra'` resources are counted — resources on the `default` account are never included.

## When to use

Trigger when the user asks (RU/EN): "отчёт нутра <дата/период>", "отчет нутра 16.06.2026-30.06.2026",
"nutra report", "сколько сайтов/доменов/серверов по нутре", "остатки на аккаунтах нутры",
"отчёт по арбам нутра", "how many nutra sites/domains/servers".

Do NOT use for: the `default` project, Binom/traffic stats (clicks/conversions/ROI), or MTA task stats.

## How to run

The skill is implemented as scripts on the host. Run:

```bash
bash /home/ubuntu/arb/.claude/skills/nutra-report/scripts/report.sh <period>
```

`<period>` accepts any of: `16.06.2026-30.06.2026` · `2026-06-16 2026-06-30` · `2026-06-16..2026-06-30`
· single day `20.06.2026` / `2026-06-20`. The script prints a fully formatted report — return it to the
user as-is (do not reformat).

## What it produces

Activity WITHIN [from..to], project='nutra' only:

1. **Sites built & deployed** — per arbitrageur.
2. **Domains bought** — per arbitrageur + cost total.
3. **Servers bought** — per arbitrageur + cost total.
4. **Live account balances** — ishosting, gname, dynadot (as of run time).
5. **All-time reference** + date-coverage block.

## Key facts

- **Purchase dates come from provider APIs** (gname / dynadot / ishosting), because dates in ExpDB are
  ~half NULL. Owner (arbitrageur) and price come from ExpDB, joined by `domain_name` / `external_id`.
  Balances are live API values.
- Secrets are read from `/home/ubuntu/arb/.claude/config/projects.json` (`.nutra.*`) — never hardcode.
- Full method reference (endpoints, gname MD5 signing, pagination, field meanings, join keys, gotchas):
  `/home/ubuntu/arb/.claude/skills/nutra-report/references/data-sources.md`.
- If a purchase section looks empty for the period, check the coverage block: activity may genuinely be
  outside the window, or a few records lack a provider-API date (lower-bound count). Balances are unaffected.
