/*
 * Week 6 explorable (lean rebuild) — "who is close, and why?"
 *
 * One character in; the week's core exercise out:
 *   - their top-10 text neighbors under TF-IDF and topic mixtures, with the
 *     week-1 Wikipedia link as the honest badge on every row,
 *   - a concordance drawer so every match is checked against real sentences,
 *   - the fingerprint words as a word strip: counts-neighbors vs PPMI-
 *     neighbors for one word (the week's raw-vs-PPMI arc in one row),
 *   - the corpus's closest structurally-unlinked pairs as a short table.
 *
 * Clicking a character's NAME recenters everything on them. No mode
 * switches, no sliders; defaults carry the page.
 *
 * Data: week6_summary.json (eager), week6_words.json and week6_sents.json
 * (lazy). Built by analysis/build_week6.py — the page is a pure reader.
 */
(function () {
  "use strict";

  function esc(s) {
    return String(s).replace(/[&<>"']/g, function (c) {
      return { "&": "&amp;", "<": "&lt;", ">": "&gt;", '"': "&quot;", "'": "&#39;" }[c];
    });
  }

  var TAB20 = [
    "#1f77b4", "#aec7e8", "#ff7f0e", "#ffbb78", "#2ca02c", "#98df8a",
    "#d62728", "#ff9896", "#9467bd", "#c5b0d5", "#8c564b", "#c49c94",
    "#e377c2", "#f7b6d2", "#7f7f7f", "#c7c7c7", "#bcbd22", "#dbdb8d",
    "#17becf", "#9edae5"
  ];
  function commColor(ci) {
    return ci < 8 ? TAB20[ci * 2] : TAB20[((ci - 8) * 2 + 1) % 20];
  }

  var S = null;      // week6_summary.json
  var WORDS = null;  // lazy
  var SENTS = null;  // lazy
  var WORDS_DUE = false;
  var SENTS_DUE = null;

  var state = { nid: null, word: null };

  function fetchJson(url) {
    return fetch(url).then(function (r) {
      if (!r.ok) throw new Error("HTTP " + r.status + " fetching " + url);
      return r.json();
    });
  }

  function nameOf(nid) { return S.pages[nid].name; }
  function linked(a, b) { return S.pages[a].links.indexOf(b) >= 0; }

  // ---------- boot / navigation ---------------------------------------------

  function bindControls() {
    var sel = document.getElementById("w6l-select");
    sel.innerHTML = Object.keys(S.pages).sort(function (a, b) {
      return nameOf(a).localeCompare(nameOf(b));
    }).map(function (nid) {
      return '<option value="' + esc(nid) + '">' + esc(nameOf(nid)) + "</option>";
    }).join("");
    sel.value = state.nid;
    sel.addEventListener("change", function () { setCharacter(this.value); });

    var input = document.getElementById("w6l-input");
    var dl = document.getElementById("w6l-datalist");
    dl.innerHTML = Object.keys(S.pages).map(function (nid) {
      return '<option value="' + esc(nameOf(nid)) + '">';
    }).join("");
    input.addEventListener("change", function () {
      var q = this.value.trim().toLowerCase();
      this.value = "";
      var hit = Object.keys(S.pages).find(function (nid) {
        return nameOf(nid).toLowerCase() === q;
      });
      if (hit) setCharacter(hit);
    });
  }

  function setCharacter(nid) {
    if (!S.pages[nid]) return;
    state.nid = nid;
    state.word = null;
    document.getElementById("w6l-select").value = nid;
    renderDocColumns();
    renderChips();
    closeDrawer();
  }

  // ---------- the two columns --------------------------------------------------

  function renderDocColumns() {
    var nid = state.nid;
    var cols = [
      {
        key: "tfidf", head: "TF-IDF", col: "#e6353a",
        sub: "cosine over tfidf·ln(N/df) — no stopword list",
      },
      {
        key: "lda_with", head: "Topic mixtures", col: "#9c6ade",
        sub: "cosine over the pages' LDA topic proportions",
      },
    ].map(function (spec) {
      var nbs = S.neighbors[spec.key][nid];
      var k = nbs.filter(function (it) { return linked(nid, it.o); }).length;
      var rows = nbs.map(function (it, i) {
        return '<li class="w6-nb-row" data-other="' + esc(it.o) + '">' +
          '<span class="w6-rank">' + (i + 1) + "</span>" +
          '<span class="w6-cdot" style="background:' + commColor(S.pages[it.o].community) + '"></span>' +
          '<span class="w6-nname" data-nav="' + esc(it.o) + '">' + esc(nameOf(it.o)) + "</span>" +
          '<span class="w6-cos">' + it.c.toFixed(2) + "</span>" +
          '<span class="w6-link' + (linked(nid, it.o) ? "" : " is-un") + '">' +
          (linked(nid, it.o) ? "✓ linked" : "—") + "</span></li>";
      }).join("");
      return '<div class="w6-doc-col" data-mode="' + esc(spec.key) + '">' +
        '<div class="w6-doc-head" style="color:' + spec.col + '">' + esc(spec.head) + "</div>" +
        '<p class="w6-doc-sub">' + esc(spec.sub) + "</p>" +
        '<p class="w6-doc-sub"><strong>' + k + " of 10</strong> rows are actual Wikipedia links &mdash; click a row to read why.</p>" +
        '<ul class="w6-nb-list">' + rows + "</ul></div>";
    }).join("");
    document.getElementById("w6l-docs").innerHTML = cols;

    document.querySelectorAll("#w6l-docs .w6-nb-row").forEach(function (row) {
      row.addEventListener("click", function () { openRow(row); });
    });
    document.querySelectorAll("#w6l-docs [data-nav]").forEach(function (el) {
      el.addEventListener("click", function (e) {
        e.stopPropagation();
        setCharacter(el.getAttribute("data-nav"));
      });
    });
  }

  function openRow(row) {
    var other = row.getAttribute("data-other");
    var col = row.closest(".w6-doc-col");
    var mode = (col && col.getAttribute("data-mode")) || "tfidf";
    var entry = S.neighbors[mode][state.nid].find(function (it) {
      return it.o === other;
    });
    openPairDrawer(state.nid, other, entry.c, entry.w);
  }

  // ---------- drawer ------------------------------------------------------------

  function sentencesWith(pool, words) {
    var res = [];
    for (var i = 0; i < pool.length && res.length < 2; i++) {
      var hit = words.find(function (w) {
        return new RegExp("\\b" + w.replace(/[.*+?^${}()|[\]\\]/g, "\\$&") + "\\b", "i").test(pool[i]);
      });
      if (hit) {
        var s = esc(pool[i]).replace(
          new RegExp("\\b(" + hit.replace(/[.*+?^${}()|[\]\\]/g, "\\$&") + ")\\b", "i"),
          "<mark>$1</mark>");
        res.push({ s: s, w: hit });
      }
    }
    return res;
  }

  var drawerPair = null; // avoids a lazy-SENTS fetch repainting a newer drawer

  function openPairDrawer(a, b, cos, words) {
    drawerPair = { a: a, b: b };
    var isL = linked(a, b);
    var chips = (words && words.length ? words : ["(no fingerprint overlap — see the topic badge)"])
      .slice(0, 4);
    var title = nameOf(a) + " ↔ " + nameOf(b);
    var note = cos.toFixed(3) + " · " +
      (isL ? "linked on Wikipedia" : "NOT linked on Wikipedia");
    var drawer = document.getElementById("w6l-drawer");
    drawer.innerHTML = '<div class="w6-drawer"><h4>' + esc(title) + "</h4>" +
      '<p class="cos-note">' + esc(note) + "</p>" +
      '<div class="w6-chips">' + chips.map(function (w) {
        return '<span class="w6-chip">' + esc(w) + "</span>";
      }).join("") + "</div>" +
      '<div class="w6-sents" id="w6l-sents">' +
      (SENTS ? "" : '<p class="cos-note">loading sentences…</p>') + "</div>" +
      '<p class="cos-note">Surname, shared comic, boilerplate — or a real shared story? The judgment is yours.</p></div>';

    var fill = function () {
      if (!drawerPair || drawerPair.a !== a || drawerPair.b !== b) return;
      var box = document.getElementById("w6l-drawer");
      if (!box) return;
      var panels = [a, b].map(function (nid) {
        var hits = SENTS ? sentencesWith((SENTS.pages[nid] || []).slice(), chips) : [];
        if (!hits.length) return "";
        return hits.map(function (h) {
          return '<p class="w6-sent"><span class="w6-sent-src">' + esc(nameOf(nid)) + "</span>" + h.s + "</p>";
        }).join("");
      }).join("");
      var sentsEl = document.getElementById("w6l-sents");
      if (sentsEl) sentsEl.innerHTML = panels ||
        '<p class="cos-note">No sentence in the store contains the shared words.</p>';
    };

    if (SENTS) { fill(); }
    else if (!SENTS_DUE) {
      SENTS_DUE = true;
      fetchJson("../data/marvel_pages/week6_sents.json").then(function (d) {
        SENTS = d;
        SENTS_DUE = false;
        fill();
      });
    }
  }

  function closeDrawer() {
    document.getElementById("w6l-drawer").innerHTML = "";
  }

  // ---------- word strip ---------------------------------------------------------

  function renderChips() {
    var nid = state.nid;
    var root = document.getElementById("w6l-chips");
    root.innerHTML = S.pages[nid].fpn.map(function (w) {
      return '<button class="w6-chip' + (state.word === w ? " active" : "") +
        '" data-w="' + esc(w) + '">' + esc(w) + "</button>";
    }).join("");
    root.querySelectorAll(".w6-chip").forEach(function (b) {
      b.addEventListener("click", function () { pickWord(b.getAttribute("data-w")); });
    });
  }

  function ensureWords(cb) {
    if (WORDS) { cb(); return; }
    if (WORDS_DUE) return;
    WORDS_DUE = true;
    document.getElementById("w6l-wordpanel").innerHTML =
      '<p class="w6-doc-sub">loading word data…</p>';
    fetchJson("../data/marvel_pages/week6_words.json").then(function (d) {
      WORDS = d;
      WORDS_DUE = false;
      cb();
    });
  }

  function pickWord(w) {
    state.word = w;
    renderChips();
    ensureWords(function () { renderWordPanel(); });
  }

  function miniCols(w, d) {
    return [
      { head: "counts", col: "#4d7cff", list: d.nb_counts },
      { head: "PPMI", col: "#e6353a", list: d.nb_ppmi },
    ].map(function (c) {
      var pairs = (c.list || []).slice(0, 6);
      var max = Math.max.apply(null, pairs.map(function (p) { return p[1]; })) || 1;
      return '<div class="w6-doc-col"><div class="w6-doc-head" style="color:' + c.col + '">' +
        esc(c.head) + "</div>" +
        '<ul class="w6-bar-list">' + pairs.map(function (p) {
          return '<li class="w6-bar-row"><span class="w6-bar-word">' + esc(p[0]) + "</span>" +
            '<span class="w6-bar-track"><span class="w6-bar-fill" style="background:' + c.col +
            ';width:' + Math.round(100 * p[1] / max) + '%"></span></span>' +
            '<span class="w6-bar-val">' + p[1].toFixed(2) + "</span></li>";
        }).join("") + "</ul></div>";
    }).join("");
  }

  function renderWordPanel() {
    var w = state.word;
    var root = document.getElementById("w6l-wordpanel");
    if (!w) {
      root.innerHTML = '<p class="w6-doc-sub">Click a fingerprint word above.</p>';
      return;
    }
    var d = WORDS.words[w];
    root.innerHTML =
      '<div class="w6-doc-head">The word <em>' + esc(w) + "</em>: same matrix, two weightings</div>" +
      '<p class="w6-doc-sub">' +
      (d ? "neighbors within &plusmn;5 sentence words of <code>" + esc(w) +
        "</code>. Counts keep the furniture of every sentence; PPMI keeps what&rsquo;s unusual."
        : "<code>" + esc(w) + "</code> is below the word vocabulary thresholds.") + "</p>" +
      '<div class="w6-word-cols">' +
      (d ? miniCols(w, d) : "") + "</div>";
  }

  // ---------- closest strangers ----------------------------------------------------

  function renderStrangers() {
    var root = document.getElementById("w6l-strangers");
    root.innerHTML = '<ol class="rank-list">' + S.unlinked.slice(0, 8).map(function (u, i) {
      return '<li class="w6-nb-row" data-a="' + esc(u.a) + '" data-b="' + esc(u.b) + '">' +
        '<span class="rank">' + (i + 1) + "</span>" +
        '<span class="name">' + esc(nameOf(u.a)) + " ↔ " + esc(nameOf(u.b)) + "</span>" +
        '<span class="metric">' + u.c.toFixed(2) + " · " + esc(u.w.slice(0, 2).join(", ")) + "</span></li>";
    }).join("") + "</ol>";
    root.querySelectorAll(".w6-nb-row").forEach(function (row) {
      row.addEventListener("click", function () {
        var a = row.getAttribute("data-a");
        var b = row.getAttribute("data-b");
        var u = S.unlinked.find(function (x) {
          return x.a === a && x.b === b;
        });
        openPairDrawer(a, b, u.c, u.w);
        document.getElementById("w6l-drawer").scrollIntoView({ behavior: "smooth", block: "nearest" });
      });
    });
  }

  // ---------- boot -------------------------------------------------------------------

  fetchJson("../data/marvel_pages/week6_summary.json").then(function (d) {
    S = d;
    state.nid = Object.keys(S.pages).find(function (nid) {
      return nameOf(nid) === "Storm (Marvel Comics)";
    });
    bindControls();
    renderDocColumns();
    renderChips();
    renderWordPanel();
    renderStrangers();
  });
})();
