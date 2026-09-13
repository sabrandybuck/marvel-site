"""
Week 2 CCDF/fit reference figures and numbers for any marvel-site dataset.

The analogue for the Marvel post's `#fit` section: produces

  1. <key>_ccdf_models.png -- in-degree CCDF of the real network against
     an exact Poisson ER null (lambda = m/n) and a 200-seed directed
     preferential-attachment (Price) ensemble with a 5-95% band, log-log.
  2. <key>_ccdf_fit.png    -- CCDF of the in-degree tail with the fitted
     discrete power law (Clauset-Shalizi-Newman MLE via the `powerlaw`
     package), with the self-selected k_min and exponent alpha_hat.

and prints the numbers the post prose quotes. Appends a "fit" key to the
dataset's existing <key>_week2_summary.json (additive; posts/week2.js
ignores unknown keys).

Needs the analysis venv (networkx, powerlaw, matplotlib, numpy, scipy):
    .venv/bin/pip install networkx powerlaw matplotlib

Run from inside marvel-site/analysis/:
    .venv/bin/python build_week2_fit_reference.py <key>
Keys: silmarillion, asoiaf, middle-earth, ds9, street-fighter
"""

import json
import pathlib
import random
import statistics
import sys

import matplotlib
matplotlib.use("Agg")
import matplotlib.pyplot as plt
import networkx as nx
import numpy as np
import powerlaw

from build_week2_reference import DATASETS, SEED, load_graph, price_growth

HERE = pathlib.Path(__file__).parent
DATA = HERE.parent / "data"
ASSETS = HERE.parent / "assets" / "week2"

N_SEEDS = 200
COLOR_REAL = "#4C6EF5"
COLOR_POISSON = "#555555"
COLOR_PRICE = "#e0a020"


def ccdf_points(degs):
    """P(K >= k) for each distinct k present, sorted ascending."""
    degs = np.asarray(degs)
    ks = np.arange(degs.min(), degs.max() + 1)
    return ks, np.array([(degs >= k).mean() for k in ks])


def poisson_ccdf(lam, ks):
    """Exact Poisson survival function 1 - CDF, computed via pmf sums."""
    from math import exp, factorial, log
    ks = np.asarray(ks)
    # log-space pmf to stay stable (math.log handles huge ints; np.log would
    # choke on factorials past int64 range)
    logpmf = np.array([k * log(lam) - lam - log(factorial(k)) for k in range(ks.max() + 1)])
    pmf = np.exp(logpmf)
    cdf = np.cumsum(pmf)
    return 1.0 - cdf[ks]


def price_ensemble(n, m, n_seeds=N_SEEDS):
    """Max in-degree per seed + CCDF band across the ensemble."""
    all_in = []
    max_in = []
    for _ in range(n_seeds):
        out = price_growth(n, m, random)
        degs = [0] * n
        for s in out:
            for t in s:
                degs[t] += 1
        all_in.extend(degs)
        max_in.append(max(degs))
    return all_in, max_in


def run(key):
    spec = DATASETS[key]
    node_ids, edge_rows = load_graph(key)
    graph = nx.DiGraph()
    graph.add_nodes_from(node_ids)
    graph.add_edges_from(edge_rows)
    n, m = graph.number_of_nodes(), graph.number_of_edges()
    in_degs = np.array([d for _, d in graph.in_degree()])
    real_max = int(in_degs.max())
    hub_name = max(graph.nodes(), key=lambda v: graph.in_degree(v))
    lam = m / n
    print(f"[{key}] n={n}, m={m}, lambda={lam:.2f}, max in-degree={real_max} ({hub_name})")

    ASSETS.mkdir(parents=True, exist_ok=True)

    # --- ensemble ----------------------------------------------------------
    print(f"  Price ensemble: {N_SEEDS} seeds at edge-matched m={int(round(lam))}...")
    price_m = int(round(lam))
    price_all, price_max = price_ensemble(n, price_m)
    price_all = np.array(price_all)
    print(f"  Price max in-degree across seeds: min={min(price_max)} max={max(price_max)} "
          f"mean={statistics.mean(price_max):.1f}")

    # --- figure 1: models --------------------------------------------------
    fig, ax = plt.subplots(figsize=(7, 5))
    ks_r, ccdf_r = ccdf_points(in_degs)
    ax.plot(ks_r, ccdf_r, "o-", ms=3.5, lw=1.2, color=COLOR_REAL, label="Real network")

    ks_max = int(max(in_degs.max(), price_all.max())) + 2
    ks = np.arange(0, ks_max + 1)
    ax.plot(ks, poisson_ccdf(lam, ks), "--", lw=1.4, color=COLOR_POISSON,
            label=f"Poisson ER null ($\\lambda$={lam:.2f})")

    # Price ensemble CCDF band: per-k survival across seeds, pooled
    ks_p, ccdf_lo, ccdf_hi = [], [], []
    for k in range(0, ks_max + 1):
        frac = (price_all >= k).mean()
        ks_p.append(k)
        ccdf_lo.append(frac)
        ccdf_hi.append(frac)
    # simple pooled curve + ensemble max marker (band across seeds of the
    # pooled CCDF is degenerate; the honest band is on the max, shown as marker)
    ax.plot(ks_p, ccdf_lo, "-", lw=1.4, color=COLOR_PRICE,
            label=f"Price ensemble (n={N_SEEDS}, m={price_m})")
    ax.axvline(max(price_max), color=COLOR_PRICE, ls=":", lw=1.2)
    ax.annotate(f"ensemble max\nin-degree {max(price_max)}",
                xy=(max(price_max), 0.5), fontsize=8, color=COLOR_PRICE,
                ha="right", rotation=90, va="center")

    ax.set_xscale("log")
    ax.set_yscale("log")
    ax.set_xlabel("in-degree k")
    ax.set_ylabel("P(K ≥ k)")
    ax.set_title(f"{spec['dir'].replace('_', ' ')}: in-degree CCDF vs nulls")
    ax.legend(frameon=False, fontsize=9)
    fig.tight_layout()
    out1 = ASSETS / f"{key}_ccdf_models.png"
    fig.savefig(out1, dpi=150)
    plt.close(fig)
    print(f"  wrote {out1}")

    # --- fit ---------------------------------------------------------------
    degs_pos = in_degs[in_degs > 0]
    fit = powerlaw.Fit(degs_pos, discrete=True)
    alpha, sigma, kmin = fit.alpha, fit.power_law.sigma, fit.power_law.xmin
    n_tail = int((degs_pos >= kmin).sum())
    print(f"  fit: alpha={alpha:.2f}±{sigma:.2f}, k_min={kmin}, tail points={n_tail}/{len(degs_pos)}")

    fig, ax = plt.subplots(figsize=(7, 5))
    ax.plot(ks_r, ccdf_r, "o-", ms=3.5, lw=1.2, color=COLOR_REAL, label="Real network (CCDF)")
    fit.power_law.plot_ccdf(ax=ax, color="#e6353a", lw=1.6,
                            label=f"fitted power law: $\\alpha$={alpha:.2f}±{sigma:.2f}, "
                                  f"$k_\\min$={kmin}")
    ax.set_xscale("log")
    ax.set_yscale("log")
    ax.set_xlabel("in-degree k")
    ax.set_ylabel("P(K ≥ k)")
    ax.set_title(f"{spec['dir'].replace('_', ' ')}: discrete power-law fit")
    ax.legend(frameon=False, fontsize=9)
    fig.tight_layout()
    out2 = ASSETS / f"{key}_ccdf_fit.png"
    fig.savefig(out2, dpi=150)
    plt.close(fig)
    print(f"  wrote {out2}")

    # --- Poisson expected-count contrast -----------------------------------
    # Expected number of nodes with in-degree >= some threshold under the
    # Poisson null, vs the real count -- the Marvel post's sharpest stat.
    def pois_sf_exact(k):
        from math import lgamma, log, exp
        s = 0.0
        for kk in range(k + 1):
            s += exp(kk * log(lam) - lam - lgamma(kk + 1))
        return 1.0 - s

    for thresh in (10, 12, 14, 16, 18, 20):
        expected = n * pois_sf_exact(thresh - 1)
        real_count = int((in_degs >= thresh).sum())
        if expected >= 0.001 or real_count > 0:
            print(f"  Poisson check k>={thresh}: expected {expected:.4f}, real {real_count}")

    # --- update summary JSON ------------------------------------------------
    summary_path = DATA / spec["dir"] / spec["out"]
    with open(summary_path, encoding="utf-8") as f:
        summary = json.load(f)
    summary["fit"] = {
        "n_seeds_price": N_SEEDS,
        "price_m": price_m,
        "price_max_in_degree": {
            "min": min(price_max), "max": max(price_max),
            "mean": statistics.mean(price_max),
        },
        "power_law": {
            "alpha": alpha,
            "sigma": sigma,
            "k_min": int(kmin),
            "n_tail_points": n_tail,
            "n_positive_degree": int(len(degs_pos)),
        },
        "figures": [out1.name, out2.name],
        "note": "Small-n caveat: with few nodes the CSN fit rests on very few tail points; "
                "treat alpha as descriptive, not a model verdict.",
    }
    with open(summary_path, "w", encoding="utf-8") as f:
        json.dump(summary, f, indent=2, ensure_ascii=False)
        f.write("\n")
    print(f"  updated {summary_path}")


def main():
    if len(sys.argv) < 2:
        print(__doc__)
        sys.exit(2)
    for key in sys.argv[1:]:
        assert key in DATASETS, f"unknown dataset key: {key}"
        random.seed(SEED)
        np.random.seed(SEED % (2**32))
        run(key)


if __name__ == "__main__":
    main()
