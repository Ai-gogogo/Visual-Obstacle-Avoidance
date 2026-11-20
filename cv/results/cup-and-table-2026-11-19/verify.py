"""Recompute the published summaries from numeric observations, without footage."""
import csv
from pathlib import Path
from statistics import median

root = Path(__file__).resolve().parent


def read_rows(name):
    with (root / name).open(newline="", encoding="utf-8") as source:
        return list(csv.DictReader(source))


frames = list(range(25, 376, 25))
regions = {}
for row in read_rows("cup-coverage.csv"):
    key = int(row["frame"]), row["region"]
    assert key not in regions
    count, area = int(row["valid"]), int(row["pixels"])
    assert area == (int(row["x2"]) - int(row["x1"])) * (int(row["y2"]) - int(row["y1"]))
    assert 0 <= count <= area and abs(float(row["pct"]) - 100 * count / area) < 1e-8
    regions[key] = row

assert set(regions) == {(frame, region) for frame in frames for region in ("print", "white", "book")}
for region in ("print", "white", "book"):
    rows = [regions[frame, region] for frame in frames]
    count = sum(int(row["valid"]) for row in rows)
    area = sum(int(row["pixels"]) for row in rows)
    typical = median(float(row["pct"]) for row in rows)
    print(f"{region}: median {typical:.1f}%, pooled {count}/{area} ({100*count/area:.1f}%)")

ordered = []
for frame in frames:
    cup, book = regions[frame, "print"], regions[frame, "book"]
    if min(float(cup["pct"]), float(book["pct"])) >= 10:
        ordered.append(float(cup["median_squares"]) < float(book["median_squares"]))
print(f"Cup closer to Camera A: {sum(ordered)}/{len(ordered)} eligible frames")

planes = read_rows("table-plane.csv")
assert [int(row["frame"]) for row in planes] == frames
passed = 0
for row in planes:
    assert row["print_pts"] == regions[int(row["frame"]), "print"]["valid"]
    accepted = (int(row["inliers"]) >= 40 and int(row["grid_cells"]) >= 6
                and int(row["inliers"]) / int(row["training"]) >= .5
                and int(row["holdout"]) >= 15 and float(row["p90"]) <= .8)
    assert accepted == (row["validated"] == "True")
    passed += accepted
best = min(planes, key=lambda row: float(row["p90"]))
print(f"Table planes accepted: {passed}/{len(planes)}; lowest holdout P90: {best['p90']} squares (frame {best['frame']})")
