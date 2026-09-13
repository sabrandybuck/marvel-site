"""Graph summary statistics for the crawled category network.

Pure Python (no networkx/pandas), producing the same schema as the frozen
week1_summary.json of the Marvel dataset.
"""

from __future__ import annotations

import math


def count_isolates(node_titles: list[str], edges: set[tuple[str, str]]) -> int:
    touched: set[str] = set()
    for source, target in edges:
        touched.add(source)
        touched.add(target)
    return sum(1 for n in node_titles if n not in touched)


def _weakly_connected_components(
    node_titles: list[str], edges: set[tuple[str, str]]
) -> list[list[str]]:
    adjacency: dict[str, set[str]] = {n: set() for n in node_titles}
    for source, target in edges:
        adjacency[source].add(target)
        adjacency[target].add(source)

    seen: set[str] = set()
    components: list[list[str]] = []
    for start in node_titles:
        if start in seen:
            continue
        component: list[str] = []
        queue = [start]
        seen.add(start)
        while queue:
            node = queue.pop()
            component.append(node)
            for neighbor in adjacency[node]:
                if neighbor not in seen:
                    seen.add(neighbor)
                    queue.append(neighbor)
        components.append(sorted(component))
    return components


def _pearson(x: list[float], y: list[float]) -> float:
    n = len(x)
    if n < 2:
        return 0.0
    mx = sum(x) / n
    my = sum(y) / n
    cov = sum((a - mx) * (b - my) for a, b in zip(x, y))
    vx = sum((a - mx) ** 2 for a in x)
    vy = sum((b - my) ** 2 for b in y)
    denom = math.sqrt(vx * vy)
    return cov / denom if denom else 0.0


def _min_max_mean(values: list[int]) -> dict:
    return {
        "min": min(values),
        "max": max(values),
        "mean": sum(values) / len(values),
    }


def _top5(
    node_titles: list[str],
    names: dict[str, str],
    degrees: dict[str, int],
    key: str,
) -> list[dict]:
    ranked = sorted(node_titles, key=lambda n: (-degrees[n], n))[:5]
    return [{"name": names[n], key: degrees[n]} for n in ranked]


def compute_summary(
    node_titles: list[str], names: dict[str, str], edges: set[tuple[str, str]]
) -> dict:
    in_degree = {n: 0 for n in node_titles}
    out_degree = {n: 0 for n in node_titles}
    for source, target in edges:
        out_degree[source] += 1
        in_degree[target] += 1

    components = _weakly_connected_components(node_titles, edges)
    sizes = sorted((len(c) for c in components), reverse=True)
    giant_size = sizes[0] if sizes else 0
    non_giant_sizes = sizes[1:]
    largest_non_giant = max(
        (c for c in components if len(c) < giant_size),
        key=len,
        default=[],
    )

    in_arr = [in_degree[n] for n in node_titles]
    out_arr = [out_degree[n] for n in node_titles]

    return {
        "node_count": len(node_titles),
        "directed_edge_count": len(edges),
        "isolate_count": count_isolates(node_titles, edges),
        "weakly_connected_components": {
            "count": len(components),
            "giant_component_size": giant_size,
            "non_giant_component_sizes": non_giant_sizes,
        },
        "degree": {
            "in_degree": _min_max_mean(in_arr),
            "out_degree": _min_max_mean(out_arr),
            "pearson_correlation_in_vs_out_degree": _pearson(
                [float(v) for v in in_arr], [float(v) for v in out_arr]
            ),
        },
        "top5_in_degree": _top5(node_titles, names, in_degree, "in_degree"),
        "top5_out_degree": _top5(node_titles, names, out_degree, "out_degree"),
        "largest_non_giant_component": {
            "size": len(largest_non_giant),
            "members": [names[n] for n in sorted(largest_non_giant)],
        },
    }
