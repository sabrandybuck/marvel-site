"""
Week 2 Marvel network analysis: is the in-degree distribution more random
(ER / Poisson), more Barabási–Albert (scale-free), or neither?

Makes the case with a CCDF and a fit:

  1. Empirical CCDF P(K >= k) of in-degree, overlaid with
     - the ER null: exact Poisson CCDF at lambda = <k> = edges / nodes, and
     - the BA null: an ensemble of Barabási–Albert graphs (N = 303, m = 3),
       averaged over seeds with a 5-95% spread band.
  2. A discrete power-law fit to the tail (Clauset, Shalizi & Newman 2009
     MLE via the `powerlaw` package), with likelihood-ratio tests against
     exponential and lognormal alternatives (Vuong test).

Uses the same frozen Week 1 snapshot in ../data/week1/ — Week 2 is about
null models, not new data. Self-contained: reads only from ../data/week1/,
writes figures to ../assets/week2/ and the fit summary to ../data/week2/.
Does not call the Wikipedia API.

Run from inside marvel-site/analysis/:
    python build_week2.py

Requires networkx, numpy, scipy, pandas, matplotlib, and powerlaw.
"""

import json
import pathlib

import matplotlib.pyplot as plt
import networkx as nx
import numpy as np
import pandas as pd
from powerlaw import Fit
from scipy import stats
from scipy.special import zeta

HERE = pathlib.Path(__file__).parent
DATA_DIR = HERE.parent / "data" / "week1"
ASSETS_DIR = HERE.parent / "assets" / "week2"
SUMMARY_DIR = HERE.parent / "data" / "week2"

NODES_PATH = DATA_DIR / "week1_nodes.tsv"
EDGES_PATH = DATA_DIR / "week1_edges.tsv"

EXPECTED_NODES = 303
EXPECTED_EDGES = 1784
EXPECTED_ISOLATES = 17

BA_N = 303
BA_SEEDS = 200
# m = 3 gives BA mean degree 2m - 2m^2/N ~= 5.94, matching the real <k> = 5.89
BA_M = 3

# House colors from build_week1.py
REAL_COLOR = "#4C6EF5"   # blue -- the real network
BA_COLOR = "#F76707"     # orange -- the BA ensemble
ER_COLOR = "#495057"     # gray -- the ER / Poisson null
FIT_COLOR = "#E6353A"    # Marvel red -- the fitted tail


def load_graph():
    # Same loading recipe as build_week1.py: nodes before edges, or the 17
    # isolates silently vanish.
    nodes = pd.read_csv(NODES_PATH, sep="\t", comment="#")
    edges = pd.read_csv(EDGES_PATH, sep="\t", comment="#", header=None, names=["source", "target"])

    graph = nx.DiGraph()
    graph.add_nodes_from(nodes["node_id"])
    graph.add_edges_from(edges.itertuples(index=False, name=None))
    return graph


def verify(graph):
    n_nodes = graph.number_of_nodes()
    n_edges = graph.number_of_edges()
    isolates = list(nx.isolates(graph))

    assert n_nodes == EXPECTED_NODES, f"Expected {EXPECTED_NODES} nodes, got {n_nodes}"
    assert n_edges == EXPECTED_EDGES, f"Expected {EXPECTED_EDGES} edges, got {n_edges}"
    assert len(isolates) == EXPECTED_ISOLATES, f"Expected {EXPECTED_ISOLATES} isolates, got {len(isolates)}"
    return n_nodes, n_edges, len(isolates)


def empirical_ccdf(degrees, k_grid):
    """P(K >= k) for each k in k_grid, computed over ALL nodes (so the 17
    isolates stay in the denominator and push P(K >= 1) below 1)."""
    degrees = np.asarray(degrees)
    return np.array([(degrees >= k).mean() for k in k_grid])


def poisson_ccdf(k_grid, lam):
    """Exact ER null: in-degree ~ Poisson(lambda) under G(N, p) with the same
    N and edge count. sf(k - 1) = P(K >= k)."""
    return stats.poisson.sf(np.asarray(k_grid) - 1, lam)


def ba_ensemble(k_grid, n_seeds=BA_SEEDS):
    """Degree CCDFs of n_seeds Barabási–Albert graphs on the common k grid,
    plus the ensemble's k_max spread. CCDFs are computed over all N nodes of
    each graph, matching the real network's convention."""
    ccdfs = np.empty((n_seeds, len(k_grid)))
    kmaxes = np.empty(n_seeds)
    mean_degrees = np.empty(n_seeds)
    for i in range(n_seeds):
        g = nx.barabasi_albert_graph(BA_N, BA_M, seed=1000 + i)
        deg = np.array([d for _, d in g.degree()])
        kmaxes[i] = deg.max()
        mean_degrees[i] = deg.mean()
        ccdfs[i] = empirical_ccdf(deg, k_grid)

    mean_ccdf = ccdfs.mean(axis=0)
    lo_ccdf = np.percentile(ccdfs, 5, axis=0)
    hi_ccdf = np.percentile(ccdfs, 95, axis=0)
    return {
        "mean_ccdf": mean_ccdf,
        "lo_ccdf": lo_ccdf,
        "hi_ccdf": hi_ccdf,
        "kmax_mean": float(kmaxes.mean()),
        "kmax_min": int(kmaxes.min()),
        "kmax_max": int(kmaxes.max()),
        "mean_degree": float(mean_degrees.mean()),
    }


def fit_power_law(in_degrees):
    """
    Discrete power-law MLE (Clauset-Shalizi-Newman 2009) via the powerlaw
    package. The fit is run on the positive degrees only: the 17 isolates
    (k = 0) cannot belong to a tail anchored at k >= xmin >= 1, and feeding
    zeros into the discrete zeta likelihood is undefined. The xmin search is
    unaffected — every candidate xmin >= 1 excludes them anyway.
    """
    positive = np.asarray(in_degrees)[np.asarray(in_degrees) > 0]
    fit = Fit(positive, discrete=True, verbose=0)

    alpha = float(fit.alpha)
    alpha_sigma = float(fit.sigma)
    xmin = float(fit.xmin)
    ks_distance = float(fit.D)
    n_tail = int((positive >= xmin).sum())

    tests = {}
    for alternative in ("exponential", "lognormal", "truncated_power_law"):
        R, p = fit.distribution_compare("power_law", alternative)
        if p < 0.05:
            favored = "power_law" if R > 0 else alternative
        else:
            favored = "indistinguishable"
        tests[f"power_law_vs_{alternative}"] = {"R": float(R), "p": float(p), "favored": favored}

    # fit.exponential.Lambda is the discrete MLE rate: P(K = k) ~ exp(-Lambda * k)
    exp_lambda = float(fit.exponential.Lambda)

    return {
        "estimator": "Clauset-Shalizi-Newman (2009) discrete MLE, powerlaw package",
        "xmin": xmin,
        "n_positive": len(positive),
        "n_tail": n_tail,
        "tail_fraction_of_positive": n_tail / len(positive),
        "alpha": alpha,
        "alpha_sigma": alpha_sigma,
        "ks_distance_D": ks_distance,
        "likelihood_ratio_tests": tests,
        "exponential_lambda": exp_lambda,
        "_fit": fit,
    }


def power_law_ccdf(k, alpha, xmin):
    """Exact CCDF of the fitted discrete power law (zeta distribution):
    P(K >= k) = zeta(alpha, k) / zeta(alpha, xmin) for k >= xmin."""
    return zeta(alpha, np.asarray(k, dtype=float)) / zeta(alpha, xmin)


def discrete_exponential_ccdf(k, lam, xmin):
    """Exact CCDF of the fitted discrete exponential:
    P(K >= k) = exp(-Lambda * (k - xmin)) for k >= xmin."""
    return np.exp(-lam * (np.asarray(k, dtype=float) - xmin))


def plot_ccdf_models(k_grid, real_ccdf, pois_ccdf, ba, out_path, lam):
    fig, ax = plt.subplots(figsize=(9, 6))

    ax.fill_between(k_grid, ba["lo_ccdf"], ba["hi_ccdf"], color=BA_COLOR, alpha=0.18, linewidth=0)
    ax.step(k_grid, ba["mean_ccdf"], where="post", color=BA_COLOR, linewidth=2.0,
            label=f"BA ensemble (N={BA_N}, m={BA_M}, {BA_SEEDS} seeds)")
    ax.step(k_grid, pois_ccdf, where="post", color=ER_COLOR, linewidth=2.0,
            label=f"ER null: Poisson(λ = {lam:.2f})")
    ax.step(k_grid, real_ccdf, where="post", color=REAL_COLOR, linewidth=2.6,
            label="Real network (in-degree)")

    k_max = int(k_grid[-1])
    # Pin the y-range to the human-readable region: the Poisson null leaves
    # the bottom of the chart around k ≈ 25 while the real curve keeps going
    # to k = 106 — that exit IS the argument, so show it instead of the
    # 10^-95 plunge that flattens everything else.
    ax.plot([k_max], [real_ccdf[-1]], marker="o", markersize=6, color=REAL_COLOR, zorder=5)
    ax.annotate(
        f"max in-degree {k_max}\n(Poisson expects ≈ 0 nodes this far out)",
        xy=(k_max, real_ccdf[-1]), xytext=(0.48, 0.10), textcoords="axes fraction",
        fontsize=9.5, color=REAL_COLOR,
        arrowprops=dict(arrowstyle="->", color=REAL_COLOR, lw=1.2),
    )

    ax.set_xscale("log")
    ax.set_yscale("log")
    ax.set_xlim(0.9, 150)
    ax.set_ylim(5e-4, 1.5)
    ax.set_xlabel("in-degree k", fontsize=12)
    ax.set_ylabel("P(K ≥ k)  (CCDF)", fontsize=12)
    ax.set_title("Week 2: Marvel in-degree CCDF vs. random (ER) and scale-free (BA) nulls", fontsize=13)
    ax.tick_params(labelsize=10)
    ax.grid(True, which="major", alpha=0.25, linewidth=0.5)
    ax.legend(fontsize=10.5, frameon=True, loc="lower left")

    fig.tight_layout()
    fig.savefig(out_path, dpi=200, bbox_inches="tight")
    plt.close(fig)


def plot_ccdf_fit(k_grid, real_ccdf, fit_result, out_path):
    alpha = fit_result["alpha"]
    alpha_sigma = fit_result["alpha_sigma"]
    xmin = fit_result["xmin"]
    ks_distance = fit_result["ks_distance_D"]
    exp_lambda = fit_result["exponential_lambda"]

    tail = k_grid[k_grid >= xmin]

    fig, ax = plt.subplots(figsize=(9, 6))

    below = k_grid[k_grid < xmin]
    ax.step(below, real_ccdf[k_grid < xmin], where="post", color=ER_COLOR,
            linewidth=1.2, alpha=0.55, label=rf"real CCDF, k < $\hat{{k}}_{{\mathrm{{min}}}}$ ({int(xmin)})")
    ax.step(tail, real_ccdf[k_grid >= xmin], where="post", color=FIT_COLOR,
            linewidth=2.2, marker="o", markersize=4.5, alpha=0.9,
            label=rf"real CCDF, tail (k ≥ {int(xmin)}, n = {fit_result['n_tail']})")

    ax.plot(tail, power_law_ccdf(tail, alpha, xmin), color=FIT_COLOR, linewidth=2.2,
            linestyle="--", label=rf"power-law fit: $\hat{{\alpha}}$ = {alpha:.2f} ± {alpha_sigma:.2f}")
    ax.plot(tail, discrete_exponential_ccdf(tail, exp_lambda, xmin), color=ER_COLOR,
            linewidth=1.8, linestyle=":", label="exponential fit (alternative)")

    ax.text(
        0.97, 0.95,
        "Clauset–Shalizi–Newman MLE (discrete)\n"
        rf"$\hat{{k}}_{{\mathrm{{min}}}}$ = {int(xmin)}, $n_{{\mathrm{{tail}}}}$ = {fit_result['n_tail']}" + "\n"
        f"KS distance D = {ks_distance:.3f}",
        transform=ax.transAxes, ha="right", va="top", fontsize=9.5,
        bbox=dict(boxstyle="round,pad=0.45", facecolor="white", edgecolor="#ced4da", alpha=0.9),
    )

    ax.set_xscale("log")
    ax.set_yscale("log")
    ax.set_xlim(0.9, 150)
    ax.set_ylim(2.5e-3, 1.5)
    ax.set_xlabel("in-degree k", fontsize=12)
    ax.set_ylabel("P(K ≥ k)  (CCDF)", fontsize=12)
    ax.set_title("Week 2: power-law fit to the Marvel in-degree tail", fontsize=13)
    ax.tick_params(labelsize=10)
    ax.grid(True, which="major", alpha=0.25, linewidth=0.5)
    ax.legend(fontsize=10.5, frameon=True, loc="lower left")

    fig.tight_layout()
    fig.savefig(out_path, dpi=200, bbox_inches="tight")
    plt.close(fig)


def build_summary(in_degrees, out_degrees, lam, fit_result, ba, k_grid, real_ccdf, pois_ccdf):
    """Machine-readable Week 2 numbers — every figure the post quotes comes
    from here, nothing hand-typed."""
    n = len(in_degrees)

    def poisson_expected(threshold):
        # Expected number of characters with degree >= threshold under the ER null
        return float(n * stats.poisson.sf(threshold - 1, lam))

    k_max_in = int(in_degrees.max())
    k_max_out = int(out_degrees.max())

    return {
        "dataset": {
            "source": "frozen Week 1 snapshot (data/week1), 2026-08-26",
            "node_count": n,
            "directed_edge_count": EXPECTED_EDGES,
            "mean_in_degree": float(in_degrees.mean()),
            "median_in_degree": float(np.median(in_degrees)),
            "max_in_degree": k_max_in,
            "max_out_degree": k_max_out,
            "isolate_count": EXPECTED_ISOLATES,
        },
        "er_null": {
            "lambda": float(lam),
            "expected_characters_with_in_degree_ge_10": poisson_expected(10),
            "observed_characters_with_in_degree_ge_10": int((in_degrees >= 10).sum()),
            "expected_characters_with_in_degree_ge_20": poisson_expected(20),
            "observed_characters_with_in_degree_ge_20": int((in_degrees >= 20).sum()),
            "expected_characters_with_in_degree_ge_106": poisson_expected(k_max_in),
            "expected_characters_with_out_degree_ge_28": poisson_expected(k_max_out),
        },
        "power_law_fit": {k: v for k, v in fit_result.items() if k != "_fit"},
        "ba_null": {
            "n": BA_N,
            "m": BA_M,
            "n_seeds": BA_SEEDS,
            "mean_degree": ba["mean_degree"],
            "kmax_mean": ba["kmax_mean"],
            "kmax_min": ba["kmax_min"],
            "kmax_max": ba["kmax_max"],
        },
        "ccdf_reference_points": {
            "k": [int(k) for k in (1, 2, 5, 10, 20, 50)],
            "real": [float(real_ccdf[np.searchsorted(k_grid, k)]) for k in (1, 2, 5, 10, 20, 50)],
            "poisson": [float(pois_ccdf[np.searchsorted(k_grid, k)]) for k in (1, 2, 5, 10, 20, 50)],
        },
    }


def main():
    ASSETS_DIR.mkdir(exist_ok=True)
    SUMMARY_DIR.mkdir(exist_ok=True)

    graph = load_graph()
    n_nodes, n_edges, n_isolates = verify(graph)

    in_arr = np.array([d for _, d in graph.in_degree()])
    out_arr = np.array([d for _, d in graph.out_degree()])
    lam = n_edges / n_nodes  # ER with the same N and edge count -> in-degree ~ Poisson(lambda)
    k_max = int(in_arr.max())

    k_grid = np.arange(1, k_max + 1)
    real_ccdf = empirical_ccdf(in_arr, k_grid)
    pois_ccdf = poisson_ccdf(k_grid, lam)

    print(f"Nodes: {n_nodes}, directed edges: {n_edges}, isolates: {n_isolates}")
    print(f"<k> (in-degree): {lam:.4f}, max in-degree: {k_max}, max out-degree: {int(out_arr.max())}")

    ba = ba_ensemble(k_grid)
    print(f"\n--- BA null (N={BA_N}, m={BA_M}, {BA_SEEDS} seeds) ---")
    print(f"Mean degree: {ba['mean_degree']:.2f}")
    print(f"k_max across ensemble: mean {ba['kmax_mean']:.1f}, range {ba['kmax_min']}–{ba['kmax_max']}")
    print(f"Real k_max ({k_max}) vs. Poisson expected count ≥ {k_max}: "
          f"{n_nodes * stats.poisson.sf(k_max - 1, lam):.3e}")

    fit_result = fit_power_law(in_arr)
    print("\n--- Power-law fit (Clauset–Shalizi–Newman, discrete) ---")
    print(f"k_min: {fit_result['xmin']:.0f}  "
          f"(n_tail = {fit_result['n_tail']} of {fit_result['n_positive']} positive degrees)")
    print(f"alpha: {fit_result['alpha']:.3f} ± {fit_result['alpha_sigma']:.3f}")
    print(f"KS distance D: {fit_result['ks_distance_D']:.4f}")
    for name, res in fit_result["likelihood_ratio_tests"].items():
        print(f"LR {name}: R = {res['R']:.2f}, p = {res['p']:.3f} -> {res['favored']}")

    models_path = ASSETS_DIR / "week2_ccdf_models.png"
    plot_ccdf_models(k_grid, real_ccdf, pois_ccdf, ba, models_path, lam)
    print(f"\nCCDF-vs-nulls figure written to: {models_path}")

    fit_path = ASSETS_DIR / "week2_ccdf_fit.png"
    plot_ccdf_fit(k_grid, real_ccdf, fit_result, fit_path)
    print(f"CCDF-fit figure written to: {fit_path}")

    summary = build_summary(in_arr, out_arr, lam, fit_result, ba, k_grid, real_ccdf, pois_ccdf)
    summary_path = SUMMARY_DIR / "week2_summary.json"
    with open(summary_path, "w", encoding="utf-8") as f:
        json.dump(summary, f, indent=2, ensure_ascii=False)
        f.write("\n")
    print(f"Summary JSON written to: {summary_path}")


if __name__ == "__main__":
    main()
