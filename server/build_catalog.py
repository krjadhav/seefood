"""Turn indian_food.csv into a committed dish_catalog.json.

Each dish becomes a rich descriptive sentence (embedded as a text label) plus
structured facts shown in the UI. This extends recognition coverage to the long
tail of dishes that have no photos in the khana prototype set.

Usage:
    python server/build_catalog.py
"""
from __future__ import annotations

import csv
import json
import re
from pathlib import Path

ROOT = Path(__file__).resolve().parent.parent
CSV = ROOT / "datasets" / "indian_food_dataset_2" / "indian_food.csv"
OUT = Path(__file__).resolve().parent / "dish_catalog.json"

MISSING = {"-1", "", "nan", "none", None}


def clean(value: str | None) -> str:
    v = (value or "").strip()
    return "" if v in MISSING else v


def key_of(name: str) -> str:
    return re.sub(r"[^a-z0-9]", "", name.lower())


def describe(row: dict) -> str:
    name = clean(row["name"])
    diet = clean(row.get("diet"))
    flavor = clean(row.get("flavor_profile"))
    course = clean(row.get("course"))
    region = clean(row.get("region"))
    ingredients = clean(row.get("ingredients"))
    kind = " ".join(x for x in [flavor, diet, course] if x) or "dish"
    where = f" from {region} India" if region else " from India"
    made = f" made with {ingredients}" if ingredients else ""
    return f"{name}: a {kind}{where}{made}".strip()


def main() -> None:
    dishes = []
    seen = set()
    with CSV.open(newline="") as fh:
        for row in csv.DictReader(fh):
            name = clean(row.get("name"))
            if not name:
                continue
            k = key_of(name)
            if k in seen:
                continue
            seen.add(k)
            dishes.append(
                {
                    "name": name,
                    "key": k,
                    "text": describe(row),
                    "diet": clean(row.get("diet")),
                    "flavor": clean(row.get("flavor_profile")),
                    "course": clean(row.get("course")),
                    "region": clean(row.get("region")),
                    "state": clean(row.get("state")),
                    "ingredients": clean(row.get("ingredients")),
                }
            )
    OUT.write_text(json.dumps(dishes, ensure_ascii=False, indent=1))
    print(f"wrote {OUT} with {len(dishes)} dishes")
    print("sample:", dishes[0]["text"])


if __name__ == "__main__":
    main()
