"""
Week 2 Marvel network analysis for the marvel-site Week 2 post.

Self-contained: reads only from ../data/week1/ (the same frozen snapshot
Week 1 uses -- Week 2 introduces no new raw data), writes only to
../data/week2/week2_summary.json. Does not modify anything under
../data/week1/ or ../posts/week-1-marvel-network.html.

Purpose: compute Week 2's reference numbers -- the ones quoted in the
post's prose -- with far more ER draws / shuffle realizations than is
comfortable to run live in a visitor's browser. The in-page interactive
explorables run the *same* algorithms client-side (fewer samples per
click, for responsiveness), so a visitor can reproduce a lighter version
of every number here themselves; this script exists so the prose isn't
hand-typed or guessed ahead of actually running the computation.

Does not use pandas (not installed in this environment) -- TSVs are
read directly with csv, matching build_week1.py's parsing logic without
importing from it.

Run from inside marvel-site/analysis/:
    python build_week2.py
"""

import csv
import json
import pathlib
import random
import statistics

import networkx as nx

HERE = pathlib.Path(__file__).parent
WEEK1_DATA_DIR = HERE.parent / "data" / "week1"
WEEK2_DATA_DIR = HERE.parent / "data" / "week2"

NODES_PATH = WEEK1_DATA_DIR / "week1_nodes.tsv"
EDGES_PATH = WEEK1_DATA_DIR / "week1_edges.tsv"

EXPECTED_NODES = 303
EXPECTED_EDGES = 1784

SEED = 20260909  # fixed for reproducibility of the *offline* reference numbers
random.seed(SEED)


def load_graph():
    with open(NODES_PATH, encoding="utf-8") as f:
        lines = [line.rstrip("\n") for line in f if not line.startswith("#") and line.strip()]
    header = lines[0].split("\t")
    id_col = header.index("node_id")
    node_ids = [line.split("\t")[id_col] for line in lines[1:]]

    with open(EDGES_PATH, encoding="utf-8") as f:
        edge_rows = [
            tuple(line.rstrip("\n").split("\t"))
            for line in f
            if not line.startswith("#") and line.strip()
        ]

    graph = nx.DiGraph()
    graph.add_nodes_from(node_ids)  # before edges, or isolates are silently dropped
    graph.add_edges_from(edge_rows)
    return graph, node_ids


def verify(graph):
    n_nodes = graph.number_of_nodes()
    n_edges = graph.number_of_edges()
    assert n_nodes == EXPECTED_NODES, f"Expected {EXPECTED_NODES} nodes, got {n_nodes}"
    assert n_edges == EXPECTED_EDGES, f"Expected {EXPECTED_EDGES} edges, got {n_edges}"
    return n_nodes, n_edges


# ---------------------------------------------------------------------------
# Baseline statistics on the real network
# ---------------------------------------------------------------------------

def baseline_stats(graph):
    n = graph.number_of_nodes()
    m = graph.number_of_edges()

    in_degs = [d for _, d in graph.in_degree()]
    out_degs = [d for _, d in graph.out_degree()]

    # Undirected projection: an edge exists between u and v if either
    # u->v or v->u exists in the directed graph (reciprocal=False, the
    # default) -- the SAME projection used for clustering here and for
    # the friendship-paradox section on the page, so both sections use
    # one consistent notion of "neighbor."
    undirected = graph.to_undirected(reciprocal=False)
    und_degs = [d for _, d in undirected.degree()]

    avg_clustering = nx.average_clustering(undirected)  # 0 for degree<2 nodes, isolates included
    reciprocity = nx.overall_reciprocity(graph)  # mutual directed edges / total directed edges

    components = sorted(nx.weakly_connected_components(graph), key=len, reverse=True)
    giant_size = len(components[0])

    # friendship paradox, exact (no simulation needed):
    #   per-node degree + average neighbor degree, both on the undirected projection
    #   network aggregate: <k> vs <k^2>/<k> (edge-weighted mean neighbor degree)
    knn_by_node = {}
    for node in undirected.nodes():
        neighbors = list(undirected.neighbors(node))
        if not neighbors:
            continue
        knn_by_node[node] = sum(undirected.degree(nb) for nb in neighbors) / len(neighbors)

    mean_k = sum(und_degs) / n
    mean_k2 = sum(d * d for d in und_degs) / n
    k2_over_k = mean_k2 / mean_k

    n_isolated = sum(1 for d in und_degs if d == 0)
    n_with_neighbors = n - n_isolated
    n_paradox_holds = sum(
        1 for node, knn in knn_by_node.items() if knn > undirected.degree(node)
    )
    n_paradox_fails = sum(
        1 for node, knn in knn_by_node.items() if knn < undirected.degree(node)
    )

    champions = sorted(
        node
        for node in undirected.nodes()
        if undirected.degree(node) > 0
        and all(undirected.degree(node) >= undirected.degree(nb) for nb in undirected.neighbors(node))
    )

    return {
        "n": n,
        "m_directed": m,
        "in_degree": {"min": min(in_degs), "max": max(in_degs), "mean": sum(in_degs) / n},
        "out_degree": {"min": min(out_degs), "max": max(out_degs), "mean": sum(out_degs) / n},
        "undirected_projection": {
            "edge_count": undirected.number_of_edges(),
            "degree_min": min(und_degs),
            "degree_max": max(und_degs),
            "degree_mean": mean_k,
        },
        "clustering": {
            "definition": "average local clustering coefficient on the undirected projection "
                           "(edge if source->target OR target->source), all 303 nodes, "
                           "nodes with degree < 2 contribute 0",
            "value": avg_clustering,
        },
        "reciprocity": {
            "definition": "mutual directed edges / total directed edges",
            "mutual_edge_fraction": reciprocity,
        },
        "components": {
            "weakly_connected_count": len(components),
            "giant_component_size": giant_size,
        },
        "friendship_paradox": {
            "definition": "undirected projection; degree = distinct neighbor count; "
                           "avg_neighbor_degree = mean degree of a node's own neighbors",
            "mean_k": mean_k,
            "k2_over_k": k2_over_k,
            "note": "k2_over_k is the edge-weighted mean neighbor degree <k^2>/<k>; it is a "
                    "pure function of the degree sequence, so it is mathematically invariant "
                    "under a degree-preserving shuffle -- not something that needs testing.",
            "n_with_neighbors": n_with_neighbors,
            "n_isolated": n_isolated,
            "n_paradox_holds": n_paradox_holds,
            "n_paradox_fails": n_paradox_fails,
            "n_paradox_tied": n_with_neighbors - n_paradox_holds - n_paradox_fails,
            "local_degree_champions": champions,
        },
    }


# ---------------------------------------------------------------------------
# Section 2: Erdos-Renyi random baseline
# ---------------------------------------------------------------------------

def er_null(n, m, n_draws=300):
    max_in_degrees = []
    for _ in range(n_draws):
        g = nx.gnm_random_graph(n, m, directed=True, seed=random.randrange(2**31))
        max_in_degrees.append(max(d for _, d in g.in_degree()))
    return {
        "n_draws": n_draws,
        "n": n,
        "m": m,
        "max_in_degree": {
            "min": min(max_in_degrees),
            "max": max(max_in_degrees),
            "mean": statistics.mean(max_in_degrees),
            "stdev": statistics.pstdev(max_in_degrees),
        },
    }


# ---------------------------------------------------------------------------
# Section 3: degree-preserving directed shuffle (methodological centerpiece)
# ---------------------------------------------------------------------------

def shuffle_null(graph, n_realizations=300, swaps_per_realization=3000, max_tries_factor=20):
    clustering_samples = []
    reciprocity_samples = []
    giant_samples = []

    for i in range(n_realizations):
        g = graph.copy()
        try:
            nx.directed_edge_swap(
                g,
                nswap=swaps_per_realization,
                max_tries=swaps_per_realization * max_tries_factor,
                seed=random.randrange(2**31),
            )
        except nx.NetworkXAlgorithmError:
            # Occasionally the swap chain can't find a valid trio within
            # max_tries this late in a run; skip this realization rather
            # than silently using a half-shuffled graph.
            continue

        und = g.to_undirected(reciprocal=False)
        clustering_samples.append(nx.average_clustering(und))
        reciprocity_samples.append(nx.overall_reciprocity(g))
        giant = max(len(c) for c in nx.weakly_connected_components(g))
        giant_samples.append(giant)

    return {
        "n_realizations_requested": n_realizations,
        "n_realizations_completed": len(clustering_samples),
        "swaps_per_realization": swaps_per_realization,
        "clustering_null": clustering_samples,
        "reciprocity_null": reciprocity_samples,
        "giant_component_null": giant_samples,
    }


def z_and_p(real_value, null_samples, tail="two-sided"):
    mean = statistics.mean(null_samples)
    stdev = statistics.pstdev(null_samples)
    # None (not NaN) when the null has zero variance -- json.dump would
    # otherwise emit the bare token NaN, which is invalid JSON and breaks
    # JSON.parse() in the browser.
    z = (real_value - mean) / stdev if stdev > 0 else None
    n = len(null_samples)
    if tail == "greater":
        # fraction of null draws >= real value (probability real value is
        # this large or larger, under the null)
        p = sum(1 for v in null_samples if v >= real_value) / n
    elif tail == "less":
        p = sum(1 for v in null_samples if v <= real_value) / n
    else:
        p = sum(1 for v in null_samples if abs(v - mean) >= abs(real_value - mean)) / n
    return {"null_mean": mean, "null_stdev": stdev, "z_score": z, "empirical_p": p}


# ---------------------------------------------------------------------------
# Section 4: directed preferential-attachment growth (Price/BA-style model)
# ---------------------------------------------------------------------------

def directed_preferential_attachment(n, m, seed=None):
    """
    Grow a directed network to n nodes: start from a small seed of m+1
    nodes wired as a directed cycle (so every seed node starts with
    in-degree 1, avoiding a zero-probability trap), then each new node
    adds m outgoing edges to distinct existing nodes chosen with
    probability proportional to (in-degree + 1).

    Out-degree is exactly m for every non-seed node by construction --
    the directed analogue of "growth"; in-degree accumulates by
    preferential attachment -- the directed analogue of "preference."
    This is the historically-original (Price 1976) citation-network
    form of preferential attachment, applied here because the real
    network is directed and its in/out-degree roles are asymmetric
    (Week 1 finding), unlike undirected Barabasi-Albert.
    """
    rng = random.Random(seed)
    g = nx.DiGraph()

    seed_size = m + 1
    seed_nodes = list(range(seed_size))
    g.add_nodes_from(seed_nodes)
    for i in seed_nodes:
        g.add_edge(i, (i + 1) % seed_size)

    for new_node in range(seed_size, n):
        g.add_node(new_node)
        existing = list(g.nodes())[:-1]  # everyone added so far, excluding new_node itself
        weights = [g.in_degree(node) + 1 for node in existing]
        targets = set()
        # weighted sampling without replacement
        pool = list(zip(existing, weights))
        while len(targets) < m and pool:
            total = sum(w for _, w in pool)
            r = rng.uniform(0, total)
            upto = 0
            for idx, (node, w) in enumerate(pool):
                upto += w
                if upto >= r:
                    targets.add(node)
                    pool.pop(idx)
                    break
        for t in targets:
            g.add_edge(new_node, t)

    return g


def ba_reference(n, m, n_trials=50):
    max_in_degrees = []
    mean_in_degrees = []
    for trial in range(n_trials):
        g = directed_preferential_attachment(n, m, seed=random.randrange(2**31))
        in_degs = [d for _, d in g.in_degree()]
        max_in_degrees.append(max(in_degs))
        mean_in_degrees.append(sum(in_degs) / len(in_degs))
        components = list(nx.weakly_connected_components(g))
        n_components = len(components)
        isolates = sum(1 for _, d in g.in_degree() if d == 0 and g.out_degree(_) == 0)
    return {
        "n": n,
        "m": m,
        "n_trials": n_trials,
        "max_in_degree": {
            "min": min(max_in_degrees),
            "max": max(max_in_degrees),
            "mean": statistics.mean(max_in_degrees),
        },
        "mean_in_degree_check": statistics.mean(mean_in_degrees),  # sanity: should equal m
        "n_weakly_connected_components_last_trial": n_components,
        "n_isolates_last_trial": isolates,
        "note": "By construction every non-seed node attaches on arrival, so BA/Price-model "
                "growth cannot produce isolated nodes or a disconnected island the way the "
                "real network does (Week 1: 17 isolates, a separate 9-node island).",
    }


def main():
    WEEK2_DATA_DIR.mkdir(exist_ok=True)

    graph, node_ids = load_graph()
    n, m = verify(graph)
    print(f"Loaded graph: n={n}, m={m}")

    print("Computing baseline stats...")
    baseline = baseline_stats(graph)
    print(f"  clustering (undirected projection) = {baseline['clustering']['value']:.4f}")
    print(f"  reciprocity = {baseline['reciprocity']['mutual_edge_fraction']:.4f}")
    print(f"  giant component = {baseline['components']['giant_component_size']}")
    print(f"  <k>={baseline['friendship_paradox']['mean_k']:.4f}  "
          f"<k^2>/<k>={baseline['friendship_paradox']['k2_over_k']:.4f}")

    print("Running ER null (300 draws)...")
    er = er_null(n, m, n_draws=300)
    print(f"  ER max in-degree across draws: min={er['max_in_degree']['min']} "
          f"max={er['max_in_degree']['max']} mean={er['max_in_degree']['mean']:.2f} "
          f"(real = {baseline['in_degree']['max']})")

    print("Running degree-preserving shuffle null (300 realizations x 3000 swaps)...")
    shuffle = shuffle_null(graph, n_realizations=300, swaps_per_realization=3000)
    print(f"  completed {shuffle['n_realizations_completed']} realizations")

    clustering_test = z_and_p(baseline["clustering"]["value"], shuffle["clustering_null"], tail="greater")
    reciprocity_test = z_and_p(baseline["reciprocity"]["mutual_edge_fraction"], shuffle["reciprocity_null"], tail="greater")
    giant_test = z_and_p(float(baseline["components"]["giant_component_size"]), [float(v) for v in shuffle["giant_component_null"]], tail="two-sided")

    print(f"  clustering: null mean={clustering_test['null_mean']:.4f} sd={clustering_test['null_stdev']:.4f} "
          f"z={clustering_test['z_score']:.2f} p={clustering_test['empirical_p']:.4f} (real={baseline['clustering']['value']:.4f})")
    print(f"  reciprocity: null mean={reciprocity_test['null_mean']:.4f} sd={reciprocity_test['null_stdev']:.4f} "
          f"z={reciprocity_test['z_score']:.2f} p={reciprocity_test['empirical_p']:.4f} (real={baseline['reciprocity']['mutual_edge_fraction']:.4f})")
    giant_z_str = f"{giant_test['z_score']:.2f}" if giant_test["z_score"] is not None else "undefined (zero variance)"
    print(f"  giant component: null mean={giant_test['null_mean']:.2f} sd={giant_test['null_stdev']:.2f} "
          f"z={giant_z_str} p={giant_test['empirical_p']:.4f} (real={baseline['components']['giant_component_size']})")

    print("Running directed preferential-attachment reference (m=2,3,6,9, 50 trials each)...")
    ba_by_m = {}
    for m_val in (2, 3, 6, 9):
        ba_by_m[str(m_val)] = ba_reference(n, m=m_val, n_trials=50)
        b = ba_by_m[str(m_val)]
        print(f"  BA(m={m_val}) max in-degree: min={b['max_in_degree']['min']} max={b['max_in_degree']['max']} "
              f"mean={b['max_in_degree']['mean']:.2f} (real max in-degree = {baseline['in_degree']['max']})")

    summary = {
        "seed": SEED,
        "baseline": baseline,
        "er_null": er,
        "shuffle_null": {
            "n_realizations_requested": shuffle["n_realizations_requested"],
            "n_realizations_completed": shuffle["n_realizations_completed"],
            "swaps_per_realization": shuffle["swaps_per_realization"],
            "clustering_test": clustering_test,
            "reciprocity_test": reciprocity_test,
            "giant_component_test": giant_test,
        },
        "ba_reference_by_m": ba_by_m,
    }

    out_path = WEEK2_DATA_DIR / "week2_summary.json"
    with open(out_path, "w", encoding="utf-8") as f:
        json.dump(summary, f, indent=2, ensure_ascii=False)
        f.write("\n")
    print(f"\nSummary JSON written to: {out_path}")


if __name__ == "__main__":
    main()
