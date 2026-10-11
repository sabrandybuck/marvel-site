#!/usr/bin/env python3
"""
Week 6 analysis — five ways to say "close" over the 303 Marvel hero pages.

Reads the frozen week-1 network (nodes, edges) and the plain-text pages in
../data/marvel_pages/, computes every representation taught in week 6, and
freezes three JSON payloads for the browser:

  week6_summary.json — document level:
    meta      — corpus + headline numbers (mean linked neighbours per mode,
                LDA-vs-network agreement, random baseline)
    pages     — per character: display name, in-degree, undirected links,
                Louvain community, tokens, TF-IDF fingerprints (with and
                without proper names)
    neighbors — per character: top-10 lists (other, cosine, top shared words)
                for raw counts, TF-IDF and LDA topic-mixtures
    unlinked  — the 20 textually-closest structurally-unlinked pairs (TF-IDF)
    topics    — both LDA fits (with/without names): topic words + our labels

  week6_words.json — word level (lazily fetched by the explorable):
    meta      — vocab thresholds, corpus stats
    words     — per word: corpus/df counts, top PPMI context dimensions,
                nearest neighbours under raw-count cosine, PPMI cosine and
                Word2Vec (gensim), for target vocabulary filtered by count

  week6_sents.json — sentence store (lazily fetched):
    pages     — per character: sentence-split text (capped length), for the
                concordance verification panel

Definitions used (matching the week-6 course page):
  tf(t,d)   = count(t,d) / |d|
  idf(t)    = ln(N / df(t))
  cosine    = dot products of the weighted vectors
  Lone stopword filtering is NOT applied inside TF-IDF (that is the point).

Not stdlib-only (week 6 is the library week): scipy + scikit-learn + gensim
+ networkx. Run:  ~/.venvs/week6-venv/bin/python build_week6.py
"""

import json
import math
import os
import re
import sys
import urllib.parse
from collections import Counter, defaultdict

import numpy as np
import networkx as nx
from scipy import sparse
from sklearn.decomposition import LatentDirichletAllocation
from sklearn.feature_extraction.text import CountVectorizer, ENGLISH_STOP_WORDS
from gensim.models import Word2Vec

HERE = os.path.dirname(os.path.abspath(__file__))
DATA = os.path.join(HERE, "..", "data")
PAGES_DIR = os.path.join(DATA, "marvel_pages")
WEEK1 = os.path.join(DATA, "week1")

TOKEN_RE = re.compile(r"[a-z]+(?:'[a-z]+)?")
SENT_SPLIT_RE = re.compile(r"(?<=[.!?])\s+")

TOP_K = 10                # neighbours per representation
SHARED_WORDS_TOP = 40     # fingerprint depth for pair "why" words
WORD_MIN_COUNT = 40       # word-explorer vocab: min corpus count
WORD_MIN_DF = 15          # word-explorer vocab: min document frequency
SENT_MAX_CHARS = 260      # sentence store cap per sentence
WORD2VEC_PARAMS = dict(vector_size=100, window=5, min_count=5, sg=1,
                       seed=0, workers=1, epochs=5)
SENTENCE_STORE_SENTS_PER_PAIR_PAGE = 2

# Top-12 lists kept for each target word in the word explorer.
NB_TOP = 12
PPMI_DIM_TOP = 10

TOPIC_LABELS = {
    "with_names": [
        "X-Men core", "Spider-Man's corner", "Cosmic & mythic",
        "Flight & armor", "Knights of the night", "Wakanda & royals",
        "Riders & ghosts", "Venom & gamma",
    ],
    "no_names": [
        "Media boilerplate", "Symbiotes & hosts", "Mutant life",
        "Pulp origins", "Gods & vampires", "Screen & sword",
        "Agents & training", "Suits & reboots",
    ],
}

# ---- small helpers ----------------------------------------------------------


def log(*a):
    print(*a, file=sys.stderr)


def load_nodes():
    path = os.path.join(WEEK1, "week1_nodes.tsv")
    with open(path, encoding="utf-8") as fh:
        lines = [ln.rstrip("\n") for ln in fh if not ln.startswith("#")]
    hdr = lines[0].split("\t")
    name_i = hdr.index("name")
    return [(ln.split("\t")[0], ln.split("\t")[name_i]) for ln in lines[1:]]


def load_edges():
    path = os.path.join(WEEK1, "week1_edges.tsv")
    edges = []
    with open(path, encoding="utf-8") as fh:
        for ln in fh:
            if ln.startswith("#") or ln.startswith("source\t"):
                continue
            src, tgt = ln.rstrip("\n").split("\t")[:2]
            edges.append((src, tgt))
    return edges


def load_pages(node_ids):
    files = {}
    for fn in os.listdir(PAGES_DIR):
        if not fn.endswith(".txt") or fn == "README.txt":
            continue
        node_id = urllib.parse.unquote(fn[:-4])
        files[node_id] = os.path.join(PAGES_DIR, fn)
    pages = {}
    for nid in node_ids:
        path = files.get(nid)
        if path is None:
            raise SystemExit(f"page file missing for {nid}")
        with open(path, encoding="utf-8") as fh:
            pages[nid] = fh.read()
    return pages


def tokenize(text):
    return TOKEN_RE.findall(text.lower())


def detect_proper_names(page_texts):
    """Course heuristic: a token appearing capitalized more than half its
    uses is treated as a proper name (it's in the words, not the lemmas)."""
    seen, capitalized = Counter(), Counter()
    for text in page_texts.values():
        for w in re.findall(r"[A-Za-z]+", text):
            seen[w.lower()] += 1
            capitalized[w.lower()] += w[0].isupper()
    return {w for w in seen if capitalized[w] > seen[w] / 2}


def split_sentences(text):
    out = []
    for s in SENT_SPLIT_RE.split(text):
        s = " ".join(s.split())
        if len(s) >= 15 and any(c.isalpha() for c in s):
            if len(s) > SENT_MAX_CHARS:
                s = s[: SENT_MAX_CHARS - 1].rstrip() + "…"
            out.append(s)
    return out


def sparse_topk(M_row, k, self_idx=None, exclude=None):
    """Row-wise top-k of a dense row array returning (idx, val) pairs."""
    order = np.argsort(M_row)[::-1]
    out = []
    for idx in order:
        if self_idx is not None and idx == self_idx:
            continue
        if exclude is not None and idx in exclude:
            continue
        v = float(M_row[idx])
        if v <= 0:
            break
        out.append((int(idx), v))
        if len(out) >= k:
            break
    return out


# ---- main --------------------------------------------------------------------


def main():
    np.random.seed(0)
    nodes = load_nodes()
    node_ids = [nid for nid, _ in nodes]
    names = {nid: name for nid, name in nodes}
    edges = load_edges()
    pages = load_pages(node_ids)
    N = len(nodes)
    log(f"{N} nodes, {len(edges)} directed edges")

    page_tokens = {nid: tokenize(txt) for nid, txt in pages.items()}
    page_counts = {nid: Counter(toks) for nid, toks in page_tokens.items()}

    # ---- vocabulary / df ----------------------------------------------------
    global_df = Counter()
    for counts in page_counts.values():
        global_df.update(counts.keys())
    vocab = sorted(global_df)
    index_of = {w: i for i, w in enumerate(vocab)}
    V = len(vocab)

    # doc-term matrix (raw counts)
    indptr, indices, data = [0], [], []
    for nid in node_ids:
        items = sorted((index_of[w], c) for w, c in page_counts[nid].items())
        indices.extend(i for i, _ in items)
        data.extend(c for _, c in items)
        indptr.append(len(indices))
    A = sparse.csr_matrix((data, indices, indptr), shape=(N, V), dtype=np.float64)

    # ---- TF-IDF (course page definitions) -----------------------------------
    Nf = float(N)
    idf = np.array([math.log(Nf / global_df[w]) for w in vocab])
    tf_norm = np.array([len(page_tokens[nid]) for nid in node_ids], dtype=np.float64)
    Tf = A.multiply(1.0 / tf_norm[:, None]).tocsr()
    Tfidf = Tf.multiply(idf[None, :]).tocsr()

    def cosine_of(M):
        """N x N cosine similarity of the rows of M (dense, 303^2 is small)."""
        S = (M @ M.T).tocsr()
        norms = np.sqrt(np.maximum(S.diagonal(), 0))
        D = np.asarray(S.todense(), dtype=np.float64)
        denom = np.outer(norms, norms)
        denom[denom == 0] = 1e-30
        D /= denom
        return D

    D_counts = cosine_of(A)
    D_tfidf = cosine_of(Tfidf)

    def to_csr_topk(D):
        return [sparse_topk(D[i], TOP_K, self_idx=i) for i in range(N)]

    tok_counts = to_csr_topk(D_counts)
    tok_tfidf = to_csr_topk(D_tfidf)

    # ---- proper names (course heuristic) ------------------------------------
    proper = detect_proper_names(pages)
    log(f"proper-name filter: {len(proper)} words")

    # fingerprint helpers: tfidf words of a page, optionally name-free
    def fingerprint(nid, keep_names, depth=SHARED_WORDS_TOP):
        counts = page_counts[nid]
        total = len(page_tokens[nid]) or 1
        words = [
            w for w in counts
            if len(w) > 1
            and (keep_names or w not in proper)
            and global_df[w] < N  # df==N words carry zero idf
        ]
        words.sort(key=lambda w: (counts[w] / total) * idf[index_of[w]],
                   reverse=True)
        return words[:depth]

    fp_named = {nid: fingerprint(nid, True) for nid in node_ids}
    fp_noname = {nid: fingerprint(nid, False) for nid in node_ids}

    def shared_words(a, b):
        ca = Counter({w: i for i, w in enumerate(fp_named[a])})
        best = []
        for w in fp_named[b]:
            if w in ca:
                # weight by min combined rank (lower rank both sides = stronger)
                best.append((min(ca[w], fp_named[b].index(w)), w))
        best.sort()
        return [w for _, w in best[:4]]

    # ---- undirected links + Louvain communities ------------------------------
    G = nx.Graph()
    G.add_nodes_from(node_ids)
    und_edges = set()
    for s, t in edges:
        key = (s, t) if s < t else (t, s)
        if key not in und_edges:
            und_edges.add(key)
            G.add_edge(s, t)
    links = {nid: sorted(G.neighbors(nid)) for nid in node_ids}

    comms = nx.community.louvain_communities(G, seed=42)
    comms = sorted(comms, key=len, reverse=True)
    comm_of = {}
    for ci, members in enumerate(comms):
        for m in members:
            comm_of[m] = ci
    log(f"Louvain: {len(comms)} communities, sizes {[len(c) for c in comms][:8]} ...")

    # ---- LDA (two fits: default stopwords, and +proper names) ----------------
    def fit_lda(extra_stop=frozenset()):
        stop = sorted(set(ENGLISH_STOP_WORDS) | set(extra_stop))
        vec = CountVectorizer(stop_words=stop, min_df=5, max_df=0.5,
                              token_pattern=r"(?u)\b[a-zA-Z]{2,}\b")
        X = vec.fit_transform(pages[nid] for nid in node_ids)
        lda = LatentDirichletAllocation(n_components=8, random_state=0,
                                        learning_method="batch")
        theta = lda.fit_transform(X)          # N x K (rows sum to 1)
        theta /= theta.sum(axis=1, keepdims=True)
        vocab_lda = vec.get_feature_names_out()
        topics = []
        for comp in lda.components_:
            top = comp.argsort()[::-1][:12]
            s = float(comp.sum())
            topics.append([(vocab_lda[i], round(float(comp[i]) / s, 4)) for i in top])
        return {
            "features": vocab_lda,
            "theta": theta,
            "topics": topics,
            "n_docs": X.shape[0],
            "n_terms": X.shape[1],
        }

    lda_with = fit_lda()
    lda_wo = fit_lda(extra_stop=proper)
    log(f"LDA(with names): {lda_with['n_terms']} terms; "
        f"LDA(no names): {lda_wo['n_terms']} terms")

    gram_with = lda_with["theta"] @ lda_with["theta"].T
    gram_wo = lda_wo["theta"] @ lda_wo["theta"].T
    lnb_with = [sparse_topk(gram_with[i], TOP_K, self_idx=i) for i in range(N)]
    lnb_wo = [sparse_topk(gram_wo[i], TOP_K, self_idx=i) for i in range(N)]

    def lda_shared_topics(theta_a, theta_b, k=2):
        return sorted(range(len(theta_a)),
                      key=lambda k_: -min(theta_a[k_], theta_b[k_]))[:k]

    # ---- neighbour payload ---------------------------------------------------
    def build_neighbors(tops, mode):
        res = {}
        for i, nid in enumerate(node_ids):
            items = []
            for j, cos in tops[i]:
                other = node_ids[j]
                items.append({
                    "o": other,
                    "c": round(cos, 4),
                    "w": shared_words(nid, other) if mode in ("counts", "tfidf") else [],
                })
            res[nid] = items
        return res

    nb_counts = build_neighbors(tok_counts, "counts")
    nb_tfidf = build_neighbors(tok_tfidf, "tfidf")

    nb_lda_with, nb_lda_wo = {}, {}
    theta_with, theta_wo = lda_with["theta"], lda_wo["theta"]
    for i, nid in enumerate(node_ids):
        def items_row(tops, theta, with_words):
            out = []
            for j, cos in tops[i]:
                other = node_ids[j]
                shared = lda_shared_topics(theta[i], theta[j])
                out.append({
                    "o": other,
                    "c": round(cos, 4),
                    "t": shared,
                    "w": shared_words(nid, other) if with_words else [],
                })
            return out
        nb_lda_with[nid] = items_row(lnb_with, theta_with, True)
        nb_lda_wo[nid] = items_row(lnb_wo, theta_wo, True)

    # ---- headline stats -------------------------------------------------------
    def linked_in_top10(nbs):
        vals = [sum(1 for it in nbs[nid] if it["o"] in links[nid]) for nid in node_ids]
        return sum(vals) / len(vals)

    def same_community_frac(nbs):
        vals = []
        for nid in node_ids:
            tops = nbs[nid]
            if not tops:
                continue
            vals.append(sum(1 for it in tops if comm_of[it["o"]] == comm_of[nid])
                        / len(tops))
        return sum(vals) / len(vals)

    rng = np.random.default_rng(7)
    random_linked = []
    for nid in node_ids:
        pool = [x for x in node_ids if x != nid]
        sample = rng.choice(pool, TOP_K, replace=False)
        random_linked.append(sum(1 for x in sample if x in links[nid]) / TOP_K)
    random_baseline = float(np.mean(random_linked))

    # ---- closest unlinked pairs (TF-IDF cosine) ------------------------------
    unlinked = []
    for i in range(N):
        for j in range(i + 1, N):
            a, b = node_ids[i], node_ids[j]
            if b in set(links[a]):
                continue
            d = float(D_tfidf[i, j])
            if d > 0:
                unlinked.append((d, a, b))
    unlinked.sort(reverse=True)
    unlinked_payload = [{
        "a": a, "b": b, "c": round(d, 4), "ca": comm_of[a], "cb": comm_of[b],
        "w": shared_words(a, b),
    } for d, a, b in unlinked[:20]]

    # ---- topic labels (placeholders; updated after inspecting word lists) ----
    lda_payload = {
        "with_names": {
            "labels": TOPIC_LABELS["with_names"],
            "topics": [[{"w": w, "p": p} for w, p in t] for t in lda_with["topics"]],
        },
        "no_names": {
            "labels": TOPIC_LABELS["no_names"],
            "topics": [[{"w": w, "p": p} for w, p in t] for t in lda_wo["topics"]],
        },
    }

    # ---- pages payload --------------------------------------------------------
    pages_payload = {}
    for i, nid in enumerate(node_ids):
        pages_payload[nid] = {
            "name": names[nid],
            "in_degree": int(sum(1 for s, t in edges if t == nid)),
            "tokens": len(page_tokens[nid]),
            "community": comm_of[nid],
            "links": links[nid],
            "fp": fp_named[nid][:8],
            "fpn": fp_noname[nid][:8],
            # document-topic mixtures (rows sum to 1) for the deep-dive page;
            # _n = the fit with proper names removed
            "theta": [round(float(x), 4) for x in theta_with[i]],
            "theta_n": [round(float(x), 4) for x in theta_wo[i]],
        }

    stats = {
        "linked_top10": {
            "counts": round(linked_in_top10(nb_counts), 2),
            "tfidf": round(linked_in_top10(nb_tfidf), 2),
            "lda": round(linked_in_top10(nb_lda_with), 2),
            "random": round(random_baseline * 10, 2),
        },
        "same_community": {
            "tfidf": round(same_community_frac(nb_tfidf), 3),
            "lda": round(same_community_frac(nb_lda_with), 3),
        },
        "n_communities": len(comms),
        "community_sizes": [len(c) for c in comms],
    }
    log("linked-in-top10 stats:", stats["linked_top10"])
    log("same-community:", stats["same_community"])

    # ---- write doc-level summary ---------------------------------------------
    out_doc = {
        "meta": {
            "nodes": N,
            "tokens": sum(len(t) for t in page_tokens.values()),
            "vocab": V,
            "n_topics": 8,
            "seed": {"lda": 0, "louvain": 42, "word2vec": 0},
            "stats": stats,
        },
        "pages": pages_payload,
        "neighbors": {
            "counts": nb_counts,
            "tfidf": nb_tfidf,
            "lda_with": nb_lda_with,
            "lda_wo": nb_lda_wo,
        },
        "unlinked": unlinked_payload,
        "topics": lda_payload,
    }
    path_doc = os.path.join(PAGES_DIR, "week6_summary.json")
    with open(path_doc, "w", encoding="utf-8") as fh:
        json.dump(out_doc, fh, ensure_ascii=False)
    log(f"wrote {path_doc} ({os.path.getsize(path_doc) / 1e6:.2f} MB)")

    # ---- word level: context windows + PPMI + Word2Vec ------------------------
    sentence_tokens = []
    for txt in pages.values():
        for s in SENT_SPLIT_RE.split(txt):
            toks = TOKEN_RE.findall(s.lower())
            if len(toks) >= 3:
                sentence_tokens.append(toks)
    cf_sents = Counter(w for s in sentence_tokens for w in s)
    log(f"{len(sentence_tokens)} sentences, {sum(cf_sents.values())} tokens")

    targets = [w for w in vocab
               if cf_sents[w] >= WORD_MIN_COUNT and global_df[w] >= WORD_MIN_DF]
    tset = set(targets)
    # every character's fingerprint words are guaranteed entry points into the
    # word explorer, even when they are too rare for the thresholds
    fp_extra = {w for nid in node_ids for fp in (fp_named, fp_noname)
                for w in fp[nid][:8] if w in vocab}
    added = sorted(fp_extra - tset)
    targets.extend(added)
    targets.sort()
    tset = set(targets)
    log(f"word-explorer targets: {len(targets)} "
        f"(count>={WORD_MIN_COUNT} & df>={WORD_MIN_DF}, +{len(added)} fingerprint)")

    WINDOW = 5
    ctx_counts = defaultdict(Counter)   # target -> context word counts
    for toks in sentence_tokens:
        L = len(toks)
        for i, w in enumerate(toks):
            if w not in tset:
                continue
            row = ctx_counts[w]
            for j in range(max(0, i - WINDOW), min(L, i + WINDOW + 1)):
                if j != i:
                    row[toks[j]] += 1

    # context vocabulary: words that ever appear in a window (restricted to
    # the same targets keeps the dictionary small; marginals use the observed
    # pair total, exactly as in the course example)
    ctx_vocab = sorted({c for row in ctx_counts.values() for c in row})
    ctx_index = {w: i for i, w in enumerate(ctx_vocab)}
    n_pairs = sum(sum(r.values()) for r in ctx_counts.values())
    log(f"context vocab {len(ctx_vocab)}, observed pair total {n_pairs}")

    Wt = len(targets)
    C = sparse.lil_matrix((Wt, len(ctx_vocab)), dtype=np.float64)
    for t_i, w in enumerate(targets):
        row = ctx_counts[w]
        for c, cnt in row.items():
            C[t_i, ctx_index[c]] = cnt
    C = C.tocsr()
    total_pairs = C.sum()
    Pw = np.asarray(C.sum(axis=1)).ravel() / total_pairs
    Pc = np.asarray(C.sum(axis=0)).ravel() / total_pairs

    ratios = C.tocoo()
    pmi = np.zeros(ratios.nnz)
    for k, (i, j, v) in enumerate(zip(ratios.row, ratios.col, ratios.data)):
        pmi[k] = math.log2((v / total_pairs) / (Pw[i] * Pc[j]))
    PPMI = sparse.csr_matrix(
        (np.maximum(pmi, 0.0), (ratios.row, ratios.col)), shape=C.shape)

    def cosine_topk(M, k):
        """Row-wise top-k cosine neighbours from the sparse matrix M.
        Normalise rows, then score each row's own nnz columns (cheap and
        exact for this sparse product size; no dense 1955^2 blowup)."""
        M = M.tocsr().astype(np.float64)
        norms = np.sqrt(np.asarray(M.multiply(M).sum(axis=1)).ravel())
        norms[norms == 0] = 1.0
        Mn = (sparse.diags(1.0 / norms) @ M).tocsr()
        S = (Mn @ Mn.T).tocsr()
        out = []
        for i in range(Wt):
            row = S.getrow(i).tocoo()
            cands = [(float(v), int(j)) for j, v in zip(row.col, row.data) if j != i]
            cands.sort(reverse=True)
            out.append([(j, v) for v, j in cands[:k]])
        return out

    nb_ppmi = cosine_topk(PPMI, NB_TOP)
    nb_counts_w = cosine_topk(C, NB_TOP)

    w2v = Word2Vec(sentence_tokens, **WORD2VEC_PARAMS)
    log("Word2Vec trained:", len(w2v.wv), "word vectors")

    words_payload = {}
    for t_i, w in enumerate(targets):
        dims = PPMI.getrow(t_i).tocoo()
        pairs = sorted(zip(dims.col, dims.data), key=lambda t: -t[1])[:PPMI_DIM_TOP]
        dims_out = [[ctx_vocab[j], round(float(v), 3)] for j, v in pairs]

        def fmt(nbs):
            return [[targets[j], round(v, 3)] for j, v in nbs[t_i]]

        in_model = w in w2v.wv
        sim = w2v.wv.most_similar(w, topn=NB_TOP) if in_model else []
        words_payload[w] = {
            "cf": cf_sents[w],
            "df": global_df[w],
            "dims": dims_out,
            "nb_counts": fmt(nb_counts_w),
            "nb_ppmi": fmt(nb_ppmi),
            "nb_w2v": [[u, round(s, 3)] for u, s in sim],
        }

    out_words = {
        "meta": {
            "window": WINDOW,
            "min_count": WORD_MIN_COUNT,
            "min_df": WORD_MIN_DF,
            "n_targets": len(targets),
            "n_context_terms": len(ctx_vocab),
            "n_pairs_observed": int(total_pairs),
            "w2v": WORD2VEC_PARAMS,
        },
        "words": words_payload,
    }
    path_words = os.path.join(PAGES_DIR, "week6_words.json")
    with open(path_words, "w", encoding="utf-8") as fh:
        json.dump(out_words, fh, ensure_ascii=False)
    log(f"wrote {path_words} ({os.path.getsize(path_words) / 1e6:.2f} MB)")

    # ---- sentence store --------------------------------------------------------
    sents_payload = {nid: split_sentences(pages[nid]) for nid in node_ids}
    out_sents = {"pages": sents_payload}
    path_sents = os.path.join(PAGES_DIR, "week6_sents.json")
    with open(path_sents, "w", encoding="utf-8") as fh:
        json.dump(out_sents, fh, ensure_ascii=False)
    log(f"wrote {path_sents} ({os.path.getsize(path_sents) / 1e6:.2f} MB)")

    # ---- console summary for labelling / prose --------------------------------
    log("\n== LDA WITH names (topic #, top words) ==")
    for k, t in enumerate(lda_with["topics"]):
        log(f"  {k}: " + ", ".join(w for w, _ in t[:10]))
    log("\n== LDA WITHOUT names ==")
    for k, t in enumerate(lda_wo["topics"]):
        log(f"  {k}: " + ", ".join(w for w, _ in t[:10]))

    log("\n== headline checks ==")
    for label, nid in [("Storm", None)]:  # resolve names below
        pass
    by_name = {names[nid]: nid for nid in node_ids}
    for probe in ["Storm", "Human Torch (android)", "Emma Frost", "Jack Frost (Marvel Comics)"]:
        nid = by_name.get(probe)
        if nid:
            top3 = ", ".join(names[it["o"]] for it in nb_tfidf[nid][:3])
            log(f"  {probe}: {top3}")
    if unlinked_payload:
        for it in unlinked_payload[:6]:
            log(f"  unlinked pair: {names[it['a']]} ~ {names[it['b']]} "
                f"({it['c']:.3f}) {it['w']}")


if __name__ == "__main__":
    main()
