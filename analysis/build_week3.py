"""
Week 3 Marvel network analysis for the marvel-site Week 3 post.

Self-contained: reads only from ../data/week1/ (the same frozen snapshot
Week 1 and Week 2 use -- Week 3 introduces no new raw data), writes only to
../data/week3/week3_summary.json. Does not modify anything under
../data/week1/, ../data/week2/, or any existing post.

Purpose: compute every authoritative Week 3 number quoted on the Week 3 post
-- paths, four centrality measures (+ PageRank), directed-vs-undirected
comparisons, degree-preserving-shuffle null models (200 realizations),
degree assortativity, node-removal fragmentation curves, and maximal
cliques -- offline, with NetworkX, so the browser only has to look numbers
up and draw them. The interactive explorers still recompute a few genuinely
per-query things live (BFS between an arbitrary character pair) straight
from the same raw TSVs this script reads -- see posts/week3.js.

Run from inside marvel-site/analysis/:
    python build_week3.py
"""

from __future__ import annotations

import json
import pathlib
import random
import statistics
import time
from collections import Counter

import networkx as nx

HERE = pathlib.Path(__file__).parent
WEEK1_DATA_DIR = HERE.parent / "data" / "week1"
WEEK3_DATA_DIR = HERE.parent / "data" / "week3"

NODES_PATH = WEEK1_DATA_DIR / "week1_nodes.tsv"
EDGES_PATH = WEEK1_DATA_DIR / "week1_edges.tsv"
SUMMARY_PATH = WEEK3_DATA_DIR / "week3_summary.json"

EXPECTED_NODES = 303
EXPECTED_EDGES = 1784

SEED = 20260916  # fixed for reproducibility of every random/offline draw below
N_SHUFFLES = 200
SWAPS_PER_REALIZATION = 3000
TOP_N = 15
CLIQUE_SIZES = (4, 5, 6, 7, 8)

# Characters the post's prose specifically discusses -- always included in the
# null-model subset even if they fall outside the top-15 by real value, so
# every number quoted in prose has a documented z-score behind it.
DISCUSSED_CHARACTERS = [
    "Spider-Man",
    "Hulk",
    "Wolverine (character)",
    "Doctor Strange",
    "Hercules (Marvel Comics)",
    "Black Widow (Natasha Romanova)",
    "U.S. Agent",
    "Rockman (character)",
]


# ---------------------------------------------------------------------------
# Loading
# ---------------------------------------------------------------------------

def load_graph():
    with open(NODES_PATH, encoding="utf-8") as f:
        lines = [line.rstrip("\n") for line in f if not line.startswith("#") and line.strip()]
    header = lines[0].split("\t")
    id_col = header.index("node_id")
    name_col = header.index("name")
    node_ids = []
    names = {}
    for line in lines[1:]:
        cols = line.split("\t")
        node_ids.append(cols[id_col])
        names[cols[id_col]] = cols[name_col]

    with open(EDGES_PATH, encoding="utf-8") as f:
        edge_rows = [
            tuple(line.rstrip("\n").split("\t"))
            for line in f
            if not line.startswith("#") and line.strip()
        ]

    graph = nx.DiGraph()
    graph.add_nodes_from(node_ids)  # before edges, or isolates are silently dropped
    graph.add_edges_from(edge_rows)
    return graph, names


def verify(graph):
    n_nodes = graph.number_of_nodes()
    n_edges = graph.number_of_edges()
    assert n_nodes == EXPECTED_NODES, f"Expected {EXPECTED_NODES} nodes, got {n_nodes}"
    assert n_edges == EXPECTED_EDGES, f"Expected {EXPECTED_EDGES} edges, got {n_edges}"
    return n_nodes, n_edges


# ---------------------------------------------------------------------------
# Giant component
# ---------------------------------------------------------------------------

def giant_component(graph):
    full_und = graph.to_undirected(reciprocal=False)
    components = sorted(nx.connected_components(full_und), key=len, reverse=True)
    giant_nodes = components[0]
    giant_und = full_und.subgraph(giant_nodes).copy()
    return full_und, giant_und, components


def path_stats(giant_und):
    ecc = nx.eccentricity(giant_und)
    diameter = max(ecc.values())
    radius = min(ecc.values())
    center = sorted(n for n, e in ecc.items() if e == radius)
    periphery = sorted(n for n, e in ecc.items() if e == diameter)
    avg_len = nx.average_shortest_path_length(giant_und)
    # one concrete pair that actually achieves the diameter, for prose
    p = periphery[0]
    dist_from_p = nx.single_source_shortest_path_length(giant_und, p)
    partner = next(v for v, d in dist_from_p.items() if d == diameter)
    return {
        "avg_shortest_path_length": round(avg_len, 4),
        "diameter": diameter,
        "radius": radius,
        "center_ids": center,
        "periphery_sample_ids": periphery[:10],
        "diameter_pair_ids": [p, partner],
    }


# ---------------------------------------------------------------------------
# Layout (precomputed once, offline -- the browser never runs physics)
# ---------------------------------------------------------------------------

def compute_layout(giant_und):
    pos = nx.spring_layout(giant_und, seed=SEED, k=1.4 / (len(giant_und) ** 0.5), iterations=200)
    xs = [p[0] for p in pos.values()]
    ys = [p[1] for p in pos.values()]
    xmin, xmax = min(xs), max(xs)
    ymin, ymax = min(ys), max(ys)
    xspan = (xmax - xmin) or 1.0
    yspan = (ymax - ymin) or 1.0
    normalized = {}
    for node, (x, y) in pos.items():
        normalized[node] = [
            round((x - xmin) / xspan, 5),
            round((y - ymin) / yspan, 5),
        ]
    return normalized


# ---------------------------------------------------------------------------
# Centrality (undirected giant component: degree, closeness, harmonic,
# betweenness -- directed full graph: PageRank, directed betweenness)
# ---------------------------------------------------------------------------

def compute_centralities(graph, giant_und):
    n_giant = giant_und.number_of_nodes()

    degree_raw = dict(giant_und.degree())
    closeness = nx.closeness_centrality(giant_und)  # already (n-1)/sum(d) -- matches course formula
    harmonic_raw = nx.harmonic_centrality(giant_und)  # NetworkX returns the raw sum, NOT divided by (n-1)
    harmonic = {k: v / (n_giant - 1) for k, v in harmonic_raw.items()}  # normalize to match course formula
    betweenness = nx.betweenness_centrality(giant_und, normalized=True)

    directed_betweenness = nx.betweenness_centrality(graph, normalized=True)
    pagerank = nx.pagerank(graph, alpha=0.85)
    in_degree = dict(graph.in_degree())
    out_degree = dict(graph.out_degree())

    return {
        "degree": degree_raw,
        "closeness": closeness,
        "harmonic": harmonic,
        "betweenness": betweenness,
        "directed_betweenness": directed_betweenness,
        "pagerank": pagerank,
        "in_degree": in_degree,
        "out_degree": out_degree,
    }


def top_n(values, names, n=TOP_N):
    ranked = sorted(values.items(), key=lambda kv: (-kv[1], names.get(kv[0], kv[0])))[:n]
    return [
        {"rank": i + 1, "node_id": nid, "name": names[nid], "value": round(val, 6)}
        for i, (nid, val) in enumerate(ranked)
    ]


def rank_lookup(values):
    """node_id -> 1-indexed rank (1 = highest value), full ranking, not just top N."""
    ranked = sorted(values.items(), key=lambda kv: -kv[1])
    return {nid: i + 1 for i, (nid, _) in enumerate(ranked)}


def all_values(values):
    """Full node_id -> value map (not just top N) -- cheap to store (<300 floats
    per measure) and lets the UI inspect ANY clicked character, not only the
    top 15, without recomputing anything expensive client-side."""
    return {nid: round(val, 6) for nid, val in values.items()}


def build_centrality_block(cent, names):
    return {
        "degree": {
            "graph": "undirected_giant_component",
            "definition": "Raw undirected degree -- number of distinct characters this one shares an edge with, either direction, on the 277-character giant component.",
            "top": top_n(cent["degree"], names),
            "all": all_values(cent["degree"]),
        },
        "closeness": {
            "graph": "undirected_giant_component",
            "definition": "(n-1) / sum of shortest-path distances to every other reachable character -- how quickly you can reach everyone.",
            "top": top_n(cent["closeness"], names),
            "all": all_values(cent["closeness"]),
        },
        "harmonic": {
            "graph": "undirected_giant_component",
            "definition": "Mean of 1/distance to every other character (1/infinity treated as 0) -- closeness's fix for unreachable nodes, not needed here since the giant component is fully connected, but computed the same way for comparability.",
            "top": top_n(cent["harmonic"], names),
            "all": all_values(cent["harmonic"]),
        },
        "betweenness": {
            "graph": "undirected_giant_component",
            "definition": "Fraction of all shortest paths between other character pairs that pass through this one -- how often you're the bridge.",
            "top": top_n(cent["betweenness"], names),
            "all": all_values(cent["betweenness"]),
        },
        "pagerank": {
            "graph": "directed_full_network",
            "definition": "Random-walk importance on the directed network (alpha=0.85): who is linked to by the important, following arrows.",
            "top": top_n(cent["pagerank"], names),
            "all": all_values(cent["pagerank"]),
        },
    }


def build_directed_vs_undirected(cent, names):
    betw_rank_u = rank_lookup(cent["betweenness"])
    betw_rank_d = rank_lookup(cent["directed_betweenness"])
    pr_rank = rank_lookup(cent["pagerank"])
    indeg_rank = rank_lookup(cent["in_degree"])

    # union of top-10 undirected and top-10 directed betweenness, by node id
    top10_u = {nid for nid, _ in sorted(cent["betweenness"].items(), key=lambda kv: -kv[1])[:10]}
    top10_d = {nid for nid, _ in sorted(cent["directed_betweenness"].items(), key=lambda kv: -kv[1])[:10]}
    union_ids = sorted(top10_u | top10_d, key=lambda nid: betw_rank_d.get(nid, 9999))

    betweenness_comparison = []
    for nid in union_ids:
        betweenness_comparison.append({
            "node_id": nid,
            "name": names[nid],
            "undirected_rank": betw_rank_u.get(nid),
            "undirected_value": round(cent["betweenness"].get(nid, 0.0), 6),
            "directed_rank": betw_rank_d.get(nid),
            "directed_value": round(cent["directed_betweenness"].get(nid, 0.0), 6),
        })

    top10_pr_ids = [nid for nid, _ in sorted(cent["pagerank"].items(), key=lambda kv: -kv[1])[:10]]
    top10_indeg_ids = {nid for nid, _ in sorted(cent["in_degree"].items(), key=lambda kv: -kv[1])[:10]}
    pagerank_surprises = [
        {"node_id": nid, "name": names[nid],
         "pagerank_rank": pr_rank[nid], "in_degree_rank": indeg_rank[nid],
         "in_degree": cent["in_degree"][nid]}
        for nid in top10_pr_ids if nid not in top10_indeg_ids
    ]

    return {
        "betweenness_rank_changes": betweenness_comparison,
        "pagerank_vs_in_degree_surprises": pagerank_surprises,
    }


# ---------------------------------------------------------------------------
# Assortativity
# ---------------------------------------------------------------------------

def compute_assortativity(full_und, giant_und):
    r_giant = nx.degree_assortativity_coefficient(giant_und)
    r_full = nx.degree_assortativity_coefficient(full_und)

    knn = nx.average_neighbor_degree(giant_und)
    degree = dict(giant_und.degree())
    by_k: dict[int, list[float]] = {}
    for node, k in degree.items():
        if k == 0:
            continue
        by_k.setdefault(k, []).append(knn[node])
    knn_curve = [[k, round(statistics.mean(v), 4), len(v)] for k, v in sorted(by_k.items())]

    return {
        "r_giant_component": round(r_giant, 4),
        "r_full_undirected_projection": round(r_full, 4),
        "knn_curve": knn_curve,  # [degree, mean_neighbor_degree, n_nodes_with_that_degree]
    }


# ---------------------------------------------------------------------------
# Cliques
# ---------------------------------------------------------------------------

def compute_cliques(giant_und, names):
    all_cliques = list(nx.find_cliques(giant_und))
    sizes = [len(c) for c in all_cliques]
    size_distribution = dict(sorted(Counter(sizes).items()))

    by_size = {}
    for size in CLIQUE_SIZES:
        matching = [c for c in all_cliques if len(c) == size]
        entries = []
        for i, clique in enumerate(matching, 1):
            member_ids = sorted(clique)
            entries.append({
                "id": f"clique_{size}_{i}",
                "member_ids": member_ids,
                "members": sorted(names[nid] for nid in member_ids),
            })
        by_size[str(size)] = {
            "count": len(matching),
            "internal_edges": size * (size - 1) // 2,
            "cliques": entries,
        }

    return {
        "clique_number": max(sizes),
        "total_maximal_cliques": len(all_cliques),
        "size_distribution": {str(k): v for k, v in size_distribution.items()},
        "by_size": by_size,
        "definition_note": (
            "Every entry below is a MAXIMAL clique of exactly the stated size -- a fully "
            "mutually-connected group that cannot be extended by adding another character "
            "connected to everyone already in it. A '4-clique' here is a group that maxes out "
            "at 4 members; it is never a 4-member subset cherry-picked out of a larger clique "
            "(such a subset could always be extended back to the larger group, so "
            "NetworkX's find_cliques() never returns it on its own)."
        ),
    }


# ---------------------------------------------------------------------------
# Fragmentation
# ---------------------------------------------------------------------------

def removal_curve(giant_und, order):
    """Giant-component size after removing the first k nodes of `order`, for
    every k from 0 to len(order). One connected-components pass per k."""
    working = giant_und.copy()
    sizes = [working.number_of_nodes()]
    for node in order:
        working.remove_node(node)
        if working.number_of_nodes() == 0:
            sizes.append(0)
            continue
        comps = sorted(nx.connected_components(working), key=len, reverse=True)
        sizes.append(len(comps[0]))
    return sizes


def compute_fragmentation(giant_und, cent, names):
    giant_total = giant_und.number_of_nodes()

    degree_order = [nid for nid, _ in sorted(cent["degree"].items(), key=lambda kv: -kv[1])]
    betweenness_order = [nid for nid, _ in sorted(cent["betweenness"].items(), key=lambda kv: -kv[1])]
    rng = random.Random(SEED)
    random_order = list(giant_und.nodes())
    rng.shuffle(random_order)

    strategies = {}
    for key, order in [
        ("degree_desc", degree_order),
        ("betweenness_desc", betweenness_order),
        ("random", random_order),
    ]:
        strategies[key] = {
            "order_ids": order,
            "order_names": [names[nid] for nid in order],
            "giant_size_after_k": removal_curve(giant_und, order),
        }

    # single-node impact: remove ONE node at a time from the untouched giant
    impact = []
    for nid in giant_und.nodes():
        h = giant_und.copy()
        h.remove_node(nid)
        comps = sorted(nx.connected_components(h), key=len, reverse=True) if h.number_of_nodes() else []
        giant_after = len(comps[0]) if comps else 0
        expected_after = giant_total - 1
        delta = expected_after - giant_after
        impact.append({
            "node_id": nid,
            "name": names[nid],
            "giant_size_after_removal": giant_after,
            "components_after": len(comps),
            "delta": delta,
        })
    impact.sort(key=lambda x: (-x["delta"], x["giant_size_after_removal"]))

    articulation_ids = sorted(nx.articulation_points(giant_und))

    max_fragmenter = impact[0]
    top_degree_id = degree_order[0]
    top_betweenness_id = betweenness_order[0]

    return {
        "giant_component_total": giant_total,
        "strategies": strategies,
        "single_node_impact_top20": impact[:20],
        "articulation_points": [{"node_id": nid, "name": names[nid]} for nid in articulation_ids],
        "articulation_point_count": len(articulation_ids),
        "max_fragmenter": max_fragmenter,
        "matches_top_degree": max_fragmenter["node_id"] == top_degree_id,
        "matches_top_betweenness": max_fragmenter["node_id"] == top_betweenness_id,
    }


# ---------------------------------------------------------------------------
# Null models (degree-preserving directed-edge-swap shuffle)
# ---------------------------------------------------------------------------

def curated_null_model_ids(cent, names):
    ids = set()
    for nid, _ in sorted(cent["betweenness"].items(), key=lambda kv: -kv[1])[:TOP_N]:
        ids.add(nid)
    for nid, _ in sorted(cent["closeness"].items(), key=lambda kv: -kv[1])[:TOP_N]:
        ids.add(nid)
    name_to_id = {v: k for k, v in names.items()}
    for display_name in DISCUSSED_CHARACTERS:
        if display_name in name_to_id:
            ids.add(name_to_id[display_name])
    return ids


def run_null_models(graph, giant_und, cent, names):
    curated_ids = curated_null_model_ids(cent, names)

    betw_samples = {nid: [] for nid in curated_ids}
    close_samples = {nid: [] for nid in curated_ids}
    r_samples = []

    t0 = time.time()
    for i in range(N_SHUFFLES):
        h = graph.copy()
        nx.directed_edge_swap(h, nswap=SWAPS_PER_REALIZATION, max_tries=SWAPS_PER_REALIZATION * 25, seed=SEED + 1000 + i)
        h_und = h.to_undirected(reciprocal=False)
        comps = sorted(nx.connected_components(h_und), key=len, reverse=True)
        h_giant = h_und.subgraph(comps[0]).copy()

        h_betw = nx.betweenness_centrality(h_giant, normalized=True)
        h_close = nx.closeness_centrality(h_giant)
        try:
            h_r = nx.degree_assortativity_coefficient(h_giant)
        except Exception:
            h_r = float("nan")
        if h_r == h_r:  # skip NaN (can occur if every node has identical degree)
            r_samples.append(h_r)

        for nid in curated_ids:
            betw_samples[nid].append(h_betw.get(nid, 0.0))
            close_samples[nid].append(h_close.get(nid, 0.0))

        if (i + 1) % 20 == 0:
            elapsed = time.time() - t0
            print(f"    shuffle {i + 1}/{N_SHUFFLES}  ({elapsed:.1f}s elapsed)", flush=True)

    def summarize(real_value, samples, one_sided=True):
        mean = statistics.mean(samples)
        sd = statistics.pstdev(samples)
        z = (real_value - mean) / sd if sd > 0 else float("nan")
        if one_sided:
            extreme = sum(1 for s in samples if s >= real_value)
        else:
            diff = abs(real_value - mean)
            extreme = sum(1 for s in samples if abs(s - mean) >= diff)
        return {
            "real": round(real_value, 6),
            "shuffle_mean": round(mean, 6),
            "shuffle_sd": round(sd, 6),
            "z": round(z, 3) if z == z else None,
            "extreme_count": extreme,
            "n_shuffles": len(samples),
        }

    betweenness_null = {
        nid: {"name": names[nid], **summarize(cent["betweenness"][nid], betw_samples[nid], one_sided=True)}
        for nid in curated_ids
    }
    closeness_null = {
        nid: {"name": names[nid], **summarize(cent["closeness"][nid], close_samples[nid], one_sided=True)}
        for nid in curated_ids
    }

    real_r = nx.degree_assortativity_coefficient(giant_und)
    assortativity_null = summarize(real_r, r_samples, one_sided=False)

    return {
        "method": (
            "200 realizations of nx.directed_edge_swap on the full directed graph "
            f"({SWAPS_PER_REALIZATION} swaps/realization), preserving every character's exact "
            "in-degree and out-degree; the undirected giant component and its statistics are "
            "recomputed fresh from scratch on each realization (component membership can shift "
            "slightly between realizations, unlike Week 2's chain-swap shuffle)."
        ),
        "n_shuffles": N_SHUFFLES,
        "swaps_per_realization": SWAPS_PER_REALIZATION,
        "extreme_count_definition": (
            "For betweenness/closeness (one-sided): number of shuffles with a value >= the real "
            "network's value (real is expected to sit at or above the null). For assortativity "
            "(two-sided): number of shuffles at least as far from the shuffle mean, in either "
            "direction, as the real value is."
        ),
        "betweenness": betweenness_null,
        "closeness": closeness_null,
        "assortativity": assortativity_null,
        "elapsed_seconds": round(time.time() - t0, 1),
    }


# ---------------------------------------------------------------------------
# Six Degrees prose facts + BFS validation spot-checks
# ---------------------------------------------------------------------------

def six_degrees_notes(graph, giant_und, names, path):
    name_to_id = {v: k for k, v in names.items()}
    spidey = name_to_id["Spider-Man"]

    dist_undirected = nx.single_source_shortest_path_length(giant_und, spidey)
    ecc_spidey = max(dist_undirected.values())
    farthest = sorted(names[nid] for nid, d in dist_undirected.items() if d == ecc_spidey)

    out_deg = graph.out_degree(spidey)
    in_deg = graph.in_degree(spidey)
    reach_out = nx.single_source_shortest_path_length(graph, spidey)
    reach_in = nx.single_source_shortest_path_length(graph.reverse(copy=False), spidey)

    diameter = max(nx.eccentricity(giant_und).values())

    return {
        "spiderman_node_id": spidey,
        "spiderman_eccentricity_undirected": ecc_spidey,
        "spiderman_farthest_characters": farthest,
        "spiderman_out_degree_directed": out_deg,
        "spiderman_in_degree_directed": in_deg,
        "spiderman_reachable_outward_directed": len(reach_out),
        "spiderman_can_reach_spiderman_directed": len(reach_in),
        "network_diameter": diameter,
        "note": (
            f"Spider-Man's own eccentricity in the undirected giant component is {ecc_spidey}, "
            f"well under the network's diameter of {diameter} -- no one is more than "
            f"{ecc_spidey} undirected hops from Spider-Man, so the network's longest chains run "
            "between other, more peripheral characters, not to or from him."
        ),
    }


def bfs_validation_spot_checks(graph, giant_und, names):
    """A handful of NetworkX-computed shortest paths (undirected + directed),
    recorded so the in-browser BFS explorer's output can be checked against
    an independent, authoritative source during manual testing."""
    rng = random.Random(SEED + 7)
    giant_list = sorted(giant_und.nodes())
    pairs = []
    for _ in range(10):
        a, b = rng.sample(giant_list, 2)
        pairs.append((a, b))

    checks = []
    for a, b in pairs:
        entry = {"source": names[a], "target": names[b]}
        if nx.has_path(giant_und, a, b):
            path = nx.shortest_path(giant_und, a, b)
            entry["undirected_distance"] = len(path) - 1
            entry["undirected_path"] = [names[n] for n in path]
        else:
            entry["undirected_distance"] = None
            entry["undirected_path"] = None

        if nx.has_path(graph, a, b):
            dpath = nx.shortest_path(graph, a, b)
            entry["directed_distance"] = len(dpath) - 1
            entry["directed_path"] = [names[n] for n in dpath]
        else:
            entry["directed_distance"] = None
            entry["directed_path"] = None
        checks.append(entry)
    return checks


# ---------------------------------------------------------------------------
# Main
# ---------------------------------------------------------------------------

def main():
    t_start = time.time()
    print("[1/8] Loading graph ...")
    graph, names = load_graph()
    n_nodes, n_edges = verify(graph)
    print(f"  {n_nodes} nodes, {n_edges} directed edges")

    print("[2/8] Giant component + path stats ...")
    full_und, giant_und, components = giant_component(graph)
    isolate_count = sum(1 for c in components if len(c) == 1)
    paths = path_stats(giant_und)
    print(f"  giant component: {giant_und.number_of_nodes()} of {n_nodes} nodes, "
          f"diameter {paths['diameter']}, avg path length {paths['avg_shortest_path_length']}")

    print("[3/8] Layout (spring_layout, seeded) ...")
    layout = compute_layout(giant_und)

    print("[4/8] Centralities (degree/closeness/harmonic/betweenness on giant component; "
          "PageRank + directed betweenness on the full directed graph) ...")
    cent = compute_centralities(graph, giant_und)
    centrality_block = build_centrality_block(cent, names)
    directed_vs_undirected = build_directed_vs_undirected(cent, names)
    top10_sets = [
        {nid for nid, _ in sorted(cent[k].items(), key=lambda kv: -kv[1])[:10]}
        for k in ("degree", "closeness", "harmonic", "betweenness")
    ]
    top10_overlap = sorted(names[nid] for nid in set.intersection(*top10_sets))

    print("[5/8] Assortativity + cliques ...")
    assortativity = compute_assortativity(full_und, giant_und)
    cliques = compute_cliques(giant_und, names)
    print(f"  clique number: {cliques['clique_number']}, "
          f"{cliques['by_size'][str(cliques['clique_number'])]['count']} maximal cliques of that size")

    print("[6/8] Fragmentation (removal curves + single-node sweep + articulation points) ...")
    fragmentation = compute_fragmentation(giant_und, cent, names)
    mf = fragmentation["max_fragmenter"]
    print(f"  max single-node fragmenter: {mf['name']} "
          f"(giant {fragmentation['giant_component_total']} -> {mf['giant_size_after_removal']}, "
          f"delta {mf['delta']}); matches top degree: {fragmentation['matches_top_degree']}, "
          f"matches top betweenness: {fragmentation['matches_top_betweenness']}")

    print(f"[7/8] Null models: {N_SHUFFLES} degree-preserving shuffles "
          f"({SWAPS_PER_REALIZATION} swaps each) -- this is the slow step ...")
    null_models = run_null_models(graph, giant_und, cent, names)
    print(f"  done in {null_models['elapsed_seconds']}s")

    print("[8/8] Six Degrees prose facts + BFS validation spot-checks ...")
    six_degrees = six_degrees_notes(graph, giant_und, names, None)
    validation = bfs_validation_spot_checks(graph, giant_und, names)

    summary = {
        "meta": {
            "generated_from": "data/week1/week1_nodes.tsv, data/week1/week1_edges.tsv",
            "seed": SEED,
            "node_count": n_nodes,
            "edge_count": n_edges,
            "isolate_count": isolate_count,
        },
        "giant_component": {
            "size": giant_und.number_of_nodes(),
            "total_nodes": n_nodes,
            "fraction": round(giant_und.number_of_nodes() / n_nodes, 4),
            **paths,
        },
        "directed": {
            "largest_scc_size": len(max(nx.strongly_connected_components(graph), key=len)),
            "note": (
                "Degree/closeness/harmonic/betweenness in `centrality` below are computed on the "
                "undirected giant component. PageRank is computed on the full directed network. "
                "`directed_vs_undirected.betweenness_rank_changes` compares undirected betweenness "
                "against betweenness computed with arrows respected on the full directed graph."
            ),
        },
        "layout": layout,
        "centrality": centrality_block,
        "directed_vs_undirected": directed_vs_undirected,
        "top10_overlap_all_undirected_measures": top10_overlap,
        "assortativity": assortativity,
        "null_models": null_models,
        "fragmentation": fragmentation,
        "cliques": cliques,
        "six_degrees_notes": six_degrees,
        "validation_bfs_spot_checks": validation,
    }

    WEEK3_DATA_DIR.mkdir(parents=True, exist_ok=True)
    with open(SUMMARY_PATH, "w", encoding="utf-8") as f:
        json.dump(summary, f, indent=2, ensure_ascii=False)
        f.write("\n")

    total_elapsed = time.time() - t_start
    print(f"\nDone in {total_elapsed:.1f}s. Wrote {SUMMARY_PATH}")


if __name__ == "__main__":
    main()
