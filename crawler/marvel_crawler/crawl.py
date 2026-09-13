"""Crawl a Wikipedia category into a week1-style graph dataset.

Pipeline
--------
1. Collect the category's direct member pages (``list=categorymembers``).
2. Resolve redirects among members and build the node set: canonical targets
   that are themselves category members (so ``[[alias]]`` members merge into
   their article, while targets landing outside the category — list pages,
   team articles — are dropped, matching the frozen week1 dataset).
3. Fetch node metadata: Wikidata id (``prop=pageprops``) and a one-sentence
   description (``prop=extracts``).
4. Extract edges the way the frozen week1 dataset does: parse each article's
   own wikitext (``prop=revisions&rvprop=content``) for ``[[...]]`` links and
   resolve link targets through redirects. Targets are canonicalised with the
   per-node redirect maps that ``generator=links&redirects=1`` produces (those
   responses are cached, so the second pass costs no extra API requests).
   An edge ``A -> B`` is kept when article A's own source links to B and both
   endpoints are in the node set. Links contributed by transcluded templates
   (navboxes etc.) are ignored, matching the week1 methodology.
5. Write ``<slug>_nodes.tsv``, ``<slug>_edges.tsv`` and ``<slug>_summary.json``
   using the same conventions as the frozen week1 Marvel dataset.
"""

from __future__ import annotations

import datetime as _dt
import json
import re
from pathlib import Path

from . import stats
from .wiki_api import CrawlerError, WikiClient, batched

TITLES_PER_BATCH = 50      # API hard limit for titles=
EXTRACTS_PER_BATCH = 20    # API limit when using prop=extracts
WIKITEXT_PER_BATCH = 50    # pages per revisions query

WIKILINK_RE = re.compile(r"\[\[([^\[\]|]+)(?:\|[^\[\]]*)?\]\]")


def slugify(category: str) -> str:
    cat = category.removeprefix("Category:")
    return cat.replace(" ", "_")


def _node_id(title: str) -> str:
    return title.replace(" ", "_")


def _sanitize_text(text: str) -> str:
    return " ".join(text.replace("\r", " ").replace("\n", " ").split("\t"))


LIST_PAGE_RE = re.compile(r"Lists? of ")


def build_node_set(
    member_titles: list[str],
    resolved: dict[str, str],
    keep_redirect_targets: bool = False,
    keep_list_pages: bool = False,
) -> tuple[list[str], dict[str, int]]:
    """Turn category members into the node set.

    Default policy (matching the frozen week1 dataset): a member that is a
    redirect merges into its canonical page; canonical targets that are not
    members themselves (list pages, team articles, ... reached only through
    redirect aliases) are dropped. Set ``keep_redirect_targets`` to keep every
    canonical target instead. ``List of ...`` pages can optionally be dropped.
    """
    member_set = set(member_titles)
    if keep_redirect_targets:
        candidates = set(resolved.values())
    else:
        candidates = {canonical for canonical in resolved.values() if canonical in member_set}
    dropped_list = 0
    if not keep_list_pages:
        lists = {t for t in candidates if LIST_PAGE_RE.match(t)}
        candidates -= lists
        dropped_list = len(lists)
    return sorted(candidates), {"list_pages": dropped_list}


# --------------------------------------------------------------------- steps

def get_category_members(client: WikiClient, category: str) -> list[str]:
    """Direct member pages of the category (cmtype=page includes redirects)."""
    cat_title = category if category.startswith("Category:") else f"Category:{category}"
    titles: list[str] = []
    for data in client.query_all(
        list="categorymembers",
        cmtitle=cat_title,
        cmtype="page",
        cmlimit="max",
    ):
        titles.extend(m["title"] for m in data.get("query", {}).get("categorymembers", []))
    return titles


def get_list_page_entries(client: WikiClient, page_title: str) -> tuple[list[str], dict[str, str]]:
    """Entries of a 'List of ...' index page: the article each bullet entry
    stands for.

    A list page links far more things than it lists — blurbs link battles,
    places, other works. The bullet's *first* link is the entry's article;
    entries written as plain text (no link) fall back on the name itself and
    are resolved through redirects like any other alias.
    Returns (entry alias names, {alias -> candidate article title}).
    """
    data = client.get(
        titles=page_title, prop="revisions", rvslots="main", rvprop="content"
    )
    page = data["query"]["pages"][0]
    wikitext = page["revisions"][0]["slots"]["main"]["content"]
    entries: list[str] = []
    candidates: dict[str, str] = {}
    for line in wikitext.splitlines():
        stripped = line.strip()
        if not stripped.startswith("*"):
            continue
        line = stripped[1:]
        match = WIKILINK_RE.search(line)
        if match:
            alias = match.group(1).strip().split("#", 1)[0].strip()
            target = alias
        else:
            name = line.split(":", 1)[0].replace("'''", "").replace("''", "").strip()
            alias = name
            if not name:
                continue
            target = name
        if alias:  # drop sub-list entries ('List of ...') later via build
            entries.append(alias)
            candidates.setdefault(alias, target)
    return entries, candidates


def resolve_list_targets(
    client: WikiClient, candidates: dict[str, str]
) -> tuple[dict[str, str], dict[str, str]]:
    """Resolve list-entry titles to canonical, existing, article-namespace
    pages; drop red links, special namespaces and sub-list pages.
    Returns ({alias -> node title}, {alias -> drop reason})."""
    resolved: dict[str, str] = {}
    dropped: dict[str, str] = {}
    aliases_by_target: dict[str, list[str]] = {}
    for alias, target in candidates.items():
        aliases_by_target.setdefault(target, []).append(alias)
    targets = sorted(aliases_by_target)
    for i, batch in enumerate(batched(targets, TITLES_PER_BATCH), 1):
        data = client.get(titles="|".join(batch), redirects=1, prop="info")
        query = data.get("query", {})
        normalized = {n["from"]: n["to"] for n in query.get("normalized", [])}
        redirects = {r["from"]: r["to"] for r in query.get("redirects", [])}
        # canonical titles that are real article-namespace pages
        ns0_pages = {
            p["title"]
            for p in query.get("pages", [])
            if "missing" not in p and p.get("ns", 0) == 0
        }
        for target in batch:
            current = normalized.get(target, target)
            seen: set[str] = set()
            while current in redirects and current not in seen:
                seen.add(current)
                current = redirects[current]
            if current not in ns0_pages:
                reason = f"no article ({current})"
            elif LIST_PAGE_RE.match(current):
                reason = f"sub-list ({current})"
            else:
                for alias in aliases_by_target[target]:
                    resolved[alias] = current
                continue
            for alias in aliases_by_target[target]:
                dropped[alias] = reason
        print(f"  list entries: batch {i}", end="", flush=True)
    print()
    return resolved, dropped


def resolve_redirects(client: WikiClient, titles: list[str]) -> dict[str, str]:
    """Map every input title to its canonical (non-redirect) page title.

    Handles normalization and multi-hop redirect chains. Titles that cannot be
    resolved to a returned page are dropped (they vanished or are invalid).
    """
    resolved: dict[str, str] = {}
    for i, batch in enumerate(batched(titles, TITLES_PER_BATCH), 1):
        data = client.get(titles="|".join(batch), redirects=1)
        query = data.get("query", {})
        normalized = {n["from"]: n["to"] for n in query.get("normalized", [])}
        redirects = {r["from"]: r["to"] for r in query.get("redirects", [])}
        page_titles = {p["title"] for p in query.get("pages", [])}
        for title in batch:
            current = normalized.get(title, title)
            seen: set[str] = set()
            while current in redirects and current not in seen:
                seen.add(current)
                current = redirects[current]
            resolved[title] = current
        print(f"\r  resolving redirects: batch {i}", end="", flush=True)
    print()
    return resolved


def fetch_wikidata_ids(client: WikiClient, titles: list[str]) -> dict[str, str]:
    out: dict[str, str] = {}
    total = (len(titles) + TITLES_PER_BATCH - 1) // TITLES_PER_BATCH
    for i, batch in enumerate(batched(titles, TITLES_PER_BATCH), 1):
        data = client.get(
            titles="|".join(batch), prop="pageprops", ppprop="wikibase_item"
        )
        for page in data.get("query", {}).get("pages", []):
            out[page["title"]] = page.get("pageprops", {}).get("wikibase_item", "")
        print(f"\r  wikidata ids: batch {i}/{total}", end="", flush=True)
    print()
    return out


def fetch_descriptions(client: WikiClient, titles: list[str]) -> dict[str, str]:
    """First-sentence plain-text intro extract for each page."""
    out: dict[str, str] = {}
    total = (len(titles) + EXTRACTS_PER_BATCH - 1) // EXTRACTS_PER_BATCH
    for i, batch in enumerate(batched(titles, EXTRACTS_PER_BATCH), 1):
        data = client.get(
            titles="|".join(batch),
            prop="extracts",
            exintro=1,
            explaintext=1,
            exsentences=1,
            exlimit="max",
        )
        for page in data.get("query", {}).get("pages", []):
            out[page["title"]] = page.get("extract", "")
        print(f"\r  descriptions: batch {i}/{total}", end="", flush=True)
    print()
    return out


def fetch_redirect_maps(
    client: WikiClient, node_titles: list[str], progress_every: int = 50
) -> dict[str, dict[str, str]]:
    """Per-node redirect maps (raw link title -> canonical target) from
    ``generator=links&redirects=1``. These requests replay from cache when a
    crawl was run before, so this pass costs no API calls on a re-run."""
    maps: dict[str, dict[str, str]] = {}
    for i, source in enumerate(node_titles, 1):
        redirects: dict[str, str] = {}
        for data in client.query_all(
            titles=source,
            generator="links",
            gplnamespace=0,
            gpllimit="max",
            redirects=1,
        ):
            redirects.update(
                {r["from"]: r["to"] for r in data.get("query", {}).get("redirects", [])}
            )
        maps[source] = redirects
        if i % progress_every == 0 or i == len(node_titles):
            print(f"\r  redirect maps: {i}/{len(node_titles)} pages", end="", flush=True)
    print()
    return maps


def fetch_wikitext_links(
    client: WikiClient, node_titles: list[str]
) -> dict[str, list[str]]:
    """Raw ``[[...]]`` link targets found in each article's own wikitext
    (body, infobox and references — but not transcluded templates)."""
    links: dict[str, list[str]] = {}
    total = (len(node_titles) + WIKITEXT_PER_BATCH - 1) // WIKITEXT_PER_BATCH
    for i, batch in enumerate(batched(node_titles, WIKITEXT_PER_BATCH), 1):
        cont: dict = {}
        while True:
            data = client.get(
                titles="|".join(batch),
                prop="revisions",
                rvslots="main",
                rvprop="content",
                **cont,
            )
            for page in data.get("query", {}).get("pages", []):
                revisions = page.get("revisions", [])
                wikitext = ""
                if revisions:
                    slots = revisions[0].get("slots", {})
                    wikitext = slots.get("main", {}).get("content", "")
                links[page["title"]] = WIKILINK_RE.findall(wikitext)
            if "continue" not in data:
                break
            cont = data["continue"]
        print(f"\r  wikitext: batch {i}/{total}", end="", flush=True)
    print()
    return links


def fetch_edges(client: WikiClient, node_titles: list[str]) -> set[tuple[str, str]]:
    """Edges A -> B when article A's own wikitext links to B (directly or
    through a redirect) and both endpoints are in the node set."""
    node_set = set(node_titles)
    redirect_maps = fetch_redirect_maps(client, node_titles)
    body_links = fetch_wikitext_links(client, node_titles)

    edges: set[tuple[str, str]] = set()
    for source in node_titles:
        redirects = redirect_maps.get(source, {})
        for raw in body_links.get(source, ()):
            target = raw.strip().split("#", 1)[0].strip()
            if not target:
                continue
            target = redirects.get(target, target)
            if target in node_set and target != source:  # no self-loops
                edges.add((source, target))
    print(f"  kept {len(edges)} edges inside the node set")
    return edges


# -------------------------------------------------------------------- output

def write_nodes_tsv(
    path: Path,
    node_titles: list[str],
    wikidata: dict[str, str],
    descriptions: dict[str, str],
    source_label: str,
    lang: str,
) -> int:
    when = _dt.date.today().isoformat()
    lines = [
        f"# marvel-crawler — {slugify(source_label)} crawl ({when})",
        f"# Wikipedia {source_label} — {len(node_titles)} nodes (redirects "
        "resolved).",
        "# node_id matches the source column of the edges file.",
        "node_id\tname\twikidata_id\turl\tdescription",
    ]
    for title in node_titles:
        node = _node_id(title)
        lines.append(
            "\t".join(
                [
                    node,
                    title,
                    wikidata.get(title, ""),
                    f"https://{lang}.wikipedia.org/wiki/{node}",
                    _sanitize_text(descriptions.get(title, "")),
                ]
            )
        )
    path.write_text("\n".join(lines) + "\n", encoding="utf-8")
    return len(node_titles)


def write_edges_tsv(
    path: Path,
    node_titles: list[str],
    edges: set[tuple[str, str]],
    source_label: str,
) -> tuple[int, int]:
    when = _dt.date.today().isoformat()
    isolates = stats.count_isolates(node_titles, edges)
    sorted_edges = sorted(edges, key=lambda e: (_node_id(e[0]), _node_id(e[1])))
    lines = [
        f"# marvel-crawler — {slugify(source_label)} crawl ({when})",
        f"# Wikipedia {source_label}: one node per page; edge A -> B",
        f"# when the article of A links to the article of B. "
        f"{len(node_titles)} nodes, {len(sorted_edges)} directed edges.",
        f"# {isolates} nodes have no edge in either direction — take the full "
        "node set from the nodes file.",
        "source\ttarget",
    ]
    for source, target in sorted_edges:
        lines.append(f"{_node_id(source)}\t{_node_id(target)}")
    path.write_text("\n".join(lines) + "\n", encoding="utf-8")
    return len(sorted_edges), isolates


def write_summary(path: Path, summary: dict) -> None:
    with open(path, "w", encoding="utf-8") as f:
        json.dump(summary, f, indent=2, ensure_ascii=False)
        f.write("\n")


# --------------------------------------------------------------------- main

def detect_source_kind(client: WikiClient, name: str) -> str:
    """'category' if Category:<name> exists, else 'page' if <name> exists.
    Raises CrawlerError when neither does."""
    title = name.removeprefix("Category:")
    probe = client.get(titles=f"Category:{title}|{title}", prop="info")
    existing = {
        p["title"] for p in probe.get("query", {}).get("pages", []) if "missing" not in p
    }
    if f"Category:{title}" in existing:
        return "category"
    if title in existing:
        return "page"
    raise CrawlerError(
        f"Neither Category:{title} nor the page {title} exists on "
        f"{client.api_url.split('/w/')[0]}"
    )


def crawl(
    source: str,
    out_dir: str | Path,
    lang: str = "en",
    sleep: float = 1.0,
    refresh_cache: bool = False,
    keep_redirect_targets: bool = False,
    keep_list_pages: bool = False,
) -> dict:
    out_dir = Path(out_dir)
    out_dir.mkdir(parents=True, exist_ok=True)
    slug = slugify(source.removeprefix("Category:"))

    client = WikiClient(
        lang=lang,
        sleep=sleep,
        cache_dir=out_dir / "cache",
        refresh_cache=refresh_cache,
    )

    kind = detect_source_kind(client, source)

    if kind == "category":
        print(f"[1/5] Collecting members of Category:{slug} ...")
        member_aliases = member_titles = get_category_members(client, source)
        print(f"  {len(member_aliases)} member pages (including redirects)")

        print("[2/5] Building the node set ...")
        resolved = resolve_redirects(client, member_titles)
        node_titles, drop_stats = build_node_set(
            member_titles,
            resolved,
            keep_redirect_targets=keep_redirect_targets,
            keep_list_pages=keep_list_pages,
        )
        if drop_stats["list_pages"]:
            print(f"  dropped {drop_stats['list_pages']} 'List of ...' pages")
        print(
            f"  {len(node_titles)} nodes "
            f"({len(set(resolved.values())) - len(node_titles)} "
            "canonical targets outside the category removed)"
        )
    else:
        print(f"[1/5] Parsing the list page '{slugify(source)}' ...")
        aliases, candidates = get_list_page_entries(client, source)
        print(f"  {len(aliases)} bullet entries")

        print("[2/5] Building the node set ...")
        entry_targets, dropped = resolve_list_targets(client, candidates)
        for alias, reason in sorted(dropped.items()):
            print(f"  dropped {alias!r}: {reason}")
        node_titles = sorted(set(entry_targets.values()))
        print(f"  {len(node_titles)} nodes from {len(aliases)} entries")

    print("[3/5] Fetching node metadata ...")
    wikidata = fetch_wikidata_ids(client, node_titles)
    descriptions = fetch_descriptions(client, node_titles)

    print("[4/5] Extracting edges (links between nodes) ...")
    edges = fetch_edges(client, node_titles)

    nodes_path = out_dir / f"{slug}_nodes.tsv"
    edges_path = out_dir / f"{slug}_edges.tsv"
    summary_path = out_dir / f"{slug}_summary.json"

    source_label = (
        f"Category:{slug}" if kind == "category" else f"the list page {slug}"
    )

    print("[5/5] Writing outputs ...")
    n_nodes = write_nodes_tsv(nodes_path, node_titles, wikidata, descriptions, source_label, lang)
    n_edges, isolates = write_edges_tsv(edges_path, node_titles, edges, source_label)
    names = {t: t for t in node_titles}  # summary reports node names; title == name
    summary = stats.compute_summary(node_titles, names, edges)
    write_summary(summary_path, summary)

    print(
        f"Done: {n_nodes} nodes, {n_edges} edges, {isolates} isolates.\n"
        f"  {nodes_path}\n  {edges_path}\n  {summary_path}\n"
        f"  ({client.n_requests} API requests, {client.n_cache_hits} cache hits)"
    )
    return {
        "nodes": n_nodes,
        "edges": n_edges,
        "isolates": isolates,
        "nodes_path": str(nodes_path),
        "edges_path": str(edges_path),
        "summary_path": str(summary_path),
    }
