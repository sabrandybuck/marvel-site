"""Command-line interface for the Wikipedia category crawler."""

from __future__ import annotations

import argparse

from .crawl import crawl as run_crawl
from .crawl import slugify


def build_parser() -> argparse.ArgumentParser:
    parser = argparse.ArgumentParser(
        prog="marvel_crawler",
        description=(
            "Crawl a Wikipedia category or list page into a network dataset: one node per "
            "page (redirects resolved), one directed edge per article link "
            "between nodes. Outputs nodes.tsv, edges.tsv and summary.json "
            "compatible with the marvel-site week1 dataset."
        ),
    )
    parser.add_argument(
        "source",
        help="Wikipedia category name (Category: prefix optional) or a "
        "'List of ...' page whose bullet entries define the nodes",
    )
    parser.add_argument(
        "--out",
        default=None,
        help="output directory (default: data/<category_slug>)",
    )
    parser.add_argument(
        "--lang", default="en", help="Wikipedia language edition (default: en)"
    )
    parser.add_argument(
        "--sleep",
        type=float,
        default=1.0,
        help="minimum seconds between API requests (default: 1.0)",
    )
    parser.add_argument(
        "--refresh-cache",
        action="store_true",
        help="ignore cached API responses and re-download everything",
    )
    parser.add_argument(
        "--keep-redirect-targets",
        action="store_true",
        help="keep every redirect's canonical target as a node, even when it "
        "is not itself a member of the category (e.g. list pages reached "
        "through redirect aliases)",
    )
    parser.add_argument(
        "--keep-list-pages",
        action="store_true",
        help="do not drop 'List of ...' pages from the node set",
    )
    return parser


def main(argv: list[str] | None = None) -> None:
    args = build_parser().parse_args(argv)
    out_dir = args.out if args.out else f"data/{slugify(args.source)}"
    try:
        run_crawl(
            source=args.source,
            out_dir=out_dir,
            lang=args.lang,
            sleep=args.sleep,
            refresh_cache=args.refresh_cache,
            keep_redirect_targets=args.keep_redirect_targets,
            keep_list_pages=args.keep_list_pages,
        )
    except KeyboardInterrupt:
        raise SystemExit(130)
