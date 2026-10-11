#!/usr/bin/env python3
"""
Week 6-3 analysis — the Marvel map + community term contrast.

Companion to build_week6.py (reads its frozen payloads to stay consistent):
the Louvain communities, fingerprints and word vocabulary all come from
week6_summary.json / week6_words.json. This script adds only what the map
and the two-corpus term plot need:

  week63_vecs.json  — Word2Vec vectors (gensim, same params as week 6,
                      retrained with the same seed for identical results),
                      quantized to int8 for the browser: any axis is then
                      built live from user-typed pole words. Shipped for the
                      word-explorer vocabulary plus every fingerprint word.
  week63_map.json   — per character: display name, community, in-degree,
                      token count and the top-12 non-name fingerprint words
                      WITH their TF-IDF weights (each map projection is a
                      TF-IDF-weighted average fingerprint, exactly like the
                      course page's recipe) + the preset axis definitions.
  week63_terms.json — for the Scattertext-style panel: per community (the
                      8 largest), the counts of every week-6 explorer term
                      plus the community token totals for rate scaling.

Run:  ~/.venvs/week6-venv/bin/python build_week63.py
"""

import base64
import json
import math
import os
import re
import sys
import urllib.parse
from collections import Counter

import numpy as np
from gensim.models import Word2Vec

HERE = os.path.dirname(os.path.abspath(__file__))
DATA = os.path.join(HERE, "..", "data")
PAGES_DIR = os.path.join(DATA, "marvel_pages")

TOKEN_RE = re.compile(r"[a-z]+(?:'[a-z]+)?")
SENT_SPLIT_RE = re.compile(r"(?<=[.!?])\s+")
FP_DEPTH = 12            # fingerprint words shipped per character
N_COMMUNITIES = 8        # largest communities get a term-contrast column


def log(*a):
    print(*a, file=sys.stderr)


def split_sentences(text):
    out = []
    for s in SENT_SPLIT_RE.split(text):
        s2 = " ".join(s.split())
        if len(s2) >= 15 and any(c.isalpha() for c in s2):
            out.append(s2)
    return out


def main():
    # ---- frozen week-6 state --------------------------------------------------
    summary = json.load(open(os.path.join(PAGES_DIR, "week6_summary.json"),
                             encoding="utf-8"))
    w6words = json.load(open(os.path.join(PAGES_DIR, "week6_words.json"),
                             encoding="utf-8"))
    pages = summary["pages"]
    ids = list(pages)
    N = len(ids)
    w2v_params = dict(w6words["meta"]["w2v"])
    topics_sizes = summary["meta"]["stats"]["community_sizes"]

    texts = {}
    for nid in ids:
        stem = urllib.parse.quote(nid, safe="")
        path = os.path.join(PAGES_DIR, stem + ".txt")
        if not os.path.exists(path):
            # filenames are percent-encoded node ids, but some may be plain
            candidates = [fn for fn in os.listdir(PAGES_DIR)
                          if fn.endswith(".txt")
                          and urllib.parse.unquote(fn[:-4]) == nid]
            if not candidates:
                raise SystemExit(f"missing page file for {nid}")
            path = os.path.join(PAGES_DIR, candidates[0])
        texts[nid] = open(path, encoding="utf-8").read()

    # season sentences for Word2Vec (identical splitting as build_week6)
    sentence_tokens = []
    for txt in texts.values():
        for s in SENT_SPLIT_RE.split(txt):
            t = TOKEN_RE.findall(s.lower())
            if len(t) >= 3:
                sentence_tokens.append(t)
    log(f"{len(sentence_tokens)} sentences")

    # ---- Word2Vec: retrain identical to build_week6 --------------------------
    model = Word2Vec(sentence_tokens, **w2v_params)
    log(f"Word2Vec: {len(model.wv.index_to_key)} vectors d={w2v_params['vector_size']}")

    # shipped word set: week-6 explorer targets + all fingerprint words + presets
    targets = set(w6words["words"])
    fp_union = {w for pid in ids for w in pages[pid]["fpn"]}
    preset_words = {
        "science", "technology", "experiment", "laboratory", "machine",
        "engineer", "magic", "spell", "sorcerer", "sorcery", "mystical",
        "telepathy", "psychic", "mental", "mind", "brain", "consciousness",
        "strength", "muscle", "fists", "physical", "war", "battle", "soldier",
        "army", "combat", "home", "family", "love", "children", "cosmic",
        "galaxy", "space", "universe", "planet", "city", "earth", "street",
        "gods", "god", "mortal", "humanity", "ancient", "myth", "robots",
        "cyborg", "aliens", "mutants", "humans", "living", "dead",
        "undead", "vampire", "future", "past", "country", "village",
    }
    wanted = sorted((targets | fp_union | preset_words) & set(model.wv.key_to_index))
    log(f"shipping {len(wanted)} vectors of {len(model.wv.index_to_key)}")

    vecs = np.vstack([model.wv[w] for w in wanted])
    scale = float(np.abs(vecs).max())
    q = np.clip(np.rint(vecs / scale * 127.0), -127, 127).astype(np.int8)
    blob = base64.b64encode(q.tobytes()).decode("ascii")

    out_vecs = {
        "meta": {
            "dims": int(w2v_params["vector_size"]),
            "scale": scale,
            "n": len(wanted),
            "quant": "int8 rows, cos_rescaled_by_scale/127",
            "w2v": {**w2v_params, "note": "retrained with identical params/seed as build_week6"},
        },
        "words": wanted,
        "vectors_b64": blob,
    }
    path = os.path.join(PAGES_DIR, "week63_vecs.json")
    json.dump(out_vecs, open(path, "w", encoding="utf-8"), ensure_ascii=False)
    log(f"wrote {path} ({os.path.getsize(path) / 1e6:.2f} MB)")

    # ---- fingerprints with TF-IDF weights -------------------------------------
    df = Counter()
    for nid in ids:
        df.update(set(TOKEN_RE.findall(texts[nid].lower())))
    fp_data = {}
    for nid in ids:
        toks = TOKEN_RE.findall(texts[nid].lower())
        counts = Counter(toks)
        total = len(toks) or 1
        scored = [
            (w, (counts[w] / total) * math.log(N / df[w]))
            for w in pages[nid]["fpn"][:FP_DEPTH]
        ]
        fp_data[nid] = [[w, round(v, 5)] for w, v in scored]

    # ---- preset axes (order: negative pole, positive pole -> drawn left↔right)
    def axis(neg, pos, label, note):
        keep_neg = [w for w in neg if w in model.wv.key_to_index]
        keep_pos = [w for w in pos if w in model.wv.key_to_index]
        if not keep_neg or not keep_pos:
            log(f"axis dropped: {label}")
            return None
        return {"label": label, "neg": keep_neg, "pos": keep_pos, "note": note}

    presets = [a for a in [
        axis(["science", "technology", "experiment", "laboratory", "machine"],
             ["magic", "spell", "sorcerer", "sorcery", "mystical"],
             "science ↔ magic",
             "the course page's classic axis"),
        axis(["strength", "muscle", "fists", "physical"],
             ["telepathy", "psychic", "mental", "mind", "consciousness"],
             "body ↔ mind", "look for the telepaths"),
        axis(["war", "battle", "soldier", "army", "combat"],
             ["home", "family", "love", "children"],
             "war ↔ home", "the bias axis — check who gravitates where"),
        axis(["galaxy", "cosmic", "space", "universe", "planet"],
             ["city", "street", "neighborhood", "earth"],
             "cosmic ↔ street", "Deep-space to the neighborhood beat"),
        axis(["gods", "god", "myth", "ancient"],
             ["humans", "mortal", "humanity", "city"],
             "gods ↔ mortals", "mythic to mundane"),
        axis(["aliens", "robots", "cyborg"],
             ["humans", "mutants"],
             "alien ↔ human", "outsiders to weird biology"),
    ] if a]

    map_payload = {
        "meta": {"nodes": N, "fp_depth": FP_DEPTH,
                 "community_sizes": topics_sizes},
        "axes": presets,
        "pages": {
            nid: {
                "name": pages[nid]["name"],
                "community": pages[nid]["community"],
                "in_degree": pages[nid]["in_degree"],
                "tokens": pages[nid]["tokens"],
                "fpw": fp_data[nid],
            }
            for nid in ids
        },
    }
    path_map = os.path.join(PAGES_DIR, "week63_map.json")
    json.dump(map_payload, open(path_map, "w", encoding="utf-8"), ensure_ascii=False)
    log(f"wrote {path_map} ({os.path.getsize(path_map) / 1e6:.2f} MB)")

    # ---- per-community term counts for the Scattertext-style plot -----------
    terms = sorted(w6words["words"])
    index_of = {w: i for i, w in enumerate(terms)}
    big = list(range(min(N_COMMUNITIES, len(topics_sizes))))
    tokenized = {
        nid: TOKEN_RE.findall(texts[nid].lower()) for nid in ids
    }
    comm = {
        ci: {
            "tokens": sum(len(tokenized[nid]) for nid in ids
                          if pages[nid]["community"] == ci),
            "counts": Counter(),
            "chars": [nid for nid in ids if pages[nid]["community"] == ci],
        }
        for ci in big
    }
    for ci, d in comm.items():
        for nid in d["chars"]:
            for w, c in Counter(t for t in tokenized[nid] if t in index_of).items():
                d["counts"][index_of[w]] += c

    def label(ci):
        best = max(comm[ci]["chars"], key=lambda n: pages[n]["in_degree"])
        return f"C{ci} · {pages[best]['name']} ({topics_sizes[ci]})"

    terms_payload = {
        "meta": {"n_terms": len(terms),
                 "communities": N_COMMUNITIES,
                 "note": "counts per community over the week-6 explorer vocabulary"},
        "labels": [label(ci) for ci in big],
        "terms": terms,
        "communities": [
            {
                "id": ci,
                "tokens": comm[ci]["tokens"],
                "n_chars": topics_sizes[ci],
                "n_unique_terms": len(comm[ci]["counts"]),
                "counts": [[i, c] for i, c in sorted(comm[ci]["counts"].items())],
            }
            for ci in big
        ],
    }
    path_terms = os.path.join(PAGES_DIR, "week63_terms.json")
    json.dump(terms_payload, open(path_terms, "w", encoding="utf-8"),
              ensure_ascii=False)
    log(f"wrote {path_terms} ({os.path.getsize(path_terms) / 1e6:.2f} MB)")

    log("\n== sanity probes ==")
    for pole in ["magic", "science"]:
        vec = model.wv[pole]
        sims = model.wv.similar_by_vector(vec, topn=7)
        log(f"  {pole} → " + ", ".join(w for w, _ in sims))
    u = np.mean([model.wv[w] for w in presets[0]["neg"]], axis=0)
    v = np.mean([model.wv[w] for w in presets[0]["pos"]], axis=0)
    d = (u - v) / np.linalg.norm(u - v)
    probes = next(nid for nid in ids if pages[nid]["name"] == "Doctor Strange")
    for nid in [probes, "Iron_Man_(character)" if "Iron_Man_(character)" in pages else None]:
        if nid is None:
            continue
        toks = tokenized[nid]
        counts = Counter(toks)
        total = len(toks) or 1
        num, den = 0.0, 0.0
        ups = []
        for w, wt in fp_data[nid]:
            if w not in model.wv.key_to_index:
                continue
            c = float(np.dot(model.wv[w], d))
            num += wt * c
            den += wt
            ups.append((w, c, wt))
        ups.sort(key=lambda t: -t[1])
        log(f"  {pages[nid]['name']}: axis pos {num / (den or 1):+.3f} | "
            f"pos pulls: {[w for w, _, _ in ups[:3]]} | "
            f"neg pulls: {[w for w, _, _ in ups[-3:]]}")


if __name__ == "__main__":
    main()
