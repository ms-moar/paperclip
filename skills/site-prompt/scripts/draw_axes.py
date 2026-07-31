#!/usr/bin/env python3
"""
draw_axes.py — движок уникальности для скилла site-prompt.

Задача: по теме сайта вытянуть НЕПОВТОРЯЮЩИЙСЯ набор дизайн-осей из banks.yaml,
избегая недавно использованных значений (cooldown) и уже виденных комбинаций
(журнал fingerprints.jsonl). Печатает JSON осей в stdout. По умолчанию сразу
записывает fingerprint в журнал (чтобы следующий вызов не повторил комбо).

Usage:
    draw_axes.py "<тема сайта>" [--dry] [--cooldown N] [--min-sections 7] [--max-sections 11]

--dry  — не записывать в журнал (только показать драфт осей).

Зависимостей нет: свой мини-парсер под формат banks.yaml, RNG из os.urandom.
"""
import os
import re
import sys
import json
import time
import hashlib
import random

HERE = os.path.dirname(os.path.abspath(__file__))
SKILL_DIR = os.path.dirname(HERE)
BANKS = os.path.join(SKILL_DIR, "references", "banks.yaml")
HIST_DIR = os.path.join(SKILL_DIR, ".history")
LEDGER = os.path.join(HIST_DIR, "fingerprints.jsonl")

# одиночные оси (по одному значению на сайт)
SINGLE_AXES = [
    "visual_style", "layout_archetype", "hero_type", "palette",
    "font_pairing", "brand_personality", "business_model", "copy_tone",
    "nav_pattern", "motion_signature",
]


def parse_banks(path):
    """Мини-парсер: top-level `key:` + элементы `- "..."`."""
    banks, cur = {}, None
    with open(path, encoding="utf-8") as f:
        for raw in f:
            line = raw.rstrip("\n")
            s = line.strip()
            if not s or s.startswith("#"):
                continue
            m_key = re.match(r"^([a-z_]+):\s*$", line)
            if m_key:
                cur = m_key.group(1)
                banks[cur] = []
                continue
            m_item = re.match(r"^\s*-\s+(.*)$", line)
            if m_item and cur:
                val = m_item.group(1).strip()
                if len(val) >= 2 and val[0] == val[-1] and val[0] in "\"'":
                    val = val[1:-1]
                banks[cur].append(val)
    return banks


def read_ledger(limit=400):
    if not os.path.exists(LEDGER):
        return []
    rows = []
    with open(LEDGER, encoding="utf-8") as f:
        for line in f.readlines()[-limit:]:
            line = line.strip()
            if not line:
                continue
            try:
                rows.append(json.loads(line))
            except Exception:
                pass
    return rows


def theme_key(theme):
    return re.sub(r"\s+", " ", theme.strip().lower())


def pick(rng, options, recent, extra_avoid=None):
    """Выбрать значение, избегая недавних; если всё отфильтровано — из полного пула."""
    avoid = set(recent)
    if extra_avoid:
        avoid |= set(extra_avoid)
    pool = [o for o in options if o not in avoid]
    if not pool:
        pool = [o for o in options if o not in set(recent)] or options
    return rng.choice(pool)


def draw(theme, cooldown=8, min_sections=7, max_sections=11, dry=False):
    banks = parse_banks(BANKS)
    for ax in SINGLE_AXES + ["section_module"]:
        if not banks.get(ax):
            raise SystemExit(f"draw_axes: пустой банк '{ax}' в banks.yaml")

    ledger = read_ledger()
    tkey = theme_key(theme)

    # cooldown: последние N значений каждой оси (по всем темам)
    recent = {ax: [] for ax in SINGLE_AXES}
    for row in ledger[-cooldown:]:
        for ax in SINGLE_AXES:
            v = (row.get("axes") or {}).get(ax)
            if v:
                recent[ax].append(v)
    # для той же темы cooldown жёстче — избегаем ВСЕ значения по этой теме
    same_theme = [r for r in ledger if r.get("theme_key") == tkey]
    seen_sigs = {r.get("sig") for r in ledger}

    seed = int.from_bytes(os.urandom(8), "big")
    rng = random.Random(seed)

    chosen = None
    for _ in range(60):
        axes = {}
        for ax in SINGLE_AXES:
            st_avoid = [(r.get("axes") or {}).get(ax) for r in same_theme[-6:]]
            st_avoid = [v for v in st_avoid if v]
            axes[ax] = pick(rng, banks[ax], recent[ax], extra_avoid=st_avoid)

        pool = banks["section_module"][:]
        rng.shuffle(pool)
        k = rng.randint(min_sections, min(max_sections, len(pool)))
        sections = pool[:k]  # порядок = порядок на главной

        sig_src = "|".join([
            tkey, axes["visual_style"], axes["layout_archetype"],
            axes["hero_type"], axes["palette"], axes["business_model"],
            "::" + ">".join(sections),
        ])
        sig = hashlib.sha1(sig_src.encode("utf-8")).hexdigest()[:16]
        if sig not in seen_sigs:
            chosen = (axes, sections, sig)
            break
    if chosen is None:
        chosen = (axes, sections, sig)  # пространство исчерпано — берём как есть

    axes, sections, sig = chosen
    nonce = hashlib.sha1(os.urandom(16)).hexdigest()[:12]
    result = {
        "theme": theme.strip(),
        "theme_key": tkey,
        "sig": sig,
        "nonce": nonce,
        "ts": int(time.time()),
        "axes": axes,
        "section_order": sections,
    }

    if not dry:
        os.makedirs(HIST_DIR, exist_ok=True)
        with open(LEDGER, "a", encoding="utf-8") as f:
            f.write(json.dumps(result, ensure_ascii=False) + "\n")

    return result


def main():
    args = sys.argv[1:]
    if not args or args[0] in ("-h", "--help"):
        print(__doc__)
        sys.exit(0)
    theme = args[0]
    dry = "--dry" in args
    cooldown = 8
    min_s, max_s = 7, 11
    for i, a in enumerate(args):
        if a == "--cooldown" and i + 1 < len(args):
            cooldown = int(args[i + 1])
        if a == "--min-sections" and i + 1 < len(args):
            min_s = int(args[i + 1])
        if a == "--max-sections" and i + 1 < len(args):
            max_s = int(args[i + 1])
    res = draw(theme, cooldown=cooldown, min_sections=min_s, max_sections=max_s, dry=dry)
    print(json.dumps(res, ensure_ascii=False, indent=2))


if __name__ == "__main__":
    main()
