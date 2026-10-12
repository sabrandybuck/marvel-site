# The Web of Heroes — Marvel Site

A weekly interactive data story for DTU course 02805 (Social Graphs and Interactions). It starts
from the Wikipedia link network of 303 Marvel Comics superheroes and, week by week, applies the
course's tools to it: degree distributions, null models, centrality and robustness, community
detection, text mining, and word embeddings. Several weeks also run the same method on other
datasets (other fictional universes, a philosopher network) for comparison.

It is also the team's first hands-on project with agentic coding tools. The site is plain
HTML/CSS/JavaScript with no build step; the analysis is done offline in Python and frozen into
JSON/TSV files that the pages load.

**Live site:** https://sabrandybuck.github.io/marvel-site/

**Status:** Weeks 1–6 are implemented. Weeks 7 and 8 are placeholder pages ("Coming soon") with
no content or data yet.

## Week by week

**Week 1 — Mapping the Marvel network** (`posts/week-1-marvel-network.html`)
How hub-dominated is the hero network? Degree distributions (linear and log-log), in- vs
out-degree, and components of the frozen snapshot (303 nodes, 1,784 edges, 277-node giant
component), with an interactive network view and figures from `assets/week1/`.

**Week 2 — Models and null models** (`posts/week-2-*.html`)
Is a hub that size an accident? Explorables for Erdős–Rényi graphs, a degree-preserving
shuffle, a preferential-attachment (Price) model and the friendship paradox, plus a power-law
fit. Run on the Marvel heroes and six crawled datasets: Silmarillion, A Song of Ice and Fire,
Middle-earth, Star Trek: Deep Space Nine, Street Fighter, and Marvel supervillains.

**Week 3 — Paths, centrality and cliques** (`posts/week-3.html`, `posts/week-3-marvel-supervillains.html`)
Who matters and what breaks without them? Five centrality measures against a shuffle null, a
Six Degrees path explorer, node-removal fragmentation curves and maximal cliques, for heroes and
supervillains. Two "save the network" games (`posts/week-3-save-game*.html`) let readers try
removing characters themselves.

**Week 4 — Communities, traditions and backbones** (`posts/week-4.html`)
New dataset: 1,444 philosophers. Louvain vs Infomap, Aristotle's community membership, a
disparity-filter backbone with an alpha slider showing where the giant component breaks, and
weighted vs unweighted Louvain.

**Week 5 — Build the corpus yourself** (`posts/week-5.html`)
Text of the 303 hero pages (727,440 tokens). How fast does vocabulary grow (Heaps' law)? A "duel"
explorable adds pages by chosen strategy (Zipf deviation, one-offs, Heaps gain, random, or by
name) against an ideal Zipf curve; static charts show which pages add vocabulary or are "weird".

**Week 6 — From counts to meaning** (`posts/week-6.html`, `week-6-2` to `week-6-6`)
Raw counts, TF-IDF, PPMI, LDA and Word2Vec as five notions of "close", checked against the link
graph and source sentences. The main page (`week-6.html`, the one linked from the home page) is
an analogy "slot machine"; the other pages are bonus explorables: a text-vs-link similarity
overlay (6.2), a Marvel map with user-defined word axes (6.3), single-character deep dives
(6.4), topic-mixture ambiguity (6.5) and a per-character neighbour explorer (`week-6-6.html`).

**Weeks 7 and 8** (`posts/week-7.html`, `posts/week-8.html`) — placeholders only; not implemented.

## Data and analysis

Raw data is frozen on disk. Scripts in `analysis/` read it, compute reference numbers offline,
and write the JSON summaries (and some figures) that the pages fetch.

| Data | Location | Used by |
| --- | --- | --- |
| Week 1 hero network snapshot (frozen 2026-08-26): nodes/edges TSVs | `data/week1/` | Weeks 1–3, 6 |
| Plain text of the 303 hero pages (URL-encoded `node_id` filenames) | `data/marvel_pages/*.txt` | Weeks 5–6 |
| Crawled category/list networks (nodes, edges, summary) | `data/<Slug>_characters/`, `data/Marvel_Comics_supervillains/` | Weeks 2–3 |
| Philosopher network (nodes, edges); also the weighted hero edges file | `data/philosophers/` | Week 4 |
| Generated summaries | `data/week2/`, `data/week3/`, `data/philosophers/week4_summary.json`, `data/marvel_pages/week*.json` | the matching posts |

The course-supplied files are copies of the frozen releases on the course data page:
- Week 1 network (`data/week1/`): https://sunelehmann.com/socialgraphs2026-web/data/week1_nodes.tsv, https://sunelehmann.com/socialgraphs2026-web/data/week1_edges.tsv
- Week 4 weighted hero edges (`data/philosophers/week4_edges_weighted.tsv`): https://sunelehmann.com/socialgraphs2026-web/data/week4_edges_weighted.tsv
- Week 4 philosophers (`data/philosophers/week4_philosophers_*.tsv`): https://sunelehmann.com/socialgraphs2026-web/data/week4_philosophers_nodes.tsv, https://sunelehmann.com/socialgraphs2026-web/data/week4_philosophers_edges.tsv
- Week 5 page text (`data/marvel_pages/*.txt`, unzipped): https://sunelehmann.com/socialgraphs2026-web/data/marvel_pages.zip

The Week 2 datasets were crawled from Wikipedia with `crawler/`, not taken from the course page.

| Script (run from `analysis/`) | Reads | Writes | Dependencies (from imports) |
| --- | --- | --- | --- |
| `build_week1.py` | `data/week1/` | `assets/week1/`, `data/week1/week1_summary.json` | networkx, pandas, scipy, numpy, matplotlib |
| `build_week2.py` | `data/week1/` | `data/week2/week2_summary.json` | networkx |
| `build_week2_reference.py <key>` | a crawled dataset | `data/<dir>/<key>_week2_summary.json` | stdlib only |
| `build_week2_fit_reference.py <key>` | a crawled dataset | CCDF figures in `assets/week2/`; adds a `fit` key to the summary | networkx, powerlaw, matplotlib, numpy, scipy |
| `build_week3.py`, `build_week3_villains.py` | heroes / villains data | `data/week3/week3_summary.json`, `week3_villains_summary.json` | networkx |
| `build_week4.py` | `data/philosophers/` | `week4_summary.json`; figures to `assets/week4/` | networkx, infomap, scikit-learn, matplotlib |
| `build_week5.py` | `data/marvel_pages/`, week 1 edges | `week5_summary.json` | stdlib only |
| `build_week5_investigation.py` | `week5_summary.json` | `week5_investigation.json` | stdlib only |
| `build_week6.py` | pages + week 1 network | `week6_summary.json`, `week6_words.json`, `week6_sents.json` | gensim, scikit-learn, scipy, networkx |
| `build_week63.py` | week 6 payloads | `week63_vecs.json`, `week63_map.json`, `week63_terms.json` | gensim, numpy |

Notes:
- There is no requirements file. `build_week1.py` asserts 303 nodes, 1,784 directed edges and 17
  isolates and fails if the data or loading logic disagrees (every character is added as a node
  before edges, so isolates are kept). `build_week5.py` roundtrip-asserts the duel's compact
  `(word index, count)` payloads against the raw token counts.
- `build_week4.py` writes to `assets/week4/`, which is not currently in the repository.
- Run `build_week6.py` before `build_week63.py`; the script headers suggest a dedicated virtual
  environment for the gensim-based scripts.
- `scripts/find_cliques.py --dataset NAME [--min-size N]` prints maximal cliques for any of the
  site's datasets.
- `crawler/` is a standalone, stdlib-only tool that crawls a Wikipedia category (or a "List of…"
  page) into the same nodes/edges/summary format; see `crawler/README.md`.

### Adding a Week 2 dataset
Week 2 posts select their dataset with `<script src="week2.js" data-dataset="KEY"></script>`,
where KEY is a key of the `DATASETS` map at the top of `posts/week2.js`; the map points at the
dataset's nodes/edges TSVs and its `<key>_week2_summary.json`. To add one: crawl into
`data/<Slug>_characters/`, add a `DATASETS` entry (also in `analysis/build_week2_reference.py`),
run `python build_week2_reference.py <key>`, copy an existing `week-2-<key>.html` post (keep its
explorer element ids `er-*`, `shuffle-*`, `ba-*`, `paradox-*`), and write the prose around the
numbers the script prints.

## Project structure

```
marvel-site/
├── index.html           home page: intro, one card per week/dataset, team
├── css/style.css        shared styling and component classes (.stats-grid, .rank-list,
│                        .figure-grid, .callout, ...)
├── posts/               one HTML page per post plus the JavaScript that drives it
│   ├── week-1-marvel-network.html
│   ├── week-2-<dataset>.html      7 posts, all driven by week2.js
│   ├── week-3*.html               analysis posts and the two save-the-network games
│   ├── week-4.html, week-5.html
│   ├── week-6.html, week-6-2..6.html
│   ├── week-7.html, week-8.html   placeholders
│   └── week2.js, week3*.js, week4-*.js, week5-*.js, week6-lean.js, week62..66.js
├── data/                frozen datasets and generated JSON (see above)
├── assets/week1, week2  figures generated by the analysis scripts
├── analysis/            offline analysis scripts that produce data/ and assets/
├── scripts/             find_cliques.py
├── crawler/             Wikipedia category crawler (own README)
├── add_this/            four extra PNG figures
└── .nojekyll            tells GitHub Pages to serve files as-is
```

Interactive pages fetch data with relative paths (`../data/...`), so the layout matters. Weeks 1
and 6.2 load the vis-network library from a CDN and need internet access.

### Adding a new week's post
1. Copy `posts/week-1-marvel-network.html` (or a `week-N.html` placeholder) as a template.
2. Update the matching card on `index.html` to link to the new post.
3. Reuse the existing CSS component classes rather than adding new styles.

## Local development

Prerequisites: Python 3 and a browser. There is no `package.json` and no build step. Pages fetch
JSON/TSV files, which browsers block on `file://`, so serve the repository root over HTTP:

```
cd marvel-site
python -m http.server 8000
```

Then open `http://localhost:8000/`. Regenerating data is optional and only needed after changing
the analysis, e.g.:

```
cd marvel-site/analysis
python build_week1.py       # needs the Week 1 dependencies above
python build_week5.py       # stdlib only
```

## Deployment

The site is fully static and published with GitHub Pages at the live-site address above.
`.nojekyll` at the root makes Pages serve files as-is. The repository contains no workflow or
other deployment configuration (no `.github/` directory), so the Pages source (branch and folder)
is set in the repository's settings rather than in code. Generated data and figures are
committed, so nothing is built on deploy.
