#!/usr/bin/env python3
"""Week 7 — all-pairs analysis: semantic similarity vs. directed link distance.

Extends build_week7_test.py (which only stored each page's top-12 neighbours)
to *every* unordered pair of the 370 Marvel supervillain pages.

Semantic side (same method as build_week7_test.py, nothing changed):
  page text -> passages of at most 180 words (sentence boundaries)
  -> each passage embedded with all-MiniLM-L6-v2 (unit length)
  -> page vector = mean of the passage vectors, re-normalised to unit length
  -> similarity of two pages = cosine = dot product of the page vectors.
Page vectors are cached in data/week7/week7_embeddings.npz; the cache is
reused only when the model, passage setting, character ids and the SHA-256 of
every page text all match. Without a valid cache the script needs the
`sentence-transformers` package (it never installs anything itself).

Structural side (directed graph, never symmetrised):
  edge A -> B when the article of A links to the article of B, restricted to
  the 370 category pages. Shortest directed paths come from one BFS per node
  (scipy.sparse.csgraph); unreachable pairs get no distance at all (empty /
  null), never a large placeholder.

Outputs (default --out-dir data/week7/):
  week7_characters.json    metadata, config, graph statistics, one record per
                           character (degrees, components, text source), the
                           directed edge list.  With --graph-only it is the only
                           file written; that mode refuses to replace a full run
                           unless --force-overwrite-full is given.
  week7_embeddings.npz     cached page vectors (float32) + provenance
  week7_pairs.tsv          one row per unordered pair {A, B}
  week7_pair_summaries.json  per-character nearest neighbours, curated pair
                           lists (thresholds are command-line options), summary
                           statistics, characters without links

The output files are replaced as a unit (staged as *.tmp, old versions kept as
*.bak until all are in place, restored on failure or at the next start).

Pair convention: A is the node whose node_id sorts first (plain string order,
which is also the order of the characters list); B is the other one. d_ab is the
number of links on the shortest directed path A -> B, d_ba the one B -> A.
reach is one of: both, a_to_b, b_to_a, none.

Run from the repository root:

    python analysis/build_week7_pairs.py                  # full run
    python analysis/build_week7_pairs.py --graph-only     # graph part, no embeddings
    python analysis/build_week7_pairs.py --min-cos 0.65 --min-distance 6

Requires: numpy, scipy. Embedding a page set without a cache additionally
needs sentence-transformers (and its model download). Run
analysis/check_week7_distances.py afterwards to validate the outputs
(it also needs networkx).
"""

import argparse
import hashlib
import json
import os
import platform
import sys
import urllib.parse
from pathlib import Path

import numpy as np
from scipy.sparse import csr_matrix
from scipy.sparse.csgraph import connected_components, shortest_path

HERE = Path(__file__).resolve().parent
sys.path.insert(0, str(HERE))
import build_week7_test as w7  # noqa: E402  (reuse read_tsv, passages, constants)

REPO = HERE.parent
VILLAIN_DIR = w7.VILLAIN_DIR
DEFAULT_OUT = REPO / "data" / "week7"
CHARACTERS_NAME = "week7_characters.json"
PAIRS_NAME = "week7_pairs.tsv"
SUMMARY_NAME = "week7_pair_summaries.json"
EMB_NAME = "week7_embeddings.npz"
PREVIOUS_JSON = "week7_supervillains.json"

SCHEMA_VERSION = 1
# bump when the way page vectors are built changes: invalidates every cache
METHOD_VERSION = "mean-of-unit-passage-vectors-v1"
SYNTHETIC_ENV = "WEEK7_ALLOW_SYNTHETIC_CACHE"   # set only by tests that use fake vectors
CONSISTENCY_TOLERANCE = 0.0006                   # stored top-12 cosines are rounded to 3 decimals
REACH_CODES = ("both", "a_to_b", "b_to_a", "none")


class UserError(Exception):
    """A problem the user can fix (missing input, missing dependency)."""


# ------------------------------------------------------------------ loading

def load_characters():
    """Nodes sorted by node_id, directed edges, and the text of every page."""
    nodes_path = VILLAIN_DIR / "Marvel_Comics_supervillains_nodes.tsv"
    edges_path = VILLAIN_DIR / "Marvel_Comics_supervillains_edges.tsv"
    pages_dir = VILLAIN_DIR / "pages"
    for p in (nodes_path, edges_path):
        if not p.exists():
            raise UserError(f"missing {p.relative_to(REPO)}; run from the repository root")
    if not pages_dir.is_dir():
        raise UserError("no data/Marvel_Comics_supervillains/pages/; run analysis/fetch_week7_pages.py first")

    header, rows = w7.read_tsv(nodes_path)
    col = {name: header.index(name) for name in ("node_id", "name", "wikidata_id", "url", "description")}
    nodes = sorted(({k: r[c] for k, c in col.items()} for r in rows), key=lambda n: n["node_id"])
    ids = [n["node_id"] for n in nodes]
    if len(set(ids)) != len(ids):
        raise UserError("duplicate node_id in the nodes file")
    index = {nid: i for i, nid in enumerate(ids)}

    _, edge_rows = w7.read_tsv(edges_path)
    edges = []
    unknown = 0
    for r in edge_rows:
        s, t = r[0], r[1]
        if s in index and t in index:
            edges.append((s, t))
        else:
            unknown += 1
    edges = sorted(set(edges))      # drop exact duplicates, make order deterministic
    n_dup = len(edge_rows) - unknown - len(edges)

    manifest_path = pages_dir / "manifest.json"
    manifest = {}
    if manifest_path.exists():
        manifest = json.loads(manifest_path.read_text(encoding="utf-8")).get("pages", {})

    texts, source = {}, {}
    for n in nodes:
        nid = n["node_id"]
        info = manifest.get(nid)
        fname = info["file"] if info else urllib.parse.quote(nid, safe="()'") + ".txt"
        f = pages_dir / fname
        text = f.read_text(encoding="utf-8") if f.exists() else ""
        if text.strip():
            texts[nid], source[nid] = text, "page"
        elif n["description"].strip():
            # same fallback as build_week7_test.py, but reported explicitly
            texts[nid], source[nid] = n["description"], "description_fallback"
        else:
            texts[nid], source[nid] = "", "no_text"
    return nodes, ids, index, edges, {"skipped_unknown": unknown, "duplicates": n_dup}, texts, source


# -------------------------------------------------------------------- graph

def relabel(labels):
    """Component labels 0.. ordered by size (desc), ties by lowest node index."""
    labels = np.asarray(labels)
    comps = {}
    for i, lab in enumerate(labels):
        comps.setdefault(int(lab), []).append(i)
    order = sorted(comps.values(), key=lambda m: (-len(m), m[0]))
    new = np.empty(len(labels), dtype=int)
    for k, members in enumerate(order):
        new[members] = k
    return new, [len(m) for m in order]


def graph_analysis(ids, index, edges):
    n = len(ids)
    src = np.array([index[s] for s, _ in edges], dtype=int)
    dst = np.array([index[t] for _, t in edges], dtype=int)
    adj = csr_matrix((np.ones(len(edges), dtype=np.int8), (src, dst)), shape=(n, n))
    # one BFS per node (unweighted, directed) instead of one search per pair
    d = shortest_path(adj, method="D", directed=True, unweighted=True)
    reach = np.isfinite(d)
    dist = np.full((n, n), -1, dtype=np.int32)
    dist[reach] = d[reach].astype(np.int32)
    _, wcc_raw = connected_components(adj, directed=True, connection="weak")
    _, scc_raw = connected_components(adj, directed=True, connection="strong")
    wcc, wcc_sizes = relabel(wcc_raw)
    scc, scc_sizes = relabel(scc_raw)
    in_deg = np.asarray(adj.sum(axis=0)).ravel().astype(int)
    out_deg = np.asarray(adj.sum(axis=1)).ravel().astype(int)
    return {"dist": dist, "in": in_deg, "out": out_deg, "wcc": wcc, "scc": scc,
            "wcc_sizes": wcc_sizes, "scc_sizes": scc_sizes}


# --------------------------------------------------------------- embeddings

def sha256(text):
    return hashlib.sha256(text.encode("utf-8")).hexdigest()


def cache_problem(cache, ids, texts, source, passage_words, model_name):
    """None when the cached vectors are valid for this exact input, else why not."""
    if list(cache["ids"]) != ids:
        return "character ids differ"
    meta = json.loads(str(cache["meta"]))
    if meta.get("synthetic") and not os.environ.get(SYNTHETIC_ENV):
        return "cache is flagged as synthetic test data"
    if meta.get("method_version") != METHOD_VERSION:
        return f"method version differs ({meta.get('method_version')} vs {METHOD_VERSION})"
    if meta.get("model") != model_name:
        return f"model differs ({meta.get('model')} vs {model_name})"
    if meta.get("passage_words") != passage_words:
        return "passage_words differs"
    hashes = [sha256(texts[i]) if source[i] != "no_text" else "" for i in ids]
    if list(cache["text_sha256"]) != hashes:
        return "page texts changed since the cache was written"
    vecs, okm = cache["vectors"], cache["ok"].astype(bool)
    if vecs.ndim != 2 or vecs.shape[0] != len(ids) or okm.shape != (len(ids),):
        return "vector matrix has the wrong shape"
    if not np.isfinite(vecs).all():
        return "vector matrix contains non-finite values"
    if okm[[source[i] == "no_text" for i in ids]].any():
        return "a page without text is marked as embedded"
    if not np.allclose(np.linalg.norm(vecs[okm].astype(np.float64), axis=1), 1.0, atol=1e-4):
        return "cached page vectors are not unit length"
    return None


def embed_pages(ids, texts, source, passage_words, model_name):
    try:
        from sentence_transformers import SentenceTransformer
    except ImportError:
        raise UserError(
            "no valid embedding cache and the 'sentence-transformers' package is not installed.\n"
            "  Install it yourself (this script never installs packages), e.g.\n"
            "      pip install sentence-transformers\n"
            "  then re-run, or use --graph-only for the link-network part only.")
    import sentence_transformers
    model = SentenceTransformer(model_name)
    print(f"embedding with {model_name} (max_seq_length {model.max_seq_length})", flush=True)
    dim = model.get_sentence_embedding_dimension()
    vecs = np.zeros((len(ids), dim), dtype=np.float32)
    ok = np.zeros(len(ids), dtype=bool)
    for i, nid in enumerate(ids):
        if source[nid] == "no_text":
            continue
        chunks = w7.passages(texts[nid], passage_words)
        v = np.asarray(model.encode(chunks, normalize_embeddings=True)).mean(axis=0)
        norm = np.linalg.norm(v)
        if not np.isfinite(norm) or norm == 0:
            continue
        vecs[i] = v / norm
        ok[i] = True
    meta = {"model": model_name, "passage_words": passage_words, "method_version": METHOD_VERSION,
            "synthetic": False, "max_seq_length": int(model.max_seq_length), "dim": int(dim),
            "sentence_transformers": sentence_transformers.__version__,
            "numpy": np.__version__, "python": platform.python_version()}
    return vecs, ok, meta


def get_embeddings(ids, texts, source, passage_words, model_name, cache_path, refresh):
    """Returns (vectors, ok_mask, provenance dict, how) — from cache when valid."""
    if cache_path.exists() and not refresh:
        with np.load(cache_path, allow_pickle=False) as cache:
            cache = {k: cache[k] for k in cache.files}
        why = cache_problem(cache, ids, texts, source, passage_words, model_name)
        if why is None:
            meta = json.loads(str(cache["meta"]))
            return cache["vectors"], cache["ok"].astype(bool), meta, "cache"
        print(f"embedding cache not reusable: {why}", flush=True)
    vecs, ok, meta = embed_pages(ids, texts, source, passage_words, model_name)
    hashes = [sha256(texts[i]) if source[i] != "no_text" else "" for i in ids]
    cache_path.parent.mkdir(parents=True, exist_ok=True)
    np.savez_compressed(cache_path, ids=np.array(ids), vectors=vecs, ok=ok,
                        text_sha256=np.array(hashes), meta=np.array(json.dumps(meta)))
    return vecs, ok, meta, "computed"


def validate_similarity(sims, ok):
    """Raise UserError unless sims is a proper cosine matrix for the vectors flagged ok."""
    n = len(ok)
    if sims.shape != (n, n):
        raise UserError("similarity matrix has the wrong shape")
    idx = np.flatnonzero(ok)
    sub = sims[np.ix_(idx, idx)]
    if not np.isfinite(sub).all():
        raise UserError("similarity matrix contains non-finite values")
    if np.abs(sub - sub.T).max(initial=0.0) > 1e-6:
        raise UserError("similarity matrix is not symmetric")
    if np.abs(np.diag(sub) - 1.0).max(initial=0.0) > 1e-4:
        raise UserError("similarity diagonal is not 1 (vectors are not unit length)")
    if sub.max(initial=-1.0) > 1 + 1e-5 or sub.min(initial=1.0) < -1 - 1e-5:
        raise UserError("cosine values outside [-1, 1]")


def commit_outputs(out, texts, order):
    """Replace the output files as a unit: all of them or none of them.

    Every new file is first written next to its target as <name>.tmp. Each
    existing target is then renamed to <name>.bak and its .tmp renamed into
    place; if anything fails, the .bak files are restored and files that did
    not exist before are removed, so the old outputs survive. A crash that
    cannot be handled in-process (power loss) leaves *.bak files behind;
    recover_interrupted() puts them back at the start of the next run.
    """
    staged, moved, created = [], [], []
    try:
        for name in order:
            tmp = out / (name + ".tmp")
            tmp.write_text(texts[name], encoding="utf-8", newline="\n")
            staged.append((out / name, tmp))
        for dst, tmp in staged:
            if dst.exists():
                bak = dst.with_name(dst.name + ".bak")
                os.replace(dst, bak)
                moved.append((dst, bak))
            else:
                created.append(dst)
            os.replace(tmp, dst)
    except BaseException:
        for dst in created:
            dst.unlink(missing_ok=True)
        for dst, bak in moved:
            os.replace(bak, dst)
        for _, tmp in staged:
            tmp.unlink(missing_ok=True)
        raise
    for _, bak in moved:
        bak.unlink(missing_ok=True)


def recover_interrupted(out):
    """Undo a commit that died half-way (leftover *.bak files) and drop stale *.tmp files."""
    if not out.is_dir():
        return
    for bak in sorted(out.glob("*.bak")):
        os.replace(bak, bak.with_suffix(""))
        print(f"restored {bak.with_suffix('').name} from an interrupted earlier run")
    for tmp in out.glob("*.tmp"):
        tmp.unlink()


def file_digest(text):
    data = text.encode("utf-8")
    return {"sha256": hashlib.sha256(data).hexdigest(), "bytes": len(data)}


def protects_full_dataset(out):
    """Why a --graph-only run must not overwrite this directory, or None if it may."""
    chars = out / CHARACTERS_NAME
    if (out / PAIRS_NAME).exists():
        return f"{PAIRS_NAME} exists"
    if not chars.exists():
        return None
    try:
        meta = json.loads(chars.read_text(encoding="utf-8"))["meta"]
    except (ValueError, KeyError):
        return f"{CHARACTERS_NAME} exists but cannot be parsed"
    if meta.get("complete") is True:
        return f"{CHARACTERS_NAME} belongs to a complete run"
    if meta.get("semantic_method", {}).get("embeddings", {}).get("status") not in (None, "not computed in this run"):
        return f"{CHARACTERS_NAME} records computed embeddings"
    return None


# ------------------------------------------------------------------ outputs

def reach_code(d_ab, d_ba):
    if d_ab >= 0 and d_ba >= 0:
        return "both"
    if d_ab >= 0:
        return "a_to_b"
    if d_ba >= 0:
        return "b_to_a"
    return "none"


def pair_rows(ids, g, sims, ok, decimals):
    """One dict per unordered pair, i < j (A = ids[i], B = ids[j])."""
    n = len(ids)
    dist, wcc, scc = g["dist"], g["wcc"], g["scc"]
    rows = []
    for i in range(n):
        for j in range(i + 1, n):
            d_ab, d_ba = int(dist[i, j]), int(dist[j, i])
            has_cos = sims is not None and ok[i] and ok[j]
            rows.append({
                "i": i, "j": j, "a": ids[i], "b": ids[j],
                "cos": round(float(sims[i, j]), decimals) if has_cos else None,
                "d_ab": d_ab if d_ab >= 0 else None,
                "d_ba": d_ba if d_ba >= 0 else None,
                "reach": reach_code(d_ab, d_ba),
                "same_wcc": int(wcc[i] == wcc[j]), "same_scc": int(scc[i] == scc[j]),
                "a_in": int(g["in"][i]), "a_out": int(g["out"][i]),
                "b_in": int(g["in"][j]), "b_out": int(g["out"][j]),
            })
    return rows


def pairs_tsv_text(rows, decimals):
    cols = ["a", "b", "cos", "d_ab", "d_ba", "reach", "same_wcc", "same_scc",
            "a_in", "a_out", "b_in", "b_out"]
    head = [
        "# Week 7 all-pairs table: one row per unordered pair of the Marvel supervillain pages.",
        "# A = node_id that sorts first, B = the other. cos = cosine of MiniLM page vectors "
        f"(rounded to {decimals} decimals, empty if a page has no vector).",
        "# d_ab / d_ba = links on the shortest DIRECTED path A->B / B->A in the 370-page "
        "category graph; EMPTY when no such path exists (never a placeholder number).",
        "# reach: both | a_to_b | b_to_a | none. same_wcc / same_scc: 1 if both nodes share a "
        "weakly / strongly connected component.",
        "# a_in/a_out/b_in/b_out: in- and out-degree. Names, titles and URLs: see week7_characters.json.",
        "\t".join(cols),
    ]
    body = ("\t".join("" if r[c] is None else str(r[c]) for c in cols) for r in rows)
    return "\n".join(head) + "\n" + "\n".join(body) + "\n"


def describe(values):
    a = np.asarray(values, dtype=float)
    if a.size == 0:
        return None
    pct = {str(p): round(float(np.percentile(a, p)), 4) for p in (1, 5, 25, 50, 75, 95, 99)}
    return {"n": int(a.size), "min": round(float(a.min()), 4), "max": round(float(a.max()), 4),
            "mean": round(float(a.mean()), 4), "std": round(float(a.std()), 4), "percentiles": pct}


def pair_view(r):
    return {k: r[k] for k in ("a", "b", "cos", "d_ab", "d_ba", "reach")}


def summaries(ids, nodes, rows, sims, ok, g, args, meta_cfg):
    excluded = set(args.exclude)
    n = len(ids)
    dist = g["dist"]

    # nearest semantic neighbours for every character (all pairs considered)
    neigh = {}
    for i, nid in enumerate(ids):
        if not ok[i]:
            neigh[nid] = []
            continue
        order = sorted((j for j in range(n) if j != i and ok[j]),
                       key=lambda j: (-sims[i, j], ids[j]))[:args.neighbours]
        neigh[nid] = [[ids[j], round(float(sims[i, j]), args.cos_decimals),
                       int(dist[i, j]) if dist[i, j] >= 0 else None,
                       int(dist[j, i]) if dist[j, i] >= 0 else None] for j in order]

    scored = [r for r in rows if r["cos"] is not None
              and r["a"] not in excluded and r["b"] not in excluded]

    def min_dist(r):
        ds = [d for d in (r["d_ab"], r["d_ba"]) if d is not None]
        return min(ds) if ds else None

    def top(pred):
        sel = [r for r in scored if pred(r)]
        sel.sort(key=lambda r: (-r["cos"], r["a"], r["b"]))
        return [dict(pair_view(r), min_distance=min_dist(r)) for r in sel[:args.top_pairs]], len(sel)

    far, far_n = top(lambda r: r["cos"] >= args.min_cos and r["reach"] != "none"
                     and min_dist(r) >= args.min_distance)
    both, both_n = top(lambda r: r["cos"] >= args.min_cos and r["reach"] == "both"
                       and max(r["d_ab"], r["d_ba"]) >= args.both_min_distance)
    nopath, nopath_n = top(lambda r: r["cos"] >= args.min_cos and r["reach"] == "none")

    cos_all = [r["cos"] for r in rows if r["cos"] is not None]
    by_reach = {}
    for code in REACH_CODES:
        sub = [r for r in rows if r["reach"] == code]
        cs = [r["cos"] for r in sub if r["cos"] is not None]
        by_reach[code] = {"pairs": len(sub), "mean_cos": round(float(np.mean(cs)), 4) if cs else None}
    finite = dist[dist >= 0]
    off_diag = finite[finite > 0]
    hist = {str(int(k)): int(v) for k, v in zip(*np.unique(off_diag, return_counts=True))}
    nn_cos = [v[0][1] for v in neigh.values() if v]

    stats = {
        "cosine_all_pairs": describe(cos_all),
        "nearest_neighbour_cosine": describe(nn_cos),
        "directed_distance_ordered_pairs": {
            **(describe(off_diag) or {}),
            "histogram": hist,
            "note": "over ordered pairs (u, v), u != v, with a directed path u -> v; "
                    "unreachable ordered pairs are not counted in any statistic here",
        },
        "pairs_by_reachability": by_reach,
        "same_wcc_pairs": int(sum(r["same_wcc"] for r in rows)),
        "same_scc_pairs": int(sum(r["same_scc"] for r in rows)),
    }
    none = lambda f: sorted(ids[i] for i in range(n) if f(i))
    links = {
        "no_incoming_and_no_outgoing": none(lambda i: g["in"][i] == 0 and g["out"][i] == 0),
        "no_incoming": none(lambda i: g["in"][i] == 0),
        "no_outgoing": none(lambda i: g["out"][i] == 0),
    }
    return {
        "meta": {
            "schema_version": SCHEMA_VERSION,
            "note": "Thresholds are command-line options chosen to surface candidates, not scientific "
                    "facts. High cosine is not evidence of a meaningful relationship: read the pages.",
            "config": meta_cfg,
            "excluded_from_lists": sorted(excluded),
            "list_sizes_before_top_cut": {"far_but_reachable": far_n, "reachable_both_ways": both_n,
                                          "similar_without_any_path": nopath_n},
            "fields": {"neighbours": ["other_id", "cos", "d_this_to_other", "d_other_to_this"],
                       "pair_lists": ["a", "b", "cos", "d_ab", "d_ba", "reach", "min_distance"]},
        },
        "neighbours": neigh,
        "far_but_reachable": far,
        "reachable_both_ways": both,
        "similar_without_any_path": nopath,
        "statistics": stats,
        "characters_without_links": links,
    }


# --------------------------------------------------------------------- main

def parse_args(argv):
    p = argparse.ArgumentParser(
        description="Week 7: cosine similarity of all supervillain page pairs vs. directed link distance.",
        formatter_class=argparse.ArgumentDefaultsHelpFormatter)
    p.add_argument("--out-dir", type=Path, default=DEFAULT_OUT, help="where the outputs are written")
    p.add_argument("--embeddings", type=Path, default=None,
                   help=f"embedding cache (default <out-dir>/{EMB_NAME})")
    p.add_argument("--refresh-embeddings", action="store_true", help="ignore the cache and re-embed")
    p.add_argument("--graph-only", action="store_true",
                   help="only write the link-network part (no embeddings needed)")
    p.add_argument("--force-overwrite-full", action="store_true",
                   help="allow --graph-only to replace the output of a complete run")
    p.add_argument("--skip-consistency-check", action="store_true",
                   help="do not compare the new cosines with the stored top-12 scores in week7_supervillains.json")
    p.add_argument("--passage-words", type=int, default=w7.PASSAGE_WORDS)
    p.add_argument("--model", default=w7.MODEL_NAME)
    p.add_argument("--cos-decimals", type=int, default=4)
    p.add_argument("--neighbours", type=int, default=12, help="semantic neighbours kept per character")
    p.add_argument("--top-pairs", type=int, default=200, help="length cap of each curated pair list")
    p.add_argument("--min-cos", type=float, default=0.60, help="cosine floor for the curated pair lists")
    p.add_argument("--min-distance", type=int, default=5,
                   help="far_but_reachable: shortest finite directed distance (either direction) at least this")
    p.add_argument("--both-min-distance", type=int, default=1,
                   help="reachable_both_ways: the larger of the two directed distances is at least this")
    p.add_argument("--exclude", nargs="*", default=[], metavar="NODE_ID",
                   help="node_ids left out of the curated lists only (e.g. very long hub pages)")
    return p.parse_args(argv)


def main(argv=None):
    args = parse_args(argv)
    out = args.out_dir
    emb_path = args.embeddings or out / EMB_NAME

    recover_interrupted(out)
    if args.graph_only and not args.force_overwrite_full:
        why = protects_full_dataset(out)
        if why:
            raise UserError(f"--graph-only would overwrite a full dataset in {out} ({why}).\n"
                            "  Use another --out-dir, or pass --force-overwrite-full if you really want that.")

    nodes, ids, index, edges, edge_info, texts, source = load_characters()
    unknown_excl = [e for e in args.exclude if e not in index]
    if unknown_excl:
        raise UserError(f"--exclude: unknown node_id(s): {unknown_excl}")
    n = len(ids)
    g = graph_analysis(ids, index, edges)
    n_passages = [len(w7.passages(texts[i], args.passage_words)) if source[i] != "no_text" else 0 for i in ids]
    words = [len(texts[i].split()) for i in ids]
    print(f"{n} characters, {len(edges)} directed edges "
          f"({edge_info['skipped_unknown']} rows with unknown endpoints, {edge_info['duplicates']} duplicates dropped)")

    # ---- embeddings (skipped for --graph-only)
    sims = ok = prov = how = None
    pending_error = None
    if not args.graph_only:
        try:
            vecs, ok, prov, how = get_embeddings(ids, texts, source, args.passage_words, args.model,
                                                 emb_path, args.refresh_embeddings)
            sims = vecs.astype(np.float64) @ vecs.astype(np.float64).T
            validate_similarity(sims, ok)
            sims = np.clip(sims, -1.0, 1.0)
        except UserError as e:
            pending_error = e

    if pending_error is not None:
        raise pending_error      # fail before touching any existing output file

    # ---- characters.json (written alone with --graph-only, which replaces an earlier full file)
    chars = []
    for i, nd in enumerate(nodes):
        title = urllib.parse.unquote(nd["url"].rsplit("/", 1)[-1]).replace("_", " ")
        chars.append({
            "id": nd["node_id"], "name": nd["name"], "title": title, "url": nd["url"],
            "wikidata_id": nd["wikidata_id"], "words": words[i], "passages": n_passages[i],
            "text_source": source[nd["node_id"]],
            "has_vector": bool(ok[i]) if ok is not None else None,
            "in_degree": int(g["in"][i]), "out_degree": int(g["out"][i]),
            "weak_component": int(g["wcc"][i]), "strong_component": int(g["scc"][i]),
        })
    dist = g["dist"]
    off = ~np.eye(n, dtype=bool)
    ordered_reach = int(((dist >= 0) & off).sum())
    n_pairs = n * (n - 1) // 2
    cfg = {k: (str(v) if isinstance(v, Path) else v) for k, v in vars(args).items()
           if k not in ("out_dir", "embeddings")}
    meta = {
        "schema_version": SCHEMA_VERSION,
        "generated_by": "analysis/build_week7_pairs.py",
        "config": cfg,
        "complete": not args.graph_only,
        "semantic_method": {
            "model": args.model,
            "method_version": METHOD_VERSION,
            "passage_words": args.passage_words,
            "passage_split": "sentence boundaries (regex (?<=[.!?])\\s+), at most passage_words words per passage",
            "passage_embedding": "model.encode(..., normalize_embeddings=True), unit length",
            "page_vector": "mean of the passage vectors, divided by its own length (unit length)",
            "similarity": "cosine = dot product of page vectors; computed for all pairs from one matrix product",
            "text_sources": "page = Wikipedia extract; description_fallback = node description (as in "
                            "build_week7_test.py); no_text = nothing to embed, excluded from similarities",
            "embeddings": ({"status": how, "cache_file": emb_path.name, **prov} if prov else
                           {"status": "not computed in this run"}),
        },
        "graph_method": {
            "graph": "directed; edge A->B = article A links to article B; only the 370 category pages are nodes",
            "distance": "number of links on the shortest directed path (BFS per node, scipy.sparse.csgraph); "
                        "null when unreachable",
            "pair_convention": "A = node_id sorting first, B = the other; d_ab: A->B, d_ba: B->A",
        },
        "counts": {
            "characters": n, "directed_edges": len(edges),
            "expected_unordered_pairs": n_pairs,
            "pairs_with_cosine": (int(sum(1 for i in range(n) for j in range(i + 1, n) if ok[i] and ok[j]))
                                  if ok is not None else None),
            "characters_without_vector": ([ids[i] for i in range(n) if not ok[i]] if ok is not None else None),
            "text_sources": {s: sum(1 for v in source.values() if v == s)
                             for s in ("page", "description_fallback", "no_text")},
            "ordered_pairs_reachable": ordered_reach,
            "weak_components": len(g["wcc_sizes"]), "weak_component_sizes": g["wcc_sizes"][:10],
            "strong_components": len(g["scc_sizes"]), "strong_component_sizes": g["scc_sizes"][:10],
            "edges_skipped_unknown_endpoint": edge_info["skipped_unknown"],
            "edges_duplicates_dropped": edge_info["duplicates"],
        },
        "weak_component_sizes_all": g["wcc_sizes"],
        "strong_component_sizes_all": g["scc_sizes"],
    }

    # ---- consistency with the earlier top-12 file, when available
    prev_path = out / PREVIOUS_JSON
    if sims is not None and prev_path.exists() and not args.skip_consistency_check:
        prev = json.loads(prev_path.read_text(encoding="utf-8"))["neighbors"]
        diffs = [abs(it["c"] - sims[index[a], index[it["o"]]])
                 for a, lst in prev.items() if a in index and ok[index[a]]
                 for it in lst if it["o"] in index and ok[index[it["o"]]]]
        worst = float(max(diffs)) if diffs else None
        meta["consistency_with_week7_supervillains_json"] = {
            "neighbour_scores_compared": len(diffs),
            "max_abs_difference": round(worst, 6) if worst is not None else None,
            "tolerance": CONSISTENCY_TOLERANCE,
            "note": "that file stores cosines rounded to 3 decimals, so differences up to 0.0005 are rounding"}
        if worst is not None and worst > CONSISTENCY_TOLERANCE:
            raise UserError(
                f"new cosines disagree with the stored top-12 scores in {PREVIOUS_JSON}: largest difference "
                f"{worst:.4f} (> {CONSISTENCY_TOLERANCE}). The embedding method, model version or page texts "
                "differ from the earlier run. Nothing was written. Investigate, or pass "
                "--skip-consistency-check if the change is intended.")

    # ---- build every output in memory first, then write
    texts_out = {}
    if not args.graph_only:
        rows = pair_rows(ids, g, sims, ok, args.cos_decimals)
        keys = [(r["a"], r["b"]) for r in rows]
        if len(rows) != n_pairs or len(set(keys)) != n_pairs or any(a >= b for a, b in keys):
            raise UserError("internal error: pair rows are not exactly the unique unordered pairs")
        texts_out[PAIRS_NAME] = pairs_tsv_text(rows, args.cos_decimals)
        summ = summaries(ids, nodes, rows, sims, ok, g, args, cfg)
        texts_out[SUMMARY_NAME] = json.dumps(summ, indent=1, ensure_ascii=False) + "\n"
        meta["outputs"] = {name: file_digest(t) for name, t in texts_out.items()}
    payload = {"meta": meta, "characters": chars, "edges": [[s_, t_] for s_, t_ in edges]}
    texts_out[CHARACTERS_NAME] = json.dumps(payload, indent=1, ensure_ascii=False) + "\n"

    out.mkdir(parents=True, exist_ok=True)
    # characters file last: it carries the 'complete' flag and the digests of the other two files
    order = [name for name in (PAIRS_NAME, SUMMARY_NAME, CHARACTERS_NAME) if name in texts_out]
    commit_outputs(out, texts_out, order)
    for name in order:
        print(f"wrote {out / name}")
    if args.graph_only:
        print("--graph-only: pair table and summaries not written")
    else:
        print(f"{n} characters, {n_pairs} unique unordered pairs")
    return 0


if __name__ == "__main__":
    try:
        sys.exit(main())
    except UserError as err:
        print(f"error: {err}", file=sys.stderr)
        sys.exit(2)
