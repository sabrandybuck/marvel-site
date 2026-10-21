#!/usr/bin/env python3
"""Week 7 test — supervillains: the link network vs. the MiniLM skeleton.

Builds the frozen payload for posts/week-7-test.html from the crawled
Marvel supervillains dataset:

  1. the Wikipedia link network (nodes/edges TSVs, undirected pairs for
     drawing, directed pairs kept as-is),
  2. the all-MiniLM-L6-v2 document embeddings of the same 370 pages
     (180-word passage chunking, mean-pooled, like the course Week 7
     corpus atlas) and a k-nearest-neighbour cosine graph over them,
  3. Louvain communities on the undirected link graph for coloring,
  4. PCA / t-SNE 2D coordinates (kept; not the point of the page).

Everything lands in ../data/week7/week7_supervillains.json and the script
prints a reference-number report for the post's prose.

Run from analysis/ with the site venv:

    ../.venv/bin/python build_week7_test.py

Run fetch_week7_pages.py first when ../data/Marvel_Comics_supervillains/pages/
does not exist yet.
"""

import json
import math
import re
import sys
import urllib.parse
from collections import Counter
from pathlib import Path

import numpy as np

HERE = Path(__file__).resolve().parent
DATA = HERE.parent / "data"
VILLAIN_DIR = DATA / "Marvel_Comics_supervillains"
OUT_DIR = DATA / "week7"

MODEL_NAME = "all-MiniLM-L6-v2"
PASSAGE_WORDS = 180          # the course atlas chunking rule
TOP_K = 12                   # neighbours frozen per page (explorable shows up to 10)


# ---------------------------------------------------------------- helpers

def read_tsv(path: Path):
    """Data rows of a marvel-crawler TSV (skips the # comment header)."""
    rows = []
    header = None
    for line in path.read_text(encoding="utf-8").splitlines():
        if not line or line.startswith("#"):
            continue
        if header is None:
            header = line.split("\t")
            continue
        rows.append(line.split("\t"))
    return header, rows


def passages(text: str, max_words: int = PASSAGE_WORDS):
    """Sentence-boundary chunks of at most max_words words (course rule)."""
    out, current, n = [], [], 0
    for sentence in re.split(r"(?<=[.!?])\s+", text):
        words = len(sentence.split())
        if current and n + words > max_words:
            out.append(" ".join(current))
            current, n = [], 0
        current.append(sentence)
        n += words
    if current:
        out.append(" ".join(current))
    return out


def components(nodes, undirected):
    """Weakly connected components over the undirected adjacency."""
    seen, comps = set(), []
    ids = list(nodes)
    for start in ids:
        if start in seen:
            continue
        stack, comp = [start], []
        seen.add(start)
        while stack:
            cur = stack.pop()
            comp.append(cur)
            for nb in undirected.get(cur, ()):
                if nb not in seen:
                    seen.add(nb)
                    stack.append(nb)
        comps.append(comp)
    comps.sort(key=len, reverse=True)
    return comps


def main():
    # -------------------------------------------------- load the network
    nodes_header, node_rows = read_tsv(VILLAIN_DIR / "Marvel_Comics_supervillains_nodes.tsv")
    id_col = nodes_header.index("node_id")
    name_col = nodes_header.index("name")
    desc_col = nodes_header.index("description")
    node_ids = [r[id_col] for r in node_rows]
    names = {r[id_col]: r[name_col] for r in node_rows}
    descs = {r[id_col]: r[desc_col] for r in node_rows}

    edges_header, edge_rows = read_tsv(VILLAIN_DIR / "Marvel_Comics_supervillains_edges.tsv")
    edges = [(r[0], r[1]) for r in edge_rows]

    in_deg = Counter(t for _, t in edges)
    out_deg = Counter(s for s, _ in edges)
    undirected_pairs = {frozenset(e) for e in edges}

    undirected = {nid: set() for nid in node_ids}
    for s, t in edges:
        undirected[s].add(t)
        undirected[t].add(s)

    comps = components(set(node_ids), undirected)
    comp_id = {}
    for ci, comp in enumerate(comps):
        for nid in comp:
            comp_id[nid] = ci

    # -------------------------------------------------- load the texts
    pages_dir = VILLAIN_DIR / "pages"
    manifest_path = pages_dir / "manifest.json"
    if not pages_dir.is_dir():
        sys.exit("run analysis/fetch_week7_pages.py first — no pages/ dir yet")
    manifest_files = {}
    if manifest_path.exists():
        manifest = json.loads(manifest_path.read_text(encoding="utf-8"))
        manifest_files = manifest["pages"]

    texts, n_words, short_nodes = {}, {}, []
    for nid in node_ids:
        # same filename scheme as data/marvel_pages/: quote(node_id, safe="()'")
        info = manifest_files.get(nid)
        fname = urllib.parse.quote(nid, safe="()'") + ".txt"
        if info and (pages_dir / info["file"]).exists():
            fname = info["file"]
        if (pages_dir / fname).exists():
            text = (pages_dir / fname).read_text(encoding="utf-8")
            if info:
                n_words[nid] = info["words"]
            else:
                n_words[nid] = len(text.split())
        else:
            texts[nid] = descs[nid]
            n_words[nid] = len(descs[nid].split())
            short_nodes.append(nid)
            continue
        texts[nid] = text

    word_counts = sorted(n_words.values())
    total_words = sum(word_counts)

    # -------------------------------------------------- embed (MiniLM)
    from sentence_transformers import SentenceTransformer

    model = SentenceTransformer(MODEL_NAME)
    max_seq_length = model.max_seq_length
    print(f"model={MODEL_NAME} max_seq_length={max_seq_length}", flush=True)

    n_passages = 0
    doc_vectors = []
    for nid in node_ids:
        chunks = passages(texts[nid])
        n_passages += len(chunks)
        vecs = model.encode(chunks, normalize_embeddings=True)
        v = np.asarray(vecs).mean(axis=0)
        doc_vectors.append(v / np.linalg.norm(v))
    emb = np.array(doc_vectors)
    print(f"embedded {len(node_ids)} pages via {n_passages} passages -> "
          f"{emb.shape}", flush=True)

    # -------------------------------------------------- kNN in original space
    sims = emb @ emb.T
    np.fill_diagonal(sims, -1.0)
    knn = {}
    for i, nid in enumerate(node_ids):
        idx = np.argsort(-sims[i])[:TOP_K]
        knn[nid] = [{"o": node_ids[j], "c": round(float(sims[i, j]), 3)}
                    for j in idx]

    def pairs_up_to(k):
        out = set()
        for nid, lst in knn.items():
            for it in lst[:k]:
                p = frozenset((nid, it["o"]))
                out.add(p)
        return out

    sem5 = pairs_up_to(5)
    sem10 = pairs_up_to(10)
    link_pairs = {p for p in undirected_pairs if len(p) == 2}
    overlap5 = sem5 & link_pairs
    only_sem5 = sem5 - link_pairs
    only_link5 = link_pairs - sem10

    # headline divergences: high-cosine pairs with no link either way
    divergences = []
    for nid, lst in knn.items():
        for it in lst[:10]:
            key = (nid, it["o"])
            if nid < it["o"] and frozenset(key) not in link_pairs:
                divergences.append({"a": nid, "b": it["o"], "c": it["c"]})
    divergences.sort(key=lambda d: -d["c"])

    # every direction blocked pairs (mutual nearest neighbours with no link)
    mutual = []
    for nid, lst in knn.items():
        if not lst:
            continue
        first = lst[0]
        rev = [x for x in knn[first["o"]] if x["o"] == nid]
        if rev and rev[0]["o"] == nid and nid < first["o"] \
                and frozenset((nid, first["o"])) not in link_pairs:
            mutual.append({"a": nid, "b": first["o"], "c": first["c"]})

    # how often do the two neighbourhoods touch at all?
    touched = 0
    for nid in node_ids:
        for it in knn[nid][:5]:
            if frozenset((nid, it["o"])) in link_pairs:
                touched += 1
                break

    # -------------------------------------------------- communities (Louvain)
    try:
        import networkx as nx
        G = nx.Graph()
        G.add_nodes_from(node_ids)
        G.add_edges_from((s, t) for s, t in edges)
        louvain = nx.community.louvain_communities(G, seed=42)
    except ImportError:
        print("networkx missing — communities skipped", flush=True)
        louvain = [set(node_ids)]

    louvain.sort(key=len, reverse=True)
    community = {}
    for ci, comp in enumerate(louvain):
        for nid in comp:
            community[nid] = ci

    # PCA / t-SNE on the untouched embeddings (reference numbers for prose)
    from sklearn.decomposition import PCA
    from sklearn.manifold import TSNE

    pca = PCA(n_components=2, random_state=42)
    pca_xy = pca.fit_transform(emb)
    tsne_xy = TSNE(n_components=2, perplexity=30, init="pca",
                   learning_rate="auto", random_state=42).fit_transform(emb)

    # -------------------------------------------------- assemble the payload
    nodes_payload = {}
    for nid in node_ids:
        nodes_payload[nid] = {
            "name": names[nid],
            "words": n_words[nid],
            "community": community.get(nid, 0),
            "component": comp_id.get(nid, 0),
            "in_degree": in_deg.get(nid, 0),
            "out_degree": out_deg.get(nid, 0),
            "pca": [round(float(x), 2) for x in pca_xy[node_ids.index(nid)]],
            "tsne": [round(float(x), 2) for x in tsne_xy[node_ids.index(nid)]],
        }

    payload = {
        "meta": {
            "model": MODEL_NAME,
            "max_seq_length": max_seq_length,
            "chunking": f"passages of at most {PASSAGE_WORDS} words along sentence "
                        "boundaries; page vector = mean of passage vectors "
                        "(normalized)",
            "top_k_frozen": TOP_K,
            "n_nodes": len(node_ids),
            "n_directed_edges": len(edges),
            "n_undirected_pairs": len(link_pairs),
            "n_passages": n_passages,
            "total_words": total_words,
            "median_words": word_counts[len(word_counts) // 2],
            "description_only_nodes": short_nodes,
            "pca_variance_explained": [round(float(v), 4) for v in pca.explained_variance_ratio_],
            "nodes_fetched": sum(1 for nid in node_ids if nid in texts),
        },
        "nodes": nodes_payload,
        "edges": [[s, t] for s, t in edges],
        "neighbors": knn,
        "divergences": divergences[:25],
        "mutual_nn_no_link": mutual[:25],
    }

    OUT_DIR.mkdir(parents=True, exist_ok=True)
    out_path = OUT_DIR / "week7_supervillains.json"
    out_path.write_text(json.dumps(payload, indent=1), encoding="utf-8")
    print(f"wrote {out_path}", flush=True)

    # -------------------------------------------------- reference report
    print("\n----- reference report -----")
    print(f"nodes {len(node_ids)}  directed edges {len(edges)}  "
          f"undirected pairs {len(link_pairs)}")
    print(f"weakly connected components: {len(comps)} "
          f"(giant {len(comps[0])}); isolates "
          f"{sum(1 for c in comps if len(c) == 1)}")
    print(f"louvain communities: {len(louvain)} sizes "
          f"{[len(c) for c in louvain][:8]}")
    print(f"corpus: {total_words} words, median page {word_counts[len(word_counts)//2]}")
    ds = len(short_nodes)
    print(f"description-only nodes: {ds} {short_nodes[:6]}")
    print(f"k=5 semantic edges {len(sem5)}; in link network {len(overlap5)} "
          f"({100*len(overlap5)/len(sem5):.1f}%)")
    print(f"k=10 semantic edges {len(sem10)}; in link network "
          f"{len(sem10 & link_pairs)} ({100*len(sem10 & link_pairs)/len(sem10):.1f}%)")
    print(f"link pairs outside top-10 semantic set: {len(only_link5)} of {len(link_pairs)}")
    print(f"villains with a k=5 neighbour also linked on Wikipedia: "
          f"{touched}/{len(node_ids)} ({100*touched/len(node_ids):.1f}%)")
    print("top meaning-only neighbours (cos, no link either direction):")
    for d in divergences[:10]:
        print(f"  {d['a']} <-> {d['b']}  cos {d['c']:.3f}")
    print("top mutual nearest neighbours with no link:")
    for d in mutual[:10]:
        print(f"  {d['a']} <-> {d['b']}  cos {d['c']:.3f}")
    print(f"PCA variance explained by 2 axes: "
          f"{100*sum(pca.explained_variance_ratio_):.1f}%")


if __name__ == "__main__":
    main()
