/*
 * Week 6-4 explorable — "one-character deep dive".
 *
 * A zoomable fingerprint explorer around a single page: every week-6
 * representation of ONE character at once.
 *
 *   identity row      — community, in-degree, links, tokens
 *   topic mixture     — the page's own LDA theta (with / without names)
 *   fingerprint       — TF-IDF weights of the page's top-12 non-name words
 *   constellation     — the character at the center; three surrounding rings
 *                       are their top-10 neighbors under TF-IDF (red),
 *                       raw counts (blue) and topic-mixture (purple) cosine.
 *                       Solid green center→dot lines mark real Wikipedia
 *                       links; click a dot to dive into that character.
 *   word inspector    — for any fingerprint word (or search): counts / PPMI /
 *                       Word2Vec neighbor columns, the PPMI context dims,
 *                       and a live two-dimensional PCA of the Word2Vec
 *                       neighborhood (vectors are shipped int8-quantized).
 *   concordance       — actual sentences from the page containing the word.
 *
 * Data: week6_summary.json (neighbors, topics, theta), week63_map.json
 * (fingerprints with weights), week6_words.json (word level), week63_vecs.json
 * (quantized vectors); week6_sents.json lazily. A pure reader.
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

  var COL_TFIDF = "#e6353a";
  var COL_COUNTS = "#4d7cff";
  var COL_LDA = "#9c6ade";
  var COL_LINK = "#0ca678";
  var TOPIC_COLOR = [
    "#e6353a", "#ff7f0e", "#0ca678", "#4d7cff",
    "#9c6ade", "#e0a020", "#d63384", "#17a2b8",
  ];

  var S = null;       // week6_summary.json
  var MAP = null;     // week63_map.json
  var WORDS = null;   // week6_words.json
  var VECS = null;    // week63_vecs.json
  var SENTS = null;   // lazy

  var V = {};         // word -> Float32Array

  var state = {
    nid: null,
    word: null,        // null = follow fingerprint[0]
    noNames: false,
    zoom: { k: 1, x: 0, y: 0 },
    dragging: false,
  };

  function fetchJson(url) {
    return fetch(url).then(function (r) {
      if (!r.ok) throw new Error("HTTP " + r.status + " fetching " + url);
      return r.json();
    });
  }

  function decodeVectors(d) {
    var bytes = atob(d.vectors_b64);
    var dims = d.meta.dims;
    var scale = d.meta.scale / 127;
    d.words.forEach(function (w, i) {
      var v = new Float32Array(dims);
      for (var j = 0; j < dims; j++) {
        var b = bytes.charCodeAt(i * dims + j);
        v[j] = (b < 128 ? b : b - 256) * scale;
      }
      V[w] = v;
    });
  }

  // ---------- SVG helpers -----------------------------------------------------

  function el(tag, attrs) {
    var e = document.createElementNS("http://www.w3.org/2000/svg", tag);
    for (var k in attrs) e.setAttribute(k, attrs[k]);
    return e;
  }
  function clear(node) { while (node.firstChild) node.removeChild(node.firstChild); }

  function barList(pairs, digits, opts) {
    opts = opts || {};
    return '<ul class="w6-bar-list">' + pairs.map(function (p) {
      var col = opts.color || "var(--accent-2)";
      return '<li class="w6-bar-row"><span class="w6-bar-word">' + esc(p[0]) + "</span>" +
        '<span class="w6-bar-track"><span class="w6-bar-fill" style="background:' + col +
        ';width:' + Math.max(4, Math.round(100 * p[1] / (opts.max ||
          Math.max.apply(null, pairs.map(function (p2) { return p2[1]; })) || 1))) +
        '%"></span></span><span class="w6-bar-val">' + p[1].toFixed(digits) + "</span></li>";
    }).join("") + "</ul>";
  }

  // ---------- character navigation --------------------------------------------

  function setCharacter(nid) {
    if (!S.pages[nid]) return;
    state.nid = nid;
    state.word = null;                    // follow this page's own fingerprint
    state.zoom = { k: 1, x: 0, y: 0 };
    document.getElementById("w64-select").value = nid;
    renderAll();
  }

  function bindCharacterControls(root) {
    var sel = root.querySelector("#w64-select");
    sel.innerHTML = Object.keys(S.pages).sort(function (a, b) {
      return S.pages[a].name.localeCompare(S.pages[b].name);
    }).map(function (nid) {
      return '<option value="' + esc(nid) + '">' + esc(S.pages[nid].name) + "</option>";
    }).join("");
    sel.value = state.nid;
    sel.addEventListener("change", function () { setCharacter(this.value); });

    var input = root.querySelector("#w64-input");
    var dl = root.querySelector("#w64-datalist");
    dl.innerHTML = Object.keys(S.pages).map(function (nid) {
      return '<option value="' + esc(S.pages[nid].name) + '">';
    }).join("");
    input.addEventListener("change", function () {
      var q = this.value.trim().toLowerCase();
      this.value = "";
      var hit = Object.keys(S.pages).find(function (nid) {
        return S.pages[nid].name.toLowerCase() === q;
      });
      if (hit) setCharacter(hit);
    });
    root.querySelector("#w64-random").addEventListener("click", function () {
      var ids = Object.keys(S.pages);
      setCharacter(ids[Math.floor(Math.random() * ids.length)]);
    });
    root.querySelector("#w64-no-names").addEventListener("change", function () {
      state.noNames = this.checked;
      renderTopics();
    });
  }

  // ---------- identity / topics / fingerprint ---------------------------------

  function renderIdentity() {
    var p = S.pages[state.nid];
    document.getElementById("w64-idcard").innerHTML =
      '<h4 class="inspector-name" style="margin-bottom:8px">' + esc(p.name) + "</h4>" +
      '<div class="w6-legend">' +
      '<span><span class="swatch" style="background:' + commColor(p.community) + '"></span>' +
      "C" + p.community + "</span>" +
      "<span>" + p.in_degree + " in-links</span>" +
      "<span>" + p.links.length + " linked neighbours</span>" +
      "<span>" + p.tokens.toLocaleString() + " tokens</span>" +
      "</div>";
  }

  function renderTopics() {
    var p = S.pages[state.nid];
    var theta = (state.noNames ? p.theta_n : p.theta).slice();
    var labels = (state.noNames ? S.topics.no_names : S.topics.with_names).labels;
    var max = Math.max.apply(null, theta) || 1;
    document.getElementById("w64-topic-col").innerHTML =
      '<div class="w6-doc-head">' + (state.noNames ? "Topics (names removed)" : "Topics") + "</div>" +
      '<p class="w6-doc-sub">The page&rsquo;s own mixture &mdash; what share of this page comes from each topic.</p>' +
      '<ul class="w6-bar-list">' + theta.map(function (t, k) {
        return '<li class="w6-bar-row"><span class="w6-bar-word" style="font-size:11.5px">' +
          esc(labels[k]) + "</span>" +
          '<span class="w6-bar-track"><span class="w6-bar-fill" style="background:' +
          TOPIC_COLOR[k % 8] + ';width:' + Math.max(t > 0.004 ? 3 : 0, Math.round(100 * t / max)) +
          '%"></span></span><span class="w6-bar-val">' + (100 * t).toFixed(1) + "%</span></li>";
      }).join("") + "</ul>" +
      (Math.max.apply(null, theta) > 0.95
        ? '<p class="w6-doc-sub">A near-single-topic page &mdash; the mixture left the page almost entirely inside one theme.</p>'
        : "");
  }

  function renderFingerprint() {
    var fpw = MAP.pages[state.nid].fpw;
    var max = Math.max.apply(null, fpw.map(function (p) { return p[1]; }));
    document.getElementById("w64-fp-col").innerHTML =
      '<div class="w6-doc-head">TF-IDF fingerprints (names removed)</div>' +
      '<p class="w6-doc-sub">tf(t,d)·ln(N/df) &mdash; click a word to inspect it below.</p>' +
      '<ul class="w6-bar-list">' + fpw.map(function (p2) {
        var active = currentWord() === p2[0];
        return '<li class="w6-nb-row' + (active ? " active" : "") +
          '" data-word="' + esc(p2[0]) + '" role="button">' +
          '<span class="w6-rank"></span>' +
          '<span class="w6-bar-word" style="width:8.5em">' + esc(p2[0]) + "</span>" +
          '<span class="w6-bar-track"><span class="w6-bar-fill" style="background:var(--accent);width:' +
          Math.max(4, Math.round(100 * p2[1] / max)) + '%"></span></span>' +
          '<span class="w6-bar-val">' + p2[1].toFixed(3) + "</span></li>";
      }).join("") + "</ul>";
    document.querySelectorAll("#w64-fp-col .w6-nb-row").forEach(function (row) {
      row.addEventListener("click", function () {
        state.word = row.getAttribute("data-word");
        renderWordPanel();
        renderFingerprint();
      });
    });
  }

  function currentWord() {
    if (state.word) return state.word;
    var fpw = MAP.pages[state.nid].fpw;
    return fpw.length ? fpw[0][0] : null;
  }

  // ---------- constellation -----------------------------------------------------

  function renderConstellation() {
    var svg = document.getElementById("w64-ring-svg");
    var W = 460, H = 460, cx = W / 2, cy = H / 2;
    clear(svg);
    svg.setAttribute("viewBox", "0 0 " + W + " " + H);

    var g = el("g", { transform: "translate(" + state.zoom.x + "," + state.zoom.y + ") scale(" + state.zoom.k + ")" });
    svg.appendChild(g);

    var p = S.pages[state.nid];
    var rings = [
      { mode: "tfidf", label: "TF-IDF", col: COL_TFIDF, r: 85 },
      { mode: "counts", label: "raw counts", col: COL_COUNTS, r: 140 },
      { mode: state.noNames ? "lda_wo" : "lda_with", label: "topics", col: COL_LDA, r: 195 },
    ];

    // ring guides + labels
    rings.forEach(function (ring) {
      g.appendChild(el("circle", {
        cx: cx, cy: cy, r: ring.r, fill: "none",
        stroke: ring.col, opacity: 0.16, "stroke-dasharray": "2 4",
      }));
      var t = el("text", {
        x: cx, y: cy - ring.r - 6, fill: ring.col, opacity: 0.8,
        "font-size": 11, "text-anchor": "middle", "font-family": "var(--mono)",
      });
      t.textContent = ring.label;
      g.appendChild(t);
    });

    rings.forEach(function (ring, ri) {
      var nbs = S.neighbors[ring.mode][state.nid];
      nbs.forEach(function (it, i) {
        var ang = -Math.PI / 2 + (i * 2 * Math.PI) / nbs.length;
        var x = cx + ring.r * Math.cos(ang);
        var y = cy + ring.r * Math.sin(ang);
        var linked = p.links.indexOf(it.o) >= 0;
        if (linked) {
          g.appendChild(el("line", {
            x1: cx, y1: cy, x2: x, y2: y,
            stroke: COL_LINK, "stroke-width": 1.4, opacity: 0.65,
          }));
        }
        var r = 3.5 + 4 * it.c;
        var dot = el("circle", {
          cx: x.toFixed(1), cy: y.toFixed(1), r: r.toFixed(1),
          fill: ring.col, opacity: 0.9,
          stroke: linked ? COL_LINK : "rgba(0,0,0,0.3)",
          "stroke-width": linked ? 1.6 : 0.6,
        });
        var title = el("title", {});
        title.textContent = S.pages[it.o].name +
          "\ncosine " + it.c.toFixed(3) + (linked ? " · LINKED" : " · not linked") +
          "\n(click to dive in)";
        dot.appendChild(title);
        (function (nid) {
          dot.addEventListener("click", function () { setCharacter(nid); });
        })(it.o);
        g.appendChild(dot);
      });
    });

    // center node
    g.appendChild(el("circle", {
      cx: cx, cy: cy, r: 8, fill: commColor(p.community),
      stroke: "#fff", "stroke-width": 2,
    }));
    var ct = el("title", {});
    ct.textContent = p.name;
    g.appendChild(ct);

    bindPanZoom(svg);
  }

  function bindPanZoom(svg) {
    svg.addEventListener("wheel", function (e) {
      e.preventDefault();
      var f = e.deltaY < 0 ? 1.15 : 1 / 1.15;
      var k = Math.min(4, Math.max(0.5, state.zoom.k * f));
      // keep zoom centered on the figure
      state.zoom.x = (state.zoom.x - 230) * (k / state.zoom.k) + 230;
      state.zoom.y = (state.zoom.y - 230) * (k / state.zoom.k) + 230;
      state.zoom.k = k;
      renderConstellation();
    }, { passive: false });
    var down = null;
    svg.addEventListener("mousedown", function (e) {
      down = { x: e.clientX, y: e.clientY, zoom: Object.assign({}, state.zoom) };
    });
    window.addEventListener("mousemove", function (e) {
      if (!down) return;
      state.zoom.x = down.zoom.x + (e.clientX - down.x);
      state.zoom.y = down.zoom.y + (e.clientY - down.y);
      renderConstellationThrottled();
    });
    window.addEventListener("mouseup", function () { down = null; });
    svg.addEventListener("dblclick", function () {
      state.zoom = { k: 1, x: 0, y: 0 };
      renderConstellation();
    });
  }

  var throttleTimer = null;
  function renderConstellationThrottled() {
    if (throttleTimer) return;
    throttleTimer = setTimeout(function () {
      throttleTimer = null;
      renderConstellation();
    }, 60);
  }

  // ---------- word inspector -----------------------------------------------------

  function renderWordPanel() {
    var root = document.getElementById("w64-word-col");
    var nid = state.nid;
    var fpw = MAP.pages[nid].fpw;
    var chips = fpw.map(function (p2) {
      return '<button class="w6-chip' + (currentWord() === p2[0] ? " active" : "") +
        '" data-w="' + esc(p2[0]) + '">' + esc(p2[0]) + "</button>";
    }).join("");
    var w = currentWord();
    var html =
      '<div class="w6-doc-head">Word inspector</div>' +
      '<p class="w6-doc-sub">The same word as a document-fingerprint entry, then as a row of the word&ndash;context matrix and a point in the learned space.</p>' +
      '<div class="w6-chips" id="w64-chips">' + chips + "</div>" +
      '<div class="w64-row" style="display:flex;gap:6px;margin-bottom:10px;">' +
      '<input id="w64-word-input" list="w64-word-list" class="search-input" placeholder="search any week-6 word…" autocomplete="off">' +
      '<datalist id="w64-word-list"></datalist></div>' +
      '<div id="w64-word-cols"></div>' +
      '<div id="w64-vecmap"></div>';
    root.innerHTML = html;
    root.querySelectorAll(".w6-chip").forEach(function (b) {
      b.addEventListener("click", function () {
        state.word = b.getAttribute("data-w");
        renderWordPanel();
        renderFingerprint();
      });
    });
    var wl = WORDS ? Object.keys(WORDS.words).sort().map(function (w2) {
      return '<option value="' + esc(w2) + '">';
    }).join("") : "";
    root.querySelector("#w64-word-list").innerHTML = wl;
    root.querySelector("#w64-word-input").addEventListener("change", function () {
      var q = this.value.trim().toLowerCase();
      this.value = "";
      if (WORDS.words[q]) {
        state.word = q;
        renderWordPanel();
        renderFingerprint();
      }
    });

    if (!w || !WORDS || !WORDS.words[w]) {
      document.getElementById("w64-word-cols").innerHTML =
        '<p class="w6-doc-sub">' + (w
          ? "<code>" + esc(w) + "</code> is below the word vocabulary thresholds."
          : "No fingerprint word available.") + "</p>";
      return;
    }
    var d = WORDS.words[w];
    var cols = [
      { head: "counts", col: COL_COUNTS, list: d.nb_counts, digits: 2 },
      { head: "PPMI", col: COL_TFIDF, list: d.nb_ppmi, digits: 2 },
      { head: "Word2Vec", col: COL_LDA, list: d.nb_w2v, digits: 2 },
    ];
    document.getElementById("w64-word-cols").innerHTML =
      cols.map(function (c) {
        return '<div class="w64-wordcol"><div class="w6-doc-head" style="color:' + c.col + '">' +
          esc(c.head) + "</div>" +
          (c.list && c.list.length ? barList(c.list, c.digits, { color: c.col }) :
            '<p class="w6-doc-sub">no neighbors.</p>') + "</div>";
      }).join("") +
      '<div style="margin-top:10px"><div class="w6-doc-head">PPMI context dimensions</div>' +
      barList(d.dims, 2, { color: COL_TFIDF }) + "</div>";

    document.getElementById("w64-vecmap").innerHTML =
      '<div class="w6-doc-head" style="margin-top:12px">The Word2Vec neighborhood, projected</div>' +
      '<p class="w6-doc-sub">Live PCA of the shipped vectors: the word and its W2V- and PPMI-neighbors, two principal axes. No labels on axes &mdash; the point is neighborhoods, not coordinates.</p>' +
      '<svg id="w64-vec-svg" style="width:100%;height:280px;"></svg>';
    renderVecMap(w, d);
    renderSentences(w);
  }

  function pca2(list) {
    /* 2-D PCA by power iteration on the Gram matrix: n is small (<= 25 rows),
       d = 100 — G is 25x25, two eigenvectors, exact enough for a scatter. */
    var n = list.length, d = list[0].length;
    var mu = new Float32Array(d);
    list.forEach(function (v) {
      for (var j = 0; j < d; j++) mu[j] += v[j] / n;
    });
    var A = list.map(function (v) {
      var c = new Float32Array(d);
      for (var j = 0; j < d; j++) c[j] = v[j] - mu[j];
      return c;
    });
    function dot(a, b) {
      var s = 0;
      for (var j = 0; j < d; j++) s += a[j] * b[j];
      return s;
    }
    var G = [];
    for (var i = 0; i < n; i++) {
      G.push(new Float32Array(n));
      for (var j = 0; j < n; j++) G[i][j] = dot(A[i], A[j]);
    }
    function powerVec(exclude) {
      var v = new Float32Array(n);
      for (var s = 0; s < n; s++) v[s] = Math.sin((s + 1) * 12.9898) + 0.5;
      for (var it = 0; it < 300; it++) {
        var nv = new Float32Array(n), norm = 0;
        for (var i2 = 0; i2 < n; i2++) {
          var acc = 0;
          for (var j2 = 0; j2 < n; j2++) acc += G[i2][j2] * v[j2];
          if (exclude) acc -= exclude[i2] * dotSym(exclude, v);
          nv[i2] = acc;
          norm += acc * acc;
        }
        norm = Math.sqrt(norm) || 1;
        for (i2 = 0; i2 < n; i2++) v[i2] = nv[i2] / norm;
      }
      return v;
    }
    function dotSym(a, b) {
      var s = 0;
      for (var i3 = 0; i3 < n; i3++) s += a[i3] * b[i3];
      return s;
    }
    function lambda(u) {
      var s = 0;
      for (var i4 = 0; i4 < n; i4++) {
        var acc = 0;
        for (var j4 = 0; j4 < n; j4++) acc += G[i4][j4] * u[j4];
        s += u[i4] * acc;
      }
      return s;
    }
    var u1 = powerVec(null);
    var l1 = lambda(u1);
    // deflate, then the second eigenvector: G' = G - λ1 u1 u1ᵀ
    for (i = 0; i < n; i++) {
      for (var j5 = 0; j5 < n; j5++) G[i][j5] -= l1 * u1[i] * u1[j5];
    }
    var u2 = powerVec(null);
    var l2 = lambda(u2);
    return A.map(function (_, i5) {
      var a = Math.sqrt(Math.max(l1, 0)) * u1[i5];
      var b = Math.sqrt(Math.max(l2, 0)) * u2[i5];
      return [a, b];
    });
  }

  function renderVecMap(word, d) {
    var svg = document.getElementById("w64-vec-svg");
    if (!svg || !VECS) return;
    var wv = V[word];
    if (!wv) return;
    drawVecMap(svg, word, d, wv);
  }

  function drawVecMap(svg, word, d, wv) {
    var W = 460, H = 280;
    clear(svg);
    svg.setAttribute("viewBox", "0 0 " + W + " " + H);

    // points: the word itself + up to 12 neighbors from each of the two lists
    var items = [{ w: word, v: wv, kind: "target" }];
    [["nb_ppmi", "ppmi", COL_TFIDF], ["nb_w2v", "w2v", COL_LDA]].forEach(function (pair) {
      (d[pair[0]] || []).forEach(function (nb) {
        var v = V[nb[0]];
        if (v) items.push({ w: nb[0], v: v, kind: pair[1], col: pair[2] });
      });
    });
    var seen = {};
    items = items.filter(function (it) {
      if (seen[it.w]) return false;
      seen[it.w] = true;
      return true;
    });

    var coords = pca2(items.map(function (it) { return it.v; }));
    var xs = coords.map(function (c) { return c[0]; });
    var ys = coords.map(function (c) { return c[1]; });
    var minX = Math.min.apply(null, xs), maxX = Math.max.apply(null, xs);
    var minY = Math.min.apply(null, ys), maxY = Math.max.apply(null, ys);
    var spanX = (maxX - minX) || 1, spanY = (maxY - minY) || 1;
    var m = 34;

    coords.forEach(function (c, i) {
      var it = items[i];
      var x = m + ((c[0] - minX) / spanX) * (W - 2 * m);
      var y = m + (1 - ((c[1] - minY) / spanY)) * (H - 2 * m);
      var isTarget = it.kind === "target";
      var r = isTarget ? 7 : 4.5;
      var col = isTarget ? "#fff" : it.col;
      var dot = el("circle", {
        cx: x.toFixed(1), cy: y.toFixed(1), r: r,
        fill: isTarget ? "var(--text)" : col, opacity: 0.9,
        stroke: isTarget ? wordColorStroke() : "rgba(0,0,0,0.3)",
        "stroke-width": isTarget ? 2 : 0.5,
      });
      var title = el("title", {});
      title.textContent = it.w + (isTarget ? " (target)" : " (" + it.kind + "-neighbor)");
      dot.appendChild(title);
      svg.appendChild(dot);
      if (isTarget) {
        var t = el("text", {
          x: x, y: y - 10, fill: "var(--text)", "font-size": 12,
          "text-anchor": "middle", "font-family": "var(--mono)",
        });
        t.textContent = it.w;
        svg.appendChild(t);
      }
    });

    function wordColorStroke() {
      return COL_COUNTS;
    }
  }

  // ---------- concordance -----------------------------------------------------

  function renderSentences(word) {
    var box = document.getElementById("w64-sent-col");
    if (!SENTS) {
      box.innerHTML = '<div class="w6-doc-head">Concordance</div>' +
        '<p class="w6-doc-sub">loading sentences…</p>';
      fetchJson("../data/marvel_pages/week6_sents.json").then(function (d) {
        SENTS = d;
        renderSentences(currentWord());
      });
      return;
    }
    var pool = (SENTS.pages[state.nid] || []).filter(function (s) {
      return new RegExp("\\b" + word.replace(/[.*+?^${}()|[\]\\]/g, "\\$&") + "\\b", "i").test(s);
    });
    var m = pool.map(function (s) {
      var rx = new RegExp("\\b(" + word.replace(/[.*+?^${}()|[\]\\]/g, "\\$&") + ")\\b", "i");
      return s.replace(rx, function (all) { return "<mark>" + esc(all) + "</mark>"; });
    });
    box.innerHTML = '<div class="w6-doc-head">Concordance &mdash; <code>' + esc(word) +
      "</code> on this page</div>" +
      (m.length
        ? m.slice(0, 6).map(function (s) {
            return '<p class="w6-sent">' + s + "</p>";
          }).join("")
        : '<p class="w6-doc-sub">No sentence contains it &mdash; the word level only agrees with the page level part of the time.</p>');
  }

  // ---------- boot ---------------------------------------------------------------

  function renderAll() {
    renderIdentity();
    renderTopics();
    renderFingerprint();
    renderConstellation();
    renderWordPanel();
  }

  function boot(summary, map, words, vecs) {
    S = summary; MAP = map; WORDS = words; VECS = vecs;
    decodeVectors(vecs);
    state.nid = Object.keys(S.pages).find(function (nid) {
      return S.pages[nid].name === "Spider-Man";
    });
    bindCharacterControls(document.getElementById("w64-topbar"));
    renderAll();
    window.addEventListener("resize", debounce(renderConstellation, 200));
  }

  function debounce(fn, ms) {
    var t = null;
    return function () {
      clearTimeout(t);
      t = setTimeout(fn, ms);
    };
  }

  Promise.all([
    fetchJson("../data/marvel_pages/week6_summary.json"),
    fetchJson("../data/marvel_pages/week63_map.json"),
    fetchJson("../data/marvel_pages/week6_words.json"),
    fetchJson("../data/marvel_pages/week63_vecs.json"),
  ]).then(function (r) { boot.apply(null, r); });
})();
