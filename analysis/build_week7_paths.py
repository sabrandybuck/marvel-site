#!/usr/bin/env python3
"""Week 7 — compute shortest path lengths and divergence scores.

Reads data/week7/week7_supervillains.json (built by build_week7_test.py),
computes all-pairs shortest paths in the undirected hyperlink graph, and
adds per-pair path lengths + divergence scores for the explorable.

Divergence score = cosine / (path_length + 1)
  - high when semantically close (high cosine) but structurally far (long path)
  - disconnected pairs get path_length = -1 (treated as "infinite" distance)

Output: overwrites data/week7/week7_supervillains.json with the new fields:
  pairs: { "nodeA|nodeB": {"cos": float, "path": int, "divergence": float} }
  path_stats: summary statistics
  top_divergent: top 50 pairs by divergence score

Run:  python3 analysis/build_week7_paths.py
"""

import json
import sys
from collections import deque
from pathlib import Path

HERE = Path(__file__).resolve().parent
DATA = HERE.parent / "data"
IN_PATH = DATA / "week7" / "week7_supervillains.json"


def build_undirected_graph(edges):
    """Build adjacency list from directed edges (undirected for pathfinding)."""
    adj = {}
    for s, t in edges:
        adj.setdefault(s, set()).add(t)
        adj.setdefault(t, set()).add(s)
    return adj


def bfs_shortest_paths(adj, source):
    """BFS from source, returns dict of node -> distance (unreachable = -1)."""
    dist = {source: 0}
    queue = deque([source])
    while queue:
        u = queue.popleft()
        for v in adj.get(u, ()):
            if v not in dist:
                dist[v] = dist[u] + 1
                queue.append(v)
    return dist


def all_pairs_shortest_paths(adj, nodes):
    """Compute shortest paths from every node. Returns nested dict."""
    paths = {}
    for source in nodes:
        paths[source] = bfs_shortest_paths(adj, source)
    return paths


def get_path_length(paths, a, b):
    """Get shortest path length between a and b, or -1 if disconnected."""
    if a == b:
        return 0
    d = paths.get(a, {}).get(b, -1)
    return d


def main():
    print(f"loading {IN_PATH}")
    data = json.loads(IN_PATH.read_text(encoding="utf-8"))

    nodes = data["nodes"]
    edges = data["edges"]
    neighbors = data["neighbors"]

    node_ids = list(nodes.keys())
    print(f"  {len(node_ids)} nodes, {len(edges)} directed edges")

    # Build undirected graph
    adj = build_undirected_graph(edges)
    print(f"  undirected adjacency: {sum(len(v) for v in adj.values()) // 2} unique pairs")

    # Compute all-pairs shortest paths (only need it for pairs we care about,
    # but 370 nodes is small enough to do all)
    print("  computing all-pairs shortest paths...")
    paths = all_pairs_shortest_paths(adj, node_ids)

    # Build the pairs dictionary: for every pair that appears in the
    # semantic neighbors lists, record cosine + path length + divergence
    pairs = {}
    path_lengths = []  # for statistics

    for nid, nlist in neighbors.items():
        for item in nlist:
            other = item["o"]
            cos = item["c"]
            # canonical key: sorted tuple
            key = "|".join(sorted([nid, other]))
            if key in pairs:
                continue
            plen = get_path_length(paths, nid, other)
            path_lengths.append(plen)
            # divergence: high cosine, long path → high score
            # disconnected pairs (plen = -1) get treated as path = 99
            eff_path = plen if plen >= 0 else 99
            divergence = cos / (eff_path + 1)
            pairs[key] = {
                "a": nid,
                "b": other,
                "cos": round(cos, 4),
                "path": plen,
                "divergence": round(divergence, 4),
            }

    print(f"  {len(pairs)} unique semantic pairs with path data")

    # Also add path lengths for direct link pairs (for reference)
    link_pairs = 0
    for s, t in edges:
        key = "|".join(sorted([s, t]))
        if key not in pairs:
            plen = get_path_length(paths, s, t)
            # get cosine from neighbors if available
            cos = 0.0
            for item in neighbors.get(s, []):
                if item["o"] == t:
                    cos = item["c"]
                    break
            if cos == 0.0:
                for item in neighbors.get(t, []):
                    if item["o"] == s:
                        cos = item["c"]
                        break
            eff_path = plen if plen >= 0 else 99
            divergence = cos / (eff_path + 1) if cos > 0 else 0.0
            pairs[key] = {
                "a": s,
                "b": t,
                "cos": round(cos, 4),
                "path": plen,
                "divergence": round(divergence, 4),
                "linked": True,
            }
            link_pairs += 1

    print(f"  added {link_pairs} direct-link pairs")

    # Statistics
    connected = [p for p in path_lengths if p >= 0]
    disconnected = [p for p in path_lengths if p < 0]
    path_stats = {
        "semantic_pairs_total": len(path_lengths),
        "connected": len(connected),
        "disconnected": len(disconnected),
        "median_path_connected": sorted(connected)[len(connected) // 2] if connected else -1,
        "max_path_connected": max(connected) if connected else -1,
        "mean_path_connected": round(sum(connected) / len(connected), 2) if connected else -1,
    }
    print(f"  path stats: {path_stats}")

    # Top divergent pairs (semantically close, structurally far)
    # Filter: cosine >= 0.5 and path >= 3 (or disconnected)
    top_divergent = []
    for key, p in pairs.items():
        if p.get("linked"):
            continue  # skip direct links
        if p["cos"] >= 0.5 and (p["path"] >= 3 or p["path"] < 0):
            top_divergent.append(p)
    top_divergent.sort(key=lambda x: -x["divergence"])
    top_divergent = top_divergent[:50]

    print(f"  top divergent pairs (cos>=0.5, path>=3 or disconnected): {len(top_divergent)}")
    for p in top_divergent[:10]:
        path_str = str(p["path"]) if p["path"] >= 0 else "∞"
        print(f"    {p['a']} <-> {p['b']}  cos={p['cos']:.3f}  path={path_str}  div={p['divergence']:.3f}")

    # Also: top pairs by cosine among disconnected pairs
    disconnected_pairs = [p for p in pairs.values() if p["path"] < 0 and not p.get("linked")]
    disconnected_pairs.sort(key=lambda x: -x["cos"])
    print(f"\n  top semantically-close but DISCONNECTED pairs:")
    for p in disconnected_pairs[:10]:
        print(f"    {p['a']} <-> {p['b']}  cos={p['cos']:.3f}  (no path)")

    # Save
    data["pairs"] = pairs
    data["path_stats"] = path_stats
    data["top_divergent"] = top_divergent
    data["disconnected_close"] = disconnected_pairs[:25]

    # Add per-node divergence info: for each node, list its top divergent partners
    node_divergent = {nid: [] for nid in node_ids}
    for p in top_divergent:
        node_divergent[p["a"]].append(p)
        node_divergent[p["b"]].append(p)
    for nid in node_divergent:
        node_divergent[nid].sort(key=lambda x: -x["divergence"])
    data["node_divergent"] = node_divergent

    # Update meta
    data["meta"]["paths_computed"] = True
    data["meta"]["n_pairs"] = len(pairs)

    IN_PATH.write_text(json.dumps(data, indent=1), encoding="utf-8")
    print(f"\nwrote {IN_PATH}")
    print(f"  pairs: {len(pairs)}")
    print(f"  top_divergent: {len(top_divergent)}")
    print(f"  disconnected_close: {len(data['disconnected_close'])}")


if __name__ == "__main__":
    main()
