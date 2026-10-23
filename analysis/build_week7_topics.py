#!/usr/bin/env python3
"""Week 7 topics — NMF topic modeling on the 370 Marvel supervillain pages.

Extracts 10 topics using TF-IDF + Non-negative Matrix Factorization (NMF),
assigns each villain to their dominant topic, and cross-references with
the divergence pairs from build_week7_paths.py.

Output: data/week7/week7_topics.json with:
  meta         — model settings, corpus stats
  topics       — per topic: top words, size, label
  assignments  — per villain: dominant topic, topic distribution
  topic_pairs  — per topic: divergent pairs within that topic (the cross-lens)
  villain_topics — per villain: list of topics they belong to (for detail panel)

Run:  python3 analysis/build_week7_topics.py
"""

import json
import re
import sys
import urllib.parse
from collections import Counter
from pathlib import Path

import numpy as np
from sklearn.decomposition import NMF
from sklearn.feature_extraction.text import TfidfVectorizer, ENGLISH_STOP_WORDS

HERE = Path(__file__).resolve().parent
DATA = HERE.parent / "data"
VILLAIN_DIR = DATA / "Marvel_Comics_supervillains"
PAGES_DIR = VILLAIN_DIR / "pages"
WEEK7_JSON = DATA / "week7" / "week7_supervillains.json"
OUT_PATH = DATA / "week7" / "week7_topics.json"

N_TOPICS = 10
MAX_FEATURES = 5000
MIN_DF = 3
MAX_DF = 0.5

# Extra stop words: common Wikipedia boilerplate + character-name fragments
EXTRA_STOP = set(ENGLISH_STOP_WORDS) | {
    "marvel", "comics", "comic", "character", "characters", "villain",
    "villains", "superhero", "superheroes", "appearing", "appears", "appear",
    "published", "publisher", "series", "issue", "issues", "story", "storyline",
    "created", "creator", "writer", "artist", "first", "original", "also",
    "one", "two", "new", "later", "since", "would", "could", "many", "often",
    "usually", "known", "called", "name", "named", "see", "refer", "citation",
    "ref", "cite", "external", "link", "category", "isbn", "vol", "no",
    "debut", "fictional", "universe", "continuity", "storyline", "arc",
    "team", "teams", "group", "groups", "member", "members", "leader",
    "based", "inspired", "version", "versions", "incarnation", "incarnations",
    "reprint", "reprinted", "collected", "edition", "trade", "paperback",
    "hardcover", "omnibus", "anthology", "graphic", "novel", "novels",
}

# Common Marvel name fragments to filter (first/last names that appear everywhere)
NAME_FRAGMENTS = {
    "man", "woman", "men", "women", "boy", "girl", "king", "queen",
    "doctor", "dr", "mister", "mr", "mrs", "ms", "miss", "lord", "lady",
    "captain", "general", "colonel", "sergeant", "professor", "prof",
    "baron", "count", "duke", "sir", "master", "mistress",
}


def read_nodes(path: Path):
    """node_id list from the nodes TSV."""
    ids = []
    for line in path.read_text(encoding="utf-8").splitlines():
        if not line or line.startswith("#"):
            continue
        fields = line.split("\t")
        if fields[0] == "node_id":
            continue
        ids.append(fields[0])
    return ids


def load_pages(node_ids):
    """Load page texts for all node_ids. Returns dict nid -> text."""
    manifest_path = PAGES_DIR / "manifest.json"
    manifest = {}
    if manifest_path.exists():
        manifest = json.loads(manifest_path.read_text(encoding="utf-8")).get("pages", {})

    texts = {}
    missing = []
    for nid in node_ids:
        info = manifest.get(nid)
        fname = urllib.parse.quote(nid, safe="()'") + ".txt"
        if info and (PAGES_DIR / info["file"]).exists():
            fname = info["file"]
        path = PAGES_DIR / fname
        if path.exists():
            texts[nid] = path.read_text(encoding="utf-8")
        else:
            missing.append(nid)
    return texts, missing


def main():
    print("loading nodes and pages...")
    node_ids = read_nodes(VILLAIN_DIR / "Marvel_Comics_supervillains_nodes.tsv")
    names = {}
    for line in (VILLAIN_DIR / "Marvel_Comics_supervillains_nodes.tsv").read_text(encoding="utf-8").splitlines():
        if line.startswith("#") or not line:
            continue
        fields = line.split("\t")
        if fields[0] == "node_id":
            continue
        names[fields[0]] = fields[1]

    texts, missing = load_pages(node_ids)
    print(f"  {len(texts)} pages loaded, {len(missing)} missing")

    # Build TF-IDF
    print("building TF-IDF...")
    # Filter out name fragments from stop words
    stop_words = list(EXTRA_STOP | NAME_FRAGMENTS)
    vec = TfidfVectorizer(
        max_features=MAX_FEATURES,
        min_df=MIN_DF,
        max_df=MAX_DF,
        stop_words=stop_words,
        ngram_range=(1, 2),
        sublinear_tf=True,
    )
    X = vec.fit_transform([texts[nid] for nid in node_ids])
    feature_names = vec.get_feature_names_out()
    print(f"  TF-IDF matrix: {X.shape[0]} docs x {X.shape[1]} features")

    # Run NMF
    print(f"running NMF with {N_TOPICS} topics...")
    nmf = NMF(
        n_components=N_TOPICS,
        random_state=42,
        max_iter=500,
        init="nndsvda",
        alpha_W=0.0,
        alpha_H=0.0,
        l1_ratio=0.0,
    )
    W = nmf.fit_transform(X)  # N x K: document-topic weights
    H = nmf.components_       # K x F: topic-feature weights
    print(f"  reconstruction error: {nmf.reconstruction_err_:.2f}")

    # Extract topics
    topics = []
    for k in range(N_TOPICS):
        top_idx = np.argsort(H[k])[::-1][:15]
        top_words = [(feature_names[i], round(float(H[k][i]), 4)) for i in top_idx]
        # Count docs where this is the dominant topic
        dominant = np.sum(np.argmax(W, axis=1) == k)
        topics.append({
            "id": k,
            "words": top_words,
            "size": int(dominant),
            "label": "",  # filled in below
        })

    # Sort topics by size (largest first) and re-index
    topics.sort(key=lambda t: -t["size"])
    for new_id, t in enumerate(topics):
        t["id"] = new_id

    # Generate labels from top words
    for t in topics:
        top_words = [w for w, _ in t["words"][:5]]
        t["label"] = " / ".join(top_words[:3])

    # Assign each villain to topics
    assignments = {}
    villain_topics = {nid: [] for nid in node_ids}
    for i, nid in enumerate(node_ids):
        # Dominant topic
        dominant = int(np.argmax(W[i]))
        # Topic distribution (normalized)
        dist = W[i] / (W[i].sum() + 1e-10)
        assignments[nid] = {
            "dominant": dominant,
            "distribution": {str(k): round(float(dist[k]), 4) for k in range(N_TOPICS)},
        }
        # List of topics this villain belongs to (weight > 0.1)
        for k in range(N_TOPICS):
            if dist[k] > 0.1:
                villain_topics[nid].append({
                    "topic": k,
                    "weight": round(float(dist[k]), 4),
                })
        villain_topics[nid].sort(key=lambda x: -x["weight"])

    # Cross-reference with divergence pairs
    print("loading divergence pairs...")
    week7 = json.loads(WEEK7_JSON.read_text(encoding="utf-8"))
    pairs = week7.get("pairs", {})

    # For each topic, find divergent pairs where both villains are in that topic
    topic_pairs = {t["id"]: [] for t in topics}
    for key, p in pairs.items():
        if p.get("linked"):
            continue
        if p["cos"] < 0.5:
            continue
        if p["path"] >= 0 and p["path"] < 3:
            continue
        # Both villains must be in the same dominant topic
        a_topic = assignments.get(p["a"], {}).get("dominant")
        b_topic = assignments.get(p["b"], {}).get("dominant")
        if a_topic is not None and a_topic == b_topic:
            topic_pairs[a_topic].append({
                "a": p["a"],
                "b": p["b"],
                "cos": p["cos"],
                "path": p["path"],
                "divergence": p["divergence"],
            })

    # Sort pairs within each topic by divergence
    for tid in topic_pairs:
        topic_pairs[tid].sort(key=lambda x: -x["divergence"])
        topic_pairs[tid] = topic_pairs[tid][:20]  # top 20 per topic

    # Count divergent pairs per topic for summary
    topic_div_counts = {t["id"]: len(topic_pairs[t["id"]]) for t in topics}

    # Build output
    payload = {
        "meta": {
            "method": "TF-IDF + NMF",
            "n_topics": N_TOPICS,
            "max_features": MAX_FEATURES,
            "min_df": MIN_DF,
            "max_df": MAX_DF,
            "ngram_range": [1, 2],
            "n_docs": len(node_ids),
            "n_missing_pages": len(missing),
            "reconstruction_error": round(float(nmf.reconstruction_err_), 2),
            "random_state": 42,
        },
        "topics": topics,
        "assignments": assignments,
        "villain_topics": villain_topics,
        "topic_pairs": topic_pairs,
        "topic_div_counts": topic_div_counts,
        "names": names,
    }

    OUT_PATH.write_text(json.dumps(payload, indent=1), encoding="utf-8")
    print(f"\nwrote {OUT_PATH}")

    # Report
    print("\n----- topic report -----")
    for t in topics:
        print(f"\nTopic {t['id']} ({t['size']} villains): {t['label']}")
        print(f"  top words: {', '.join(w for w, _ in t['words'][:10])}")
        div_count = topic_div_counts[t["id"]]
        print(f"  divergent pairs within topic: {div_count}")
        if div_count > 0:
            top_pair = topic_pairs[t["id"]][0]
            print(f"    top: {names[top_pair['a']]} <-> {names[top_pair['b']]} "
                  f"(cos={top_pair['cos']:.3f}, path={top_pair['path']})")


if __name__ == "__main__":
    main()
