"""
Week 2 reference numbers for any marvel-site dataset (pass dataset keys).

Stdlib-only analogue of build_week2.py (which needs networkx; this
environment doesn't have it). Same algorithms, same defaults:

  - baseline stats on the real graph (undirected-projected clustering,
    reciprocity, friendship paradox incl. local degree champions)
  - Erdos-Renyi null, 300 draws
  - degree-preserving directed shuffle, 300 realizations x 3000 swaps
  - directed preferential-attachment (Price model) reference, 50 trials
    per m around the network's mean out-degree

Reads data/<dir>/<prefix>_nodes.tsv and <prefix>_edges.tsv, writes
data/<dir>/<key>_week2_summary.json in the same JSON shape build_week2.py
produces (the subset posts/week2.js reads).

Usage (from inside marvel-site/analysis/):
    python build_week2_reference.py <key> [<key> ...]
Keys: silmarillion, asoiaf, middle-earth, ds9, street-fighter
"""

import json
import pathlib
import random
import statistics
import sys

HERE = pathlib.Path(__file__).parent
DATA = HERE.parent / "data"

DATASETS = {
    "silmarillion": {
        "dir": "Silmarillion_characters",
        "prefix": "The_Silmarillion_characters",
        "out": "silmarillion_week2_summary.json",
    },
    "asoiaf": {
        "dir": "A_Song_of_Ice_and_Fire_characters",
        "prefix": "A_Song_of_Ice_and_Fire_characters",
        "out": "asoiaf_week2_summary.json",
    },
    "middle-earth": {
        "dir": "List_of_Middle-earth_characters",
        "prefix": "List_of_Middle-earth_characters",
        "out": "middle_earth_week2_summary.json",
    },
    "ds9": {
        "dir": "Star_Trek:_Deep_Space_Nine_characters",
        "prefix": "Star_Trek:_Deep_Space_Nine_characters",
        "out": "ds9_week2_summary.json",
    },
    "street-fighter": {
        "dir": "Street_Fighter_characters",
        "prefix": "Street_Fighter_characters",
        "out": "street_fighter_week2_summary.json",
    },
}

SEED = 20260909


# ---------------------------------------------------------------------------
# Graph made of adjacency-indexed nodes; completely plain data structures.
# ---------------------------------------------------------------------------

class Graph:
    def __init__(self, node_ids, edge_rows):
        self.ids = list(node_ids)
        self.index = {node_id: i for i, node_id in enumerate(self.ids)}
        self.n = len(self.ids)
        self.out = [set() for _ in range(self.n)]
        self.m = len(edge_rows)
        for src, dst in edge_rows:
            self.out[self.index[src]].add(self.index[dst])

    @classmethod
    def from_graph(cls, other):
        g = cls.__new__(cls)
        g.ids, g.index, g.n, g.m = other.ids, other.index, other.n, other.m
        g.out = [set(s) for s in other.out]
        return g

    def copy(self):
        return Graph.from_graph(self)

    def in_degree(self):
        degs = [0] * self.n
        for s in self.out:
            for t in s:
                degs[t] += 1
        return degs

    def undirected(self):
        adj = [set() for _ in range(self.n)]
        for i, s in enumerate(self.out):
            for j in s:
                if j != i:
                    adj[i].add(j)
                    adj[j].add(i)
        return adj

    def reciprocity(self):
        mutual = sum(1 for i, s in enumerate(self.out) for j in s if i in self.out[j])
        return mutual / self.m

    def clustering(self):
        """Average local clustering on the undirected projection; degree<2 -> 0."""
        adj = self.undirected()
        total = 0.0
        for i in range(self.n):
            deg = len(adj[i])
            if deg < 2:
                continue
            neighbors = list(adj[i])
            links = 0
            for a_idx in range(len(neighbors)):
                a = neighbors[a_idx]
                for b in neighbors[a_idx + 1:]:
                    if b in adj[a]:
                        links += 1
            total += (2 * links) / (deg * (deg - 1))
        return total / self.n

    def weakly_connected_components(self):
        adj = self.undirected()
        seen = [False] * self.n
        sizes = []
        for start in range(self.n):
            if seen[start]:
                continue
            stack, size = [start], 0
            seen[start] = True
            while stack:
                node = stack.pop()
                size += 1
                for nb in adj[node]:
                    if not seen[nb]:
                        seen[nb] = True
                        stack.append(nb)
            sizes.append(size)
        return sorted(sizes, reverse=True)


def load_graph(key):
    """nodes file: #-comments, then a `node_id name ...` header row; edges
    file: #-comments, then a `source target` header row."""
    spec = DATASETS[key]
    nodes_path = DATA / spec["dir"] / (spec["prefix"] + "_nodes.tsv")
    edges_path = DATA / spec["dir"] / (spec["prefix"] + "_edges.tsv")

    with open(nodes_path, encoding="utf-8") as f:
        lines = [line.rstrip("\n") for line in f if not line.startswith("#") and line.strip()]
    header = lines[0].split("\t")
    id_col = header.index("node_id")
    node_ids = [line.split("\t")[id_col] for line in lines[1:]]

    with open(edges_path, encoding="utf-8") as f:
        edge_lines = [line.rstrip("\n") for line in f if not line.startswith("#") and line.strip()]
    edge_header = edge_lines[0].split("\t")
    src_col = edge_header.index("source")
    dst_col = edge_header.index("target")
    edge_rows = [
        (line.split("\t")[src_col], line.split("\t")[dst_col])
        for line in edge_lines[1:]
    ]
    return node_ids, edge_rows


# ---------------------------------------------------------------------------
# Section 1: baseline stats (mirrors build_week2.py's fields)
# ---------------------------------------------------------------------------

def baseline_stats(graph):
    n, m = graph.n, graph.m
    in_degs = graph.in_degree()
    out_degs = [len(s) for s in graph.out]
    und_adj = graph.undirected()
    und_degs = [len(a) for a in und_adj]

    knn_by_node = {}
    for i in range(n):
        if not und_adj[i]:
            continue
        knn_by_node[i] = sum(und_degs[nb] for nb in und_adj[i]) / len(und_adj[i])

    mean_k = sum(und_degs) / n
    mean_k2 = sum(d * d for d in und_degs) / n
    n_isolated = sum(1 for d in und_degs if d == 0)
    n_with_neighbors = n - n_isolated
    n_holds = sum(1 for i, knn in knn_by_node.items() if knn > und_degs[i])
    n_fails = sum(1 for i, knn in knn_by_node.items() if knn < und_degs[i])
    champion_indices = [
        i
        for i in range(n)
        if und_degs[i] > 0
        and all(und_degs[i] >= und_degs[nb] for nb in und_adj[i])
    ]
    return {
        "n": n,
        "m_directed": m,
        "in_degree": {"min": min(in_degs), "max": max(in_degs), "mean": sum(in_degs) / n},
        "out_degree": {"min": min(out_degs), "max": max(out_degs), "mean": sum(out_degs) / n},
        "undirected_projection": {
            "edge_count": sum(und_degs) // 2,
            "degree_min": min(und_degs),
            "degree_max": max(und_degs),
            "degree_mean": mean_k,
        },
        "clustering": {
            "definition": "average local clustering coefficient on the undirected projection "
                          "(edge if source->target OR target->source), all nodes counted, "
                          "nodes with degree < 2 contribute 0",
            "value": graph.clustering(),
        },
        "reciprocity": {
            "definition": "mutual directed edges / total directed edges",
            "mutual_edge_fraction": graph.reciprocity(),
        },
        "components": {
            "weakly_connected_count": len(graph.weakly_connected_components()),
            "giant_component_size": graph.weakly_connected_components()[0],
        },
        "friendship_paradox": {
            "definition": "undirected projection; degree = distinct neighbor count; "
                          "avg_neighbor_degree = mean degree of a node's own neighbors",
            "mean_k": mean_k,
            "k2_over_k": mean_k2 / mean_k,
            "n_with_neighbors": n_with_neighbors,
            "n_isolated": n_isolated,
            "n_paradox_holds": n_holds,
            "n_paradox_fails": n_fails,
            "n_paradox_tied": n_with_neighbors - n_holds - n_fails,
            "local_degree_champions": [graph.ids[i] for i in champion_indices],
        },
    }


# ---------------------------------------------------------------------------
# Section 2: Erdos-Renyi null. Directed g(n, m), no self-loops, no repeats.
# ---------------------------------------------------------------------------

def er_null(n, m, n_draws=300):
    max_in = []
    for _ in range(n_draws):
        all_edges = [(s, t) for s in range(n) for t in range(n) if s != t]
        chosen = random.sample(all_edges, m)
        degs = [0] * n
        for s, t in chosen:
            degs[t] += 1
        max_in.append(max(degs))
    return {
        "n_draws": n_draws,
        "n": n,
        "m": m,
        "max_in_degree": {
            "min": min(max_in),
            "max": max(max_in),
            "mean": statistics.mean(max_in),
            "stdev": statistics.pstdev(max_in),
        },
    }


# ---------------------------------------------------------------------------
# Section 3: degree-preserving directed shuffle, same chain-swap semantics
# as nx.directed_edge_swap / the in-browser implementation.
# ---------------------------------------------------------------------------

def directed_shuffle(graph, swaps, rng, max_tries_factor=20):
    out = [set(s) for s in graph.out]
    # nodes with at least one out-edge: sampling pool for chain starts (a->b)
    tails = [i for i in range(graph.n) if out[i]]

    def try_one():
        """Sample a random chain a->b->c->d edge by edge from adjacency (not
        from all node quadruples) -- far higher acceptance rate on a dense
        graph, same swap semantics: preserves every node's directed in/out
        degree exactly."""
        a = rng.choice(tails)
        b = rng.choice(sorted(out[a]))
        if not out[b]:
            return None
        c = rng.choice(sorted(out[b]))
        if not out[c]:
            return None
        d = rng.choice(sorted(out[c]))
        if len({a, b, c, d}) < 4:
            return None
        # New edges are a->c, c->b, b->d; each must not already exist.
        if c in out[a] or b in out[c] or d in out[b]:
            return None
        return a, b, c, d

    done = 0
    tries = 0
    max_tries = swaps * max_tries_factor
    while done < swaps and tries < max_tries:
        tries += 1
        tetrad = try_one()
        if tetrad is None:
            continue
        a, b, c, d = tetrad
        out[a].discard(b)
        out[b].discard(c)
        out[c].discard(d)
        out[a].add(c)
        out[c].add(b)
        out[b].add(d)
        done += 1

    g = graph.copy()
    g.out = out
    return g


def shuffle_null(graph, n_realizations=300, swaps_per_realization=3000):
    clustering_samples = []
    reciprocity_samples = []
    giant_samples = []
    for _ in range(n_realizations):
        g = directed_shuffle(graph, swaps_per_realization, random)
        clustering_samples.append(g.clustering())
        reciprocity_samples.append(g.reciprocity())
        giant_samples.append(max(g.weakly_connected_components()))
    return {
        "n_realizations_requested": n_realizations,
        "n_realizations_completed": len(clustering_samples),
        "swaps_per_realization": swaps_per_realization,
        "clustering_null": clustering_samples,
        "reciprocity_null": reciprocity_samples,
        "giant_component_null": giant_samples,
    }


def z_and_p(real_value, null_samples, tail="greater"):
    mean = statistics.mean(null_samples)
    stdev = statistics.pstdev(null_samples)
    z = (real_value - mean) / stdev if stdev > 0 else None
    n = len(null_samples)
    if tail == "greater":
        p = sum(1 for v in null_samples if v >= real_value) / n
    elif tail == "less":
        p = sum(1 for v in null_samples if v <= real_value) / n
    else:
        p = sum(1 for v in null_samples if abs(v - mean) >= abs(real_value - mean)) / n
    return {"null_mean": mean, "null_stdev": stdev, "z_score": z, "empirical_p": p}


# ---------------------------------------------------------------------------
# Section 4: directed preferential attachment (Price model), same growth
# as build_week2.py: cycle seed of m+1 nodes, each newcomer adds m
# out-edges weighted by (in-degree + 1).
# ---------------------------------------------------------------------------

def price_growth(n, m, rng):
    out = [set() for _ in range(n)]
    in_deg = [0] * n
    seed_size = min(m + 1, n)
    for i in range(seed_size):
        out[i].add((i + 1) % seed_size)
        in_deg[(i + 1) % seed_size] += 1

    for new in range(seed_size, n):
        pool = [(i, in_deg[i] + 1) for i in range(new)]
        total = sum(w for _, w in pool)
        chosen = set()
        while len(chosen) < m:
            r = rng.uniform(0, total)
            upto = 0
            for node, w in pool:
                upto += w
                if upto >= r:
                    chosen.add(node)
                    break
            if len(chosen) < m:
                pool = [(i, w) for i, w in pool if i not in chosen]
                if not pool:
                    break
                total = sum(w for _, w in pool)
        for t in chosen:
            out[new].add(t)
            in_deg[t] += 1
    return out


def price_reference(n, m, n_trials=50):
    max_in = []
    for _ in range(n_trials):
        out = price_growth(n, m, random)
        in_degs = [0] * n
        for s in out:
            for t in s:
                in_degs[t] += 1
        max_in.append(max(in_degs))
    return {
        "n": n,
        "m": m,
        "n_trials": n_trials,
        "max_in_degree": {
            "min": min(max_in),
            "max": max(max_in),
            "mean": statistics.mean(max_in),
        },
    }


def run(key):
    node_ids, edge_rows = load_graph(key)
    graph = Graph(node_ids, edge_rows)
    print(f"[{key}] loaded n={graph.n}, m={graph.m}")

    baseline = baseline_stats(graph)
    fp = baseline["friendship_paradox"]
    print(f"  clustering = {baseline['clustering']['value']:.4f}  "
          f"reciprocity = {baseline['reciprocity']['mutual_edge_fraction']:.4f}")
    print(f"  components = {baseline['components']['weakly_connected_count']} "
          f"(giant {baseline['components']['giant_component_size']}), isolates {fp['n_isolated']}")
    print(f"  <k>={fp['mean_k']:.3f}  <k^2>/<k>={fp['k2_over_k']:.3f}  "
          f"paradox {fp['n_paradox_holds']}/{fp['n_with_neighbors']}")
    print(f"  in-degree max = {baseline['in_degree']['max']} "
          f"(mean {baseline['in_degree']['mean']:.2f}), out-degree max {baseline['out_degree']['max']}")
    print(f"  champions: {fp['local_degree_champions']}")

    er = er_null(graph.n, graph.m, n_draws=300)
    erd = er["max_in_degree"]
    print(f"  ER max in-degree: min={erd['min']} max={erd['max']} mean={erd['mean']:.2f} sd={erd['stdev']:.2f}")

    shuffle = shuffle_null(graph, 300, 3000)
    clustering_test = z_and_p(baseline["clustering"]["value"], shuffle["clustering_null"], "greater")
    reciprocity_test = z_and_p(baseline["reciprocity"]["mutual_edge_fraction"], shuffle["reciprocity_null"], "greater")
    giant = baseline["components"]["giant_component_size"]
    giant_test = z_and_p(float(giant), [float(v) for v in shuffle["giant_component_null"]], "two-sided")
    print(f"  clustering null = {clustering_test['null_mean']:.4f} (sd {clustering_test['null_stdev']:.4f}), "
          f"z={clustering_test['z_score']:.2f}, p={clustering_test['empirical_p']:.4f}")
    print(f"  reciprocity null = {reciprocity_test['null_mean']:.4f} (sd {reciprocity_test['null_stdev']:.4f}), "
          f"z={reciprocity_test['z_score']:.2f}, p={reciprocity_test['empirical_p']:.4f}")
    print(f"  giant null = {giant_test['null_mean']:.2f}, p={giant_test['empirical_p']:.4f}")

    # Price trials bracket the network's mean out-degree (the m that
    # roughly matches its density scale) plus one step on each side.
    mean_out = baseline["out_degree"]["mean"]
    m_center = max(1, int(round(mean_out)))
    m_values = sorted({m_center - 1, m_center, m_center + 1})
    price_by_m = {}
    for m_val in m_values:
        ref = price_reference(graph.n, m=m_val, n_trials=50)
        price_by_m[str(m_val)] = ref
        print(f"  Price(m={m_val}) max in-degree: {ref['max_in_degree']['min']}–"
              f"{ref['max_in_degree']['max']} mean {ref['max_in_degree']['mean']:.2f}")

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
        "price_reference_by_m": price_by_m,
    }
    out_path = DATA / DATASETS[key]["dir"] / DATASETS[key]["out"]
    with open(out_path, "w", encoding="utf-8") as f:
        json.dump(summary, f, indent=2, ensure_ascii=False)
        f.write("\n")
    print(f"  wrote {out_path}")


def main():
    random.seed(SEED)
    keys = sys.argv[1:] or list(DATASETS)
    for key in keys:
        assert key in DATASETS, f"unknown dataset key: {key}"
        random.seed(SEED)  # same fixed seed per dataset for reproducibility
        run(key)


if __name__ == "__main__":
    main()
