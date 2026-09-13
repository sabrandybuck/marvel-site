# marvel-crawler

Crawl any Wikipedia category into a network dataset in the same format as the
frozen `marvel-site/data/week1/` Marvel superhero snapshot:

- one **node** per page in the category (redirects resolved and deduplicated)
- one directed **edge** `A -> B` when article A links (directly or through a
  redirect) to article B
- a **summary** with graph statistics (isolates, weakly-connected components,
  degree stats, top-5 hubs and authorities)

Pure Python 3 standard library — no third-party dependencies.

## Usage

```sh
python -m marvel_crawler "Marvel Comics superheroes"
# or, explicitly:
python -m marvel_crawler "Marvel Comics superheroes" \
    --out data/marvel_superheroes --lang en --sleep 1.0

# a 'List of ...' index page works too: the bullets' articles become nodes
python -m marvel_crawler "List of Middle-earth characters"
```

When the input is not a category, the crawler treats it as a list page: each
bullet entry's article (the entry's first `[[...]]` link, redirect-resolved)
becomes a node — links from the entry blurbs to other topics are ignored.

Options:

| flag                      | default          | meaning                                                   |
| ------------------------- | ---------------- | --------------------------------------------------------- |
| `category`                | (required)       | category name, `Category:` prefix optional                |
| `--out DIR`               | `data/<slug>`    | output directory                                          |
| `--lang LANG`             | `en`             | Wikipedia language edition                                |
| `--sleep SEC`             | `1.0`            | minimum seconds between API requests                      |
| `--refresh-cache`         | off              | ignore cached API responses and re-download               |
| `--keep-redirect-targets` | off              | also keep redirect targets that are not category members  |
| `--keep-list-pages`       | off              | do not drop `List of ...` pages from the node set         |

Crawling is resumable: every API response is cached under `out/cache/`, so an
interrupted run (or a re-run) replays from cache instead of hitting Wikipedia
again. Use `--refresh-cache` to force fresh data.

## Output files

For category `X`, with slug `S` (spaces → underscores):

- `S_nodes.tsv` — `node_id`, `name`, `wikidata_id`, `url`, `description`
  (`node_id` = article title with underscores, `description` = first-sentence
  intro extract)
- `S_edges.tsv` — `source`, `target` (node_ids, tab-separated)
- `S_summary.json` — node/edge counts, isolate count, weakly-connected
  component sizes, in/out-degree min/max/mean, Pearson correlation between in-
  and out-degree, top-5 pages by each, largest non-giant component

Both TSV files start with `#` comment lines describing the crawl.

`validate_against_week1.py` (optional helper) compares a crawl of
`Category:Marvel Comics superheroes` against the frozen `marvel-site/data/week1`
dataset and reports node overlap and edge recall:

```sh
python validate_against_week1.py data/Marvel_Comics_superheroes
```

## How it works

1. `list=categorymembers&cmtype=page` — the category's member pages (this
   includes redirect pages, as on live Wikipedia).
2. `action=query&redirects=1` in batches of 50 — member redirects resolve to
   their canonical pages (multi-hop chains and normalization included). The
   node set is the canonical pages that are themselves category members: an
   alias redirect merges into its article, while targets landing outside the
   category (`List of ...`, team articles reached only through aliases) are
   dropped — the same policy the frozen Marvel dataset applies. `List of ...`
   pages are dropped as well (both rules can be relaxed via CLI flags).
3. `prop=pageprops&ppprop=wikibase_item` (50/batch) and
   `prop=extracts&exintro&explaintext&exsentences=1` (20/batch) — node metadata.
4. Per node, `generator=links&gplnamespace=0&gpllimit=max&redirects=1` —
   provides a per-node redirect map (raw linked title -> canonical target).
   Then, in batches of 50, `prop=revisions&rvprop=content` — each article's
   own wiki-source. Edges are the `[[...]]` links found in that source, with
   targets resolved through the redirect maps. This deliberately excludes
   links contributed by transcluded templates (navboxes) — Wikipedia's link
   index would make whole rosters mutually adjacent by templating artefact.
   An edge `A -> B` is kept when both endpoints are nodes (redirect-resolved
   on both ends, no self-loops).
5. Write the TSVs and compute the summary (pure Python: BFS for components,
   hand-rolled Pearson correlation).

## Politeness

The client sends a descriptive `User-Agent`, passes `maxlag=5`, sleeps at
least `--sleep` seconds between requests, and retries with capped exponential
backoff + jitter on 429/503 responses, network errors, empty bodies and
malformed JSON. A full category of a few hundred pages takes roughly 5–15
minutes at the default sleep.

## Fidelity note

Live Wikipedia drifts, so a fresh crawl will not exactly reproduce a frozen
snapshot. Validated against `marvel-site/data/week1` (snapshot 2026-08-26) by
re-crawling `Category:Marvel Comics superheroes` on 2026-09-09:

|                  | week1 snapshot | fresh crawl |
| ---------------- | -------------- | ----------- |
| nodes            | 303            | 307         |
| directed edges   | 1,784          | 1,822       |
| isolates         | 17             | 17          |
| weakly-connected | 19 (giant 277, island of 9) | 19 (giant 281, island of 9) |
| edge recall within shared nodes | — | 97.5% (+4 extra edges) |

Every week1 node except 3 (`Anne Weying`, `Doctor Spectrum`, `NFL SuperPro`
— pages that changed since the snapshot) appears in the fresh crawl; the few
extra nodes and the ~2.5% edge difference are Wikipedia edits made in the two
weeks between snapshots, not methodology gaps. The 9-character non-giant
island consists of the exact same members in both datasets.
