#!/usr/bin/env python3
"""Fetch plain-text Wikipedia extracts for the Marvel supervillains network.

Reads data/Marvel_Comics_supervillains/Marvel_Comics_supervillains_nodes.tsv
and writes one plain-text file per villain page to
data/Marvel_Comics_supervillains/pages/<node_id>.txt, plus a manifest
data/Marvel_Comics_supervillains/pages/manifest.json with per-page word
counts and the pages that could not be fetched.

Uses marvel-crawler's stdlib WikiClient (throttle, retries, disk cache),
so an interrupted run resumes from cache. Run from analysis/:

    python3 fetch_week7_pages.py [--sleep 0.5] [--refresh-cache]
"""

import argparse
import json
import sys
import time
import urllib.parse
from pathlib import Path

import importlib.util

HERE = Path(__file__).resolve().parent
SITE = HERE.parent


def load_wiki_client(sleep: float, refresh: bool):
    """Import marvel-crawler's WikiClient from the sibling project."""
    spec = importlib.util.find_spec("marvel_crawler")
    if spec is None:
        sibling = SITE.parent / "marvel-crawler"
        if not (sibling / "marvel_crawler").is_dir():
            sys.exit("marvel-crawler not found next to marvel-site")
        sys.path.insert(0, str(sibling))
    from marvel_crawler.wiki_api import WikiClient

    return WikiClient(lang="en", sleep=sleep, cache_dir=SITE / "data" / "week7_cache",
                      refresh_cache=refresh)


def read_nodes(path: Path):
    """node_id list from the nodes TSV (# comments + header skipped)."""
    ids = []
    for line in path.read_text(encoding="utf-8").splitlines():
        if not line or line.startswith("#"):
            continue
        fields = line.split("\t")
        if fields[0] == "node_id":          # the TSV header row
            continue
        ids.append(fields[0])
    return ids


def count_words(text: str) -> int:
    return len(text.split())


def main() -> None:
    ap = argparse.ArgumentParser()
    ap.add_argument("--sleep", type=float, default=0.5)
    ap.add_argument("--refresh-cache", action="store_true")
    args = ap.parse_args()

    villain_dir = SITE / "data" / "Marvel_Comics_supervillains"
    pages_dir = villain_dir / "pages"
    pages_dir.mkdir(parents=True, exist_ok=True)

    node_ids = read_nodes(villain_dir / "Marvel_Comics_supervillains_nodes.tsv")
    print(f"{len(node_ids)} villain pages", flush=True)

    client = load_wiki_client(args.sleep, args.refresh_cache)

    manifest = {}
    failed = []
    t0 = time.time()
    for i, node_id in enumerate(node_ids, 1):
        # Full page extracts: the MediaWiki TextExtracts API allows only one
        # title per request when not using exintro.
        data = client.get(
            prop="extracts",
            explaintext=1,
            exlimit=1,
            titles=node_id.replace("_", " "),
        )
        pages = data.get("query", {}).get("pages", [])
        text = pages[0].get("extract", "") if pages else ""

        # Pages that went live as redirects (renames since the crawl snapshot)
        # return no extract at all; follow the redirect and try again.
        if not text.strip():
            data = client.get(
                prop="extracts",
                explaintext=1,
                exlimit=1,
                redirects=1,
                titles=node_id.replace("_", " "),
            )
            pages = data.get("query", {}).get("pages", [])
            if pages:
                text = pages[0].get("extract", "")

        if not text.strip():
            failed.append(node_id)
            print(f"  [{i:3d}/{len(node_ids)}] NO EXTRACT: {node_id}", flush=True)
            continue

        # same filename scheme as data/marvel_pages/: quote(node_id, safe="()'")
        fname = urllib.parse.quote(node_id, safe="()'") + ".txt"
        (pages_dir / fname).write_text(text, encoding="utf-8")
        words = count_words(text)
        manifest[node_id] = {"file": fname, "words": words}
        if i % 25 == 0:
            print(f"  [{i:3d}/{len(node_ids)}] {node_id} ({words} words) "
                  f"elapsed {time.time()-t0:.0f}s", flush=True)

    summary = {
        "requested": len(node_ids),
        "fetched": len(manifest),
        "failed": failed,
        "pages": manifest,
        "total_words": sum(m["words"] for m in manifest.values()),
    }
    out = pages_dir / "manifest.json"
    out.write_text(json.dumps(summary, indent=1), encoding="utf-8")
    print(f"done: fetched {len(manifest)}, failed {len(failed)}, "
          f"{summary['total_words']} words -> {out}", flush=True)
    if failed:
        print("failed nodes:", ", ".join(failed), flush=True)


if __name__ == "__main__":
    main()
