/*
 * Week 6 explorable — "five ways to say close".
 *
 * One character in, five representations of "close" out:
 *
 *   Documents (a page is its words):
 *     - raw-count cosine            (stopwords poison the ranking)
 *     - TF-IDF cosine               (course-page definitions, name kept in)
 *     - LDA topic-mixture cosine    (with / without proper names)
 *
 *   Words (a word is its contexts), over the character's fingerprint words:
 *     - raw-count cosine in the word-context matrix
 *     - PPMI cosine                 (same matrix, common contexts discounted)
 *     - Word2Vec neighbors          (gensim, sg=1, 100d, window 5, seed 0)
 *
 * Plus a verification drawer (concordance sentences from the actual pages)
 * and the "closest unlinked pairs" list. Week-1 network links and week-4
 * Louvain communities are overlaid as the structural ground truth.
 *
 * Heavy computation is frozen in three JSON payloads built by
 * analysis/build_week6.py; the page is a pure reader.
 *   week6_summary.json  (document level, fetched immediately)
 *   week6_words.json    (word level, lazy)
 *   week6_sents.json    (sentences, lazy)
 */
(function () {
  "use strict";

  function esc(s) {
    return String(s).replace(/[&<>"']/g, function (c) {
      return { "&": "&amp;", "<": "&lt;", ">": "&gt;", '"': "&quot;", "'": "&#39;" }[c];
    });
  }

  function fmt(v, d) {
    return v == null ? "—" : Number(v).toFixed(d == null ? 3 : d);
  }

  // matplotlib tab20 — same palette family as the week-4 figures
  var TAB20 = [
    "#1f77b4", "#aec7e8", "#ff7f0e", "#ffbb78", "#2ca02c", "#98df8a",
    "#d62728", "#ff9896", "#9467bd", "#c5b0d5", "#8c564b", "#c49c94",
    "#e377c2", "#f7b6d2", "#7f7f7f", "#c7c7c7", "#bcbd22", "#dbdb8d",
    "#17becf", "#9edae5"
  ];
  function commColor(ci) {
    return ci < 8
      ? TAB20[ci * 2]                    // big communities get saturated colors
      : TAB20[((ci - 8) * 2 + 1) % 20];  // small ones the pale variants
  }

  var NAMEMODES = [
    {
      key: "counts",
      head: "Raw counts",
      sub: "cosine over the pages' word counts — stopwords welcome",
    },
    {
      key: "tfidf",
      head: "TF-IDF",
      sub: "cosine over tfidf(t,d) = tf(t,d)·ln(N/df(t)) — no stopword list",
    },
    {
      key: "lda_with",
      head: "Topic mixtures",
      sub: "cosine over the pages' LDA topic proportions",
      alias: { lda: "lda_with", lda_no: "lda_wo" },
    },
  ];

  var S = null;          // week6_summary.json
  var WORDS = null;      // week6_words.json (lazy)
  var SENTS = null;      // week6_sents.json (lazy)
  var WORDS_DUE = false; // a word lookup is waiting on the lazy fetch
  var SENTS_DUE = null;  // pair key waiting on the lazy fetch

  var current = "Spider-Man";
  var ldaNoNames = false;
  var activeWord = null;
  var activeRowKey = null; // key of open drawer row: mode + other id

  // ---- data plumbing --------------------------------------------------------

  function fetchJson(url) {
    return fetch(url).then(function (r) {
      if (!r.ok) throw new Error("HTTP " + r.status + " fetching " + url);
      return r.json();
    });
  }

  function pageOf(nid) { return S.pages[nid]; }
  function nameOf(nid) { return S.pages[nid].name; }
  function linksOf(nid) { return S.pages[nid].links; }

  function ldaKey() { return ldaNoNames ? "lda_wo" : "lda_with"; }

  function topicsFor() {
    var fit = ldaNoNames ? S.topics.no_names : S.topics.with_names;
    return fit;
  }

  // ---- picker + legend ------------------------------------------------------

  function buildPicker(root) {
    var sel = root.querySelector("#w6-select");
    sel.innerHTML = Object.keys(S.pages)
      .sort(function (a, b) { return pageOf(a).name.localeCompare(pageOf(b).name); })
      .map(function (nid) {
        return '<option value="' + esc(nid) + '">' + esc(pageOf(nid).name) + "</option>";
      }).join("");
    sel.value = current;
    sel.addEventListener("change", function () { setCharacter(sel.value); });

    var input = root.querySelector("#w6-input");
    var datalist = root.querySelector("#w6-datalist");
    datalist.innerHTML = Object.keys(S.pages)
      .map(function (nid) { return '<option value="' + esc(pageOf(nid).name) + '">'; })
      .join("");
    input.addEventListener("change", function () {
      var q = input.value.trim().toLowerCase();
      var hit = Object.keys(S.pages).find(function (nid) {
        return pageOf(nid).name.toLowerCase() === q;
      });
      if (hit) { setCharacter(hit); input.value = ""; }
      else { input.value = pageOf(current).name; }
    });

    root.querySelector("#w6-random").addEventListener("click", function () {
      var ids = Object.keys(S.pages);
      setCharacter(ids[Math.floor(Math.random() * ids.length)]);
    });

    root.querySelector("#w6-no-names").addEventListener("change", function () {
      ldaNoNames = this.checked;
      renderDocs();
      if (activeWord) renderWordPanel();
    });
  }

  function setCharacter(nid) {
    if (!S.pages[nid]) return;
    current = nid;
    activeRowKey = null;
    activeWord = null;
    document.getElementById("w6-select").value = current;
    renderDocs();
    renderWordPanel();
    closeDrawer();
  }

  function buildLegend(root) {
    var sizes = S.meta.stats.community_sizes;
    var legend = root.querySelector("#w6-legend-swatches");
    var html = "";
    for (var ci = 0; ci < Math.min(sizes.length, 8); ci++) {
      // label each community by its most-linked member
      var best = null;
      Object.keys(S.pages).forEach(function (nid) {
        if (pageOf(nid).community !== ci) return;
        if (!best || pageOf(nid).in_degree > pageOf(best).in_degree) best = nid;
      });
      html += '<span><span class="swatch" style="background:' + commColor(ci) +
        '"></span>C' + ci + " · " + esc(pageOf(best).name) + " (" + sizes[ci] + ")</span>";
    }
    legend.innerHTML = html;
  }

  // ---- document panel ---------------------------------------------------------

  function docModeStat(nid, mode) {
    var nbs = S.neighbors[mode][nid];
    var linked = linksOf(nid);
    var k = nbs.filter(function (it) { return linked.indexOf(it.o) >= 0; }).length;
    return k;
  }

  function renderDocs() {
    var root = document.getElementById("w6-docs");
    var nid = current;
    var all = ["counts", "tfidf", ldaKey()].map(function (mode) {
      var spec = NAMEMODES.find(function (m) { return m.key === mode; });
      var nbs = S.neighbors[mode][nid];
      var k = docModeStat(nid, mode);
      var rows = nbs.map(function (it, i) {
        var other = pageOf(it.o);
        var p = other.community;
        var key = mode + ":" + it.o;
        var chips = "";
        if (mode === ldaKey()) {
          var labels = topicsFor().labels;
          chips = (it.t || []).map(function (t) {
            return '<span class="w6-topic-chip" style="color:' + commColor(t) + '">' +
              esc(labels[t]) + "</span>";
          }).join("");
        }
        return '<li class="w6-nb-row' + (activeRowKey === key ? " active" : "") +
          '" data-key="' + esc(key) + '" data-mode="' + esc(mode) + '" data-other="' + esc(it.o) + '">' +
          '<span class="w6-rank">' + (i + 1) + "</span>" +
          '<span class="w6-cdot" style="background:' + commColor(p) + '"></span>' +
          '<span class="w6-nname">' + esc(other.name) + "</span>" +
          '<span class="w6-cos">' + fmt(it.c, 2) + "</span>" +
          '<span class="w6-link">' + (linksOf(nid).indexOf(it.o) >= 0 ? "link" : "—") + "</span>" +
          "</li><li class=\"w6-chips\"" + " style=\"padding:0 8px 4px 26px\">" + chips + "</li>";
      }).join("");
      return '<div class="w6-doc-col" data-mode="' + esc(mode) + '">' +
        '<div class="w6-doc-head">' + esc(spec.head) + "</div>" +
        '<p class="w6-doc-sub">' + esc(spec.sub) + "</p>" +
        '<p class="w6-doc-sub"><strong>' + k + "/10</strong> neighbors also linked to " +
        esc(pageOf(nid).name) + " <span class='w6-cos'>(random 0/10)</span></p>" +
        '<ul class="w6-nb-list">' + rows + "</ul></div>";
    }).join("");
    root.innerHTML = all;
    root.querySelectorAll(".w6-nb-row").forEach(function (row) {
      row.addEventListener("click", function () { openRow(row); });
    });
  }

  function openRow(row) {
    var mode = row.getAttribute("data-mode");
    var other = row.getAttribute("data-other");
    activeRowKey = row.getAttribute("data-key");
    renderDocs(); // cheap; re-renders active border
    openPairDrawer(mode, current, other, S.neighbors[mode][current]
      .find(function (it) { return it.o === other; }));
  }

  // ---- drawer (verification panel) --------------------------------------------

  function pairShared(mode, a, b, entry) {
    if (entry && entry.w && entry.w.length) return entry.w;
    var fa = pageOf(a).fpn, fb = pageOf(b).fpn;
    var rankA = {}, i;
    for (i = 0; i < fa.length; i++) rankA[fa[i]] = i;
    var out = [];
    for (i = 0; i < fb.length; i++) {
      var w = fb[i];
      if (rankA[w] != null) out.push([Math.min(rankA[w], i), w]);
    }
    out.sort(function (x, y) { return x[0] - y[0]; });
    return out.map(function (p) { return p[1]; }).slice(0, 4);
  }

  function sentencesWith(pool, words) {
    var rx = null;
    function matches(s) {
      if (!rx) rx = words.map(function (w) {
        return new RegExp("\\b" + w.replace(/'/g, "'") + "\\b", "i");
      });
      var hit = null;
      words.some(function (w, idx) {
        if (rx[idx].test(s)) { hit = w; return true; }
        return false;
      });
      return hit;
    }
    var out = [];
    for (var i = 0; i < pool.length && out.length < 3; i++) {
      var hit = matches(pool[i]);
      if (hit) {
        out.push({ s: pool[i], w: hit });
        pool[i] = ""; // don't repeat a sentence
      }
    }
    return out;
  }

  function drawerHtml(title, cosNote, chips, a, b) {
    var words = chips;
    function sentsOf(nid) {
      var pool = ((SENTS && SENTS.pages[nid]) || []).slice();
      return sentencesWith(pool, words);
    }
    var panels = [a, b].map(function (nid) {
      var src = esc(pageOf(nid).name);
      var hits = SENTS ? sentsOf(nid) : null;
      var inner = hits == null
        ? '<p class="cos-note">loading sentences…</p>'
        : hits.map(function (h) {
            var s = esc(h.s);
            var rx = new RegExp("\\b" + h.w.replace(/[.*+?^${}()|[\]\\]/g, "\\$&") + "\\b", "i");
            s = s.replace(rx, function (m) { return "<mark>" + m + "</mark>"; });
            return '<p class="w6-sent"><span class="w6-sent-src">' + src + "</span>" + s + "</p>";
          }).join("") || '<p class="cos-note">no sentence in the store contains the shared words.</p>';
      return inner;
    });
    return '<div class="w6-drawer"><h4>' + esc(title) + "</h4>" +
      '<p class="cos-note">' + esc(cosNote) + "</p>" +
      '<div class="w6-chips">' + chips.map(function (w) {
        return '<span class="w6-chip">' + esc(w) + "</span>";
      }).join("") + "</div>" +
      '<div class="w6-sents">' + panels.join("") + "</div>" +
      '<p class="cos-note">Read the sentences before you believe the match: ' +
      "a name, a formula, or a genuinely shared story? The judgment is yours.</p></div>";
  }

  function openPairDrawer(mode, a, b, entry) {
    var rep = NAMEMODES.find(function (m) { return m.key === mode; }) ||
      { head: mode };
    var label = rep.head;
    var cos = entry ? entry.c : S.unlinked.find(function (u) {
      return (u.a === a && u.b === b) || (u.b === a && u.a === b);
    });
    if (cos && typeof cos === "object") cos = cos.c;
    var linked = linksOf(a).indexOf(b) >= 0;
    var chips = pairShared(mode, a, b, entry);
    var title = nameOf(a) + " ↔ " + nameOf(b);
    var note = fmt(cos, 3) + " under " + label.toLowerCase() +
      " · " + (linked ? "linked on Wikipedia" : "NOT linked on Wikipedia");
    document.getElementById("w6-drawer").innerHTML =
      drawerHtml(title, note, chips, a, b);
    if (!SENTS) {
      SENTS_DUE = [mode, a, b, entry];
      fetchJson("../data/marvel_pages/week6_sents.json").then(function (d) {
        SENTS = d;
        if (SENTS_DUE) {
          var args = SENTS_DUE; SENTS_DUE = null;
          openPairDrawer.apply(null, args);
        }
      });
    }
  }

  function closeDrawer() {
    document.getElementById("w6-drawer").innerHTML = "";
  }

  // ---- word panel ---------------------------------------------------------------

  function ensureWords(cb) {
    if (WORDS) { cb(); return; }
    if (WORDS_DUE) return;
    WORDS_DUE = true;
    document.getElementById("w6-wordcols").innerHTML =
      '<div class="w6-doc-col"><p class="w6-doc-sub">loading word data…</p></div>';
    fetchJson("../data/marvel_pages/week6_words.json").then(function (d) {
      WORDS = d;
      WORDS_DUE = false;
      buildWordList(d);
      if (cb) cb();
    });
  }

  function renderWordPanel() {
    ensureWords(function () {
      var nid = current;
      var chipsRoot = document.getElementById("w6-chips");
      if (chipsRoot.dataset.nid !== nid) {
        chipsRoot.dataset.nid = nid;
        chipsRoot.innerHTML = pageOf(nid).fpn.map(function (w) {
          return '<button class="w6-chip' + (activeWord === w ? " active" : "") +
            '" data-w="' + esc(w) + '">' + esc(w) + "</button>";
        }).join("");
        chipsRoot.querySelectorAll(".w6-chip").forEach(function (b) {
          b.addEventListener("click", function () { setWord(b.getAttribute("data-w")); });
        });
      } else {
        chipsRoot.querySelectorAll(".w6-chip").forEach(function (b) {
          b.classList.toggle("active", b.getAttribute("data-w") === activeWord);
        });
      }
      renderWordCols();
    });
  }

  function setWord(w) {
    activeWord = w;
    renderWordPanel();
  }

  function barList(pairs, digits, scaleMax) {
    var max = scaleMax || Math.max.apply(null, pairs.map(function (p) { return p[1]; })) || 1;
    return '<ul class="w6-bar-list">' + pairs.map(function (p) {
      return '<li class="w6-bar-row"><span class="w6-bar-word">' + esc(p[0]) + "</span>" +
        '<span class="w6-bar-track"><span class="w6-bar-fill" style="width:' +
        Math.max(4, Math.round(100 * p[1] / max)) + '%"></span></span>' +
        '<span class="w6-bar-val">' + fmt(p[1], digits) + "</span></li>";
    }).join("") + "</ul>";
  }

  function renderWordCols() {
    var root = document.getElementById("w6-wordcols");
    if (!WORDS) return;
    if (!activeWord) {
      root.innerHTML = '<div class="w6-doc-col"><p class="w6-doc-sub">Click a fingerprint word ' +
        "(or search below) to see the same word under three representations.</p></div>";
      return;
    }
    var d = WORDS.words[activeWord];
    if (!d) {
      root.innerHTML = '<div class="w6-doc-col"><p class="w6-doc-sub"><code>' + esc(activeWord) +
        "</code> is below this week's vocabulary thresholds (corpus count ≥ " +
        WORDS.meta.min_count + ", df ≥ " + WORDS.meta.min_df + ").</p></div>";
      return;
    }
    var cols = [
      { head: "Counts", sub: "raw co-occurrence cosine, window ±5",
        list: d.nb_counts, digits: 2 },
      { head: "PPMI", sub: "positive pointwise mutual information, same matrix",
        list: d.nb_ppmi, digits: 2 },
      { head: "Word2Vec", sub: "gensim skip-gram, 100d, window 5, seed 0",
        list: d.nb_w2v, digits: 2 },
    ].map(function (c) {
      return '<div class="w6-doc-col"><div class="w6-doc-head">' + esc(c.head) + "</div>" +
        '<p class="w6-doc-sub">' + esc(c.sub) + "</p>" +
        (c.list && c.list.length
          ? barList(c.list, c.digits)
          : '<p class="w6-doc-sub">no neighbors stored.</p>') + "</div>";
    });
    root.innerHTML = cols.join("") +
      '<div class="w6-doc-col" style="grid-column:1/-1">' +
      '<div class="w6-doc-head">PPMI context dimensions</div>' +
      '<p class="w6-doc-sub">Top PPMI values in ' + esc(activeWord) +
      "'s context row — the dimensions its similarity runs on.</p>" +
      barList(d.dims, 2) + "</div>";
  }

  function buildWordList(words) {
    var input = document.getElementById("w6-word-input");
    var dl = document.getElementById("w6-word-list");
    dl.innerHTML = Object.keys(words.words)
      .sort()
      .map(function (w) { return '<option value="' + esc(w) + '">'; })
      .join("");
    input.addEventListener("change", function () {
      var q = input.value.trim().toLowerCase();
      input.value = "";
      if (words.words[q]) setWord(q);
      else if (S.pages[current].fpn.indexOf(q) >= 0) setWord(q);
    });
  }

  // ---- unlinked pairs -------------------------------------------------------------

  function renderUnlinked() {
    var root = document.getElementById("w6-unlinked");
    root.innerHTML = '<ol class="rank-list">' + S.unlinked.slice(0, 10).map(function (u, i) {
      return '<li class="w6-nb-row" data-a="' + esc(u.a) + '" data-b="' + esc(u.b) +
        '"><span class="rank">' + (i + 1) + "</span>" +
        '<span class="name">' + esc(nameOf(u.a)) + " ↔ " + esc(nameOf(u.b)) + "</span>" +
        '<span class="metric">' + fmt(u.c, 2) + " · " +
        esc(u.w.slice(0, 2).join(", ")) + "</span></li>";
    }).join("") + "</ol>";
    root.querySelectorAll(".w6-nb-row").forEach(function (row) {
      row.addEventListener("click", function () {
        var a = row.getAttribute("data-a"), b = row.getAttribute("data-b");
        openPairDrawer("tfidf", a, b, null);
        document.getElementById("w6-drawer").scrollIntoView({ behavior: "smooth", block: "nearest" });
      });
    });
  }

  // ---- boot -----------------------------------------------------------------------

  function bootSummary(Sd) {
    S = Sd;
    // default character: the course page's running example
    var ids = Object.keys(S.pages);
    current = ids.find(function (nid) { return pageOf(nid).name === "Storm (Marvel Comics)"; }) ||
      ids.find(function (nid) { return pageOf(nid).name === "Spider-Man"; }) || ids[0];
    buildPicker(document.getElementById("w6-explorable"));
    buildLegend(document.getElementById("w6-explorable"));
    renderDocs();
    renderWordPanel();
    renderUnlinked();
  }

  fetchJson("../data/marvel_pages/week6_summary.json").then(bootSummary);
})();
