#!/usr/bin/env python3
"""Find maximal cliques in the Marvel network(s).

Loads one dataset's frozen TSVs (Week 1 heroes snapshot or the Week 2
supervillains crawl -- same files the site's clique explorers use), treats a
link in either direction as a connection, keeps the giant component, runs
NetworkX's Bron-Kerbosch and prints a summary.

Usage: python3 scripts/find_cliques.py [--dataset marvel|villains] [--min-size N]
"""

import argparse
import pathlib
from collections import Counter

import networkx as nx

HERE = pathlib.Path(__file__).resolve().parent
DATA_DIR = HERE.parent / "data"

DATASETS = {
    "marvel": {
        "label": "Marvel Comics superheroes (Week 1 snapshot)",
        "nodes": DATA_DIR / "week1" / "week1_nodes.tsv",
        "edges": DATA_DIR / "week1" / "week1_edges.tsv",
    },
    "villains": {
        "label": "Marvel Comics supervillains (Week 2 crawl)",
        "nodes": DATA_DIR / "Marvel_Comics_supervillains" / "Marvel_Comics_supervillains_nodes.tsv",
        "edges": DATA_DIR / "Marvel_Comics_supervillains" / "Marvel_Comics_supervillains_edges.tsv",
    },
}


def load_undirected_giant(nodes_path, edges_path):
    nodes_lines = tsv_lines(nodes_path)
    header = nodes_lines[0].split("\t")
    id_col = header.index("node_id")
    name_col = header.index("name")
    names = {}
    for line in nodes_lines[1:]:
        cols = line.split("\t")
        names[cols[id_col]] = cols[name_col]

    # skip any "source\ttarget" header row -- the supervillains edges file
    # carries one; the heroes edges file doesn't, so this is a no-op there
    edges = [
        tuple(line.split("\t"))
        for line in tsv_lines(edges_path)
        if line != "source\ttarget" and "\t" in line
    ]

    graph = nx.DiGraph()
    graph.add_nodes_from(names)
    graph.add_edges_from(edges)

    undirected = graph.to_undirected(reciprocal=False)
    giant_nodes = max(nx.connected_components(undirected), key=len)
    return undirected.subgraph(giant_nodes).copy(), names


def tsv_lines(path):
    # splitlines() handles both the heroes' LF and the supervillains crawl's
    # CRLF line endings
    return [line for line in path.read_text(encoding="utf-8").splitlines() if line and not line.startswith("#")]


def main():
    parser = argparse.ArgumentParser(description="Maximal cliques in a Marvel network")
    parser.add_argument("--dataset", choices=sorted(DATASETS), default="marvel", help="which network's frozen TSVs to run on")
    parser.add_argument("--min-size", type=int, default=4, help="only print cliques at least this large")
    args = parser.parse_args()

    dataset = DATASETS[args.dataset]
    giant, names = load_undirected_giant(dataset["nodes"], dataset["edges"])
    cliques = list(nx.find_cliques(giant))
    sizes = Counter(len(c) for c in cliques)

    print(f"Dataset: {dataset['label']}")
    print(f"Undirected giant component: {giant.number_of_nodes()} nodes")
    print(f"Total maximal cliques: {len(cliques)}")
    print(f"Clique number: {max(sizes)}")
    print("Size distribution:")
    for size in sorted(sizes):
        print(f"  {size}: {sizes[size]}")

    print(f"\nCliques of size >= {args.min_size}:")
    for clique in sorted((c for c in cliques if len(c) >= args.min_size), key=lambda c: (-len(c), sorted(names[n] for n in c))):
        members = sorted(names[n] for n in clique)
        print(f"  {len(members)}: {', '.join(members)}")


if __name__ == "__main__":
    main()
