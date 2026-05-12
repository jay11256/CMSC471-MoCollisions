"""
Preprocess the raw Montgomery County crash reporting CSV into a compact, cleaned
data file (and a pre-aggregated ZIP-code GeoJSON) that the front-end can load fast.

Output files (written into ``data/``):
    - ``crashes_clean.csv``         : 1 row per crash, normalised columns
    - ``mc_zipcodes.geojson``       : Montgomery-County, MD ZIP-code polygons
                                      (only created if a source GeoJSON is found)
    - ``zip_aggregate.json``        : { zip: { total, fatal, severe, injury, ... } }

Run from the project root:
    python preprocess.py
"""

from __future__ import annotations

import json
import re
import sys
import urllib.request
from collections import Counter, defaultdict
from pathlib import Path

import pandas as pd

try:
    from shapely.geometry import shape, Point
    from shapely.strtree import STRtree
    HAVE_SHAPELY = True
except Exception:
    HAVE_SHAPELY = False

DATA_DIR = Path(__file__).parent / "data"
RAW_CSV = DATA_DIR / "Crash_Reporting.csv"
OUT_CSV = DATA_DIR / "crashes_clean.csv"
ZIP_AGG_OUT = DATA_DIR / "zip_aggregate.json"
ZIP_GEOJSON_OUT = DATA_DIR / "mc_zipcodes.geojson"


# ---------------------------------------------------------------------------
# Category normalisation
# ---------------------------------------------------------------------------

SEVERITY_MAP = {
    "no apparent injury": "No Apparent Injury",
    "possible injury": "Possible Injury",
    "suspected minor injury": "Suspected Minor Injury",
    "suspected serious injury": "Suspected Serious Injury",
    "fatal injury": "Fatal Injury",
}


def norm(value):
    if pd.isna(value):
        return None
    return re.sub(r"\s+", " ", str(value)).strip()


def title_case(value):
    v = norm(value)
    if v is None:
        return None
    return v.title()


def severity(value):
    v = norm(value)
    if v is None:
        return "Unknown"
    return SEVERITY_MAP.get(v.lower(), v.title())


def light_bucket(value):
    """Collapse the 16 light categories into 5 buckets."""
    v = norm(value)
    if v is None:
        return "Unknown"
    up = v.upper()
    if "DAYLIGHT" in up:
        return "Daylight"
    if "DUSK" in up:
        return "Dusk"
    if "DAWN" in up:
        return "Dawn"
    if "DARK" in up:
        if "LIGHTS ON" in up or "LIGHTED" in up:
            return "Dark - Lighted"
        if "NO LIGHTS" in up or "NOT LIGHTED" in up:
            return "Dark - Unlit"
        return "Dark"
    return "Other / Unknown"


def weather_bucket(value):
    v = norm(value)
    if v is None:
        return "Unknown"
    up = v.upper()
    if "CLEAR" in up:
        return "Clear"
    if "CLOUD" in up:
        return "Cloudy"
    if "RAIN" in up or "DRIZZLE" in up:
        return "Rain"
    if "SNOW" in up:
        return "Snow"
    if "SLEET" in up or "HAIL" in up or "WINTRY" in up:
        return "Sleet / Ice"
    if "FOG" in up:
        return "Fog"
    if "WIND" in up or "BLOW" in up:
        return "Severe Winds"
    return "Other / Unknown"


def surface_bucket(value):
    v = norm(value)
    if v is None:
        return "Unknown"
    up = v.upper()
    if up == "DRY":
        return "Dry"
    if up == "WET":
        return "Wet"
    if "ICE" in up or "FROST" in up or "SNOW" in up or "SLUSH" in up:
        return "Ice / Snow"
    if "OIL" in up or "MUD" in up or "SAND" in up or "WATER" in up:
        return "Debris / Water"
    return "Other / Unknown"


def collision_bucket(value):
    v = norm(value)
    if v is None:
        return "Unknown"
    up = v.upper()
    if "REAR END" in up or "FRONT TO REAR" in up or "REND" in up:
        return "Rear-End"
    if "HEAD ON" in up or "FRONT TO FRONT" in up:
        return "Head-On"
    if "SIDESWIPE" in up:
        return "Sideswipe"
    if "ANGLE" in up or "STRAIGHT MOVEMENT ANGLE" in up:
        return "Angle"
    if "SINGLE" in up:
        return "Single Vehicle"
    if "LEFT TURN" in up or "RIGHT TURN" in up:
        return "Turning"
    if "PEDESTRIAN" in up:
        return "Pedestrian"
    return "Other"


def distraction_bucket(value):
    v = norm(value)
    if v is None:
        return "Unknown"
    up = v.upper()
    if up.startswith("NOT DISTRACTED"):
        return "Not Distracted"
    if up == "UNKNOWN":
        return "Unknown"
    if "CELL" in up or "PHONE" in up or "TEXT" in up or "ELECTRONIC" in up:
        return "Phone / Electronics"
    if "LOOKED BUT DID NOT SEE" in up:
        return "Looked but did not see"
    if "INATTENTIVE" in up or "LOST IN THOUGHT" in up:
        return "Inattentive"
    if "EATING" in up or "DRINKING" in up:
        return "Eating / Drinking"
    if "OUTSIDE" in up or "MOVING OBJECT" in up:
        return "External distraction"
    if "OTHER" in up:
        return "Other distraction"
    return "Other distraction"


def substance_bucket(value):
    v = norm(value)
    if v is None:
        return "Unknown"
    up = v.upper()
    if "NONE DETECTED" in up or "NOT SUSPECT" in up:
        return "None"
    if "ALCOHOL" in up and "DRUG" in up and "SUSPECT" in up:
        return "Alcohol + Drug suspected"
    if "ALCOHOL" in up:
        return "Alcohol"
    if "DRUG" in up:
        return "Drug"
    if "MEDICATION" in up:
        return "Medication"
    if "COMBINED" in up:
        return "Combined"
    return "Unknown"


def vehicle_bucket(value):
    v = norm(value)
    if v is None:
        return "Unknown"
    up = v.upper()
    if "PASSENGER CAR" in up:
        return "Passenger Car"
    if "UTILITY VEHICLE" in up or "SUV" in up:
        return "SUV"
    if "PICKUP" in up:
        return "Pickup"
    if "VAN" in up and "CARGO" not in up:
        return "Van"
    if "BUS" in up:
        return "Bus"
    if "TRUCK" in up or "CARGO" in up:
        return "Truck"
    if "MOTORCYCLE" in up or "MOPED" in up:
        return "Motorcycle"
    if "BICYCLE" in up:
        return "Bicycle"
    if "POLICE" in up or "EMERGENCY" in up or "FIRE" in up or "AMBULANCE" in up:
        return "Emergency"
    return "Other"


# ---------------------------------------------------------------------------
# Main
# ---------------------------------------------------------------------------


def main() -> None:
    if not RAW_CSV.exists():
        sys.exit(f"Raw CSV not found at {RAW_CSV}")

    print(f"Loading {RAW_CSV.name} ...")
    df = pd.read_csv(RAW_CSV, low_memory=False)
    print(f"  loaded {len(df):,} rows")

    df["Crash Date/Time"] = pd.to_datetime(df["Crash Date/Time"], errors="coerce")
    df = df.dropna(subset=["Crash Date/Time", "Latitude", "Longitude"]).copy()

    df = df[
        (df["Latitude"].between(38.9, 39.4))
        & (df["Longitude"].between(-77.5, -76.85))
    ].copy()
    print(f"  {len(df):,} rows remain after geo / date cleaning")

    out = pd.DataFrame()
    out["year"] = df["Crash Date/Time"].dt.year.astype("int16")
    out["month"] = df["Crash Date/Time"].dt.month.astype("int8")
    out["dow"] = df["Crash Date/Time"].dt.dayofweek.astype("int8")
    out["hour"] = df["Crash Date/Time"].dt.hour.astype("int8")
    out["lat"] = df["Latitude"].round(4)
    out["lon"] = df["Longitude"].round(4)

    out["severity"] = df["Injury Severity"].map(severity)
    out["weather"] = df["Weather"].map(weather_bucket)
    out["light"] = df["Light"].map(light_bucket)
    out["surface"] = df["Surface Condition"].map(surface_bucket)
    out["collision"] = df["Collision Type"].map(collision_bucket)
    out["distraction"] = df["Driver Distracted By"].map(distraction_bucket)
    out["substance"] = df["Driver Substance Abuse"].map(substance_bucket)
    out["vehicle"] = df["Vehicle Body Type"].map(vehicle_bucket)
    out["at_fault"] = df["Driver At Fault"].map(norm).fillna("Unknown")
    out["speed"] = pd.to_numeric(df["Speed Limit"], errors="coerce").fillna(-1).astype("int16")
    out["route"] = df["Route Type"].map(norm).fillna("Unknown")

    out = out.sort_values(["year", "month"]).reset_index(drop=True)

    out["zip"] = compute_zip_per_row(out)

    cat_cols = [
        "severity", "weather", "light", "surface", "collision",
        "distraction", "substance", "vehicle", "at_fault", "route",
    ]
    sort_orders = {
        "severity": [
            "No Apparent Injury", "Possible Injury", "Suspected Minor Injury",
            "Suspected Serious Injury", "Fatal Injury", "Unknown",
        ],
    }
    categories = {}
    encoded = pd.DataFrame()
    encoded["year"] = out["year"]
    encoded["month"] = out["month"]
    encoded["dow"] = out["dow"]
    encoded["hour"] = out["hour"]
    encoded["lat"] = out["lat"]
    encoded["lon"] = out["lon"]
    encoded["speed"] = out["speed"]

    for col in cat_cols:
        order = sort_orders.get(col)
        if order is None:
            order = sorted(out[col].dropna().unique().tolist())
        else:
            for value in sorted(out[col].dropna().unique().tolist()):
                if value not in order:
                    order.append(value)
        mapping = {name: idx for idx, name in enumerate(order)}
        encoded[col] = out[col].map(mapping).fillna(-1).astype("int16")
        categories[col] = order

    encoded["zip"] = out["zip"].fillna("").astype(str)

    encoded.to_csv(OUT_CSV, index=False)
    size_mb = OUT_CSV.stat().st_size / 1024 / 1024
    print(f"  wrote {OUT_CSV.name}  ({size_mb:.1f} MB, {len(out):,} rows)")

    summary = {
        "total_rows": int(len(out)),
        "year_min": int(out["year"].min()),
        "year_max": int(out["year"].max()),
        "lat_bounds": [float(out["lat"].min()), float(out["lat"].max())],
        "lon_bounds": [float(out["lon"].min()), float(out["lon"].max())],
        "categories": categories,
    }
    (DATA_DIR / "summary.json").write_text(json.dumps(summary, indent=2))
    print("  wrote summary.json")

    build_zip_choropleth(out)
    print("\nDone.")


# ---------------------------------------------------------------------------
# Helpers: ZIP polygons (cached at module level once we fetch them)
# ---------------------------------------------------------------------------

_ZIP_CACHE = {"feats": None}


def _load_zip_feats(out: pd.DataFrame):
    if _ZIP_CACHE["feats"] is not None:
        return _ZIP_CACHE["feats"]
    if not HAVE_SHAPELY:
        _ZIP_CACHE["feats"] = []
        return []
    try:
        with urllib.request.urlopen(MD_ZIP_SOURCE, timeout=60) as resp:
            md = json.load(resp)
    except Exception:
        _ZIP_CACHE["feats"] = []
        return []

    lat_min, lat_max = float(out["lat"].min()) - 0.05, float(out["lat"].max()) + 0.05
    lon_min, lon_max = float(out["lon"].min()) - 0.05, float(out["lon"].max()) + 0.05
    feats = []
    for feat in md["features"]:
        try:
            lat = float(feat["properties"]["INTPTLAT10"])
            lon = float(feat["properties"]["INTPTLON10"])
        except Exception:
            continue
        if lat_min <= lat <= lat_max and lon_min <= lon <= lon_max:
            zip_code = feat["properties"]["ZCTA5CE10"]
            geom = shape(feat["geometry"])
            feats.append((zip_code, geom, feat))
    _ZIP_CACHE["feats"] = feats
    return feats


def compute_zip_per_row(out: pd.DataFrame):
    """Return a Series of ZIP code (string, '' if unassigned) per row."""
    feats = _load_zip_feats(out)
    if not feats:
        return pd.Series([""] * len(out), index=out.index)

    geoms = [c[1] for c in feats]
    zips = [c[0] for c in feats]
    tree = STRtree(geoms)

    pts_lat = out["lat"].values
    pts_lon = out["lon"].values
    n = len(out)
    print(f"  assigning ZIPs to {n:,} crashes ...")
    result = [None] * n
    for i in range(n):
        pt = Point(float(pts_lon[i]), float(pts_lat[i]))
        idxs = tree.query(pt)
        for idx in idxs:
            if geoms[idx].contains(pt):
                result[i] = zips[idx]
                break
    miss = sum(1 for r in result if r is None)
    print(f"  {n - miss:,} assigned, {miss:,} unassigned")
    return pd.Series([r if r else "" for r in result], index=out.index)


# ---------------------------------------------------------------------------
# Build Montgomery County ZIP GeoJSON + per-ZIP aggregates
# ---------------------------------------------------------------------------


MD_ZIP_SOURCE = (
    "https://raw.githubusercontent.com/OpenDataDE/State-zip-code-GeoJSON/master/"
    "md_maryland_zip_codes_geo.min.json"
)


def build_zip_choropleth(out: pd.DataFrame) -> None:
    """Filter the MD ZIP-code GeoJSON down to Montgomery County polygons that
    actually contain crashes, then write the filtered GeoJSON + a per-ZIP
    aggregate JSON used by the choropleth."""

    if not HAVE_SHAPELY:
        print("  shapely not available - skipping ZIP choropleth build")
        return

    print("\nBuilding ZIP-code choropleth ...")
    candidates = _load_zip_feats(out)
    if not candidates:
        print("  no candidate ZIPs - skipping")
        return
    print(f"  {len(candidates)} candidate ZIPs in bbox")

    counts = defaultdict(lambda: defaultdict(int))
    sev_vals = out["severity"].values
    coll_vals = out["collision"].values
    zip_vals = out["zip"].values
    miss = 0
    for i in range(len(out)):
        z = zip_vals[i]
        if not z:
            miss += 1
            continue
        counts[z]["total"] += 1
        sev = sev_vals[i]
        if sev == "Fatal Injury":
            counts[z]["fatal"] += 1
        elif sev == "Suspected Serious Injury":
            counts[z]["serious"] += 1
        elif sev in ("Suspected Minor Injury", "Possible Injury"):
            counts[z]["injury"] += 1
        if coll_vals[i] == "Pedestrian":
            counts[z]["pedestrian"] += 1

    keep = [c for c in candidates if c[0] in counts]
    print(f"  {len(keep)} ZIPs with crash data ({miss:,} crashes outside any ZIP)")

    def round_coords(c):
        if isinstance(c[0], (int, float)):
            return [round(float(c[0]), 4), round(float(c[1]), 4)]
        return [round_coords(x) for x in c]

    filtered_features = []
    for zip_code, _, feat in keep:
        geom = json.loads(json.dumps(feat["geometry"]))
        geom["coordinates"] = round_coords(geom["coordinates"])
        filtered_features.append({
            "type": "Feature",
            "geometry": geom,
            "properties": {
                "zip": zip_code,
                "total": counts[zip_code]["total"],
                "fatal": counts[zip_code]["fatal"],
                "serious": counts[zip_code]["serious"],
                "injury": counts[zip_code]["injury"],
                "pedestrian": counts[zip_code]["pedestrian"],
            },
        })
    filtered = {"type": "FeatureCollection", "features": filtered_features}
    ZIP_GEOJSON_OUT.write_text(json.dumps(filtered, separators=(",", ":")))
    size_mb = ZIP_GEOJSON_OUT.stat().st_size / 1024 / 1024
    print(f"  wrote {ZIP_GEOJSON_OUT.name}  ({size_mb:.1f} MB, {len(keep)} ZIPs)")

    aggregate = {z: dict(v) for z, v in counts.items()}
    ZIP_AGG_OUT.write_text(json.dumps(aggregate))
    print(f"  wrote {ZIP_AGG_OUT.name}")


if __name__ == "__main__":
    main()
