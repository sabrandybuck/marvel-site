#!/usr/bin/env python3
"""Week 7 — independent checks of the directed link distances and the all-pairs outputs.

1. Always: recompute the directed shortest paths of the five pairs featured in
   posts/week-7.html with networkx from the edge list in week7_supervillains.json
   and compare them (and the stored cosines) with the values printed in the post.
2. If data/week7/week7_characters.json exists (build_week7_pairs.py): compare
   degrees, weak/strong components and counts with networkx.
3. If data/week7/week7_pairs.tsv exists: check pair count, uniqueness and A/B
   convention, cosine range, reach codes, that every distance equals the
   networkx BFS distance and that unreachable pairs carry no distance, SCC /
   WCC consistency, and agreement with the stored top-12 cosines.

Run from the repository root (needs numpy-free stdlib + networkx):

    python analysis/check_week7_distances.py [--data-dir data/week7]

Options: --skip-stored-cosine (only for pipeline tests with synthetic vectors:
skips the comparison with the stored top-12 cosines), --allow-synthetic (without it
a dataset built from synthetic embeddings is reported as a failure).

Exit status 0 when every check that could run passed, 1 otherwise.
"""

import argparse
import hashlib
import json
import math
import sys
from pathlib import Path

import networkx as nx

REPO = Path(__file__).resolve().parent.parent

# as printed in the table of posts/week-7.html: (A, B, cosine, d A->B, d B->A)
FEATURED = [
    ("Firebrand_(Marvel_Comics)", "Firepower_(comics)", 0.729, 7, None),
    ("Doom_2099", "Kristoff_Vernard", 0.722, None, 6),
    ("Masked_Marauder", "Gentleman_(character)", 0.669, 6, 6),
    ("Gorgon_(Inhuman)", "Lady_Gorgon", 0.669, None, 7),
    ("Condor_(comics)", "Flying_Tiger_(Marvel_Comics)", 0.663, None, 6),
]

failures = []


def check(cond, msg):
    if not cond:
        failures.append(msg)
        print(f"  FAIL: {msg}")
    return cond


def directed_distance(g, a, b):
    try:
        return nx.shortest_path_length(g, a, b)
    except nx.NetworkXNoPath:
        return None


def partition(labels):
    groups = {}
    for node, lab in labels.items():
        groups.setdefault(lab, set()).add(node)
    return {frozenset(v) for v in groups.values()}


def main(argv=None):
    failures.clear()
    ap = argparse.ArgumentParser(description=__doc__.split("\n")[0])
    ap.add_argument("--data-dir", type=Path, default=REPO / "data" / "week7")
    ap.add_argument("--skip-stored-cosine", action="store_true")
    ap.add_argument("--allow-synthetic", action="store_true")
    args = ap.parse_args(argv)
    d = args.data_dir

    prev = json.loads((d / "week7_supervillains.json").read_text(encoding="utf-8"))
    g = nx.DiGraph()
    g.add_nodes_from(prev["nodes"])
    g.add_edges_from(map(tuple, prev["edges"]))
    stored = {a: {it["o"]: it["c"] for it in lst} for a, lst in prev["neighbors"].items()}
    print(f"graph: {g.number_of_nodes()} nodes, {g.number_of_edges()} directed edges")

    print("featured pairs (posts/week-7.html):")
    for a, b, cos, dab, dba in FEATURED:
        got = (directed_distance(g, a, b), directed_distance(g, b, a))
        c = stored[a].get(b, stored[b].get(a))
        ok = check(got == (dab, dba), f"{a} / {b}: distances {got}, expected {(dab, dba)}")
        ok &= check(c is not None and round(c, 3) == cos, f"{a} / {b}: stored cosine {c}, expected {cos}")
        print(f"  {'ok  ' if ok else 'FAIL'} {a} - {b}: cos {c}, A->B {got[0]}, B->A {got[1]}")

    chars_path = d / "week7_characters.json"
    pairs_path = d / "week7_pairs.tsv"
    summ_path = d / "week7_pair_summaries.json"
    ids = None
    if chars_path.exists():
        print("week7_characters.json:")
        cj = json.loads(chars_path.read_text(encoding="utf-8"))
        chars = cj["characters"]
        ids = [c["id"] for c in chars]
        check(ids == sorted(ids), "characters are not sorted by id")
        check(set(ids) == set(g.nodes), "character ids differ from the graph nodes")
        check(len(cj["edges"]) == g.number_of_edges(), "edge count differs")
        check({tuple(e) for e in cj["edges"]} == set(g.edges), "edge set differs")
        for c in chars:
            if not (check(c["in_degree"] == g.in_degree(c["id"]), f"in-degree of {c['id']}")
                    and check(c["out_degree"] == g.out_degree(c["id"]), f"out-degree of {c['id']}")):
                break
        wcc = partition({c["id"]: c["weak_component"] for c in chars})
        scc = partition({c["id"]: c["strong_component"] for c in chars})
        check(wcc == {frozenset(s) for s in nx.weakly_connected_components(g)}, "weak components differ")
        check(scc == {frozenset(s) for s in nx.strongly_connected_components(g)}, "strong components differ")
        m = cj["meta"]["counts"]
        check(m["characters"] == len(ids), "meta character count")
        check(m["expected_unordered_pairs"] == len(ids) * (len(ids) - 1) // 2, "meta pair count")
        reach = sum(len(v) - 1 for v in dict(nx.all_pairs_shortest_path_length(g)).values())
        check(m["ordered_pairs_reachable"] == reach, f"ordered reachable pairs {m['ordered_pairs_reachable']} vs {reach}")
        print(f"  {len(ids)} characters, {m['weak_components']} weak / {m['strong_components']} strong components, "
              f"{m['ordered_pairs_reachable']} reachable ordered pairs")
        cmeta = cj["meta"]
        complete = cmeta.get("complete")
        emb = cmeta["semantic_method"]["embeddings"]
        check(complete in (True, False), "meta.complete is missing")
        check(bool(complete) == pairs_path.exists() == summ_path.exists(),
              f"meta.complete={complete} but pair table exists={pairs_path.exists()}, summaries exist={summ_path.exists()}")
        if complete:
            check(emb.get("status") in ("cache", "computed"), f"complete dataset but embeddings status {emb.get('status')!r}")
            check(args.allow_synthetic or not emb.get("synthetic"),
                  "dataset was built from SYNTHETIC embeddings (not real results)")
            for name, info in cmeta.get("outputs", {}).items():
                text = (d / name).read_text(encoding="utf-8").encode("utf-8")
                check(hashlib.sha256(text).hexdigest() == info["sha256"] and len(text) == info["bytes"],
                      f"{name} does not match the digest recorded in week7_characters.json (files from different runs?)")
            check(set(cmeta.get("outputs", {})) == {"week7_pairs.tsv", "week7_pair_summaries.json"},
                  "meta.outputs is missing the digests of the pair table / summaries")
        else:
            print("  graph-only dataset (no embeddings): pair table and summaries not expected")
    else:
        print("week7_characters.json not found: skipped (run analysis/build_week7_pairs.py)")

    if pairs_path.exists() and ids is not None:
        print("week7_pairs.tsv:")
        apl = dict(nx.all_pairs_shortest_path_length(g))
        wcc_of = {n: i for i, comp in enumerate(nx.weakly_connected_components(g)) for n in comp}
        scc_of = {n: i for i, comp in enumerate(nx.strongly_connected_components(g)) for n in comp}
        lines = [ln for ln in pairs_path.read_text(encoding="utf-8").splitlines() if ln and not ln.startswith("#")]
        header = lines[0].split("\t")
        rows = [dict(zip(header, ln.split("\t"))) for ln in lines[1:]]
        n = len(ids)
        check(len(rows) == n * (n - 1) // 2, f"pair count {len(rows)} != {n * (n - 1) // 2}")
        seen = set()
        pos = {nid: i for i, nid in enumerate(ids)}
        order = [(pos.get(r["a"], -1), pos.get(r["b"], -1)) for r in rows]
        check(order == sorted(order), "pair rows are not sorted by (index of A, index of B)")
        counts = {"both": 0, "a_to_b": 0, "b_to_a": 0, "none": 0}
        n_cos = 0
        bad = 0
        for r in rows:
            a, b = r["a"], r["b"]
            key = (a, b)
            if key in seen or a >= b or a not in g or b not in g:
                bad += 1
                continue
            seen.add(key)
            dab = apl[a].get(b)
            dba = apl[b].get(a)
            exp = "both" if dab is not None and dba is not None else "a_to_b" if dab is not None else \
                "b_to_a" if dba is not None else "none"
            counts[exp] += 1
            if (r["reach"] != exp or r["d_ab"] != ("" if dab is None else str(dab))
                    or r["d_ba"] != ("" if dba is None else str(dba))
                    or int(r["same_wcc"]) != int(wcc_of[a] == wcc_of[b])
                    or int(r["same_scc"]) != int(scc_of[a] == scc_of[b])
                    or int(r["same_scc"]) != int(exp == "both")
                    or (exp != "none" and not int(r["same_wcc"]))
                    or int(r["a_in"]) != g.in_degree(a) or int(r["a_out"]) != g.out_degree(a)
                    or int(r["b_in"]) != g.in_degree(b) or int(r["b_out"]) != g.out_degree(b)):
                bad += 1
            if r["cos"] != "":
                n_cos += 1
                c = float(r["cos"])
                if not math.isfinite(c) or not -1.0 <= c <= 1.0:
                    bad += 1
                s = stored[a].get(b, stored[b].get(a))
                if not args.skip_stored_cosine and s is not None and abs(s - c) > 0.0006:
                    bad += 1
        check(bad == 0, f"{bad} pair rows failed the per-row checks (ids, distances, reach, components, degrees, cosine)")
        check(len(seen) == len(rows), "duplicate or malformed pair keys")
        print(f"  {len(rows)} pairs, {n_cos} with a cosine; reach counts {counts}")
        for a, b, cos, dab, dba in FEATURED:
            row = next((r for r in rows if (r["a"], r["b"]) == tuple(sorted((a, b)))), None)
            if check(row is not None, f"featured pair {a}/{b} missing"):
                swap = (a, b) != (row["a"], row["b"])
                got = (row["d_ba"], row["d_ab"]) if swap else (row["d_ab"], row["d_ba"])
                want = tuple("" if x is None else str(x) for x in (dab, dba))
                check(got == want, f"featured pair {a}/{b}: table has {got}, expected {want}")
                if not args.skip_stored_cosine:
                    check(row["cos"] != "" and abs(float(row["cos"]) - cos) <= 0.0006, f"featured pair {a}/{b}: cosine {row['cos']}")
    elif ids is not None:
        print("week7_pairs.tsv not found: skipped (needs embeddings; see build_week7_pairs.py)")

    if summ_path.exists():
        print("week7_pair_summaries.json:")
        sj = json.loads(summ_path.read_text(encoding="utf-8"))
        for key in ("far_but_reachable", "reachable_both_ways", "similar_without_any_path"):
            for r in sj[key]:
                if key == "similar_without_any_path":
                    check(r["reach"] == "none" and r["d_ab"] is None and r["d_ba"] is None, f"{key}: {r}")
                if key == "reachable_both_ways":
                    check(r["reach"] == "both" and r["d_ab"] is not None and r["d_ba"] is not None, f"{key}: {r}")
                if key == "far_but_reachable":
                    check(r["reach"] != "none" and r["min_distance"] is not None, f"{key}: {r}")
        if pairs_path.exists() and ids is not None:
            lookup = {(r["a"], r["b"]): r for r in rows}
            for nid, lst in sj["neighbours"].items():
                for other, c, d_to, d_from in lst:
                    a_, b_ = sorted((nid, other))
                    r = lookup.get((a_, b_))
                    ds = (d_to, d_from) if nid == a_ else (d_from, d_to)
                    want = tuple(None if r[k] == "" else int(r[k]) for k in ("d_ab", "d_ba"))
                    if not (r and r["cos"] != "" and abs(float(r["cos"]) - c) < 1e-9 and ds == want):
                        check(False, f"neighbour {nid} -> {other} disagrees with the pair table")
                        break
        print(f"  lists: {len(sj['far_but_reachable'])} far-but-reachable, {len(sj['reachable_both_ways'])} both-ways, "
              f"{len(sj['similar_without_any_path'])} without a path")

    print("\nALL CHECKS PASSED" if not failures else f"\n{len(failures)} CHECK(S) FAILED")
    return 0 if not failures else 1


if __name__ == "__main__":
    sys.exit(main())
