#!/usr/bin/env python3
"""
Week 5 analysis — text mining the 303 Marvel hero Wikipedia pages.

Reads the pages frozen in ../data/marvel_pages/ (plain text, one file per
character, node_id URL-encoded; tokenization notes in the loader) plus the
Week 1 edges (for "who is most linked to" ordering), computes everything
offline, once, and freezes the numbers into ../data/marvel_pages/week5_summary.json:

  meta    — counts and headline numbers quoted in the prose
  pages   — per character: token/type counts, TTR, hapax share, entropy,
            mean TF-IDF, Zipf fit (slope s, R^2, deviation from s = -1),
            z-scored weirdness components + composite, in-degree,
            page's top TF-IDF words
  heaps   — stepwise vocabulary-growth arrays for the explorable:
            in-degree-first, reverse, alphabetical, and an ensemble of
            random shuffles (with a percent band); per-bucket new-word
            rates for the famous-vs-minor comparison
  weird   — the composite-weight recipe the browser mirrors

stdlib only. Run:  python3 build_week5.py
"""

import json
import base64
import math
import os
import random
import re
import sys
import urllib.parse
from collections import Counter

HERE = os.path.dirname(os.path.abspath(__file__))
DATA = os.path.join(HERE, "..", "data")
PAGES_DIR = os.path.join(DATA, "marvel_pages")
WEEK1 = os.path.join(DATA, "week1")

N_SHUFFLES = 24          # random-order ensemble size for the Heaps band
Z_COUNT = 6              # z-scored weirdness components
TOKEN_RE = re.compile(r"[a-z]+(?:'[a-z]+)?")


def log(*a):
    print(*a, file=sys.stderr)


def load_nodes():
    path = os.path.join(WEEK1, "week1_nodes.tsv")
    rows = []
    with open(path, encoding="utf-8") as fh:
        lines = [ln.rstrip("\n") for ln in fh if not ln.startswith("#")]
    hdr = lines[0].split("\t")
    name_i = hdr.index("name")
    for ln in lines[1:]:
        parts = ln.split("\t")
        rows.append((parts[0], parts[name_i]))
    return rows  # [(node_id, name)]


def load_in_degree():
    path = os.path.join(WEEK1, "week1_edges.tsv")
    indeg = Counter()
    with open(path, encoding="utf-8") as fh:
        for ln in fh:
            if ln.startswith("#") or ln.startswith("source\t"):
                continue
            src, tgt = ln.rstrip("\n").split("\t")[:2]
            indeg[tgt] += 1
    return indeg  # target := linked-to


def load_pages(node_ids):
    """Return {node_id: raw text}. Filenames are URL-encoded node_id stems."""
    files = {}
    for fn in os.listdir(PAGES_DIR):
        if not fn.endswith(".txt") or fn == "README.txt":
            continue
        stem = fn[:-4]
        try:
            node_id = urllib.parse.unquote(stem)
        except Exception:
            continue
        files[node_id] = os.path.join(PAGES_DIR, fn)
    pages = {}
    for nid, _ in node_ids:
        if nid not in files:
            raise SystemExit(f"page file missing for {nid}")
        with open(files[nid], encoding="utf-8") as fh:
            pages[nid] = fh.read()
    if node_ids and len(files) != len(node_ids):
        log(f"note: {len(files)} page files for {len(node_ids)} nodes")
    return pages


def tokenize(text):
    return TOKEN_RE.findall(text.lower())


def entropy(counts, total):
    if total == 0:
        return 0.0
    h = 0.0
    for c in counts.values():
        p = c / total
        h -= p * math.log2(p)
    return h


def zipf_fit(counts):
    """Fit log10(freq) ~ log10(rank) over the rank-frequency curve.

    Returns (slope s, r2, s - (-1)). Ideal Zipf is s = -1 with R2 ~ 1;
    real short pages stay flatter, so deviation feeds the weirdness score.
    """
    freqs = sorted(counts.values(), reverse=True)
    n_fit = min(len(freqs), 200)
    if n_fit < 8:
        return 0.0, 0.0, math.nan
    xs = [math.log10(r) for r in range(1, n_fit + 1)]
    total = float(sum(freqs))
    ys = [math.log10(max(f, 1) / total) for f in freqs[:n_fit]]
    mx = sum(xs) / n_fit
    my = sum(ys) / n_fit
    sxy = sum((x - mx) * (y - my) for x, y in zip(xs, ys))
    sxx = sum((x - mx) ** 2 for x in xs)
    syy = sum((y - my) ** 2 for y in ys)
    if sxx == 0 or syy == 0:
        return 0.0, 0.0, math.nan
    slope = sxy / sxx
    r2 = (sxy * sxy) / (sxx * syy)
    return slope, r2, abs(slope + 1.0)


def heaps_run(order, page_tokens):
    """Stepwise (t, v, new, seen_frac) arrays for adding pages in `order`."""
    seen = set()
    t_cum = 0
    steps_t, steps_v, steps_new, steps_seen = [], [], [], []
    for nid in order:
        toks = page_tokens[nid]
        counts = page_counts[nid]
        fresh = [w for w in counts if w not in seen]
        n_new = sum(counts[w] for w in fresh)
        seen.update(fresh)
        t_cum += len(toks)
        steps_t.append(t_cum)
        steps_v.append(len(seen))
        steps_new.append(n_new)
        steps_seen.append(1.0 - (n_new / len(toks)) if toks else 0.0)
    return {
        "order": order,
        "t": steps_t,
        "v": steps_v,
        "new": steps_new,
        "seen": [round(s, 4) for s in steps_seen],
    }


def percentile(sorted_vals, q):
    if not sorted_vals:
        return 0.0
    idx = (len(sorted_vals) - 1) * q
    lo = int(math.floor(idx))
    hi = int(math.ceil(idx))
    if lo == hi:
        return sorted_vals[lo]
    return sorted_vals[lo] + (idx - lo) * (sorted_vals[hi] - sorted_vals[lo])


def varint_encode(n, out):
    while True:
        b7 = n & 0x7F
        n >>= 7
        if n:
            out.append(b7 | 0x80)
        else:
            out.append(b7)
            return


def varint_decode(data):
    vals = []
    n = 0
    shift = 0
    for byte in data:
        n |= (byte & 0x7F) << shift
        if byte & 0x80:
            shift += 7
        else:
            vals.append(n)
            n = 0
            shift = 0
    return vals


def build_duel_payload(nodes, page_counts, all_counts):
    """Combined Zipf/Heaps explorable payload.

    The browser needs, per page: (a) WHICH words the page uses and their
    multiplicities, so it can score every remaining candidate's marginal ΔV
    live (an O(1) in-union flag lookup per word), (b) the page's own
    rank-frequency multiset for its Zipf curve, and (c) the ability to merge
    into the accumulated corpus's count profile exactly.

    One encoding serves all three: per page, words sorted by global vocab
    index, shipped as varint (idx-delta, count) pairs in base64. Delta from
    the previous word's index keeps the stream at ~2.5 bytes/pair.
    Roundtrip-asserted against the raw counters.
    """
    vocab = sorted(all_counts)
    index_of = {w: i for i, w in enumerate(vocab)}

    pairs = {}
    for nid, _ in nodes:
        items = sorted((index_of[w], c) for w, c in page_counts[nid].items())
        # stream: idx0, c0, delta1, c1, ... (deltas >= 1 after the first)
        out = bytearray()
        prev_idx = None
        for idx, c in items:
            varint_encode(idx if prev_idx is None else idx - prev_idx, out)
            varint_encode(c, out)
            prev_idx = idx
        pairs[nid] = base64.b64encode(bytes(out)).decode("ascii")

    # ---- roundtrip assertions ------------------------------------------------
    def pair_decode(b64):
        vals = varint_decode(base64.b64decode(b64))
        got = Counter()
        prev_idx = 0
        for k in range(0, len(vals), 2):
            idx = vals[k] + (0 if k == 0 else prev_idx)
            prev_idx = idx
            got[vocab[idx]] = vals[k + 1]
        return got

    for nid, _ in nodes:
        decoded = pair_decode(pairs[nid])
        assert decoded == page_counts[nid], f"pair roundtrip failed for {nid}"

    return {
        "n_vocab": len(vocab),
        "vocab": vocab,
        "pairs": pairs,
    }


def main():
    random.seed(20261002)

    nodes = load_nodes()
    indeg = load_in_degree()
    pages = load_pages(nodes)

    global page_counts, page_tokens
    page_tokens = {nid: tokenize(txt) for nid, txt in pages.items()}
    page_counts = {nid: Counter(toks) for nid, toks in page_tokens.items()}

    n_docs = len(page_tokens)
    df = Counter()
    for counts in page_counts.values():
        for w in counts:
            df[w] += 1
    idf = {w: math.log((1.0 + n_docs) / (1.0 + df_w)) + 1.0 for w, df_w in df.items()}

    # ---- per-page text metrics -------------------------------------------
    raw = {}
    for nid, _ in nodes:
        counts = page_counts[nid]
        total = len(page_tokens[nid])
        types = len(counts)
        hapax = sum(1 for c in counts.values() if c == 1)
        tfidf_sum = 0.0
        for w, c in counts.items():
            tfidf_sum += (c / total) * idf[w]
        slope, r2, dev = zipf_fit(counts)
        # corpus one-off share: fraction of the page's TOKENS sitting in words
        # with document frequency 1 across the whole corpus — the corpus-aware
        # sibling of the within-page hapax share
        oneoff_toks = sum(c for w, c in counts.items() if df[w] == 1)
        raw[nid] = {
            "tokens": total,
            "types": types,
            "ttr": types / total if total else 0.0,
            "hapax": hapax / types if types else 0.0,
            "entropy": entropy(counts, total),
            "tfidf": tfidf_sum,
            "oneoff": oneoff_toks / total if total else 0.0,
            "zipf_s": slope,
            "zipf_r2": r2,
            "zipf_dev": dev,
        }

    # z-scores across pages (population std)
    def zscores(key):
        vals = [raw[n][key] for n, _ in nodes if not math.isnan(raw[n][key])]
        mu = sum(vals) / len(vals)
        sd = math.sqrt(sum((v - mu) ** 2 for v in vals) / len(vals)) or 1e-9
        return {n: (raw[n][key] - mu) / sd for n, _ in nodes if not math.isnan(raw[n][key])}

    z_ttr = zscores("ttr")
    z_hapax = zscores("hapax")
    z_ent = zscores("entropy")
    z_tfidf = zscores("tfidf")
    z_zipf = zscores("zipf_dev")
    z_oneoff = zscores("oneoff")

    composite = {
        nid: (z_ttr[nid] + z_hapax[nid] + z_ent[nid] + z_tfidf[nid] + z_zipf[nid] + z_oneoff[nid]) / Z_COUNT
        for nid in z_ttr
    }

    # top TF-IDF words per page (8, most distinctive; negligible-frequency
    # English function words first screened out so the displayed list shows
    # what the page is actually about, not "the and of in a")
    STOP = set(
        "the a an and or of in on at to for with by from as is are was were be been "
        "being it its it's he his him she her they their them this that these those "
        "not no but if then than so such also which who whom what when where how "
        "into out up down over under after before during between about against "
        "has have had having does did doing can could may might must will would "
        "am you your we our us s t d ll m re ve y ain aren "
        "couldn didn doesn hadn hasn haven isn ma mightn mustn needn shan shouldn "
        "won wouldn first two one other since used use known appeared appear "
        "appears american comics book books fiction "
        "fictional character characters series superhero superheroes comic villain"
    .split())
    top_words = {}
    for nid, _ in nodes:
        counts = page_counts[nid]
        total = len(page_tokens[nid])
        scored = sorted(
            (w for w in counts if w not in STOP and len(w) > 1),
            key=lambda w: ((counts[w] / total) * idf[w], counts[w]), reverse=True)
        top_words[nid] = scored[:8]

    pages_json = {}
    for nid, name in nodes:
        r = raw[nid]
        pages_json[nid] = {
            "name": name,
            "in_degree": indeg.get(nid, 0),
            "tokens": r["tokens"],
            "types": r["types"],
            "ttr": round(r["ttr"], 4),
            "hapax": round(r["hapax"], 4),
            "entropy": round(r["entropy"], 4),
            "tfidf": round(r["tfidf"], 4),
            "oneoff": round(r["oneoff"], 4),
            "zipf_s": round(r["zipf_s"], 4),
            "zipf_r2": round(r["zipf_r2"], 4),
            "zipf_dev": round(r["zipf_dev"], 4),
            "z_ttr": round(z_ttr[nid], 3),
            "z_hapax": round(z_hapax[nid], 3),
            "z_entropy": round(z_ent[nid], 3),
            "z_tfidf": round(z_tfidf[nid], 3),
            "z_zipf": round(z_zipf[nid], 3),
            "z_oneoff": round(z_oneoff[nid], 3),
            "weird": round(composite[nid], 3),
            "top_tfidf": top_words[nid],
        }

    # ---- Heaps -------------------------------------------------------------
    deg = {nid: indeg.get(nid, 0) for nid, _ in nodes}
    order_indegree = sorted(nodes, key=lambda nt: (-deg[nt[0]], nt[1]))
    order_reverse = list(reversed(order_indegree))
    order_alpha = sorted(nodes, key=lambda nt: nt[0])

    heaps = {
        "indegree": heaps_run([nid for nid, _ in order_indegree], page_tokens),
        "reverse": heaps_run([nid for nid, _ in order_reverse], page_tokens),
        "alpha": heaps_run([nid for nid, _ in order_alpha], page_tokens),
    }

    # random ensemble: N_SHUFFLES full runs; 3 kept playable and the full set
    # folded into a 10/50/90-percent band on the V curve
    random.seed(20261002)
    shuffle_runs = []
    all_v = []
    for i in range(N_SHUFFLES):
        ids = [nid for nid, _ in nodes]
        random.shuffle(ids)
        run = heaps_run(ids, page_tokens)
        all_v.append(run["v"])
        if len(shuffle_runs) < 3:
            shuffle_runs.append(run)
    band = {
        "t": run["t"],
        "q10": [], "q50": [], "q90": [],
    }
    for j in range(len(nodes)):
        col = sorted(vals[j] for vals in all_v)
        band["q10"].append(percentile(col, 0.10))
        band["q50"].append(percentile(col, 0.50))
        band["q90"].append(percentile(col, 0.90))
    heaps["random"] = {"runs": shuffle_runs, "band": band}

    # famous vs minor: top quartile of pages by in-degree vs the rest
    q75 = percentile(sorted(deg.values()), 0.75)
    buckets = {0: [], 1: []}
    for nid, _ in nodes:
        buckets[0 if deg[nid] >= q75 else 1].append(nid)

    def new_word_rate(nids):
        seen = set()
        fresh_total = 0
        tok_total = 0
        per_page = []
        for nid in sorted(nids, key=lambda x: (-deg[x], x)):
            counts = page_counts[nid]
            fresh = [w for w in counts if w not in seen]
            f = sum(counts[w] for w in fresh)
            seen.update(fresh)
            fresh_total += f
            tok_total += len(page_tokens[nid])
            per_page.append({"i": nid, "new": f, "tokens": len(page_tokens[nid])})
        per_page.sort(key=lambda d: -d["new"])
        return {
            "n": len(nids),
            "tokens": tok_total,
            "new": fresh_total,
            "rate_per_1k": round(1000.0 * fresh_total / tok_total, 2) if tok_total else 0.0,
            "top_contributors": [
                {"i": d["i"], "n": pages_json[d["i"]]["name"], "new": d["new"],
                 "in_degree": deg[d["i"]]}
                for d in per_page[:10]
            ],
        }

    # order-independent companion metric: words whose every corpus occurrence
    # sits inside one bucket's pages -- that bucket's *private* vocabulary
    df_bucket = {}
    for b, nids in buckets.items():
        df_bucket[b] = Counter()
        for nid in nids:
            for w in page_counts[nid]:
                df_bucket[b][w] += 1
    excl = {
        0: sorted(df_bucket[0].keys() - df_bucket[1].keys()),
        1: sorted(df_bucket[1].keys() - df_bucket[0].keys()),
    }

    heaps["famous_vs_minor"] = {
        "famous_in_degree_at_least": q75,
        "famous": new_word_rate(buckets[0]),
        "minor": new_word_rate(buckets[1]),
        "exclusive": {
            "famous_words": excl[0],
            "minor_words": excl[1],
            "famous_count": len(excl[0]),
            "minor_count": len(excl[1]),
        },
    }

    # ---- headline numbers ---------------------------------------------------
    final_v = heaps["indegree"]["v"][-1]
    all_tokens = sum(r["tokens"] for r in raw.values())
    log_v = [math.log(t) for t in heaps["indegree"]["t"] if t > 0]
    log_w = [math.log(v) for v in heaps["indegree"]["v"]]
    mx, my = sum(log_v) / len(log_v), sum(log_w) / len(log_w)
    sxy = sum((x - mx) * (y - my) for x, y in zip(log_v, log_w))
    sxx = sum((x - mx) ** 2 for x in log_v)
    heaps_exp = sxy / sxx

    weird_sorted = sorted(nodes, key=lambda nt: -composite[nt[0]])
    all_counts = Counter()
    for counts in page_counts.values():
        all_counts.update(counts)
    vocab_all = len(all_counts)

    # ---- duel: combined Zipf/Heaps explorable payload ------------------------
    # The browser needs two things no other section stores:
    #   * per page, WHICH global words the page uses and how often, so it can
    #     score every remaining candidate's marginal ΔV live,
    #   * per page, its own rank-frequency multiset to draw the page's Zipf
    #     curve and to merge curves into the accumulated corpus profile.
    # Encoded as base64 of compact binary: per page, one varint stream of
    # (idx-delta, count) pairs over the global vocabulary. Roundtrip-asserted.
    duel = build_duel_payload(nodes, page_counts, all_counts)

    summary = {
        "meta": {
            "nodes": len(nodes),
            "total_tokens": all_tokens,
            "total_vocab": vocab_all,
            "final_v_indegree": final_v,
            "heaps_exponent": round(heaps_exp, 3),
            "n_shuffles": N_SHUFFLES,
            "n_z_components": Z_COUNT,
            "weights": ["ttr", "hapax", "entropy", "tfidf", "zipf_dev", "oneoff"],
        },
        "pages": pages_json,
        "heaps": heaps,
        "weird": {
            "components": ["z_ttr", "z_hapax", "z_entropy", "z_tfidf", "z_zipf", "z_oneoff"],
            "top10": [{"i": nid, "n": pages_json[nid]["name"], "s": round(composite[nid], 3)}
                      for nid, _ in weird_sorted[:10]],
            "bottom10": [{"i": nid, "n": pages_json[nid]["name"], "s": round(composite[nid], 3)}
                         for nid, _ in weird_sorted[-10:]],
        },
        "duel": duel,
    }

    out_path = os.path.join(PAGES_DIR, "week5_summary.json")
    with open(out_path, "w", encoding="utf-8") as fh:
        json.dump(summary, fh, ensure_ascii=False)
    size = os.path.getsize(out_path)
    log(f"wrote {out_path} ({size/1e6:.2f} MB)")
    log(f"pages {len(pages_json)}, tokens {all_tokens}, vocab {vocab_all}, "
        f"heap exponent {heaps_exp:.3f}, final V {final_v}")
    log("weird top5: " + ", ".join(f"{d['n']} ({d['s']})" for d in summary["weird"]["top10"][:5]))


if __name__ == "__main__":
    main()
