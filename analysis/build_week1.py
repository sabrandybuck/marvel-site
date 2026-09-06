"""
Week 1 Marvel network analysis for the marvel-site Week 1 post.

Self-contained: reads only from ../data/week1/, writes only to
../assets/week1/. Does not import anything from the course notebooks.
Does not call the Wikipedia API — it uses the frozen Week 1 course
dataset.

Run from inside marvel-site/analysis/:
    python build_week1.py
"""

import json
import pathlib

import matplotlib.pyplot as plt
import networkx as nx
import numpy as np
import pandas as pd
from matplotlib.lines import Line2D

HERE = pathlib.Path(__file__).parent
DATA_DIR = HERE.parent / "data" / "week1"
ASSETS_DIR = HERE.parent / "assets" / "week1"

NODES_PATH = DATA_DIR / "week1_nodes.tsv"
EDGES_PATH = DATA_DIR / "week1_edges.tsv"

EXPECTED_NODES = 303
EXPECTED_EDGES = 1784
EXPECTED_ISOLATES = 17


def load_graph():
    # Real header row present (after 3 "#" comment lines) -> comment="#" handles it.
    nodes = pd.read_csv(NODES_PATH, sep="\t", comment="#")

    # No real header row here -- the "# source  target" line is itself a comment,
    # so the columns must be named explicitly rather than inferred.
    edges = pd.read_csv(EDGES_PATH, sep="\t", comment="#", header=None, names=["source", "target"])

    graph = nx.DiGraph()
    # Nodes must be added before edges, or the 17 isolates (present in the
    # node roster but absent from every edge) are silently dropped.
    graph.add_nodes_from(nodes["node_id"])
    graph.add_edges_from(edges.itertuples(index=False, name=None))
    return graph, nodes, edges


def verify(graph):
    n_nodes = graph.number_of_nodes()
    n_edges = graph.number_of_edges()
    isolates = list(nx.isolates(graph))

    assert n_nodes == EXPECTED_NODES, f"Expected {EXPECTED_NODES} nodes, got {n_nodes}"
    assert n_edges == EXPECTED_EDGES, f"Expected {EXPECTED_EDGES} edges, got {n_edges}"
    assert len(isolates) == EXPECTED_ISOLATES, f"Expected {EXPECTED_ISOLATES} isolates, got {len(isolates)}"

    return n_nodes, n_edges, isolates


def top5_in_degree(graph, nodes):
    name_by_id = dict(zip(nodes["node_id"], nodes["name"]))
    in_deg = dict(graph.in_degree())
    top5 = sorted(in_deg.items(), key=lambda kv: kv[1], reverse=True)[:5]
    return [(name_by_id.get(node_id, node_id), degree) for node_id, degree in top5]


# Same colors used for both the linear and log-log combined figures, so
# in-degree/out-degree are identifiable at a glance across either plot.
IN_DEGREE_COLOR = "#4C6EF5"    # blue -- same hue as the old solo in-degree chart
OUT_DEGREE_COLOR = "#F76707"   # orange -- same hue as the old solo out-degree chart


def plot_degree_distribution_linear(graph, out_path):
    in_k1 = np.array([d for _, d in graph.in_degree()]) + 1  # so isolates (k=0) are visible on a log axis later
    out_k1 = np.array([d for _, d in graph.out_degree()]) + 1

    fig, ax = plt.subplots(figsize=(9, 6))
    bins = np.linspace(1, max(in_k1.max(), out_k1.max()), 31)

    ax.hist(in_k1, bins=bins, histtype="step", linewidth=2.4, color=IN_DEGREE_COLOR, label="In-degree")
    ax.hist(out_k1, bins=bins, histtype="step", linewidth=2.4, color=OUT_DEGREE_COLOR, label="Out-degree")

    ax.set_xlabel("degree + 1", fontsize=12)
    ax.set_ylabel("number of characters", fontsize=12)
    ax.set_title("Week 1 Marvel character network: degree distribution (linear)", fontsize=13)
    ax.tick_params(labelsize=10)
    ax.legend(fontsize=12, frameon=True)

    fig.tight_layout()
    fig.savefig(out_path, dpi=200, bbox_inches="tight")
    plt.close(fig)


def plot_degree_distribution_loglog(graph, out_path):
    in_k1 = np.array([d for _, d in graph.in_degree()]) + 1
    out_k1 = np.array([d for _, d in graph.out_degree()]) + 1

    fig, ax = plt.subplots(figsize=(9, 6))
    bins = np.logspace(0, np.log10(max(in_k1.max(), out_k1.max())), 20)

    ax.hist(in_k1, bins=bins, histtype="step", linewidth=2.4, color=IN_DEGREE_COLOR, label="In-degree")
    ax.hist(out_k1, bins=bins, histtype="step", linewidth=2.4, color=OUT_DEGREE_COLOR, label="Out-degree")
    ax.set_xscale("log")
    ax.set_yscale("log")

    ax.set_xlabel("degree + 1 (log)", fontsize=12)
    ax.set_ylabel("number of characters (log)", fontsize=12)
    ax.set_title("Week 1 Marvel character network: degree distribution (log-log)", fontsize=13)
    ax.tick_params(labelsize=10)
    ax.legend(fontsize=12, frameon=True)

    fig.tight_layout()
    fig.savefig(out_path, dpi=200, bbox_inches="tight")
    plt.close(fig)


def in_out_degree_arrays(graph):
    node_list = list(graph.nodes())
    in_deg = dict(graph.in_degree())
    out_deg = dict(graph.out_degree())
    in_arr = np.array([in_deg[n] for n in node_list])
    out_arr = np.array([out_deg[n] for n in node_list])
    return in_arr, out_arr


def plot_in_vs_out_degree(in_arr, out_arr, out_path):
    fig, ax = plt.subplots(figsize=(6, 6))

    ax.scatter(out_arr, in_arr, alpha=0.6, color="#2F9E44", edgecolor="white", linewidth=0.4)
    ax.set_xlabel("out-degree")
    ax.set_ylabel("in-degree")
    ax.set_title("Week 1 Marvel character network:\nin-degree vs. out-degree (one point per character)")

    fig.tight_layout()
    fig.savefig(out_path, dpi=150)
    plt.close(fig)


def analyze_components(graph, nodes):
    name_by_id = dict(zip(nodes["node_id"], nodes["name"]))

    components = list(nx.weakly_connected_components(graph))
    components.sort(key=len, reverse=True)

    n_components = len(components)
    giant = components[0]
    giant_size = len(giant)

    non_giant = components[1:]
    non_giant_sizes = [len(c) for c in non_giant]
    n_outside_giant = sum(non_giant_sizes)
    n_singleton_isolates = sum(1 for size in non_giant_sizes if size == 1)

    multi_node_components = [
        [name_by_id.get(node_id, node_id) for node_id in sorted(component)]
        for component in non_giant
        if len(component) > 1
    ]

    return {
        "n_components": n_components,
        "giant_size": giant_size,
        "n_outside_giant": n_outside_giant,
        "non_giant_sizes": non_giant_sizes,
        "n_singleton_isolates": n_singleton_isolates,
        "multi_node_components": multi_node_components,
    }


def plot_network(graph, nodes, out_path):
    """
    Static layout of the full 303-node network. Isolates and the small
    non-giant island are laid out separately from the giant component
    and placed in their own regions, since a single spring_layout run
    would scatter isolates randomly on top of (or inside) the giant
    component and make them impossible to distinguish.
    """
    name_by_id = dict(zip(nodes["node_id"], nodes["name"]))
    in_deg = dict(graph.in_degree())

    components = sorted(nx.weakly_connected_components(graph), key=len, reverse=True)
    giant_nodes = components[0]
    rest = components[1:]
    isolate_nodes = set().union(*[c for c in rest if len(c) == 1]) if rest else set()
    island_components = [c for c in rest if len(c) > 1]

    pos = {}

    # giant component: force-directed layout, scaled up for spread
    giant_sub = graph.subgraph(giant_nodes)
    giant_pos_raw = nx.spring_layout(giant_sub, seed=42, k=0.35)
    scale = 6.0
    for node_id, (x, y) in giant_pos_raw.items():
        pos[node_id] = (x * scale, y * scale)

    xs = [p[0] for p in pos.values()]
    ys = [p[1] for p in pos.values()]
    x_min, x_max = min(xs), max(xs)
    y_min, y_max = min(ys), max(ys)

    # each non-giant multi-node island: its own compact layout, offset to the right
    island_x = x_max + 3.0
    for i, island in enumerate(island_components):
        island_sub = graph.subgraph(island)
        island_pos_raw = nx.spring_layout(island_sub, seed=100 + i, k=0.6)
        y_center = y_min + (i + 0.5) * (y_max - y_min) / max(len(island_components), 1)
        for node_id, (x, y) in island_pos_raw.items():
            pos[node_id] = (x * 1.3 + island_x, y * 1.3 + y_center)

    # isolates: fixed grid below the giant component, so all 17 stay visible and unoverlapped
    n_cols = 6
    spacing = 1.3
    grid_x0 = x_min
    grid_y0 = y_min - 2.5
    for i, node_id in enumerate(sorted(isolate_nodes)):
        col, row = i % n_cols, i // n_cols
        pos[node_id] = (grid_x0 + col * spacing, grid_y0 - row * spacing)

    def color_for(node_id):
        if node_id in isolate_nodes:
            return "#adb5bd"
        if node_id in giant_nodes:
            return "#4C6EF5"
        return "#F76707"  # any small multi-node island

    node_list = list(graph.nodes())
    node_colors = [color_for(n) for n in node_list]
    node_sizes = [20 + 3.0 * in_deg.get(n, 0) for n in node_list]

    fig, ax = plt.subplots(figsize=(13, 10))

    nx.draw_networkx_edges(
        graph, pos, ax=ax, arrows=True, arrowsize=5, arrowstyle="-|>",
        width=0.4, alpha=0.25, edge_color="#495057", connectionstyle="arc3,rad=0.02",
    )
    nx.draw_networkx_nodes(
        graph, pos, ax=ax, nodelist=node_list, node_color=node_colors,
        node_size=node_sizes, linewidths=0.3, edgecolors="white",
    )

    # label only the top-5 in-degree hubs, to keep 303 nodes' worth of text readable
    top5_ids = [nid for nid, _ in sorted(in_deg.items(), key=lambda kv: kv[1], reverse=True)[:5]]
    nx.draw_networkx_labels(
        graph, pos, labels={nid: name_by_id.get(nid, nid) for nid in top5_ids},
        ax=ax, font_size=9, font_weight="bold",
    )

    # label every member of the small island(s), since there are few enough to read
    island_labels = {nid: name_by_id.get(nid, nid) for island in island_components for nid in island}
    nx.draw_networkx_labels(graph, pos, labels=island_labels, ax=ax, font_size=7)

    if isolate_nodes:
        iso_xs = [pos[n][0] for n in isolate_nodes]
        iso_ys = [pos[n][1] for n in isolate_nodes]
        ax.text(
            sum(iso_xs) / len(iso_xs), min(iso_ys) - 0.9,
            f"{len(isolate_nodes)} isolated characters (no links in or out)",
            ha="center", va="top", fontsize=9, color="#495057",
        )

    for island in island_components:
        island_xs = [pos[n][0] for n in island]
        island_ys = [pos[n][1] for n in island]
        ax.text(
            sum(island_xs) / len(island_xs), max(island_ys) + 0.6,
            f"{len(island)}-node island (disconnected from the giant component)",
            ha="center", va="bottom", fontsize=9, color="#c2410c",
        )

    legend_handles = [
        Line2D([0], [0], marker="o", linestyle="", color="#4C6EF5", markersize=9,
               label=f"Giant component ({len(giant_nodes)} nodes)"),
        Line2D([0], [0], marker="o", linestyle="", color="#F76707", markersize=9,
               label="Small island component(s)"),
        Line2D([0], [0], marker="o", linestyle="", color="#adb5bd", markersize=7,
               label=f"Isolated characters ({len(isolate_nodes)} nodes)"),
    ]
    ax.legend(handles=legend_handles, loc="upper left", fontsize=9, frameon=True)

    ax.text(
        0.99, 0.01,
        "Node size ∝ in-degree (bigger = more characters link to them).\n"
        "Arrows show link direction; the 5 highest in-degree hubs are labeled.",
        transform=ax.transAxes, ha="right", va="bottom", fontsize=8, color="#495057",
    )

    ax.set_title("Week 1 Marvel character network (303 characters)", fontsize=14)
    ax.set_axis_off()
    fig.tight_layout()
    # higher dpi than the other Week 1 figures: this one is displayed much
    # larger on the page (full section width, not the narrow article column),
    # so it needs more source pixels to stay crisp instead of pixelating
    fig.savefig(out_path, dpi=220)
    plt.close(fig)


def build_summary(n_nodes, n_edges, isolates, components, in_arr, out_arr, correlation, top5):
    """Assemble the machine-readable Week 1 summary from already-computed
    values only -- nothing here is a fresh hard-coded number."""
    non_giant_multi = components["multi_node_components"]
    largest_non_giant = non_giant_multi[0] if non_giant_multi else []

    return {
        "node_count": n_nodes,
        "directed_edge_count": n_edges,
        "isolate_count": len(isolates),
        "weakly_connected_components": {
            "count": components["n_components"],
            "giant_component_size": components["giant_size"],
            "non_giant_component_sizes": components["non_giant_sizes"],
        },
        "degree": {
            "in_degree": {
                "min": int(in_arr.min()),
                "max": int(in_arr.max()),
                "mean": float(in_arr.mean()),
            },
            "out_degree": {
                "min": int(out_arr.min()),
                "max": int(out_arr.max()),
                "mean": float(out_arr.mean()),
            },
            "pearson_correlation_in_vs_out_degree": float(correlation),
        },
        "top5_in_degree": [{"name": name, "in_degree": int(degree)} for name, degree in top5],
        "largest_non_giant_component": {
            "size": len(largest_non_giant),
            "members": largest_non_giant,
        },
    }


def save_summary(summary, out_path):
    with open(out_path, "w", encoding="utf-8") as f:
        json.dump(summary, f, indent=2, ensure_ascii=False)
        f.write("\n")


def main():
    ASSETS_DIR.mkdir(exist_ok=True)

    graph, nodes, edges = load_graph()
    n_nodes, n_edges, isolates = verify(graph)
    top5 = top5_in_degree(graph, nodes)

    linear_fig_path = ASSETS_DIR / "week1_degree_distribution_linear.png"
    plot_degree_distribution_linear(graph, linear_fig_path)

    loglog_fig_path = ASSETS_DIR / "week1_degree_distribution_loglog.png"
    plot_degree_distribution_loglog(graph, loglog_fig_path)

    in_arr, out_arr = in_out_degree_arrays(graph)
    assert len(in_arr) == EXPECTED_NODES and len(out_arr) == EXPECTED_NODES

    scatter_fig_path = ASSETS_DIR / "week1_in_vs_out_degree.png"
    plot_in_vs_out_degree(in_arr, out_arr, scatter_fig_path)

    correlation = np.corrcoef(in_arr, out_arr)[0, 1]

    print(f"Nodes: {n_nodes}")
    print(f"Directed edges: {n_edges}")
    print(f"Isolates: {len(isolates)}")
    print("Top 5 by in-degree:")
    for name, degree in top5:
        print(f"  {name}: {degree}")
    print(f"Out-degree: min={out_arr.min()}, max={out_arr.max()}, mean={out_arr.mean():.4f}")
    print(f"In-degree:  min={in_arr.min()}, max={in_arr.max()}, mean={in_arr.mean():.4f}")
    print(f"Pearson correlation (in-degree vs out-degree), n={len(in_arr)}: {correlation:.4f}")
    print(f"Combined linear degree-distribution figure written to: {linear_fig_path}")
    print(f"Combined log-log degree-distribution figure written to: {loglog_fig_path}")
    print(f"In-vs-out scatter written to: {scatter_fig_path}")

    components = analyze_components(graph, nodes)
    assert components["giant_size"] + components["n_outside_giant"] == n_nodes

    print()
    print("--- Weakly connected component structure ---")
    print(f"Number of weakly connected components: {components['n_components']}")
    print(f"Size of the largest (giant) component: {components['giant_size']}")
    print(f"Nodes outside the giant component: {components['n_outside_giant']}")
    print(f"Sizes of non-giant components (largest to smallest): {components['non_giant_sizes']}")
    print(f"Of those, single-node isolate components: {components['n_singleton_isolates']}")
    print("Non-giant components with more than one node:")
    if components["multi_node_components"]:
        for i, members in enumerate(components["multi_node_components"], start=1):
            print(f"  Component {i} (size {len(members)}): {', '.join(members)}")
    else:
        print("  (none)")

    network_fig_path = ASSETS_DIR / "week1_network.png"
    plot_network(graph, nodes, network_fig_path)
    print(f"Network visualization written to: {network_fig_path}")

    summary = build_summary(n_nodes, n_edges, isolates, components, in_arr, out_arr, correlation, top5)
    summary_path = DATA_DIR / "week1_summary.json"
    save_summary(summary, summary_path)
    print(f"Summary JSON written to: {summary_path}")


if __name__ == "__main__":
    main()
