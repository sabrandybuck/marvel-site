"""Compare a fresh crawl against the frozen week1 marvel-site dataset.

Reads both node/edge TSVs (ignoring # comment lines) and reports overlap.
Usage: python validate_against_week1.py [data/Marvel_Comics_superheroes]
"""

from __future__ import annotations

import sys
from pathlib import Path

WEEK1 = Path("/projects/marvel-site/data/week1")


def load_tsv(path: Path, columns: int) -> list[tuple[str, ...]]:
    rows = []
    for line in path.read_text(encoding="utf-8").splitlines():
        if not line or line.startswith("#"):
            continue
        parts = tuple(line.split("\t"))
        if len(parts) >= columns:
            rows.append(parts[:columns])
    return rows


def main(out_dir: Path) -> None:
    week1_nodes = {r[0] for r in load_tsv(WEEK1 / "week1_nodes.tsv", 1)}
    week1_edges = {tuple(r) for r in load_tsv(WEEK1 / "week1_edges.tsv", 2)}

    slug = out_dir.name
    fresh_nodes = {r[0] for r in load_tsv(out_dir / f"{slug}_nodes.tsv", 1)}
    fresh_edges = {tuple(r) for r in load_tsv(out_dir / f"{slug}_edges.tsv", 2)}

    print(f"week1:  {len(week1_nodes)} nodes, {len(week1_edges)} edges")
    print(f"fresh:  {len(fresh_nodes)} nodes, {len(fresh_edges)} edges")
    print(f"node overlap: {len(week1_nodes & fresh_nodes)}")
    print(f"  only in week1 ({len(week1_nodes - fresh_nodes)}): "
          f"{sorted(week1_nodes - fresh_nodes)[:8]} ...")
    print(f"  only in fresh ({len(fresh_nodes - week1_nodes)}): "
          f"{sorted(fresh_nodes - week1_nodes)[:8]} ...")

    shared_nodes = week1_nodes & fresh_nodes
    consistent = {e for e in fresh_edges if e[0] in shared_nodes and e[1] in shared_nodes}
    matched = week1_edges & consistent
    print(f"edge recall within shared nodes: "
          f"{len(matched)}/{len(week1_edges)} week1 edges "
          f"({100 * len(matched) / len(week1_edges):.1f}%)")
    print(f"  extra fresh edges among shared nodes: {len(consistent - week1_edges)}")

    nodes_path = out_dir / f"{slug}_nodes.tsv"
    fresh_meta = {r[0]: r for r in load_tsv(nodes_path, 5)}
    week1_meta = {r[0]: r for r in load_tsv(WEEK1 / "week1_nodes.tsv", 5)}
    same_meta = sum(
        1
        for n in shared_nodes
        if week1_meta[n][1] == fresh_meta[n][1]
        and week1_meta[n][2] == fresh_meta[n][2]
        and week1_meta[n][3] == fresh_meta[n][3]
    )
    print(f"nodes with identical name/wikidata/url as week1: {same_meta}/{len(shared_nodes)}")


if __name__ == "__main__":
    main(Path(sys.argv[1]) if len(sys.argv) > 1 else Path("data/Marvel_Comics_superheroes"))
