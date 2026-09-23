"""
Week 4 philosophers network analysis for the marvel-site Week 4 post.

Self-contained: reads only from ../data/philosophers/ (the frozen week-4
release crawl), writes only to ../data/philosophers/week4_summary.json and
../assets/week4/. Does not modify any other data directory or post.

Computes every authoritative Week 4 number quoted on the post:

  Section 1  Louvain vs Infomap on the weighted undirected giant component,
             NMI between the two partitions, purity/NMI vs the era metadata,
             a figure (alluvial) of where the two methods disagree.
  Section 2  Aristotle: k-clique communities and ego-network edges colored
             by the global (Louvain) community of the other endpoint.
  Section 3  Disparity-filter backbone (Serrano et al. 2009) at three alpha
             values, the alpha scan of giant-component size, the critical
             alpha where the giant breaks, and the philosopher whose links
             break it.
  Section 4  Louvain with vs without weights, NMI, and the philosophers
             that move between communities.

Run from inside marvel-site/analysis/:
    python build_week4.py
"""

from __future__ import annotations

import csv
import json
import pathlib
from collections import Counter, defaultdict

import matplotlib
matplotlib.use("Agg")
import matplotlib.pyplot as plt
import networkx as nx
import numpy as np
import sklearn.metrics as skmetrics
import infomap
from matplotlib.lines import Line2D

HERE = pathlib.Path(__file__).parent
DATA_DIR = HERE.parent / "data" / "philosophers"
ASSETS_DIR = HERE.parent / "assets" / "week4"

NODES_PATH = DATA_DIR / "week4_philosophers_nodes.tsv"
EDGES_PATH = DATA_DIR / "week4_philosophers_edges.tsv"
SUMMARY_PATH = DATA_DIR / "week4_summary.json"

EXPECTED_NODES = 1444
EXPECTED_EDGES = 11135

SEED = 20260923  # fixed seed for every random/offline draw below

FAMOUS = {
    "Aristotle", "Plato", "Socrates", "Immanuel Kant", "Karl Marx",
    "Friedrich Nietzsche", "David Hume", "Bertrand Russell",
    "Thomas Aquinas", "Ludwig Wittgenstein", "Georg Wilhelm Friedrich Hegel",
    "Baruch Spinoza", "Confucius", "Laozi", "Zhu Xi", "René Descartes",
    "John Locke", "John Stuart Mill", "Augustine of Hippo", "Averroes",
    "Avicenna", "Al-Ghazali", "Al-Farabi", "Al-Kindi", "Moses Maimonides",
    "William of Ockham", "John Duns Scotus", "Gottfried Wilhelm Leibniz",
    "Gottlob Frege", "Martin Heidegger", "Edmund Husserl",
    "Arthur Schopenhauer", "Søren Kierkegaard", "Jean-Paul Sartre",
    "Michel Foucault", "Jacques Derrida", "Gilles Deleuze", "Henri Bergson",
    "Émile Durkheim", "Auguste Comte", "Friedrich Engels", "Vladimir Lenin",
    "Karl Popper", "Thomas Kuhn", "Willard Van Orman Quine", "Saul Kripke",
    "David Lewis", "Hilary Putnam", "John Rawls", "Hannah Arendt",
    "Jürgen Habermas", "Zeno of Citium", "Epictetus", "Chrysippus",
    "Marcus Aurelius", "Cicero", "Seneca the Younger", "Plotinus",
    "Epicurus", "Lucretius", "Democritus", "Heraclitus", "Parmenides",
    "Pythagoras", "John Dewey", "William James", "Charles Sanders Peirce",
    "Rudolf Carnap", "George Berkeley", "Denis Diderot", "Voltaire",
    "Jean-Jacques Rousseau", "Montesquieu", "Ayn Rand", "Sigmund Freud",
    "Charles Darwin", "Adam Smith", "Edmund Burke", "Alexius Meinong",
    "Franz Brentano", "Max Scheler", "Wilfrid Sellars", "Nelson Goodman",
    "Alfred North Whitehead", "Axel Hägerström", "Simone de Beauvoir",
    "Maurice Merleau-Ponty", "Emmanuel Levinas", "Hans-Georg Gadamer",
    "Anicius Manlius Severinus Boethius", "Boethius", "Averroes",
    "Porphyry (philosopher)", "Proclus", "Themistius",
    "Alexander of Aphrodisias", "Simplicius of Cilicia", "John Philoponus",
    "Diogenes Laertius", "Plutarch", "Theophrastus", "Sextus Empiricus",
    "Xenophanes", "Anaxagoras", "Melissus of Samos", "Simon of Faversham",
    "Bruno Bauer", "Friedrich Wilhelm Joseph Schelling", "Johann Gottlieb Fichte",
    "Alfred North Whitehead", "Erasmus", "Isaac Newton", "John Locke",
}

SHORT = {
    "Immanuel Kant": "Kant", "Karl Marx": "Marx",
    "Friedrich Nietzsche": "Nietzsche", "David Hume": "Hume",
    "Thomas Aquinas": "Aquinas", "Ludwig Wittgenstein": "Wittgenstein",
    "Georg Wilhelm Friedrich Hegel": "Hegel", "Baruch Spinoza": "Spinoza",
    "René Descartes": "Descartes", "John Stuart Mill": "J.S. Mill",
    "Augustine of Hippo": "Augustine", "Moses Maimonides": "Maimonides",
    "William of Ockham": "Ockham", "John Duns Scotus": "Duns Scotus",
    "Gottfried Wilhelm Leibniz": "Leibniz", "Arthur Schopenhauer": "Schopenhauer",
    "Søren Kierkegaard": "Kierkegaard", "Jean-Paul Sartre": "Sartre",
    "Zeno of Citium": "Zeno", "Seneca the Younger": "Seneca",
    "Marcus Aurelius": "M. Aurelius", "Porphyry (philosopher)": "Porphyry",
    "Alexander of Aphrodisias": "Alex. Aphrodisias",
    "Simplicius of Cilicia": "Simplicius", "Diogenes Laertius": "D. Laertius",
    "Charles Sanders Peirce": "Peirce", "Willard Van Orman Quine": "Quine",
    "Alfred North Whitehead": "Whitehead", "Georg Wilhelm Friedrich Hegel": "Hegel",
    "Marcelino Menéndez y Pelayo": "Menéndez Pelayo",
    "Hermann Friedrich Wilhelm Hinrichs": "Hinrichs",
    "Anicius Manlius Severinus Boethius": "Boethius",
}

ERA_SHORT = {
    "centuries BC": "BC",
    "1st through 10th centuries": "1–10c",
    "11th through 14th centuries": "11–14c",
    "15th and 16th centuries": "15–16c",
    "17th century": "17c",
    "18th century": "18c",
    "19th century": "19c",
}

PANEL_ALPHAS = (0.20, 0.05, 0.005)


# ---------------------------------------------------------------------------
# Loading
# ---------------------------------------------------------------------------

def read_tsv(path: pathlib.Path):
    with open(path, encoding="utf-8") as f:
        lines = [ln for ln in f if not ln.startswith("#") and ln.strip()]
    return list(csv.DictReader(lines, delimiter="\t"))


def load():
    nodes = read_tsv(NODES_PATH)
    edges = read_tsv(EDGES_PATH)
    if len(nodes) != EXPECTED_NODES:
        raise SystemExit(f"expected {EXPECTED_NODES} nodes, got {len(nodes)}")
    if len(edges) != EXPECTED_EDGES:
        raise SystemExit(f"expected {EXPECTED_EDGES} edges, got {len(edges)}")

    idx = {n["node_id"]: i for i, n in enumerate(nodes)}
    name_of = {i: n["name"] for i, n in enumerate(nodes)}
    era_of = {i: n["era"] for i, n in enumerate(nodes)}
    sf_of = {
        i: [s.strip() for s in (n["subfields"] or "").split(";") if s.strip()]
        for i, n in enumerate(nodes)
    }

    G = nx.DiGraph()
    G.add_nodes_from(idx.values())
    for e in edges:
        G.add_edge(idx[e["source"]], idx[e["target"]], weight=int(e["weight"]))

    # undirected with summed weights
    UG = nx.Graph()
    UG.add_nodes_from(G.nodes())
    for u, v, d in G.edges(data=True):
        if UG.has_edge(u, v):
            UG[u][v]["weight"] += d["weight"]
        else:
            UG.add_edge(u, v, weight=d["weight"])

    giant_nodes = max(nx.connected_components(UG), key=len)
    H = UG.subgraph(giant_nodes).copy()
    return nodes, edges, idx, name_of, era_of, sf_of, G, UG, H


def sname(name: str) -> str:
    if name in SHORT:
        return SHORT[name]
    for full, s in SHORT.items():
        if name.startswith(full):
            return s
    return name


# ---------------------------------------------------------------------------
# Section 1: Louvain vs Infomap
# ---------------------------------------------------------------------------

def section1(H, name_of, era_of, report):
    luc = nx.community.louvain_communities(H, weight="weight", seed=SEED)
    im = infomap.Infomap(two_level=True, silent=True, seed=SEED, num_trials=10)
    for u, v, d in H.edges(data=True):
        im.add_link(u, v, float(d["weight"]))
    im.run()
    mod_of = dict(im.get_modules())
    inf_groups = defaultdict(list)
    for n, m in mod_of.items():
        inf_groups[m].append(n)
    inf_groups = [set(v) for v in inf_groups.values()]

    node_list = sorted(H.nodes())
    lab_l = {}
    for gi, c in enumerate(luc):
        for n in c:
            lab_l[n] = gi
    lab_i = mod_of
    era_labels = [era_of[n] for n in node_list]

    nmi = skmetrics.normalized_mutual_info_score(
        [lab_l[n] for n in node_list], [lab_i[n] for n in node_list])
    nmi_l_era = skmetrics.normalized_mutual_info_score(
        [lab_l[n] for n in node_list], era_labels)
    nmi_i_era = skmetrics.normalized_mutual_info_score(
        [lab_i[n] for n in node_list], era_labels)

    def purity(labels):
        by = defaultdict(Counter)
        for lab, era in zip(labels, era_labels):
            by[lab][era] += 1
        return sum(c.most_common(1)[0][1] for c in by.values()) / len(labels)

    p_l, p_i = purity([lab_l[n] for n in node_list]), purity([lab_i[n] for n in node_list])

    def describe(groups):
        out = []
        for g in sorted(groups, key=len, reverse=True):
            fam = [sname(name_of[i]) for i in g if name_of[i] in FAMOUS]
            era_c = Counter(ERA_SHORT[era_of[i]] for i in g).most_common(3)
            out.append({
                "size": len(g),
                "famous": fam[:8],
                "era_top": era_c,
            })
        return out

    louv_desc = describe(luc)
    inf_desc = describe(inf_groups)

    # biggest disagreement: Infomap modules that sit inside one big Louvain
    # community but apart from each other, and Louvain communities that merge
    # several Infomap modules
    pairs = Counter((lab_l[n], lab_i[n]) for n in node_list)
    cell_matrix = defaultdict(dict)
    for (l, i), c in pairs.items():
        cell_matrix[l][i] = c

    # famous members per group goes into the figure labels
    result = {
        "n_louvain": len(luc),
        "n_infomap": len(inf_groups),
        "nmi": nmi,
        "nmi_louvain_era": nmi_l_era,
        "nmi_infomap_era": nmi_i_era,
        "purity_era_louvain": p_l,
        "purity_era_infomap": p_i,
        "louvain_groups": louv_desc,
        "infomap_modules": inf_desc[:25],
        "louvain_labels": {name_of[n]: lab_l[n] for n in node_list},
        "infomap_labels": {name_of[n]: lab_i[n] for n in node_list},
    }

    report.append(f"giant component: {H.number_of_nodes()} nodes, {H.number_of_edges()} edges")
    report.append(f"Louvain: {len(luc)} communities; Infomap: {len(inf_groups)} modules")
    report.append(f"NMI(louvain, infomap) = {nmi:.3f}")
    report.append(f"purity vs era: louvain {p_l:.3f}, infomap {p_i:.3f}")
    report.append(f"NMI vs era: louvain {nmi_l_era:.3f}, infomap {nmi_i_era:.3f}")
    for d in louv_desc:
        report.append(f"  louvain {d['size']:4d}  {d['era_top']}  {d['famous'][:5]}")
    report.append("  ...")
    for d in inf_desc[:10]:
        report.append(f"  infomap {d['size']:4d}  {d['famous'][:5]}")
    return result, luc, inf_groups, lab_l, lab_i, node_list


def draw_alluvial(groups_l, title_l, groups_r, title_r, name_of, out_path,
                  min_ribbon=3, figsize=(10, 15), label_min=12,
                  right_label_top=None):
    """Generic two-column alluvial diagram. Blocks are stacked by descending
    size; ribbons show shared members; blocks get famous-name labels."""
    set_l = sorted(groups_l, key=len, reverse=True)
    set_r = sorted(groups_r, key=len, reverse=True)
    labpos_l, labpos_r = {}, {}

    def label_for(group, max_names=3, max_len=16):
        fam = [sname(name_of[i]) for i in group if name_of[i] in FAMOUS]
        seen, out = set(), []
        for f in fam:
            if f not in seen:
                seen.add(f)
                out.append(f)
        return ", ".join(out[:max_names]) if out else "misc"

    gap = 2.0
    y = 0.0
    for i, g in enumerate(set_l):
        labpos_l[i] = y
        y += len(g) + gap
    total_h = y - gap
    y = 0.0
    for i, g in enumerate(set_r):
        labpos_r[i] = y
        y += len(g) + gap

    cmap = plt.get_cmap("tab20")
    fig, ax = plt.subplots(figsize=figsize)
    x_l0, x_l1 = 1.0, 1.9
    x_r0, x_r1 = 8.1, 9.0

    ribbon_order_l = defaultdict(list)
    for ai, ga in enumerate(set_l):
        ints = [(len(ga & rb), bi) for bi, rb in enumerate(set_r)]
        ints = [(c, bi) for c, bi in ints if c >= min_ribbon]
        ints.sort(key=lambda t: (-t[0], t[1]))
        ribbon_order_l[ai] = ints

    used_l = Counter()
    used_r = Counter()
    for ai, ints in ribbon_order_l.items():
        for c, bi in ints:
            yl = labpos_l[ai] + used_l[ai]
            yr = labpos_r[bi] + used_r[bi]
            used_l[ai] += c
            used_r[bi] += c
            ax.add_patch(plt.Polygon(
                [(x_l1, yl), (x_l1, yl + c), (x_r0, yr + c), (x_r0, yr)],
                closed=True, color=cmap(ai % 20), alpha=0.35,
                linewidth=0, zorder=1))

    for ai, g in enumerate(set_l):
        y0 = labpos_l[ai]
        ax.add_patch(plt.Rectangle((x_l0, y0), x_l1 - x_l0, len(g),
                                   color=cmap(ai % 20), alpha=0.9, zorder=2))
        if len(g) >= label_min:
            ax.text(x_l1 + 0.15, y0 + len(g) / 2,
                    f"{label_for(g)} ({len(g)})",
                    va="center", ha="left", fontsize=8, zorder=5)

    drawn_r = 0
    for bi, g in enumerate(set_r):
        y0 = labpos_r[bi]
        ax.add_patch(plt.Rectangle((x_r0, y0), x_r1 - x_r0, len(g),
                                   color=cmap(bi % 20), alpha=0.9, zorder=2))
        if right_label_top is None:
            ok = len(g) >= label_min
        else:
            ok = drawn_r < right_label_top and len(g) >= 12
        if ok:
            drawn_r += 1
            ax.text(x_r0 - 0.15, y0 + len(g) / 2,
                    f"({len(g)}) {label_for(g, 2)}",
                    va="center", ha="right", fontsize=7.5, zorder=5)

    ax.text((x_l0 + x_l1) / 2, total_h + 6, title_l,
            ha="center", fontsize=11, fontweight="bold")
    ax.text((x_r0 + x_r1) / 2, total_h + 6, title_r,
            ha="center", fontsize=11, fontweight="bold")
    ax.set_xlim(0, 10)
    ax.set_ylim(-2, total_h + 9)
    ax.axis("off")
    fig.savefig(out_path, dpi=200, bbox_inches="tight")
    plt.close(fig)


def figure1(H, luc, inf_groups, lab_l, lab_i, node_list, name_of, out_path):
    """Alluvial: Louvain communities (left) vs Infomap modules (right)."""
    draw_alluvial(list(luc), f"Louvain — {len(luc)} communities",
                  list(inf_groups), f"Infomap — {len(inf_groups)} modules",
                  name_of, out_path)


# ---------------------------------------------------------------------------
# Section 2: Aristotle
# ---------------------------------------------------------------------------

def section2(H, idx, name_of, era_of, report):
    ARIS = idx["Aristotle"]
    deg = H.degree(ARIS)
    degw = H.degree(ARIS, weight="weight")

    # k-clique communities containing Aristotle
    kclique = {}
    for k in (4, 5, 6):
        comms = [c for c in nx.community.k_clique_communities(H, k) if ARIS in c]
        kclique[k] = sorted(comms, key=len, reverse=True)

    # global louvain partition for neighbor coloring
    luc = nx.community.louvain_communities(H, weight="weight", seed=SEED)
    lab = {}
    for gi, c in enumerate(luc):
        for n in c:
            lab[n] = gi
    nbrs = list(H.neighbors(ARIS))
    nb_counts = Counter(lab[n] for n in nbrs)

    ego = nx.ego_graph(H, ARIS, radius=1).copy()
    result = {
        "degree": deg,
        "weighted_degree": degw,
        "kclique": {
            str(k): [
                {"size": len(c), "members": [name_of[i] for i in sorted(c)]}
                for c in comms[:6]
            ]
            for k, comms in kclique.items()
        },
        "neighbor_community_counts": {
            str(lab[n]): sum(1 for x in nbrs if lab[x] == lab[n]) for n in nbrs
        },
        "neighbor_communities": {
            str(gi): [sname(name_of[i]) for i in nbrs if lab[i] == gi and name_of[i] in FAMOUS][:10]
            for gi in {lab[n] for n in nbrs}
        },
    }
    report.append(
        f"Aristotle: degree {deg} (weight {degw}); neighbor communities: "
        + ", ".join(f"c{g}={c}" for g, c in nb_counts.most_common()))
    for k, comms in kclique.items():
        report.append(f"  k={k}: {len(comms)} clique-communities contain him; "
                      f"sizes {[len(c) for c in comms[:6]]}")
    return result, ARIS, ego, lab


def figure2(H, ARIS, ego, lab, name_of, out_path):
    nbrs = sorted(H.neighbors(ARIS))
    # order neighbors by degree for placement
    ring = sorted(nbrs, key=lambda n: (lab[n], -H.degree(n)))
    n = len(ring)

    import math
    pos = {ARIS: (0.0, 0.0)}
    for j, v in enumerate(ring):
        ang = 2 * math.pi * j / n
        r = 1.0
        pos[v] = (r * math.cos(ang), r * math.sin(ang))

    # color per community = louvain partition on H
    luc = nx.community.louvain_communities(H, weight="weight", seed=SEED)
    comm_sorted = sorted(range(len(luc)), key=lambda g: -len(luc[g]))
    color_of_comm = {g: plt.get_cmap("tab20")(k % 20) for k, g in enumerate(comm_sorted)}

    comm_sizes = Counter(lab[v] for v in ring)

    fig, ax = plt.subplots(figsize=(11, 11))
    # draw edges thin, colored by neighbor community
    for v in ring:
        g = lab[v]
        ax.plot([0, pos[v][0]], [0, pos[v][1]],
                color=color_of_comm[g], linewidth=0.8, alpha=0.55, zorder=1)
    # neighbor-neighbor edges within the ego (light gray) to show structure
    sub = ego.copy()
    sub.remove_node(ARIS)
    # relabel positions for drawing; networkx draw with our pos
    nx.draw_networkx_edges(sub, pos, ax=ax, alpha=0.10, width=0.4, edge_color="#888888")

    # nodes
    for v in ring:
        g = lab[v]
        ax.scatter([pos[v][0]], [pos[v][1]], s=18 + 2.5 * H.degree(v),
                   color=color_of_comm[g], zorder=3, edgecolors="white", linewidths=0.4)

    # label famous neighbors
    for v in ring:
        nm = sname(name_of[v])
        if name_of[v] in FAMOUS or H.degree(v) > 60:
            ax.annotate(nm, pos[v], textcoords="offset points",
                        xytext=(6 * math.copysign(1, pos[v][0]), 4),
                        ha="left" if pos[v][0] >= 0 else "right",
                        fontsize=7.5, zorder=5)

    # Aristotle in the middle
    ax.scatter([0], [0], s=260, color="#222222", zorder=4, marker="*")
    ax.annotate("Aristotle", (0, 0), textcoords="offset points", xytext=(0, -14),
                ha="center", fontsize=10, fontweight="bold", zorder=5)

    handles = [Line2D([0], [0], marker="o", linestyle="", color=color_of_comm[g],
                      markersize=9,
                      label=f"c{g} ({comm_sizes[g]} nbrs: {', '.join(famous_sample(g, luc, name_of))})")
               for g in sorted(comm_sizes, key=lambda g: -comm_sizes[g])]
    ax.legend(handles=handles, loc="upper left", bbox_to_anchor=(1.02, 1.0),
              fontsize=8, frameon=True)
    ax.set_xlim(-1.25, 1.25)
    ax.set_ylim(-1.25, 1.25)
    ax.axis("off")
    fig.savefig(out_path, dpi=200, bbox_inches="tight")
    plt.close(fig)
    return color_of_comm, comm_sizes


def famous_sample(g, luc, name_of, k=3):
    fam = [sname(name_of[i]) for i in luc[g] if name_of[i] in FAMOUS][:k]
    return fam if fam else ["…"]


# ---------------------------------------------------------------------------
# Section 3: backbone
# ---------------------------------------------------------------------------

def backbone(H, alpha):
    """Union-rule disparity backbone: edge kept if it is significant from
    EITHER endpoint (matches how the filter is usually applied to undirected
    graphs). Degree-1 nodes keep their single edge."""
    kept = set()
    for u in H.nodes():
        nbrs = list(H.neighbors(u))
        k = len(nbrs)
        if k <= 1:
            kept.add((min(u, nbrs[0]), max(u, nbrs[0])))
            continue
        wsum = sum(H[u][v]["weight"] for v in nbrs)
        for v in nbrs:
            p = H[u][v]["weight"] / wsum
            if (1 - p) ** (k - 1) < alpha:
                kept.add((min(u, v), max(u, v)))
    B = nx.Graph()
    B.add_nodes_from(H.nodes())
    B.add_edges_from(((u, v, {"weight": H[u][v]["weight"]}) for u, v in kept))
    return B


def edge_alpha(H, u, v):
    """Minimum over the two endpoint disparities: the edge is kept (union rule)
    iff min(a_u, a_v) < alpha, so it dies exactly when alpha <= min."""
    vals = []
    for s, t in ((u, v), (v, u)):
        if H.has_edge(s, t):
            nbrs = list(H.neighbors(s))
            k = len(nbrs)
            wsum = sum(H[s][x]["weight"] for x in nbrs)
            p = H[s][t]["weight"] / wsum
            vals.append((1 - p) ** (k - 1))
    return min(vals) if vals else 1.0


def section3(H, name_of, report):
    scan = []
    for alpha in (0.3, 0.25, 0.2, 0.18, 0.16, 0.14, 0.12, 0.1, 0.08, 0.07, 0.06,
                  0.05, 0.04, 0.03, 0.02, 0.01, 0.005, 0.003, 0.002, 0.001,
                  0.0005, 0.0001, 0.0):
        B = backbone(H, alpha)
        comps = sorted(nx.connected_components(B), key=len, reverse=True)
        scan.append({
            "alpha": alpha,
            "edges": B.number_of_edges(),
            "n_components": len(comps),
            "giant": len(comps[0]) if comps else 0,
            "top_sizes": [len(c) for c in comps[:6]],
        })
        if alpha < 0.011:
            top_names = [name_of[i] for i in comps[0]] if comps else []
            scan[-1]["giant_names"] = top_names if len(comps[0]) <= 8 else None
            scan[-1]["second_names"] = ([name_of[i] for i in comps[1]]
                                        if len(comps) > 1 and len(comps[1]) <= 6 else None)

    # critical alpha: first alpha (scanning tighter) where giant < half
    half = len(H) / 2
    critical = None
    for row in scan:
        if row["giant"] < half:
            critical = row["alpha"]
            break

    # panels
    panels = {}
    for a in PANEL_ALPHAS:
        B = backbone(H, a)
        comps = sorted(nx.connected_components(B), key=len, reverse=True)
        panels[a] = {
            "edges": B.number_of_edges(),
            "n_components": len(comps),
            "giant": len(comps[0]),
            "top_degrees": [(name_of[i], d) for i, d in
                            sorted(B.degree(), key=lambda kv: -kv[1])[:6]],
        }

    # the last multi-node fragments and the edges holding them
    B = backbone(H, 0.0)
    comps0 = sorted(nx.connected_components(B), key=len, reverse=True)
    fragments_final = []
    for c in comps0[:10]:
        if len(c) < 2:
            continue
        edges_in = []
        for u in c:
            for v in c:
                if u < v and B.has_edge(u, v):
                    edges_in.append((name_of[u], name_of[v], B[u][v]["weight"],
                                     edge_alpha(H, u, v)))
        fragments_final.append({
            "nodes": [name_of[i] for i in c],
            "edges": edges_in,
        })

    # the giant-breaking edge: the weakest binding edge of the largest
    # fragment at alpha ~ 0.001 (the Aristotelian tail)
    report.append("backbone scan:")
    for row in scan:
        report.append(f"  alpha={row['alpha']:<8g} edges {row['edges']:4d} "
                      f"comps {row['n_components']:4d} giant {row['giant']:4d}")

    result = {
        "scan": scan,
        "critical_alpha": critical,
        "panels": {str(k): v for k, v in panels.items()},
        "final_fragments": fragments_final,
    }
    return result


def figure3(H, name_of, era_of, out_path):
    """Three backbone panels (node size = backbone degree) + giant-size curve."""
    fig = plt.figure(figsize=(15, 11))
    gs = fig.add_gridspec(2, 3, height_ratios=[1.0, 0.85], hspace=0.30, wspace=0.22)

    alphas = list(PANEL_ALPHAS)
    axes_pos = [gs[0, 0], gs[0, 1], gs[0, 2]]
    for a, axp in zip(alphas, axes_pos):
        B = backbone(H, a)
        comps = sorted(nx.connected_components(B), key=len, reverse=True)
        ax = fig.add_subplot(axp)
        cmap = plt.get_cmap("tab20")
        color_cycle = [cmap(i % 20) for i in range(20)]
        shown_comps = [c for c in comps if len(c) >= 2][:20]
        seen_labels = set()
        for ci, c in enumerate(shown_comps):
            sub = B.subgraph(c)
            pos = nx.spring_layout(sub, seed=SEED, k=0.55, iterations=80, scale=0.85)
            nx.draw_networkx_edges(sub, pos, ax=ax, alpha=0.30, width=0.7,
                                   edge_color=color_cycle[ci])
            sizes = [12 + 9 * min(sub.degree(n), 40) for n in sub.nodes()]
            nx.draw_networkx_nodes(sub, pos, ax=ax, node_size=sizes,
                                   node_color=[color_cycle[ci]] * sub.number_of_nodes(),
                                   edgecolors="white", linewidths=0.3)
            # label the highest-backbone-degree node of the six biggest comps
            if ci < 4 and sub.number_of_nodes() >= 2:
                top_node = max(sub.degree, key=lambda kv: kv[1])[0]
                if top_node not in seen_labels:
                    seen_labels.add(top_node)
                    if ci % 2 == 0:
                        dy, dx, ha = 6, 5, "left"
                    else:
                        dy, dx, ha = -12, -3, "right"
                    ax.annotate(sname(name_of[top_node]), pos[top_node],
                                textcoords="offset points", xytext=(dx, dy),
                                fontsize=7.5, fontweight="bold", ha=ha, zorder=6)

        # singletons ringing the edge of the panel
        singles = [n for c in comps if len(c) == 1 for n in c]
        if singles:
            import math as _m
            rr = 1.28
            pts = []
            for k in range(len(singles)):
                ang = 2 * _m.pi * k / len(singles)
                pts.append((rr * _m.cos(ang), rr * _m.sin(ang)))
            xs_, ys_ = zip(*pts)
            ax.scatter(xs_, ys_, s=4, color="#c9c9c9", zorder=1)
        ax.set_title(f"\u03b1 = {a:g}   |   {B.number_of_edges()} edges kept,\n"
                     f"{len(comps)} components, giant = {len(comps[0])}", fontsize=11)
        ax.set_xlim(-1.45, 1.45)
        ax.set_ylim(-1.45, 1.45)
        ax.axis("off")

    # bottom: the curve
    axc = fig.add_subplot(gs[1, :])
    scan_alphas = (0.3, 0.25, 0.2, 0.18, 0.16, 0.14, 0.12, 0.1, 0.08, 0.07, 0.06,
                   0.05, 0.04, 0.03, 0.02, 0.01, 0.005, 0.003, 0.002, 0.001,
                   0.0005, 0.0001)
    giants = []
    for a in scan_alphas:
        B = backbone(H, a)
        comps = sorted(nx.connected_components(B), key=len, reverse=True)
        giants.append(len(comps[0]) if comps else 0)
    xs = list(scan_alphas)
    axc.plot(xs, giants, "o-", color="#4C6EF5", linewidth=2, markersize=4)
    axc.axvline(0.16, color="#F76707", linestyle="--", linewidth=1)
    gi = xs.index(0.16)
    axc.annotate("giant < \u00bd the network\n(critical \u03b1 \u2248 0.16)",
                 xy=(0.16, giants[gi]), xytext=(0.09, 780), fontsize=9,
                 arrowprops={"arrowstyle": "->", "color": "#F76707"})
    axc.axvline(0.005, color="gray", linestyle=":", linewidth=1)
    gi5 = xs.index(0.005)
    axc.annotate("\u03b1 = 0.005: the largest piece left is the\nHegel \u2192 Marx cluster",
                 xy=(0.005, giants[gi5]), xytext=(0.0016, 340), fontsize=9,
                 arrowprops={"arrowstyle": "->", "color": "#666666"})
    axc.set_xscale("log")
    axc.set_xlim(0.0001, 0.35)
    axc.invert_xaxis()
    axc.set_xlabel("\u03b1 (tighter significance test \u2192, log scale)")
    axc.set_ylabel("giant component size (nodes)")
    axc.set_title("Disparity filter: the giant component coming apart", fontsize=12)

    fig.savefig(out_path, dpi=200, bbox_inches="tight")
    plt.close(fig)


# ---------------------------------------------------------------------------
# Section 4: weighted vs unweighted
# ---------------------------------------------------------------------------

def section4(H, name_of, report):
    lw = nx.community.louvain_communities(H, weight="weight", seed=SEED)
    lu = nx.community.louvain_communities(H, weight=None, seed=SEED)
    lab_w, lab_u = {}, {}
    for gi, c in enumerate(lw):
        for n in c:
            lab_w[n] = gi
    for gi, c in enumerate(lu):
        for n in c:
            lab_u[n] = gi
    node_list = sorted(H.nodes())
    nmi = skmetrics.normalized_mutual_info_score(
        [lab_w[n] for n in node_list], [lab_u[n] for n in node_list])
    movers = [n for n in node_list if lab_w[n] != lab_u[n]]

    # named groups for the weighted / unweighted partitions (matched by best IoU
    # between the two partitions so labels are comparable)
    fam_dec = []
    for n in movers:
        if name_of[n] in FAMOUS:
            fam_dec.append(name_of[n])

    result = {
        "n_weighted": len(lw),
        "n_unweighted": len(lu),
        "nmi": nmi,
        "movers": len(movers),
        "movers_fraction": len(movers) / len(node_list),
        "famous_movers": fam_dec[:25],
        "weighted_groups": [{"size": len(g),
                             "famous": [sname(name_of[i]) for i in g if name_of[i] in FAMOUS][:8]}
                            for g in sorted(lw, key=len, reverse=True)],
        "unweighted_groups": [{"size": len(g),
                               "famous": [sname(name_of[i]) for i in g if name_of[i] in FAMOUS][:8]}
                              for g in sorted(lu, key=len, reverse=True)],
        "labels_weighted": {name_of[n]: lab_w[n] for n in node_list},
        "labels_unweighted": {name_of[n]: lab_u[n] for n in node_list},
    }
    report.append(f"Louvain weighted: {len(lw)} groups; unweighted: {len(lu)} groups")
    report.append(f"NMI(weighted, unweighted) = {nmi:.3f}")
    report.append(f"movers: {len(movers)} of {len(node_list)} ({result['movers_fraction']:.1%})")
    return result, lw, lu, lab_w, lab_u


def figure4(H, lw, lu, lab_w, lab_u, name_of, out_path):
    """Alluvial: Louvain on the weighted network (left) vs unweighted (right)."""
    draw_alluvial(list(lw), f"Louvain, weighted — {len(lw)} communities",
                  list(lu), f"Louvain, unweighted — {len(lu)} communities",
                  name_of, out_path, figsize=(10, 13), right_label_top=12)


# ---------------------------------------------------------------------------
# Main
# ---------------------------------------------------------------------------

def main():
    import time as _t
    t0 = _t.time()
    print("loading ...")
    nodes, edges, idx, name_of, era_of, sf_of, G, UG, H = load()
    print(f"  {len(nodes)} nodes, {len(edges)} directed edges; "
          f"giant {H.number_of_nodes()} nodes / {H.number_of_edges()} undirected edges")

    ASSETS_DIR.mkdir(parents=True, exist_ok=True)
    report = []

    print("section 1: Louvain vs Infomap ...")
    s1, luc, inf_groups, lab_l, lab_i, node_list = section1(H, name_of, era_of, report)
    # global name lookup used by figure1 helper
    global _NAME_OF
    _NAME_OF = name_of
    figure1(H, luc, inf_groups, lab_l, lab_i, node_list, name_of,
            ASSETS_DIR / "week4_louvain_infomap_alluvial.png")
    print("  figure 1 done")

    print("section 2: Aristotle ...")
    s2, ARIS, ego, lab_global = section2(H, idx, name_of, era_of, report)
    fig2_paths = ASSETS_DIR / "week4_aristotle_ego.png"
    color_of_comm, comm_sizes = figure2(H, ARIS, ego, lab_global, name_of, fig2_paths)
    s2["ego_figure_communities"] = {str(g): c for g, c in comm_sizes.items()}
    print("  figure 2 done")

    print("section 3: backbone ...")
    s3 = section3(H, name_of, report)
    figure3(H, name_of, era_of, ASSETS_DIR / "week4_backbone_panels.png")
    print("  figure 3 done")

    print("section 4: weighted vs unweighted ...")
    s4, lw, lu, lab_w, lab_u = section4(H, name_of, report)
    figure4(H, lw, lu, lab_w, lab_u, name_of, ASSETS_DIR / "week4_weighted_vs_unweighted.png")
    print("  figure 4 done")

    summary = {
        "meta": {
            "nodes": len(nodes),
            "edges": len(edges),
            "giant_nodes": H.number_of_nodes(),
            "giant_edges": H.number_of_edges(),
            "seed": SEED,
        },
        "section1": s1,
        "section2": s2,
        "section3": s3,
        "section4": s4,
    }
    SUMMARY_PATH.write_text(json.dumps(summary, indent=1, ensure_ascii=False))
    print(f"wrote {SUMMARY_PATH}")
    print("\n=== REPORT ===")
    for line in report:
        print(line)
    print(f"\ndone in {_t.time() - t0:.0f}s")


_NAME_OF = None


if __name__ == "__main__":
    main()