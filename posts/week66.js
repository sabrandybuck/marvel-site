/*
 * Week 6-6 explorable — "the analogy slot machine".
 *
 * King − man + woman = queen, but with Marvel pages in the seat of the
 * answer. The recipe is the week-6 map's own: every character is the
 * TF-IDF-weighted average of their fingerprint words in the shipped
 * Word2Vec space (week63_vecs.json + week63_map.json). The player picks a
 * starting character, trades one vocabulary word away for another, and the
 * direction `char − vec(neg) + vec(pos)` is cosine-scored against all 303
 * fingerprint averages. Nothing is precomputed — the arithmetic runs live.
 *
 * Verified presets (from the frozen payload, computed at build time):
 *   Spider-Man − man + woman → Spider-Girl (#2, Wild Child #1)
 *   Luke Cage − street + magic → Doctor Druid (#1, majesty family)
 *   Venom − aliens + technology → Eddie Brock (#1, the echo-machine trap)
 * Self and near-duplicate pages are dropped from the podium, because
 * "Wolverine → Ultimate Wolverine" is not a winning move.
 *
 * Winner drawer: the words that moved, then actual sentences from the
 * winner's page containing either traded word. The verdict stays human.
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

  var MAP = null;     // fingerprints
  var VECS = null;    // quantized word vectors
  var SENTS = null;   // lazy
  var SENTS_DUE = false;
  var MEAN = null;    // mean fingerprint vector (map origin)

  var V = {};         // word -> Float32Array
  var FP = {};        // nid -> Float32Array
  var WORDS = [];     // shipped vocabulary
  var dims = 0;

  var state = {
    nid: null,
    minus: "man",
    plus: "woman",
    expect: null,       // the hero the player expected (optional)
    podium: null,       // last spin's filtered ranking
    winner: null,
    base: null,         // the spin's start vector (map before)
    dir: null,          // the spin's after-trade vector (map after)
  };

  function fetchJson(url) {
    return fetch(url).then(function (r) {
      if (!r.ok) throw new Error("HTTP " + r.status + " fetching " + url);
      return r.json();
    });
  }

  function decode(d) {
    var bytes = atob(d.vectors_b64);
    dims = d.meta.dims;
    var scale = d.meta.scale / 127;
    WORDS = d.words;
    WORDS.forEach(function (w, i) {
      var v = new Float32Array(dims);
      for (var j = 0; j < dims; j++) {
        var b = bytes.charCodeAt(i * dims + j);
        v[j] = (b < 128 ? b : b - 256) * scale;
      }
      V[w] = v;
    });
  }

  function fpAvg(nid) {
    if (FP[nid]) return FP[nid];
    var a = new Float32Array(dims), den = 0;
    MAP.pages[nid].fpw.forEach(function (p) {
      var v = V[p[0]];
      if (!v) return;
      for (var j = 0; j < dims; j++) a[j] += p[1] * v[j];
      den += p[1];
    });
    for (var j = 0; j < dims; j++) a[j] /= (den || 1);
    FP[nid] = a;
    return a;
  }

  function zero() { return new Float32Array(dims); }
  function cos(a, b) {
    var d = 0, na = 0, nb = 0;
    for (var j = 0; j < dims; j++) { d += a[j] * b[j]; na += a[j] * a[j]; nb += b[j] * b[j]; }
    return d / Math.sqrt((na * nb) || 1);
  }

  // ---------- game core -------------------------------------------------------

  function spin() {
    var vm = V[state.minus], vp = V[state.plus];
    var msg = document.getElementById("w66-error");
    msg.textContent = "";
    if (!vm || !vp) {
      var miss = [];
      if (!vm) miss.push(state.minus);
      if (!vp) miss.push(state.plus);
      msg.textContent = "Not in the machine's Marvel vocabulary (it only knows " +
        WORDS.length.toLocaleString() + " words): " + miss.filter(Boolean).join(", ");
      document.getElementById("w66-results").innerHTML = "";
      return;
    }
    var base = fpAvg(state.nid);
    var dir = new Float32Array(dims);
    for (var j = 0; j < dims; j++) dir[j] = base[j] - vm[j] + vp[j];
    state.base = base;
    state.dir = dir;

    var results = Object.keys(MAP.pages)
      .filter(function (nid) { return nid !== state.nid; })
      .filter(function (nid) { return MAP.pages[nid].name.indexOf("Ultimate") < 0; })
      .map(function (nid) {
        return { nid: nid, name: MAP.pages[nid].name,
                 c: cos(dir, fpAvg(nid)), community: MAP.pages[nid].community };
      })
      .sort(function (a, b) { return b.c - a.c; });
    // the unfiltered list backs the "expected hero" verdict (self included)
    state.scoredAll = Object.keys(MAP.pages)
      .map(function (nid) {
        return { nid: nid, name: MAP.pages[nid].name, c: cos(dir, fpAvg(nid)) };
      })
      .sort(function (a, b) { return b.c - a.c; });
    state.podium = results;
    state.winner = results[0];

    // which fingerprint words moved the needle, toward each traded pole
    var deltaDir = new Float32Array(dims);
    for (j = 0; j < dims; j++) deltaDir[j] = vp[j] - vm[j];
    var moves = MAP.pages[state.nid].fpw.map(function (p) {
      var v = V[p[0]];
      if (!v) return null;
      return { w: p[0], d: p[1] * cos(v, deltaDir) };
    }).filter(Boolean).sort(function (a, b) { return b.d - a.d; });

    renderResults(results, moves);
  }

  function renderResults(results, moves) {
    var root = document.getElementById("w66-results");
    var winner = results[0];
    root.innerHTML =
      '<ul class="w6-nb-list w66-podium">' + results.slice(0, 5).map(function (r, i) {
        return '<li class="w6-nb-row' + (i === 0 ? " w66-win" : "") + '" data-nid="' + esc(r.nid) + '">' +
          '<span class="w6-rank">' + (i + 1) + "</span>" +
          '<span class="w6-cdot" style="background:' + commColor(r.community) + '"></span>' +
          '<span class="w6-nname" >' + esc(r.name) + "</span>" +
          '<span class="w6-cos">' + r.c.toFixed(2) + "</span>" +
          '<span class="w6-link">' + (i === 0 ? "the machine says…" : "") + "</span></li>";
      }).join("") + "</ul>" +
      '<p class="cos-note">Starting fingerprint words pulled toward <strong>−</strong>' +
      esc(state.minus) + ': ' +
      (moves.filter(function (m) { return m.d < 0; }).slice(-3).reverse().map(function (m) {
        return "<code>" + esc(m.w) + "</code>";
      }).join(", ") || "—") +
      " · toward <strong>+</strong>" + esc(state.plus) + ': ' +
      (moves.filter(function (m) { return m.d > 0; }).slice(0, 3).map(function (m) {
        return "<code>" + esc(m.w) + "</code>";
      }).join(", ") || "—") + "</p>" +
      '<div id="w66-verdict"></div>' +
      '<div id="w66-evidence"></div>';

    root.querySelectorAll("[data-nid]").forEach(function (row) {
      row.addEventListener("click", function () {
        setFrom(row.getAttribute("data-nid"));
      });
    });

    computeVerdict();
    showEvidence(winner);
    drawMap(results);
  }

  // the "expected hero" verdict: rank, cosine, and who got in the way
  function computeVerdict() {
    var box = document.getElementById("w66-verdict");
    if (!box) return;
    if (!state.expect || !state.scoredAll) { box.innerHTML = ""; return; }
    if (state.expect === state.nid) {
      box.innerHTML = '<div class="w66-verdict"><strong>' +
        esc(MAP.pages[state.expect].name) + "</strong> is the page you started from — " +
        "you can't subtract your way out of your own fingerprint. Pick someone else " +
        "to see how far the traded words carry them.</div>";
      return;
    }
    var pool = state.scoredAll.filter(function (r) { return r.nid !== state.nid; });
    var idx = pool.findIndex(function (r) { return r.nid === state.expect; });
    if (idx < 0) { box.innerHTML = ""; return; }
    var mine = pool[idx];
    var blockers = pool.slice(0, idx).slice(0, 3);
    var selfWas = state.scoredAll[0].nid === state.nid ? 1 : 0;
    var dupeNote;
    if (MAP.pages[state.expect].name.indexOf("Ultimate") >= 0) {
      dupeNote = " (a near-duplicate page of an already-listed hero — its text is essentially the same article)";
    }
    box.innerHTML = '<div class="w66-verdict"><strong>You expected ' +
      esc(MAP.pages[state.expect].name) + '</strong>: <strong>#' + (idx + 1) +
      " of " + pool.length + "</strong> (cosine " + mine.c.toFixed(2) +
      (dupeNote || "") + ")" +
      (blockers.length
        ? ". In the way: " + blockers.map(function (b) {
            return esc(b.name) + " <span style='font-family:var(--mono);font-size:11px'>" +
              b.c.toFixed(2) + "</span>";
          }).join(", ") + "…"
        : " — the machine agrees.") +
      "</div>";
  }

  function showEvidence(winner) {
    var box = document.getElementById("w66-evidence");
    box.innerHTML =
      '<div class="w6-drawer"><h4>Why ' + esc(winner.name) + "?</h4>" +
      '<p class="cos-note">Actual sentences from the winner&rsquo;s page that mention ' +
      "<code>" + esc(state.minus) + "</code> or <code>" + esc(state.plus) +
      "</code> — the reading before you believe the machine:</p>" +
      '<div class="w6-sents" id="w66-sents">' +
      (SENTS ? "" : '<p class="cos-note">loading sentences…</p>') + "</div></div>";
    if (SENTS) { fillEvidence(winner); return; }
    if (SENTS_DUE) return;
    SENTS_DUE = true;
    fetchJson("../data/marvel_pages/week6_sents.json").then(function (d) {
      SENTS = d;
      if (state.winner) fillEvidence(state.winner);
    });
  }

  function fillEvidence(winner) {
    var box = document.getElementById("w66-sents");
    if (!box) return;
    var words = [state.minus, state.plus];
    var pool = (SENTS.pages[winner.nid] || []);
    var out = [];
    for (var i = 0; i < pool.length && out.length < 3; i++) {
      var s = pool[i], found = null;
      out2: for (var k = 0; k < words.length; k++) {
        var rx = new RegExp("\\b" + words[k].replace(/[.*+?^${}()|[\]\\]/g, "\\$&") + "\\b", "i");
        if (rx.test(s)) { found = words[k]; break out2; }
      }
      if (found) {
        var mark = new RegExp("\\b(" + found.replace(/[.*+?^${}()|[\]\\]/g, "\\$&") + ")\\b", "i");
        out.push(s.replace(mark, function (m) { return "<mark>" + esc(m) + "</mark>"; }));
      }
    }
    box.innerHTML = out.length
      ? out.map(function (s) { return '<p class="w6-sent">' + s + "</p>"; }).join("")
      : '<p class="cos-note">The winner&rsquo;s page never mentions the traded words — the match is pure fingerprint geometry. Suspicious? Good.</p>';
  }

  // ---------- the spin map ------------------------------------------------------
  // x-axis is exactly this spin's trade: the direction from the data's center
  // to "char − minus + plus", so everyone the answer "points at" lines up on
  // the right in (roughly) rank order. y is the widest spread of the residual
  // (one power iteration on its covariance) — the tribes, for context.

  function vsub(a, b) {
    var r = new Float32Array(dims);
    for (var j = 0; j < dims; j++) r[j] = a[j] - b[j];
    return r;
  }

  function vdot(a, b) {
    var d = 0;
    for (var j = 0; j < dims; j++) d += a[j] * b[j];
    return d;
  }

  function buildMean() {
    var nids = Object.keys(MAP.pages);
    nids.forEach(function (nid) { fpAvg(nid); });
    var m = new Float32Array(dims);
    nids.forEach(function (nid) {
      var v = FP[nid];
      for (var j = 0; j < dims; j++) m[j] += v[j];
    });
    for (var j = 0; j < dims; j++) m[j] /= nids.length;
    MEAN = m;
  }

  function drawMap(results) {
    var root = document.getElementById("w66-map");
    if (!root || !MEAN || !state.base || !state.dir || !results || !results.length) return;
    var c = MEAN, cu, cw;

    var u = vsub(state.dir, c);
    var un = Math.sqrt(vdot(u, u)) || 1;
    for (var j = 0; j < dims; j++) u[j] /= un;
    cu = vdot(c, u);

    // dominant direction of the residual covariance (orthogonal to the trade)
    var nids = Object.keys(MAP.pages);
    var res = [], i, k, r;
    for (i = 0; i < nids.length; i++) {
      r = vsub(FP[nids[i]], c);
      var du = vdot(r, u);
      for (var j = 0; j < dims; j++) r[j] -= du * u[j];
      res.push(r);
    }
    var w = new Float32Array(dims); w[0] = 1;
    for (var it = 0; it < 40; it++) {
      var nw = new Float32Array(dims);
      for (i = 0; i < res.length; i++) {
        var p = res[i], d = vdot(p, w);
        for (k = 0; k < dims; k++) nw[k] += d * p[k];
      }
      var nwn = Math.sqrt(vdot(nw, nw)) || 1;
      for (k = 0; k < dims; k++) nw[k] /= nwn;
      w = nw;
    }
    // deterministic orientation: the largest component points positive
    var bigj = 0;
    for (k = 1; k < dims; k++) if (Math.abs(w[k]) > Math.abs(w[bigj])) bigj = k;
    if (w[bigj] < 0) for (k = 0; k < dims; k++) w[k] = -w[k];
    cw = vdot(c, w);

    var P = {}, minx = 1e9, maxx = -1e9, miny = 1e9, maxy = -1e9;
    for (i = 0; i < nids.length; i++) {
      var v = FP[nids[i]];
      var vx = vdot(v, u) - cu, vy = vdot(v, w) - cw;
      P[nids[i]] = { x: vx, y: vy };
      if (vx < minx) minx = vx; if (vx > maxx) maxx = vx;
      if (vy < miny) miny = vy; if (vy > maxy) maxy = vy;
    }
    var bx = vdot(state.base, u) - cu, by = vdot(state.base, w) - cw;
    var ax = vdot(state.dir, u) - cu, ay = vdot(state.dir, w) - cw;

    // a trade that flies far off the hull is clamped just past the edge
    var hx = maxx - minx, hy = maxy - miny;
    if (ax > maxx + 0.5 * hx) ax = maxx + 0.5 * hx;
    if (ax < minx - 0.5 * hx) ax = minx - 0.5 * hx;
    if (ay > maxy + 0.5 * hy) ay = maxy + 0.5 * hy;
    if (ay < miny - 0.5 * hy) ay = miny - 0.5 * hy;

    var d0x = Math.min(minx, ax, bx) - 0.07 * hx, d1x = Math.max(maxx, ax, bx) + 0.07 * hx;
    var d0y = Math.min(miny, ay, by) - 0.07 * hy, d1y = Math.max(maxy, ay, by) + 0.07 * hy;

    var W = 760, H = 430, m = 16, tmb = 8;
    function sxx(x) { return m + (x - d0x) / ((d1x - d0x) || 1) * (W - 2 * m); }
    function syy(y) { return H - m - (y - d0y) / ((d1y - d0y) || 1) * (H - tmb - m); }

    var topHat = {};
    results.slice(0, 5).forEach(function (rw, i) { topHat[rw.nid] = i + 1; });

    var dots = nids.map(function (nid) {
      var p = P[nid], rank = topHat[nid];
      return '<circle data-nid="' + esc(nid) + '" cx="' + sxx(p.x).toFixed(1) +
        '" cy="' + syy(p.y).toFixed(1) + '" r="' + (rank ? 4.5 : 3) +
        '" fill="' + commColor(MAP.pages[nid].community) + '" opacity="' + (rank ? 1 : 0.45) +
        '"><title>' + esc(MAP.pages[nid].name) + "</title></circle>";
    }).join("");

    var rings = results.slice(0, 5).map(function (rw, i) {
      var p = P[rw.nid];
      return '<circle cx="' + sxx(p.x).toFixed(1) + '" cy="' + syy(p.y).toFixed(1) +
        '" r="7.5" fill="none" stroke="#fff" stroke-width="1.3" opacity="0.85"/>' +
        '<text x="' + sxx(p.x).toFixed(1) + '" y="' + (syy(p.y) - 10).toFixed(1) +
        '" font-size="11" font-family="monospace" font-weight="bold" fill="#fff" text-anchor="middle">' + (i + 1) + "</text>";
    }).join("");

    var startDot = '<circle cx="' + sxx(bx).toFixed(1) + '" cy="' + syy(by).toFixed(1) +
      '" r="6" fill="none" stroke="#fff" stroke-width="2"/>' +
      '<text x="' + sxx(bx).toFixed(1) + '" y="' + (syy(by) - 11).toFixed(1) +
      '" font-size="10.5" fill="#fff" text-anchor="middle">started here</text>';

    var afterPart = '<line x1="' + sxx(bx).toFixed(1) + '" y1="' + syy(by).toFixed(1) +
      '" x2="' + sxx(ax).toFixed(1) + '" y2="' + syy(ay).toFixed(1) +
      '" stroke="#e6353a" stroke-width="2.4" marker-end="url(#w66-arrh)" opacity="0.9"/>' +
      '<circle cx="' + sxx(ax).toFixed(1) + '" cy="' + syy(ay).toFixed(1) +
      '" r="5.5" fill="#e6353a" stroke="#fff" stroke-width="1.2"/>';

    var expectPart = "";
    if (state.expect && P[state.expect]) {
      var e = P[state.expect];
      expectPart =
        '<line x1="' + sxx(ax).toFixed(1) + '" y1="' + syy(ay).toFixed(1) +
        '" x2="' + sxx(e.x).toFixed(1) + '" y2="' + syy(e.y).toFixed(1) +
        '" stroke="#e6353a" stroke-width="1.2" stroke-dasharray="3 4" opacity="0.55"/>' +
        '<circle cx="' + sxx(e.x).toFixed(1) + '" cy="' + syy(e.y).toFixed(1) +
        '" r="10" fill="none" stroke="#e6353a" stroke-width="1.6" stroke-dasharray="3 3">' +
        "<title>expected: " + esc(MAP.pages[state.expect].name) + "</title></circle>";
    }

    root.innerHTML =
      '<svg viewBox="0 0 760 430" role="img" aria-label="Map of the spin: every character projected so the traded direction is the x-axis">' +
      '<defs><marker id="w66-arrh" viewBox="0 0 10 10" refX="8" refY="5" markerWidth="7" markerHeight="7" orient="auto-start-reverse">' +
      '<path d="M0 0L10 5L0 10z" fill="#e6353a"/></marker></defs>' +
      dots + expectPart + afterPart + rings + startDot + "</svg>" +
      '<div class="w66-legend">' +
      '<span><i class="lg-dot"></i>all 303 characters</span>' +
      '<span><b>1–5</b> the podium</span>' +
      '<span><i class="lg-start"></i>started here</span>' +
      '<span><i class="lg-after"></i>after the trade</span>' +
      '<span><i class="lg-expect"></i>hero you expected</span>' +
      "</div>" +
      '<p class="cos-note w66-cap">x is exactly this spin&rsquo;s trade direction — the closer a dot sits to the arrowhead, the more the machine&rsquo;s answer points at it; y is the widest leftover spread (the tribes). Dots reshuffle every spin. Positions are projections: the podium above is ranked in the full 100-D space.</p>';

    root.querySelectorAll("[data-nid]").forEach(function (el) {
      el.addEventListener("click", function () {
        setFrom(el.getAttribute("data-nid"));
      });
    });
  }

  // ---------- controls ----------------------------------------------------------

  function setFrom(nid) {
    state.nid = nid;
    document.getElementById("w66-from").value = nid;
    document.getElementById("w66-from-name").value = "";
    spin();
  }

  function randomFrom() {
    var ids = Object.keys(MAP.pages);
    return ids[Math.floor(Math.random() * ids.length)];
  }

  function randomNonsensical() {
    var ids = Object.keys(MAP.pages);
    state.nid = ids[Math.floor(Math.random() * ids.length)];
    state.minus = WORDS[Math.floor(Math.random() * WORDS.length)];
    state.plus = WORDS[Math.floor(Math.random() * WORDS.length)];
    // a random round only makes sense if both words exist, which they do
    document.getElementById("w66-from").value = state.nid;
    document.getElementById("w66-minus").value = state.minus;
    document.getElementById("w66-plus").value = state.plus;
    spin();
  }

  function bindControls(root) {
    // starting character: select + free text
    var sel = root.querySelector("#w66-from");
    sel.innerHTML = Object.keys(MAP.pages).sort(function (a, b) {
      return MAP.pages[a].name.localeCompare(MAP.pages[b].name);
    }).map(function (nid) {
      return '<option value="' + esc(nid) + '">' + esc(MAP.pages[nid].name) + "</option>";
    }).join("");
    sel.value = state.nid;
    sel.addEventListener("change", function () { setFrom(this.value); });

    var input = root.querySelector("#w66-from-name");
    var dl = root.querySelector("#w66-from-datalist");
    dl.innerHTML = Object.keys(MAP.pages).map(function (nid) {
      return '<option value="' + esc(MAP.pages[nid].name) + '">';
    }).join("");
    input.addEventListener("change", function () {
      var q = this.value.trim().toLowerCase();
      this.value = "";
      var hit = Object.keys(MAP.pages).find(function (nid) {
        return MAP.pages[nid].name.toLowerCase() === q;
      });
      if (hit) setFrom(hit);
    });

    // traded words
    ["minus", "plus"].forEach(function (slot) {
      var w = root.querySelector("#w66-" + slot);
      var wdl = root.querySelector("#w66-" + slot + "-datalist");
      wdl.innerHTML = WORDS.map(function (x) {
        return '<option value="' + esc(x) + '">';
      }).join("");
      w.value = state[slot];
      w.addEventListener("change", function () {
        state[slot] = this.value.trim().toLowerCase();
        spin();
      });
    });

    // the expected target: rank + blockers on every spin, no new arithmetic
    var ex = root.querySelector("#w66-expect");
    ex.innerHTML = '<option value="">— the hero you expected (optional) —</option>' +
      Object.keys(MAP.pages).sort(function (a, b) {
        return MAP.pages[a].name.localeCompare(MAP.pages[b].name);
      }).map(function (nid) {
        return '<option value="' + esc(nid) + '">' + esc(MAP.pages[nid].name) + "</option>";
      }).join("");
    ex.value = state.expect || "";
    ex.addEventListener("change", function () {
      state.expect = this.value || null;
      computeVerdict();
      drawMap(state.podium);
    });

    root.querySelector("#w66-lever").addEventListener("click", spin);

    // verified preset equations
    var presets = [
      { from: "Spider-Man", minus: "man", plus: "woman", label: "spider−man+woman" },
      { from: "Luke Cage", minus: "street", plus: "magic", label: "street to magic" },
      { from: "Venom (character)", minus: "aliens", plus: "technology", label: "the echo trap" },
    ];
    var chipRow = root.querySelector("#w66-presets");
    chipRow.innerHTML =
      '<button class="w6-chip" id="w66-random">🎲 random round</button>' +
      presets.map(function (p, i) {
        return '<button class="w6-chip" data-i="' + i + '">' + esc(p.label) + "</button>";
      }).join("");
    chipRow.querySelectorAll("[data-i]").forEach(function (b) {
      b.addEventListener("click", function () {
        var p = presets[+b.getAttribute("data-i")];
        setFrom(Object.keys(MAP.pages).find(function (nid) {
          return MAP.pages[nid].name === p.from;
        }));
        state.minus = p.minus;
        state.plus = p.plus;
        document.getElementById("w66-minus").value = p.minus;
        document.getElementById("w66-plus").value = p.plus;
        spin();
      });
    });
    root.querySelector("#w66-random").addEventListener("click", randomNonsensical);
  }

  // ---------- boot -----------------------------------------------------------------

  Promise.all([
    fetchJson("../data/marvel_pages/week63_map.json"),
    fetchJson("../data/marvel_pages/week63_vecs.json"),
  ]).then(function (r) {
    MAP = r[0]; VECS = r[1];
    decode(VECS);
    buildMean();
    state.nid = Object.keys(MAP.pages).find(function (nid) {
      return MAP.pages[nid].name === "Spider-Man";
    });
    bindControls(document.getElementById("w66-controls"));
    spin();
  });
})();
