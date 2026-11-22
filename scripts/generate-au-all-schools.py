"""Generate slim AU schools JSON from ACARA School Location 2025 (My School terms)."""
from __future__ import annotations

import json
import re
import sys
from pathlib import Path

try:
    import openpyxl
except ImportError:
    print("openpyxl required: pip install openpyxl", file=sys.stderr)
    sys.exit(1)

ROOT = Path(__file__).resolve().parents[1]
XLSX = ROOT / "tmp" / "School_Location_2025.xlsx"
OUT_JSON = ROOT / "src" / "data" / "auAllSchools.json"
OUT_TS = ROOT / "src" / "data" / "auAllSchools.ts"

SHEET = "SchoolLocations 2025"


def slugify(value: str) -> str:
    text = re.sub(r"[^a-z0-9]+", "-", value.strip().lower())
    return text.strip("-") or "school"


def title_suburb(value: str) -> str:
    raw = (value or "").strip()
    if not raw:
        return ""
    return " ".join(
        part if part.isupper() and len(part) <= 3 else part.capitalize()
        for part in raw.replace("-", " - ").split()
    ).replace(" - ", "-")


def main() -> None:
    if not XLSX.exists():
        print(f"Missing {XLSX}", file=sys.stderr)
        sys.exit(1)

    wb = openpyxl.load_workbook(XLSX, read_only=True, data_only=True)
    ws = wb[SHEET]
    rows = ws.iter_rows(values_only=True)
    header = [str(h).strip() if h is not None else "" for h in next(rows)]
    idx = {name: i for i, name in enumerate(header)}

    required = ["School Name", "Suburb", "State", "Postcode", "Latitude", "Longitude"]
    for col in required:
        if col not in idx:
            raise SystemExit(f"Missing column {col}")

    seen: dict[str, dict] = {}
    for row in rows:
        name = str(row[idx["School Name"]] or "").strip()
        suburb = title_suburb(str(row[idx["Suburb"]] or ""))
        state = str(row[idx["State"]] or "").strip().upper()
        postcode = str(row[idx["Postcode"]] or "").strip()
        try:
            lat = float(row[idx["Latitude"]])
            lng = float(row[idx["Longitude"]])
        except (TypeError, ValueError):
            continue
        if not name or not suburb or not state or not postcode:
            continue
        if not (-45.0 <= lat <= -9.0 and 112.0 <= lng <= 154.0):
            continue
        key = f"{name.lower()}|{suburb.lower()}|{state}|{postcode}"
        if key in seen:
            continue
        acara_id = row[idx.get("ACARA SML ID", 0)] if "ACARA SML ID" in idx else None
        school_id = f"acara-{acara_id}" if acara_id not in (None, "") else slugify(f"{name}-{state}-{postcode}")
        seen[key] = {
            "id": school_id,
            "name": name,
            "suburb": suburb,
            "state": state,
            "postcode": postcode,
            "lat": round(lat, 5),
            "lng": round(lng, 5),
        }

    wb.close()
    schools = sorted(seen.values(), key=lambda s: (s["state"], s["suburb"], s["name"]))
    OUT_JSON.parent.mkdir(parents=True, exist_ok=True)
    OUT_JSON.write_text(json.dumps(schools, separators=(",", ":")), encoding="utf-8")
    OUT_TS.write_text(
        """/** Auto-generated Australian schools master (ACARA School Location 2025). */
import raw from './auAllSchools.json';

export type AuSchoolRecord = {
  id: string;
  name: string;
  suburb: string;
  state: string;
  postcode: string;
  lat: number;
  lng: number;
};

export const AU_ALL_SCHOOLS: readonly AuSchoolRecord[] = raw as AuSchoolRecord[];
""",
        encoding="utf-8",
    )

    sample_names = (
        "Cranbourne North",
        "Narre Warren South",
        "Craigieburn",
        "Pakenham",
        "Docklands",
    )
    print("count", len(schools))
    print("bytes", OUT_JSON.stat().st_size)
    for suburb in sample_names:
        hits = [s["name"] for s in schools if s["suburb"].lower() == suburb.lower()]
        print(suburb, len(hits), hits[:5])


if __name__ == "__main__":
    main()
