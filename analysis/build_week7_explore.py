#!/usr/bin/env python3
"""Week 7 explorer payload: embedding clusters vs. link-network communities.

Reuses (read-only) the earlier Week 7 outputs and adds only what was missing:

  data/week7/week7_embeddings.npz    page vectors (370 x 384, unit length)
  data/week7/week7_pairs.tsv         cosine + directed distances of all pairs
  data/week7/week7_supervillains.json  directed edge list
  data/week7/week7_characters.json   names

Computed here (new):
  * PCA of the page vectors to 2D (view A coordinates) and its variance share.
  * Embedding clusters: Ward agglomerative clustering of the unit page vectors
    into K clusters (K = number of network communities in the giant component).
    Ward is deterministic, so no seed is involved.
  * Network communities: Louvain (networkx, seed 42, resolution 1) on the
    UNDIRECTED version of the link graph. Only the 323-page giant weak component
    gets a community label; the other 47 pages are left unlabelled (None) because
    a one- or two-page component is not a community.
  * A force-directed layout (networkx spring_layout, seed 42) of the giant
    component for view B; the 47 small-component pages are placed in a side strip.
  * Agreement between the two groupings (ARI, NMI, permutation null, K-robustness).
  * Per-character neighbour evidence and the list of pair "cases".

Writes data/week7/week7_explore.json. Run from the repository root:

    python analysis/build_week7_explore.py

Needs numpy, scipy, scikit-learn, networkx. It never writes week7_embeddings.npz.
"""
import csv
import json
from collections import Counter
from pathlib import Path

import networkx as nx
import numpy as np
from sklearn.cluster import AgglomerativeClustering
from sklearn.decomposition import PCA
from sklearn.metrics import adjusted_rand_score, normalized_mutual_info_score

REPO = Path(__file__).resolve().parent.parent
D = REPO / "data" / "week7"
SEED = 42
MIN_COS, MIN_DIST = 0.60, 5   # same thresholds as build_week7_pairs.py
N_NEIGH = 8
FEATURED = [
    ("Firebrand_(Marvel_Comics)", "Firepower_(comics)"),
    ("Doom_2099", "Kristoff_Vernard"),
    ("Masked_Marauder", "Gentleman_(character)"),
    ("Gorgon_(Inhuman)", "Lady_Gorgon"),
    ("Condor_(comics)", "Flying_Tiger_(Marvel_Comics)"),
]

# ---------------------------------------------------------------- load
z = np.load(D / "week7_embeddings.npz", allow_pickle=True)
ids = [str(x) for x in z["ids"]]
V = z["vectors"].astype(np.float64)
idx = {n: i for i, n in enumerate(ids)}
n = len(ids)
sv = json.load(open(D / "week7_supervillains.json", encoding="utf-8"))
chars = {c["id"]: c for c in json.load(open(D / "week7_characters.json", encoding="utf-8"))["characters"]}
edges = [(a, b) for a, b in sv["edges"]]
assert set(ids) == set(chars) and all(a in idx and b in idx for a, b in edges)

# The three very long pages (Naga, Tundra, Shepard; 6,500-18,000 words) that the post leaves out of
# its pair selection because they sit near many other pages.
BIG_THREE = {k for k in ids if k.split("_(")[0] in ("Naga", "Tundra", "Shepard")}
assert len(BIG_THREE) == 3, BIG_THREE

# ---------------------------------------------------------------- network communities
G = nx.Graph()
G.add_nodes_from(sorted(ids))
G.add_edges_from(sorted(tuple(sorted(e)) for e in edges))
giant = max(nx.connected_components(G), key=len)
Gg = G.subgraph(giant)
parts = nx.community.louvain_communities(Gg, seed=SEED)
parts.sort(key=lambda c: (-len(c), sorted(c)[0]))
comm = {nid: ci for ci, c in enumerate(parts) for nid in c}
K = len(parts)
modularity = nx.community.modularity(Gg, parts)

# ---------------------------------------------------------------- embedding clusters
ward = AgglomerativeClustering(n_clusters=K, linkage="ward").fit_predict(V)
csize = Counter(ward)
order = [c for c, _ in sorted(csize.items(), key=lambda kv: (-kv[1], kv[0]))]
remap = {c: i for i, c in enumerate(order)}
clus = {ids[i]: remap[int(ward[i])] for i in range(n)}

gi = [i for i, k in enumerate(ids) if k in giant]
a_clus = np.array([clus[ids[i]] for i in gi])
a_comm = np.array([comm[ids[i]] for i in gi])
ari = adjusted_rand_score(a_clus, a_comm)
nmi = normalized_mutual_info_score(a_clus, a_comm)
rng = np.random.default_rng(SEED)
null = [adjusted_rand_score(rng.permutation(a_clus), a_comm) for _ in range(500)]
robust = {}
for k in (8, 10, 15, 20):
    w = AgglomerativeClustering(n_clusters=k, linkage="ward").fit_predict(V)
    robust[k] = round(adjusted_rand_score(w[gi], a_comm), 3)

# ---------------------------------------------------------------- PCA
pca = PCA(n_components=2, random_state=SEED)
xy = pca.fit_transform(V)

# How faithful is the 2D map? Rank agreement between the true cosine and the projected
# distance over all pairs, and how many of a page's 10 nearest pages (cosine) are also
# among its 10 nearest on the map.
from scipy.stats import spearmanr
_iu = np.triu_indices(n, 1)
_C = V @ V.T
_Dp = np.linalg.norm(xy[:, None] - xy[None], axis=2)
pca_spearman = float(spearmanr(_C[_iu], -_Dp[_iu])[0])
_C2, _D2 = _C.copy(), _Dp.copy()
np.fill_diagonal(_C2, -9)
np.fill_diagonal(_D2, 9)
pca_knn_overlap = float(np.mean([len(set(np.argsort(-_C2[i])[:10]) & set(np.argsort(_D2[i])[:10])) for i in range(n)]))
_rank = np.argsort(np.argsort(_Dp[_iu])) / len(_iu[0])


def pca_percentile(a, b):
    """Percentile of the pair's projected distance among all pairs (0 = closest on the map)."""
    i, j = sorted((idx[a], idx[b]))
    k = int(np.where((_iu[0] == i) & (_iu[1] == j))[0][0])
    return round(100 * float(_rank[k]), 1)


# ---------------------------------------------------------------- layout for view B
pos = nx.spring_layout(Gg, seed=SEED, k=1.2, iterations=400)
P = np.array([pos[k] for k in sorted(giant)])
lo, hi = P.min(0), P.max(0)
layout = {}
for k in sorted(giant):
    layout[k] = [round(float((pos[k][0] - lo[0]) / (hi[0] - lo[0])), 4),
                 round(float((pos[k][1] - lo[1]) / (hi[1] - lo[1])), 4)]
rest = sorted(set(ids) - giant)
# side strip: x in 1.08..1.5 as a grid, y in 0..1
cols = 6
for j, k in enumerate(rest):
    layout[k] = [round(1.08 + 0.07 * (j % cols), 4), round(0.02 + 0.98 * (j // cols) / (len(rest) / cols), 4)]

# ---------------------------------------------------------------- pairs
cos = {}
dist = {}
with open(D / "week7_pairs.tsv", encoding="utf-8") as fh:
    rows = csv.reader((l for l in fh if not l.startswith("#")), delimiter="\t")
    header = next(rows)
    col = {h: i for i, h in enumerate(header)}
    for r in rows:
        a, b = r[col["a"]], r[col["b"]]
        c = float(r[col["cos"]])
        dab = int(r[col["d_ab"]]) if r[col["d_ab"]] != "" else None
        dba = int(r[col["d_ba"]]) if r[col["d_ba"]] != "" else None
        cos[(a, b)] = c
        dist[(a, b)] = (dab, dba)
assert len(cos) == n * (n - 1) // 2


def pair(a, b):
    """cosine, d(a->b), d(b->a) for any order of a, b."""
    if (a, b) in cos:
        return cos[(a, b)], dist[(a, b)][0], dist[(a, b)][1]
    return cos[(b, a)], dist[(b, a)][1], dist[(b, a)][0]


def rec(a, b):
    c, dab, dba = pair(a, b)
    return {"a": idx[a], "b": idx[b], "cos": c, "dab": dab, "dba": dba,
            "sameCluster": clus[a] == clus[b],
            "sameComm": (comm.get(a) is not None and comm.get(a) == comm.get(b))}


# neighbour evidence per character
neigh = {}
for k in ids:
    others = sorted((o for o in ids if o != k), key=lambda o: -pair(k, o)[0])[:N_NEIGH]
    neigh[idx[k]] = [[idx[o], pair(k, o)[0], pair(k, o)[1], pair(k, o)[2],
                      int(clus[k] == clus[o]),
                      int(comm.get(k) is not None and comm.get(k) == comm.get(o))] for o in others]

# 2x2 table over "similar" pairs (cos >= MIN_COS), excluding the three long pages,
# restricted to pairs where both pages are in the giant component (communities defined)
sim_pairs = [(a, b) for (a, b), c in cos.items()
             if c >= MIN_COS and a not in BIG_THREE and b not in BIG_THREE and a in giant and b in giant]
table = Counter((clus[a] == clus[b], comm[a] == comm[b]) for a, b in sim_pairs)


def mind(a, b):
    _, x, y = pair(a, b)
    ds = [d for d in (x, y) if d is not None]
    return min(ds) if ds else None


# Cases: similar pairs in the same embedding cluster but different communities and far apart
# (shortest directed path in either direction >= MIN_DIST) -- the strongest disagreements
far_diff = [(a, b) for a, b in sim_pairs if clus[a] == clus[b] and comm[a] != comm[b]
            and mind(a, b) is not None and mind(a, b) >= MIN_DIST]
# Same cluster + same community + close: agreement baseline
agree = [(a, b) for a, b in sim_pairs if clus[a] == clus[b] and comm[a] == comm[b]
         and mind(a, b) is not None and mind(a, b) <= 2]
# similar but in different embedding cluster AND different community
both_diff = [(a, b) for a, b in sim_pairs if clus[a] != clus[b] and comm[a] != comm[b]
             and mind(a, b) is not None and mind(a, b) >= MIN_DIST]
# similar and far apart but the SAME community (the community hides distance)
far_same_comm = [(a, b) for a, b in sim_pairs if comm[a] == comm[b]
                 and mind(a, b) is not None and mind(a, b) >= MIN_DIST]

featured = [rec(a, b) for a, b in FEATURED]

# cluster x community crosstab (giant component only)
cross = [[0] * K for _ in range(K)]
for i in gi:
    cross[clus[ids[i]]][comm[ids[i]]] += 1
cl_giant = Counter(a_clus)
cm_giant = Counter(a_comm)
purity_comm = sum(max(cross[c][m] for c in range(K)) for m in range(K)) / len(gi)
purity_clus = sum(max(cross[c]) for c in range(K)) / len(gi)

# ---------------------------------------------------------------- characters
nodes = []
for k in ids:
    nodes.append({
        "id": k, "name": chars[k]["name"], "words": chars[k]["words"],
        "inDeg": chars[k]["in_degree"], "outDeg": chars[k]["out_degree"],
        "pca": [round(float(xy[idx[k]][0]), 4), round(float(xy[idx[k]][1]), 4)],
        "net": layout[k],
        "cluster": clus[k], "comm": comm.get(k),
        "giant": k in giant,
    })

# representative members: nearest to the cluster centroid / highest-degree in the community
clus_reps, comm_reps = [], []
for c in range(K):
    mem = [i for i in range(n) if clus[ids[i]] == c]
    cen = V[mem].mean(0)
    clus_reps.append([i for _, i in sorted(((-float(V[i] @ cen), i) for i in mem))[:4]])
for m_ in range(K):
    mem = sorted(parts[m_], key=lambda k: (-(chars[k]["in_degree"] + chars[k]["out_degree"]), k))[:4]
    comm_reps.append([idx[k] for k in mem])

payload = {
    "meta": {
        "cluster_reps": clus_reps, "comm_reps": comm_reps,
        "generated_by": "analysis/build_week7_explore.py",
        "n_nodes": n, "n_edges": len(edges), "n_giant": len(giant),
        "embedding": "all-MiniLM-L6-v2, mean of passage vectors (week7_embeddings.npz)",
        "pca_spearman": round(pca_spearman, 3), "pca_knn10_overlap": round(pca_knn_overlap, 2),
        "featured_pca_percentile": [pca_percentile(a, b) for a, b in FEATURED],
        "pca_variance": [round(float(v), 4) for v in pca.explained_variance_ratio_],
        "cluster_method": f"Ward agglomerative clustering of the unit 384-d page vectors, K={K} (deterministic)",
        "community_method": f"Louvain (networkx, seed {SEED}) on the undirected link graph of the 323-page giant component; modularity {modularity:.3f}",
        "K": K,
        "cluster_sizes_all": [csize[order[i]] for i in range(K)],
        "cluster_sizes_giant": [int(cl_giant[i]) for i in range(K)],
        "comm_sizes": [len(c) for c in parts],
        "ari": round(ari, 3), "nmi": round(nmi, 3),
        "ari_null_mean": round(float(np.mean(null)), 4), "ari_null_max": round(float(np.max(null)), 4),
        "ari_by_k": robust,
        "purity_comm": round(purity_comm, 3), "purity_clus": round(purity_clus, 3),
        "min_cos": MIN_COS, "min_dist": MIN_DIST,
        "big_three": sorted(BIG_THREE),
        "sim_pairs": len(sim_pairs),
        "table": {"clusterSame_commSame": table[(True, True)], "clusterSame_commDiff": table[(True, False)],
                  "clusterDiff_commSame": table[(False, True)], "clusterDiff_commDiff": table[(False, False)]},
        "counts": {"far_diff": len(far_diff), "agree_close": len(agree), "both_diff_far": len(both_diff),
                   "far_same_comm": len(far_same_comm)},
    },
    "nodes": nodes,
    "edges": [[idx[a], idx[b]] for a, b in edges],
    "cross": cross,
    "featured": featured,
    "neighbours": neigh,
    "cases": {
        "farDiff": [rec(a, b) for a, b in sorted(far_diff, key=lambda p: -cos[p] if p in cos else -cos[(p[1], p[0])])[:40]],
        "farSameComm": [rec(a, b) for a, b in sorted(far_same_comm, key=lambda p: -pair(*p)[0])[:25]],
        "agree": [rec(a, b) for a, b in sorted(agree, key=lambda p: -pair(*p)[0])[:15]],
    },
}
with open(D / "week7_explore.json", "w", encoding="utf-8") as fh:
    json.dump(payload, fh, separators=(",", ":"))

m = payload["meta"]
print(f"giant {len(giant)}  K={K}  modularity {modularity:.3f}")
print("PCA variance", m["pca_variance"], "spearman", m["pca_spearman"], "10-NN overlap", m["pca_knn10_overlap"], "featured pct", m["featured_pca_percentile"])
print(f"ARI {m['ari']}  NMI {m['nmi']}  null mean {m['ari_null_mean']} max {m['ari_null_max']}  ARI by K {robust}")
print("purity (community->cluster):", m["purity_comm"], " (cluster->community):", m["purity_clus"])
print("2x2 over", len(sim_pairs), "similar pairs:", m["table"])
print("counts:", m["counts"])
for name, lst in (("featured", featured),):
    for r in lst:
        print(ids[r["a"]], ids[r["b"]], r["cos"], r["dab"], r["dba"], "cl", clus[ids[r["a"]]], clus[ids[r["b"]]],
              "cm", comm.get(ids[r["a"]]), comm.get(ids[r["b"]]))
