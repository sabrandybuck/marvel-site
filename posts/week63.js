/*
 * Week 6-3 explorable — "the Marvel map" + community term contrast.
 *
 * Two hand-rolled SVG panels over frozen week-6 data:
 *
 * 1. THE MAP — every character is a dot whose coordinates are projections of
 *    their TF-IDF-weighted fingerprint average onto an embedding axis
 *    (pos-pole average minus neg-pole average, normalized). Axes are either
 *    the built-in presets (science↔magic, body↔mind, war↔home, …) or any two
 *    words the user types — the quantized Word2Vec vectors ship to the
 *    browser, so nothing is pre-baked. Watch Doctor Strange drift to the
 *    magic end and Machine Man hold the science end, and try war↔home for
 *    the gender-bias probe from the course page.
 *
 * 2. THE TERM CONTRAST — a Scattertext-style log-log plot of uses-per-10k
 *    words for the two selected Louvain communities, diagonal = equal rates.
 *    Red-ish: distinctive of community A, blue-ish: of B.
 *
 * Data (all lazy-loaded, small): week63_map.json (fingerprints + axes),
 * week63_vecs.json (int8-quantized Word2Vec), week63_terms.json
 * (per-community term counts). A pure reader — no live model is trained.
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
    return ci < 8
      ? TAB20[ci * 2]
      : TAB20[((ci - 8) * 2 + 1) % 20];
  }

  var COL_A = "#e6353a";
  var COL_B = "#4d7cff";
  var COL_NEUTRAL = "#9aa0ad";

  var MAP = null;    // week63_map.json
  var VECS = null;   // week63_vecs.json
  var TERMS = null;  // week63_terms.json

  var V = {};        // word -> Float32Array
  var MISSING = [];  // pole words not in the shipped vocabulary

  var state = {
    x: 0,   // preset index or "custom"
    y: 1,
    xNeg: "science", xPos: "magic",
    yNeg: "strength", yPos: "telepathy",
    highlight: null,
    minCount: 5,
    commA: 0,
    commB: 1,
    label: true,
  };

  function fetchJson(url) {
    return fetch(url).then(function (r) {
      if (!r.ok) throw new Error("HTTP " + r.status + " fetching " + url);
      return r.json();
    });
  }

  // ---------- vectors ------------------------------------------------------

  function decodeVectors(d) {
    var bytes = atob(d.vectors_b64);
    var dims = d.meta.dims;
    var scale = d.meta.scale / 127;
    var rows = d.words;
    for (var i = 0; i < rows.length; i++) {
      var v = new Float32Array(dims);
      for (var j = 0; j < dims; j++) {
        var b = bytes.charCodeAt(i * dims + j);
        v[j] = ((b < 128 ? b : b - 256)) * scale;
      }
      V[rows[i]] = v;
    }
  }

  function vecOf(word) { return V[word] || null; }

  function axisFrom(negWords, posWords) {
    MISSING = [];
    var neg = [], pos = [];
    negWords.concat(posWords).forEach(function (w) {
      if (V[w]) (negWords.indexOf(w) >= 0 ? neg : pos).push(V[w]);
      else MISSING.push(w);
    });
    if (!neg.length || !pos.length) return null;
    function avg(list) {
      var v = new Float32Array(list[0].length);
      list.forEach(function (w) {
        for (var i = 0; i < v.length; i++) v[i] += w[i];
      });
      return v;
    }
    var a = avg(neg), b = avg(pos);
    var d = new Float32Array(a.length);
    var norm = 0;
    for (var i = 0; i < a.length; i++) {
      d[i] = b[i] - a[i];
      norm += d[i] * d[i];
    }
    norm = Math.sqrt(norm) || 1;
    for (var j = 0; j < d.length; j++) d[j] /= norm;
    return d;
  }

  function charAxis(nid, d) {
    var fp = MAP.pages[nid].fpw;
    var num = 0, den = 0;
    var pulls = [];
    for (var i = 0; i < fp.length; i++) {
      var w = fp[i][0], wt = fp[i][1];
      var v = V[w];
      if (!v) continue;
      var c = 0;
      for (var j = 0; j < v.length; j++) c += v[j] * d[j];
      num += wt * c;
      den += wt;
      pulls.push([w, c]);
    }
    if (den === 0) return null;
    return { pos: num / den, pulls: pulls };
  }

  // ---------- SVG helpers --------------------------------------------------

  function el(tag, attrs) {
    var e = document.createElementNS("http://www.w3.org/2000/svg", tag);
    for (var k in attrs) e.setAttribute(k, attrs[k]);
    return e;
  }

  function clearSvg(svg) {
    while (svg.firstChild) svg.removeChild(svg.firstChild);
  }

  function fmtCoord(x) {
    return (x >= 0 ? "+" : "") + x.toFixed(2);
  }

  function fmtRate(r) {
    return r >= 10 ? Math.round(r).toString() : r >= 0.1 ? r.toFixed(1) : r.toFixed(2);
  }

  // ---------- PANEL 1: the map ----------------------------------------------

  function renderMap() {
    var svg = document.getElementById("w63-map-svg");
    var box = svg.parentElement.getBoundingClientRect();
    var width = Math.max(560, box.width);
    var height = 520;
    svg.setAttribute("viewBox", "0 0 " + width + " " + height);
    svg.setAttribute("width", width);
    svg.setAttribute("height", height);
    clearSvg(svg);

    var m = 50;
    var negX = "", posX = "", negY = "", posY = "";
    var dx = axisFor(state.x, state.xNeg, state.xPos);
    if (dx) { negX = dx.negLabel; posX = dx.posLabel; }
    var dy = axisFor(state.y, state.yNeg, state.yPos);
    if (dy) { negY = dy.negLabel; posY = dy.posLabel; }

    // axes chrome
    var g = el("g", {});
    svg.appendChild(g);
    g.appendChild(el("line", {
      x1: m, y1: height / 2, x2: width - m, y2: height / 2,
      stroke: "var(--line)", "stroke-width": 1,
    }));
    g.appendChild(el("line", {
      x1: width / 2, y1: m, x2: width / 2, y2: height - m,
      stroke: "var(--line)", "stroke-width": 1,
    }));
    function axisText(x, y, txt, anchor) {
      var t = el("text", {
        x: x, y: y, fill: "var(--text-dim)", "font-size": 12,
        "text-anchor": anchor || "middle", "font-family": "var(--mono)",
      });
      t.textContent = txt;
      g.appendChild(t);
    }
    if (dx) {
      axisText(m - 6, height / 2 + 4, negX + " ↤", "end");
      axisText(width - m + 6, height / 2 + 4, "↤ " + posX, "start");
    }
    if (dy) {
      axisText(width / 2, m - 8, posY + " ↑", "middle");
      axisText(width / 2, height - m + 16, "↓ " + negY, "middle");
    }

    var note = document.getElementById("w63-map-note");
    var missingNote = "";
    if (MISSING.length) {
      missingNote = "not in the Marvel vocabulary: " + MISSING.join(", ");
    }

    // dots
    var pts = [];
    ptsByNid = {};
    ids().forEach(function (nid) {
      if (!dx) return;
      var px = charAxis(nid, dx.d);
      if (px == null) return;
      var py = dy ? charAxis(nid, dy.d) : null;
      if (dy && py == null) return;
      var x = m + ((px.pos + 1) / 2) * (width - 2 * m);
      var y = dy ? m + (1 - (py.pos + 1) / 2) * (height - 2 * m)
                 : height / 2 + (((nid.charCodeAt(0) % 7) - 3) * 14);
      var p = MAP.pages[nid];
      pts.push({ nid: nid, x: x, y: y, px: px, py: py, p: p });
    });

    pts.forEach(function (t) { ptsByNid[t.nid] = t; });
    pts.forEach(function (t) {
      var r = 2.5 + 3.5 * Math.sqrt(Math.min(t.p.in_degree, 106) / 106);
      var hl = state.highlight === t.nid;
      var c = el("circle", {
        cx: t.x.toFixed(1), cy: t.y.toFixed(1), r: hl ? r + 3 : r.toFixed(1),
        fill: commColor(t.p.community),
        stroke: hl ? "#fff" : "rgba(0,0,0,0.35)",
        "stroke-width": hl ? 2 : 0.5,
        opacity: 0.92,
      });
      var title = el("title", {});
      title.textContent = t.p.name + " · C" + t.p.community +
        (dx ? " · X " + fmtCoord(t.px.pos) : "") +
        (t.py ? " · Y " + fmtCoord(t.py.pos) : "");
      c.appendChild(title);
      c.addEventListener("click", function () { openCharPanel(t); });
      svg.appendChild(c);
      if (hl || state.highlight === null && (t.p.name === "Doctor Strange" ||
          t.p.name === "Machine Man" || t.p.name === "Spider-Man")) {
        var lbl = el("text", {
          x: t.x.toFixed(1), y: (t.y - r - 3).toFixed(1), fill: "var(--text)",
          "font-size": 10, "text-anchor": "middle",
        });
        lbl.textContent = t.p.name;
        svg.appendChild(lbl);
      }
    });

    if (note) {
      note.textContent = missingNote ||
        (dx ? dy ? "" : "no Y axis — dots jittered for legibility only" : "");
    }
    return pts;
  }

  function ids() {
    return Object.keys(MAP.pages);
  }

  function axisFor(which, negW, posW) {
    var d, negLabel, posLabel;
    if (which === "none") return null;
    if (which === "custom") {
      d = axisFrom([negW.trim().toLowerCase()], [posW.trim().toLowerCase()]);
      negLabel = negW.trim(); posLabel = posW.trim();
    } else {
      var preset = MAP.axes[which] || MAP.axes[0];
      d = axisFrom(preset.neg, preset.pos);
      negLabel = preset.neg[0]; posLabel = preset.pos[0];
    }
    if (!d) return null;
    return { d: d, negLabel: negLabel, posLabel: posLabel };
  }

  function openCharPanel(t) {
    state.highlight = t.nid;
    renderMap();
    var p = t.p;
    function endList(pulls, dir) {
      var arr = pulls.filter(function (pr) {
        return dir > 0 ? pr[1] > 0 : pr[1] < 0;
      });
      arr.sort(function (a, b) { return dir > 0 ? b[1] - a[1] : a[1] - b[1]; });
      return arr.slice(0, 3).map(function (pr) {
        return '<span class="neighbor-pill" style="color:var(--text)">' +
          esc(pr[0]) + "</span>";
      }).join(" ") || "—";
    }
    var px = t.px ? t.px.pulls : [];
    var py = t.py ? t.py.pulls : [];
    document.getElementById("w63-char-panel").innerHTML =
      '<h4 class="inspector-name">' + esc(p.name) + "</h4>" +
      '<div style="margin-bottom:12px"><span class="inspector-group">C' +
      p.community + " · " + p.tokens.toLocaleString() + " tokens · in-degree " +
      p.in_degree + "</span></div>" +
      '<div class="inspector-stats">' +
      (t.px ? '<div class="inspector-stat"><span class="stat-label">X projection</span><span class="stat-value">' + fmtCoord(t.px.pos) + "</span></div>" : "") +
      (t.py ? '<div class="inspector-stat"><span class="stat-label">Y projection</span><span class="stat-value">' + fmtCoord(t.py.pos) + "</span></div>" : "") +
      "</div>" +
      (t.px ? '<div class="inspector-section"><h5>Pulled toward the right (X) by</h5><div>' +
        endList(px, +1) + "</div><h5>…and toward the left by</h5><div>" +
        endList(px, -1) + "</div></div>" : "") +
      (t.py ? '<div class="inspector-section" style="margin-top:10px"><h5>Pulled toward the top (Y) by</h5><div>' +
        endList(py, +1) + "</div><h5>…and toward the bottom by</h5><div>" +
        endList(py, -1) + "</div></div>" : "") +
      '<p class="network-note">These positions are not facts about the characters: ' +
      "they measure how <em>Wikipedia</em> talks about them, through vectors trained " +
      "on the very same 727k tokens.</p>";
  }

  function buildMapControls(root) {
    var xSel = root.querySelector("#w63-x-axis");
    var ySel = root.querySelector("#w63-y-axis");
    function opts() {
      var o = "";
      MAP.axes.forEach(function (a, i) {
        o += '<option value="' + i + '">' + esc(a.label) + "</option>";
      });
      o += '<option value="custom">custom…</option>';
      return o;
    }
    xSel.innerHTML = opts();
    ySel.innerHTML = '<option value="none">none (horizontal line)</option>' + opts();
    xSel.value = String(state.x);
    ySel.value = String(state.y);

    function customRow(which, sel) {
      var row = root.querySelector("#w63-" + which + "-custom");
      var sync = function () {
        row.style.display = sel.value === "custom" ? "flex" : "none";
      };
      sel.addEventListener("change", function () {
        state[which] = sel.value === "custom" ? "custom" : +sel.value;
        sync();
        renderMap();
      });
      row.querySelector("#w63-" + which + "-neg").addEventListener("change", function () {
        state[which + "Neg"] = this.value; renderMap();
      });
      row.querySelector("#w63-" + which + "-pos").addEventListener("change", function () {
        state[which + "Pos"] = this.value; renderMap();
      });
      sync();
    }
    customRow("x", xSel);
    customRow("y", ySel);

    var search = root.querySelector("#w63-char-input");
    var dl = root.querySelector("#w63-char-list");
    dl.innerHTML = ids().map(function (nid) {
      return '<option value="' + esc(MAP.pages[nid].name) + '">';
    }).join("");
    function findNid(name) {
      return ids().find(function (nid) {
        return MAP.pages[nid].name.toLowerCase() === name.toLowerCase();
      });
    }
    search.addEventListener("change", function () {
      var nid = findNid(this.value);
      this.value = "";
      if (!nid) return;
      state.highlight = nid;
      renderMap();
      var pts = svgPoints();
      openCharPanel(pts[nid]);
    });

    root.querySelector("#w63-map-reset").addEventListener("click", function () {
      state.x = 0; state.y = 1; state.highlight = null;
      xSel.value = "0"; ySel.value = "1";
      root.querySelector("#w63-x-custom").style.display = "none";
      root.querySelector("#w63-y-custom").style.display = "none";
      renderMap();
      document.getElementById("w63-char-panel").innerHTML = "";
    });
  }

  var ptsByNid = {};
  function svgPoints() { return ptsByNid; }

  // ---------- PANEL 2: term contrast ---------------------------------------

  function rate(count, tokens) { return 10000 * count / tokens; }

  function renderTerms() {
    var svg = document.getElementById("w63-terms-svg");
    var box = svg.parentElement.getBoundingClientRect();
    var width = Math.max(560, box.width);
    var height = 480;
    svg.setAttribute("viewBox", "0 0 " + width + " " + height);
    svg.setAttribute("width", width);
    svg.setAttribute("height", height);
    clearSvg(svg);

    var A = byId(TERMS.communities, state.commA);
    var B = byId(TERMS.communities, state.commB);
    var countA = toCountMap(A), countB = toCountMap(B);

    var FLOOR = 0.01;  // per-10k; below this a term is "absent"
    function logRate(c, tokens) {
      return Math.log10(Math.max(rate(c, tokens), FLOOR));
    }
    var lo = logRate(0, 1e9), hi = Math.log10(20000);
    function scale(v) {
      var t = (v - lo) / (hi - lo);
      return t;
    }

    // grid + chrome
    var m = 46;
    var g = el("g", {});
    svg.appendChild(g);
    [lo, Math.log10(1), Math.log10(10), Math.log10(100), Math.log10(1000), Math.log10(10000)].forEach(function (v) {
      var p = m + scale(v) * (width - 2 * m);
      g.appendChild(el("line", {
        x1: p, y1: m, x2: p, y2: height - m, stroke: "rgba(255,255,255,0.06)",
      }));
      var t = el("text", { x: p, y: height - m + 16, fill: "var(--text-dim)", "font-size": 10, "text-anchor": "middle" });
      t.textContent = rateAxisLabel(v);
      g.appendChild(t);
      var p2 = m + (1 - scale(v)) * (height - 2 * m);
      var t2 = el("text", { x: m - 8, y: p2 + 3, fill: "var(--text-dim)", "font-size": 10, "text-anchor": "end" });
      t2.textContent = rateAxisLabel(v);
      g.appendChild(t2);
    });
    g.appendChild(el("line", {
      x1: m, y1: height - m, x2: width - m, y2: m,
      stroke: "rgba(255,255,255,0.18)", "stroke-dasharray": "3 3",
    }));
    var dlab = el("text", { x: width - m - 8, y: height - m - 8, fill: "var(--text-dim)", "font-size": 10, "text-anchor": "end" });
    dlab.textContent = "equal rates";
    g.appendChild(dlab);

    // points
    var minCount = state.minCount;
    var shown = 0, labeled = [];
    for (var i = 0; i < TERMS.terms.length; i++) {
      var cA = countA[i] || 0, cB = countB[i] || 0;
      if (cA < minCount && cB < minCount) continue;
      var rA = rate(cA, A.tokens), rB = rate(cB, B.tokens);
      var x = m + scale(logRate(cA, A.tokens)) * (width - 2 * m);
      var y = m + (1 - scale(logRate(cB, B.tokens))) * (height - 2 * m);
      var col = rA > rB * 1.5 ? COL_A : rB > rA * 1.5 ? COL_B : COL_NEUTRAL;
      var w = TERMS.terms[i];
      var c = el("circle", {
        cx: x.toFixed(1), cy: y.toFixed(1), r: 2.6, fill: col,
        opacity: 0.55, "class": "w63-term-dot",
      });
      var t = el("title", {});
      t.textContent = w + " — A: " + cA + " (" + fmtRate(rA) + "/10k) · " +
        "B: " + cB + " (" + fmtRate(rB) + "/10k)";
      c.appendChild(t);
      (function (word, cc) {
        cc.addEventListener("click", function () { openTermPanel(word); });
      })(w, c);
      svg.appendChild(c);
      shown++;
      if (state.label && (cA > 0 || cB > 0)) {
        var lr = Math.abs(Math.log10(Math.max(rA, 1e-3) / Math.max(rB, 1e-3))) +
          Math.log10(Math.max(cA + cB, 1)) / 4;
        labeled.push([lr, w, cA, cB]);
      }
    }
    labeled.sort(function (a, b) { return b[0] - a[0]; });
    labeled.slice(0, 10).forEach(function (L) {
      var w = L[1];
      var cA = L[2], cB = L[3];
      var x = m + scale(logRate(cA, A.tokens)) * (width - 2 * m);
      var y = m + (1 - scale(logRate(cB, B.tokens))) * (height - 2 * m);
      var t = el("text", { x: x.toFixed(1), y: (y - 5).toFixed(1), fill: "var(--text)", "font-size": 10, "text-anchor": "middle" });
      t.textContent = w;
      svg.appendChild(t);
    });

    // captions
    var cap = el("text", { x: m, y: m - 10, fill: COL_A, "font-size": 11 });
    cap.textContent = "↖ distinctive of " + escLabel(state.commA);
    svg.appendChild(cap);
    var capB = el("text", { x: width - m, y: m - 10, fill: COL_B, "font-size": 11, "text-anchor": "end" });
    capB.textContent = escLabel(state.commB) + ", distinctive ↗";
    svg.appendChild(capB);

    var status = document.getElementById("w63-terms-status");
    status.textContent = shown.toLocaleString() + " terms shown (min " + minCount +
      " uses in either community) · A: " + escLabel(state.commA) + " · B: " +
      escLabel(state.commB);
  }

  function rateAxisLabel(logv) {
    var r = Math.pow(10, logv);
    return fmtRate(r) === "0.01" ? "0" : fmtRate(r);
  }

  function byId(list, id) {
    return list.find(function (c) { return c.id === +id; }) || list[0];
  }

  function toCountMap(c) {
    var m = {};
    c.counts.forEach(function (p) { m[p[0]] = p[1]; });
    return m;
  }

  function escLabel(id) {
    return TERMS.labels[TERMS.communities.findIndex(function (c) { return c.id === +id; })] ||
      ("C" + id);
  }

  function openTermPanel(word) {
    var idx = TERMS.terms.indexOf(word);
    var A = byId(TERMS.communities, state.commA);
    var B = byId(TERMS.communities, state.commB);
    var cA = toCountMap(A)[idx] || 0, cB = toCountMap(B)[idx] || 0;
    var rA = rate(cA, A.tokens), rB = rate(cB, B.tokens);
    document.getElementById("w63-term-panel").innerHTML =
      '<h4 class="inspector-name"><code>' + esc(word) + "</code></h4>" +
      '<div class="inspector-stats">' +
      '<div class="inspector-stat"><span class="stat-label">' + escLabel(state.commA) +
      '</span><span class="stat-value">' + cA.toLocaleString() +
      ' <span style="font-size:12px;color:var(--text-dim)">(' + fmtRate(rA) + "/10k)</span></span></div>" +
      '<div class="inspector-stat"><span class="stat-label">' + escLabel(state.commB) +
      '</span><span class="stat-value">' + cB.toLocaleString() +
      ' <span style="font-size:12px;color:var(--text-dim)">(' + fmtRate(rB) + "/10k)</span></span></div>" +
      "</div>" +
      '<p class="network-note">' +
      (cA && cB ? "Used in both communities" + (rA > rB * 1.5 || rB > rA * 1.5 ? "" : " at similar rates") + " — click through to actual pages before deciding the term means anything." :
        "Used in only one of the two — a rarity signal as much as a meaning signal.") +
      "</p>";
  }

  function buildTermControls(root) {
    var selA = root.querySelector("#w63-comm-a");
    var selB = root.querySelector("#w63-comm-b");
    function opts() {
      return TERMS.communities.map(function (c) {
        return '<option value="' + c.id + '">' + esc(TERMS.labels[c.id]) + "</option>";
      }).join("");
    }
    selA.innerHTML = opts();
    selB.innerHTML = opts();
    selA.value = String(state.commA);
    selB.value = String(state.commB);
    [selA, selB].forEach(function (sel) {
      sel.addEventListener("change", function () {
        if (this === selA) state.commA = +this.value; else state.commB = +this.value;
        renderTerms();
      });
    });
    var slider = root.querySelector("#w63-mincount");
    slider.value = state.minCount;
    slider.addEventListener("input", function () {
      state.minCount = +this.value;
      document.getElementById("w63-mincount-val").textContent = this.value;
      renderTerms();
    });
    var chk = root.querySelector("#w63-label");
    chk.checked = state.label;
    chk.addEventListener("change", function () {
      state.label = this.checked;
      renderTerms();
    });
  }

  // ---------- boot -----------------------------------------------------------

  function boot(results) {
    MAP = results[0]; VECS = results[1]; TERMS = results[2];
    decodeVectors(VECS);
    // sanity: default axes exist
    state.x = Math.min(state.x, MAP.axes.length - 1);
    state.y = Math.min(state.y, MAP.axes.length - 1);
    buildMapControls(document.getElementById("w63-map-controls"));
    buildTermControls(document.getElementById("w63-terms-controls"));
    renderMap();
    renderTerms();
    window.addEventListener("resize", debounce(function () {
      renderMap(); renderTerms();
    }, 200));
  }

  function debounce(fn, ms) {
    var t = null;
    return function () {
      clearTimeout(t);
      t = setTimeout(fn, ms);
    };
  }

  Promise.all([
    fetchJson("../data/marvel_pages/week63_map.json"),
    fetchJson("../data/marvel_pages/week63_vecs.json"),
    fetchJson("../data/marvel_pages/week63_terms.json"),
  ]).then(boot);
})();
