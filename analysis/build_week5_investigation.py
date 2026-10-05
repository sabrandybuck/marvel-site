#!/usr/bin/env python3
"""Week 5 investigation payload: who adds the vocabulary / who is weird.

Reads the frozen week5_summary.json (produced by build_week5.py from the 303
page texts) and freezes one compact row per page for the three static charts
below the duel explorable:

  dv   distinct words the page adds when pages are added in the linked-first
       (in-degree) order = first difference of heaps.indegree.v (scatter x)
  w    weirdness = rare-word share: the fraction of the page's running text
       (tokens) made of words that occur in at most RARE_MAX of the 303 pages.
       Dividing by the page's own token count removes the raw page-length
       effect. A word's page count (document frequency) comes from the
       per-page word sets in the summary's duel payload.
  rt   the page's rare-word token count (w = rt / tokens)
  rare the page's most frequent rare words (up to 8), for inspection

Only page counts and a share; no composite score.
"""
import base64
import json
import os
from collections import Counter

RARE_MAX = 3  # "rare" = appears in at most 3 of the 303 pages (about 1%)

HERE = os.path.dirname(os.path.abspath(__file__))
DIR = os.path.join(HERE, "..", "data", "marvel_pages")

with open(os.path.join(DIR, "week5_summary.json"), encoding="utf-8") as fh:
    s = json.load(fh)


def varint_decode(data):
    vals, n, shift = [], 0, 0
    for byte in data:
        n |= (byte & 0x7F) << shift
        if byte & 0x80:
            shift += 7
        else:
            vals.append(n)
            n, shift = 0, 0
    return vals


vocab = s["duel"]["vocab"]
page_counts = {}
for nid, b64 in s["duel"]["pairs"].items():
    vals = varint_decode(base64.b64decode(b64))
    counts, idx = {}, 0
    for k in range(0, len(vals), 2):
        idx = vals[k] if k == 0 else idx + vals[k]
        counts[vocab[idx]] = vals[k + 1]
    page_counts[nid] = counts

df = Counter()
for counts in page_counts.values():
    df.update(counts.keys())

h = s["heaps"]["indegree"]
v = h["v"]
dv = {nid: v[i] - (v[i - 1] if i else 0) for i, nid in enumerate(h["order"])}
assert sum(dv.values()) == s["meta"]["total_vocab"]

rows = []
for rank, nid in enumerate(h["order"], 1):
    p = s["pages"][nid]
    counts = page_counts[nid]
    tokens = sum(counts.values())
    assert tokens == p["tokens"]
    rare = {w: c for w, c in counts.items() if df[w] <= RARE_MAX}
    top = sorted(rare, key=lambda w: (-rare[w], w))[:8]
    rows.append({"id": nid, "n": p["name"], "r": rank, "k": p["in_degree"],
                 "t": tokens, "dv": dv[nid],
                 "w": round(sum(rare.values()) / tokens, 4),
                 "rt": sum(rare.values()), "rare": top})
assert len(rows) == s["meta"]["nodes"] == 303

out = {"order": "in-degree, most-linked first", "rare_max": RARE_MAX, "pages": rows}
with open(os.path.join(DIR, "week5_investigation.json"), "w", encoding="utf-8") as fh:
    json.dump(out, fh, ensure_ascii=False, separators=(",", ":"))
print("wrote", len(rows), "rows; weirdness range",
      min(r["w"] for r in rows), max(r["w"] for r in rows))
