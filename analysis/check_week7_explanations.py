#!/usr/bin/env python3
"""Week 7 -- reproduce the statistics quoted in the explanation sections of posts/week-7.html.

Reads saved files only (no embedding model, no embedding cache, nothing is written):

  data/week7/week7_pairs.tsv        cosine + directed distances of all 68,265 unordered pairs
  data/week7/week7_characters.json  names, word counts, degrees and the 1,136 directed edges
  data/Marvel_Comics_supervillains/pages/*.txt   saved page text of the 370 pages
  posts/week-7.html                 only to compare the five-pair table with the data

Run from the repository root (stdlib only, deterministic):

    python analysis/check_week7_explanations.py

Exit status 0 when every quoted number is reproduced, 1 otherwise. Statistics whose original
definition is not saved in the repository are printed as RECONSTRUCTED, with the rule used here,
and never counted as a pass or a failure.

DEFINITIONS (used throughout)
  pages              the 370 pages of Category:Marvel Comics supervillains.
  pairs              unordered pairs {A, B}, A != B. 370 pages -> 68,265 pairs.
  long three         "Naga (Marvel Comics)", "Tundra (Marvel Comics)", "Shepard (comics)" (6,503 / 18,047 / 8,697 words). The post leaves them out of
                     its pair selection and of the proxy statistics below. 367 pages -> 67,161 pairs;
                     the other 1,104 pairs involve at least one of the three.
  d(A->B)            number of links on the shortest DIRECTED path from A to B inside the 370-page graph
                     (the d_ab / d_ba columns of week7_pairs.tsv); empty = no directed path.
                     Absence of a path says nothing about links outside the 370 pages.
  high-cosine pair   cosine >= 0.60 (among the 67,161 pairs unless stated).
  path category      both = d both ways; one-way = d in exactly one direction; none = neither.
  far pair           high-cosine, at least one directed path exists, and the SHORTER of the existing
                     distances is >= 5 (this is exactly build_week7_pairs.py's far_but_reachable rule:
                     reach != none and min_dist >= 5). Not "any direction >= 5". Consequences: a pair with a
                     path BOTH ways needs both distances >= 5 (the shorter one is >= 5); a pair with a path in
                     ONE direction only is judged by that single distance; a pair with no path is excluded.
                     The script reports the both-ways / one-way split of the far pairs (16 / 33).
  title word         word of the page title without its bracketed part (lower-case, [a-z0-9'] tokens),
                     excluding: the, of, and, a, marvel, comics, character, man, woman.
  franchise          of 17 hero/team names, the one the page text mentions most (case-insensitive,
                     whole-word, hyphen-aware); needs >= 3 mentions; ties go to the earlier name in the list.
  name mention       page title without its bracketed part occurs as a whole word (case-insensitive,
                     hyphen-aware) in the other page's text. Aliases and nicknames are NOT detected.
"""
import csv
import json
import math
import re
import sys
import urllib.parse
from collections import Counter, defaultdict, deque
from pathlib import Path

REPO = Path(__file__).resolve().parent.parent
D7 = REPO / "data" / "week7"
PAGES = REPO / "data" / "Marvel_Comics_supervillains" / "pages"
HTML = REPO / "posts" / "week-7.html"

MIN_COS, FAR_MIN = 0.60, 5
LONG_BASE = ("Naga", "Tundra", "Shepard")
STOP = {"the", "of", "and", "a", "marvel", "comics", "character", "man", "woman"}
FRANCHISES = ["Spider-Man", "Iron Man", "Captain America", "Thor", "Hulk", "Daredevil", "Fantastic Four", "X-Men",
              "Avengers", "Punisher", "Wolverine", "Doctor Strange", "Nova", "Spider-Woman", "Black Panther",
              "Luke Cage", "Namor"]
FEATURED = [  # (A, B) in the order of the post's table
    ("Firebrand_(Marvel_Comics)", "Firepower_(comics)"),
    ("Doom_2099", "Kristoff_Vernard"),
    ("Masked_Marauder", "Gentleman_(character)"),
    ("Gorgon_(Inhuman)", "Lady_Gorgon"),
    ("Condor_(comics)", "Flying_Tiger_(Marvel_Comics)"),
]
# One shortest path per direction as quoted in the post (full node ids, endpoints included).
QUOTED_PATHS = [
    ("Firebrand_(Marvel_Comics)", "Firepower_(comics)", ["Firebrand_(Marvel_Comics)", "Flying_Tiger_(Marvel_Comics)", "Tiger_Shark_(Marvel_Comics)", "Attuma", "Orka_(character)", "Iron_Monger", "Guardsman_(character)", "Firepower_(comics)"]),
    ("Kristoff_Vernard", "Doom_2099", ["Kristoff_Vernard", "Nathaniel_Richards_(Marvel_Comics)", "Maker_(character)", "Molecule_Man", "Super-Adaptoid", "Phalanx_(comics)", "Doom_2099"]),
    ("Masked_Marauder", "Gentleman_(character)", ["Masked_Marauder", "Gladiator_(Melvin_Potter)", "Mister_Fear", "Eel_(Marvel_Comics)", "Black_Cat_(Marvel_Comics)", "Lizard_(character)", "Gentleman_(character)"]),
    ("Gentleman_(character)", "Masked_Marauder", ["Gentleman_(character)", "Mysterio", "Black_Cat_(Marvel_Comics)", "Lizard_(character)", "Mister_Hyde_(Marvel_Comics)", "Gladiator_(Melvin_Potter)", "Masked_Marauder"]),
    ("Lady_Gorgon", "Gorgon_(Inhuman)", ["Lady_Gorgon", "Rampage_(Marvel_Comics)", "Wrecker_(comics)", "Hulk", "Leader_(character)", "Super-Skrull", "Quicksilver_(Marvel_Comics)", "Gorgon_(Inhuman)"]),
    ("Flying_Tiger_(Marvel_Comics)", "Condor_(comics)", ["Flying_Tiger_(Marvel_Comics)", "Tiger_Shark_(Marvel_Comics)", "Egghead_(Marvel_Comics)", "Puppet_Master_(Marvel_Comics)", "Sphinx_(Marvel_Comics)", "Diamondhead_(comics)", "Condor_(comics)"]),
]

failures = []


def head(t):
    print("\n== " + t)


def expect(label, got, want, note=""):
    ok = got == want
    if not ok:
        failures.append(label)
    print(f"  {'PASS' if ok else 'FAIL'}  {label}: {got!r}" + ("" if ok else f"  (page says {want!r})") + (f"   [{note}]" if note else ""))


def info(label, value, note=""):
    print(f"  info  {label}: {value}" + (f"   [{note}]" if note else ""))


def stat(label, num, den, definition):
    pct = f" = {100 * num / den:.1f}%" if den else ""
    print(f"  stat  {label}: {num:,} / {den:,}{pct}   [{definition}]")


# ------------------------------------------------------------------ load
chars = json.load(open(D7 / "week7_characters.json", encoding="utf-8"))
ids = [c["id"] for c in chars["characters"]]
name = {c["id"]: c["name"] for c in chars["characters"]}
words = {c["id"]: c["words"] for c in chars["characters"]}
edges = [tuple(e) for e in chars["edges"]]
eset = set(edges)
out_n, in_n = defaultdict(list), defaultdict(list)
for a, b in edges:
    out_n[a].append(b)
    in_n[b].append(a)

text = {}
by_unq = {urllib.parse.unquote(p.stem): p for p in PAGES.glob("*.txt")}
for k in ids:
    text[k] = by_unq[k].read_text(encoding="utf-8")

pairs = {}
with open(D7 / "week7_pairs.tsv", encoding="utf-8") as fh:
    rd = csv.reader((ln for ln in fh if not ln.startswith("#")), delimiter="\t")
    hdr = next(rd)
    col = {h: i for i, h in enumerate(hdr)}
    for r in rd:
        pairs[(r[col["a"]], r[col["b"]])] = (float(r[col["cos"]]),
                                              int(r[col["d_ab"]]) if r[col["d_ab"]] else None,
                                              int(r[col["d_ba"]]) if r[col["d_ba"]] else None,
                                              r[col["reach"]])


def pair(a, b):
    """(cosine, d(a->b), d(b->a)) for either order."""
    if (a, b) in pairs:
        c, x, y, _ = pairs[(a, b)]
        return c, x, y
    c, x, y, _ = pairs[(b, a)]
    return c, y, x


def short_title(k):
    return re.sub(r"\s*\(.*\)$", "", name[k])


def mind(v):
    ds = [d for d in (v[1], v[2]) if d is not None]
    return min(ds) if ds else None


def mention_re(k):
    return re.compile(r"(?<![\w-])" + re.escape(short_title(k)) + r"(?![\w-])", re.I)


# ------------------------------------------------------------------ 1. pair universe
head("1. Pair universe")
n = len(ids)
expect("pages", n, 370)
expect("unordered pairs among 370 pages", len(pairs), 68265, "370*369/2")
long_three = sorted(k for k in ids if re.sub(r"_\(.*\)$", "", k) in LONG_BASE)
expect("long-three pages found", len(long_three), 3)
info("long-three word counts", {k: words[k] for k in long_three}, "post says 6,500 to 18,000 words")
keep_pairs = {k: v for k, v in pairs.items() if k[0] not in long_three and k[1] not in long_three}
expect("pairs without the long three (367 pages)", len(keep_pairs), 67161, "367*366/2")
expect("pairs involving at least one long-three page", len(pairs) - len(keep_pairs), 1104, "68,265 - 67,161")
info("why two pair counts appear on the page",
     "68,265 = all pairs of the 370 pages (Method: path categories, 0.636 median); 67,161 = the same minus the 1,104 pairs that "
     "involve Naga (Marvel Comics), Tundra (Marvel Comics) or Shepard (comics) (selection of pairs and the explanation proxies)")

# ------------------------------------------------------------------ 2. paths over all 68,265 pairs (Method section)
head("2. Directed-path categories over all 68,265 pairs (Method section)")
cat = Counter(v[3] for v in pairs.values())
expect("both directions", cat["both"], 18561)
expect("one direction only", cat["a_to_b"] + cat["b_to_a"], 24781)
expect("  first-sorting page -> other", cat["a_to_b"], 13324)
expect("  other -> first-sorting page", cat["b_to_a"], 11457)
expect("no path either way", cat["none"], 24923)
expect("categories sum to all pairs", sum(cat.values()), 68265)

# weak components and mean undirected distance in the giant component
und = defaultdict(set)
for a, b in edges:
    und[a].add(b)
    und[b].add(a)
seen, comps = set(), []
for s in sorted(ids):
    if s in seen:
        continue
    comp, dq = {s}, deque([s])
    seen.add(s)
    while dq:
        u = dq.popleft()
        for v in sorted(und[u]):
            if v not in seen:
                seen.add(v)
                comp.add(v)
                dq.append(v)
    comps.append(comp)
comps.sort(key=len, reverse=True)
expect("weakly connected components", len(comps), 46)
expect("giant component size", len(comps[0]), 323)
tot = cnt = 0
for s in sorted(comps[0]):
    dist = {s: 0}
    dq = deque([s])
    while dq:
        u = dq.popleft()
        for v in und[u]:
            if v not in dist:
                dist[v] = dist[u] + 1
                dq.append(v)
    tot += sum(dist.values())
    cnt += len(dist) - 1
expect("mean undirected distance in the giant component", round(tot / cnt, 2), 3.55, f"{cnt // 2:,} unordered pairs")

nn = sorted(max(pair(k, o)[0] for o in ids if o != k) for k in ids)
expect("median nearest-neighbour cosine (370 pages, all 369 others)", round((nn[184] + nn[185]) / 2, 3), 0.636)

# ------------------------------------------------------------------ 3. high-cosine and far pairs
head("3. High-cosine pairs and far pairs")
hi = [k for k, v in keep_pairs.items() if v[0] >= MIN_COS]
stat("high-cosine pairs", len(hi), len(keep_pairs), "cos >= 0.60; 367 pages")
expect("high-cosine pairs", len(hi), 712)
hc = Counter(keep_pairs[k][3] for k in hi)
expect("  reachable both ways", hc["both"], 455)
expect("  reachable one way", hc["a_to_b"] + hc["b_to_a"], 192)
expect("  not reachable", hc["none"], 65)
far = [k for k in hi if keep_pairs[k][3] != "none" and mind(keep_pairs[k]) >= FAR_MIN]
stat("far pairs (shorter existing distance >= 5)", len(far), len(hi), "of the high-cosine pairs")
expect("far pairs", len(far), 49)
fc = Counter(keep_pairs[k][3] for k in far)
expect("  with a path both ways", fc["both"], 16)
expect("  with a path one way", fc["a_to_b"] + fc["b_to_a"], 33)
far_all = [k for k, v in pairs.items() if v[0] >= MIN_COS and v[3] != "none" and mind(v) >= FAR_MIN]
expect("far pairs before leaving out the long three", len(far_all), 128)
expect("far pairs that involve a long-three page", len(far_all) - len(far), 79)
alt = [k for k in hi if any(d is not None and d >= FAR_MIN for d in keep_pairs[k][1:3])]
info("NOT the rule used: pairs with ANY existing direction >= 5", len(alt),
     "for contrast only: the page's Method sentence now states the rule used (shorter existing distance >= 5; one-way pairs judged by their single distance)")

# ------------------------------------------------------------------ 4. proxies
head("4. Proxy statistics over the 67,161 pairs (all correlational)")


def title_words(k):
    return set(re.findall(r"[a-z0-9']+", short_title(k).lower())) - STOP


sw = {k for k in keep_pairs if title_words(k[0]) & title_words(k[1])}
expect("pairs sharing a title word", len(sw), 106)
mean = lambda xs: sum(xs) / len(xs)
expect("  mean cosine, sharing", round(mean([keep_pairs[k][0] for k in sw]), 3), 0.577)
expect("  mean cosine, all other pairs", round(mean([v[0] for k, v in keep_pairs.items() if k not in sw]), 3), 0.388)
stat("high-cosine pairs that share a title word", len([k for k in hi if k in sw]), len(hi), "denominator: the 712")
expect("  of the 712", len([k for k in hi if k in sw]), 40)

kept_ids = [k for k in ids if k not in long_three]
# the franchise is defined for all 370 pages (the long three are only left out of the pair sets)
fr_pat = {f: re.compile(r"(?<![\w-])" + re.escape(f) + r"(?![\w-])", re.I) for f in FRANCHISES}
fr, ties = {}, 0
for k in ids:
    c = {f: len(fr_pat[f].findall(text[k])) for f in FRANCHISES}
    m = max(c.values())
    if m >= 3:
        winners = [f for f in FRANCHISES if c[f] == m]
        ties += len(winners) > 1
        fr[k] = (winners[0], m)
    else:
        fr[k] = (None, m)
expect("pages with a franchise (>= 3 mentions), of 370", sum(1 for v in fr.values() if v[0]), 303)
info("pages whose top franchise is tied (earlier name in the list wins)", ties)
same_fr = lambda k: fr[k[0]][0] is not None and fr[k[0]][0] == fr[k[1]][0]
expect("high-cosine pairs sharing a franchise", sum(1 for k in hi if same_fr(k)), 446, "of the 712")
expect("all pairs sharing a franchise (%)", round(100 * sum(1 for k in keep_pairs if same_fr(k)) / len(keep_pairs), 1), 6.9, "of 67,161")
expect("far pairs sharing a franchise", sum(1 for k in far if same_fr(k)), 11, "of the 49")
diff_fr = sum(1 for k in far if fr[k[0]][0] and fr[k[1]][0] and not same_fr(k))
none_fr = sum(1 for k in far if not (fr[k[0]][0] and fr[k[1]][0]))
expect("far pairs with different top franchises", diff_fr, 28)
expect("far pairs where a page has no franchise", none_fr, 10)

# alias pages: the original wording rule is NOT saved; two reconstructions bracket it
ALIAS_RULES = {
    "broad": re.compile(r"(name|alias)[^.]{0,40}(several|two|three|four|five|multiple)|several (supervillains|characters)|"
                        r"used by (two|three|four|five)|the name of (several|two|three)|alias (used|shared)", re.I),
    "narrow": re.compile(r"the name of (several|two|three|four|five)|an alias (used|shared) by (two|three|four|five|several)|"
                         r"alias(es)? of (two|three|four|five|several)", re.I),
}
res = {}
for rn, rx in ALIAS_RULES.items():
    al = {k: bool(rx.search(text[k][:500])) for k in kept_ids}
    n_al = sum(al.values())
    both_hi = sum(1 for k in hi if al[k[0]] and al[k[1]])
    both_all = sum(1 for k in keep_pairs if al[k[0]] and al[k[1]])
    res[rn] = (n_al, both_hi, both_all)
    print(f"  RECONSTRUCTED alias rule '{rn}': {n_al} of {len(kept_ids)} pages; both alias in {both_hi} of {len(hi)} high-cosine pairs "
          f"({100 * both_hi / len(hi):.1f}%) vs {100 * both_all / len(keep_pairs):.1f}% of all {len(keep_pairs):,} pairs")
print("  LIMITATION: the wording rule behind the page's earlier '82 of 367' and '4.9%' is not saved, so those figures cannot be reproduced. "
      "The page therefore quotes ranges: roughly 70-90 alias pages, 9-12% of the 712 high-cosine pairs and 4-6% of all pairs. "
      "Check that both reconstructions sit inside those ranges:")
for rn, (n_al, bh, ba) in res.items():
    in_rng = (70 <= n_al <= 90 and 9 <= round(100 * bh / len(hi)) <= 12 and 3.5 <= 100 * ba / len(keep_pairs) <= 6.5)
    info(f"  '{rn}' inside the page's quoted ranges", in_rng)
    if not in_rng:
        failures.append("alias ranges " + rn)
fb, fp = FEATURED[0]
al_b = {k: bool(ALIAS_RULES['broad'].search(text[k][:500])) for k in (fb, fp)}
info("Firebrand and Firepower are both alias pages (broad rule)", all(al_b.values()))

xs = [v[0] for v in keep_pairs.values()]
ys = [math.log(min(words[a], words[b])) for a, b in keep_pairs]
mx, my = mean(xs), mean(ys)
r = sum((x - mx) * (y - my) for x, y in zip(xs, ys)) / math.sqrt(sum((x - mx) ** 2 for x in xs) * sum((y - my) ** 2 for y in ys))
expect("Pearson r, cosine vs ln(word count of the shorter page)", round(r, 2), 0.29, "67,161 pairs; word counts from week7_characters.json")

# ------------------------------------------------------------------ 5. link targets and name mentions
head("5. Do links point to pages whose name the linking page mentions?")
mre = {k: mention_re(k) for k in ids}
linked = sum(1 for a, b in edges if mre[b].search(text[a]))
stat("links A->B where A's text mentions B's name", linked, len(edges), "all 1,136 directed edges")
expect("share of links (%)", round(100 * linked / len(edges)), 87)
base = tot_b = 0
for a in ids:
    for b in ids:
        if a != b and (a, b) not in eset:
            tot_b += 1
            base += 1 if mre[b].search(text[a]) else 0
stat("comparison: ordered pairs (A, B) with NO link A->B where A's text mentions B's name", base, tot_b, "370*369 - 1,136 ordered pairs; an association measure only, not evidence that a mention causes a link")
print("  LIMITATION: name matching only; links to pages mentioned under another name are not counted as mentions, and a mention is not a reason for a link.")

# ------------------------------------------------------------------ 6. featured pairs
head("6. The five featured pairs")
page = HTML.read_text(encoding="utf-8")
rows = re.findall(r'<th scope="row" data-label="Pair">(.*?)</th><td class="num" data-label="Cosine">([\d.]+)</td>'
                  r'<td data-label="Rank of the other in each list">(.*?)</td>'
                  r'<td class="num[^"]*" data-label="Distance A &rarr; B">(.*?)</td>'
                  r'<td class="num[^"]*" data-label="Distance B &rarr; A">(.*?)</td>', page)
expect("table rows found in posts/week-7.html", len(rows), 5)
rank_in = lambda a, b: 1 + sum(1 for o in ids if o not in (a, b) and pair(a, o)[0] > pair(a, b)[0])
for (a, b), row in zip(FEATURED, rows):
    c, dab, dba = pair(a, b)
    fmt = lambda d: "no path" if d is None else str(d)
    ok = (f"{c:.4f}" == row[1] and fmt(dab) == row[3] and fmt(dba) == row[4]
          and f"#{rank_in(a, b)} and #{rank_in(b, a)}" == row[2])
    direction = "both ways" if dab is not None and dba is not None else ("A->B only" if dab is not None else "B->A only")
    in_far = any((a, b) == k or (b, a) == k for k in far)
    if not ok:
        failures.append("table row " + a)
    print(f"  {'PASS' if ok else 'FAIL'}  {short_title(a)} - {short_title(b)}: cos {c:.4f}, d(A->B) {fmt(dab)}, d(B->A) {fmt(dba)}, "
          f"{direction}, ranks #{rank_in(a, b)}/#{rank_in(b, a)}, among the 49 far pairs: {in_far}   [matches the page table: {ok}]")


def bfs_count(s, t):
    dist, cnt, dq = {s: 0}, {s: 1}, deque([s])
    while dq:
        u = dq.popleft()
        for v in sorted(out_n[u]):
            if v not in dist:
                dist[v], cnt[v] = dist[u] + 1, cnt[u]
                dq.append(v)
            elif dist[v] == dist[u] + 1:
                cnt[v] += cnt[u]
    return dist.get(t), cnt.get(t)


print("  shortest paths (BFS over the 1,136 edges): length and NUMBER of distinct shortest paths per direction")
for a, b in FEATURED:
    (d1, c1), (d2, c2) = bfs_count(a, b), bfs_count(b, a)
    c, dab, dba = pair(a, b)
    ok = d1 == dab and d2 == dba
    if not ok:
        failures.append("bfs " + a)
    print(f"  {'PASS' if ok else 'FAIL'}  {short_title(a)}->{short_title(b)}: {d1} links, {c1 if c1 else '-'} shortest paths | reverse: {d2} links, {c2 if c2 else '-'} shortest paths")
info("so the paths quoted on the page are ONE shortest path each, not the only route", "see counts above")
for s_, t_, p in QUOTED_PATHS:
    valid = all((p[i], p[i + 1]) in eset for i in range(len(p) - 1))
    shortest = bfs_count(s_, t_)[0] == len(p) - 1
    if not (valid and shortest):
        failures.append("quoted path " + s_)
    print(f"  {'PASS' if valid and shortest else 'FAIL'}  quoted path {short_title(s_)} -> {short_title(t_)}: every link exists={valid}, length {len(p) - 1} is the shortest={shortest}")

print("  in/out links of the path end-points (inside the 370 pages):")
for k in ("Firepower_(comics)", "Doom_2099", "Condor_(comics)", "Flying_Tiger_(Marvel_Comics)", "Gorgon_(Inhuman)", "Kristoff_Vernard"):
    print(f"    {short_title(k)}: links to {sorted(short_title(x) for x in out_n[k])}; linked from {sorted(short_title(x) for x in in_n[k])}")
info("Firepower has exactly one in-link (Guardsman), Doom 2099 exactly one (Phalanx)", f"{len(in_n['Firepower_(comics)'])} and {len(in_n['Doom_2099'])}")

print("  direct page-to-page mentions and links (name mention rule above; Lady Gorgon's page uses 'Gorgon' for herself):")
for a, b in FEATURED:
    print(f"    {short_title(a)} mentions {short_title(b)}: {bool(mre[b].search(text[a]))}; reverse: {bool(mre[a].search(text[b]))}; "
          f"edge A->B: {(a, b) in eset}; B->A: {(b, a) in eset}")
cn, fl = "Condor_(comics)", "Flying_Tiger_(Marvel_Comics)"
nbr = lambda k: set(out_n[k]) | set(in_n[k])
info("Condor / Flying Tiger: pages linked to or from BOTH", sorted(nbr(cn) & nbr(fl)), "empty = no shared neighbour in either direction")
info("Condor / Flying Tiger: page-text mentions of 'Zemo' and 'Jack Flag'",
     {short_title(k): (len(re.findall("Zemo", text[k])), len(re.findall("Jack Flag", text[k]))) for k in (cn, fl)}, "shared subject matter without mentioning each other")

df = Counter(w for k in ids for w in set(re.findall(r"[a-z][a-z'-]{3,}", text[k].lower())))
print("  words shared by both pages that occur in at most 15 of the 370 pages (descriptive only, not a similarity measure):")
for a, b in FEATURED:
    va, vb = (set(re.findall(r"[a-z][a-z'-]{3,}", text[k].lower())) for k in (a, b))
    sh = sorted((w for w in va & vb if df[w] <= 15), key=lambda w: (df[w], w))
    print(f"    {short_title(a)} / {short_title(b)}: {len(sh)} {sh[:8]}")

info("page lengths (words)", {short_title(k): words[k] for k in ("Condor_(comics)", "Flying_Tiger_(Marvel_Comics)")}, f"median of the 370 pages: {sorted(words.values())[185]}")
short_pairs = [v[0] for k, v in keep_pairs.items() if min(words[k[0]], words[k[1]]) < 500]
long_pairs = [v[0] for k, v in keep_pairs.items() if min(words[k[0]], words[k[1]]) >= 500]
info("mean cosine, pairs whose shorter page has < 500 words vs >= 500", f"{mean(short_pairs):.3f} (n={len(short_pairs):,}) vs {mean(long_pairs):.3f} (n={len(long_pairs):,})",
     "short pages tend to give LOWER cosines, so short length does not explain a high cosine")
print("  Iron Man / Doctor Doom mention counts (whole word, case-insensitive):")
IRON = re.compile(r"(?<![\w-])Iron Man(?![\w-])", re.I)
DOOM = re.compile(r"Doctor Doom|Dr\. Doom")
ARMOR = re.compile(r"armou?r", re.I)
for k in ("Firebrand_(Marvel_Comics)", "Firepower_(comics)"):
    print(f"    {short_title(k)}: Iron Man x{len(IRON.findall(text[k]))}; top franchise {fr[k]}")
for k in ("Doom_2099", "Kristoff_Vernard"):
    print(f"    {short_title(k)}: 'Doctor Doom' or 'Dr. Doom' x{len(DOOM.findall(text[k]))}; 'armor/armour' x{len(ARMOR.findall(text[k]))}; top franchise {fr[k]}")
info("a page for Doctor Doom among the 370 nodes", any(re.search(r"Doctor_Doom|Victor_von_Doom", k) for k in ids),
     "False = absent; whether Doom 2099 / Vernard link to his page cannot be known from the induced graph")
for k in ("Gorgon_(Inhuman)", "Lady_Gorgon", "Masked_Marauder", "Gentleman_(character)", "Condor_(comics)", "Flying_Tiger_(Marvel_Comics)"):
    print(f"    top franchise {short_title(k)}: {fr[k]}")

print()
if failures:
    print(f"FAILED ({len(failures)}): " + "; ".join(failures))
    sys.exit(1)
print("ALL QUOTED NUMBERS REPRODUCED (alias-page figures are reconstructions, see section 4)")
