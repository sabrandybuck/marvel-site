/*
 * Week 5 duel explorable — "the Zipf vs Heaps duel": build your own corpus.
 *
 * A vocabulary-building explorable joining the week's two questions. Pages
 * are added one at a time; each addition draws the page's own Zipf curve
 * (log-log rank x frequency) as well as the accumulated corpus's merged
 * curve, with the idealised Zipf curve (slope exactly -1) as the dashed
 * reference. Layers are checkbox-toggled. Four ways to add a character:
 *   - "Add top-Zipf"   : argmax of the frozen per-page Zipf deviation
 *                        (precomputed by analysis/build_week5.py);
 *   - "Add top-Heaps"  : argmax of the LIVE marginal Heaps gain — the number
 *                        of brand-new distinct words a candidate would add
 *                        right now, computed from its frozen (idx, count)
 *                        varint pairs against the running union flags;
 *   - a text box       : name any character, add it;
 *   - auto-play        : ▶ Play adds one page per ~0.2 s using whichever
 *                        strategy the Zipf/Heaps toggle selects — toggle it
 *                        live mid-run to flip the chooser.
 *
 * Everything heavy is frozen (data/marvel_pages/week5_summary.json duel
 * section: the 26,952-word global vocab and per-page delta-encoded
 * (word index, count) pairs). The only live computation is a linear scan
 * per candidate, so scoring all 303 remaining pages per button press stays
 * in the tens-of-milliseconds range.
 */
(function () {
  "use strict";

  function fetchJson(url) {
    return fetch(url).then(function (r) {
      if (!r.ok) throw new Error("HTTP " + r.status + " fetching " + url);
      return r.json();
    });
  }

  var REDUCED_MOTION = !!(window.matchMedia &&
    window.matchMedia("(prefers-reduced-motion: reduce)").matches);

  var INK = "#e9eaee";
  var DIM = "#9a9daa";
  var GRID = "rgba(233,234,238,0.08)";
  var COLOR_IDEAL = "#0ca678";                     // ideal Zipf slope -1
  var COLOR_ACC = "#4c6ef5";                       // accumulated corpus curve
  var COLOR_DOT = "#F76707";                       // last-added marker
  var RANGE_Y = 8;   // decades below 1.0 the y axis reaches (10^-1 .. 10^-8)

  // matplotlib tab20, same palette family the week-4 figures use
  var TAB20 = [
    "#1f77b4", "#aec7e8", "#ff7f0e", "#ffbb78", "#2ca02c", "#98df8a",
    "#d62728", "#ff9896", "#9467bd", "#c5b0d5", "#8c564b", "#c49c94",
    "#e377c2", "#f7b6d2", "#7f7f7f", "#c7c7c7", "#bcbd22", "#dbdb8d",
    "#17becf", "#9edae5"
  ];

  function escapeHtml(s) {
    return String(s).replace(/[&<>"']/g, function (c) {
      return { "&": "&amp;", "<": "&lt;", ">": "&gt;", '"': "&quot;", "'": "&#39;" }[c];
    });
  }
  function fmtInt(v) { return String(Math.round(v)).replace(/\B(?=(\d{3})+(?!\d))/g, ","); }
  function fmtFl(v, d) { return Number(v).toFixed(d == null ? 2 : d); }

  function setup(S) {
    var pages = S.pages;
    var duel = S.duel;
    var vocab = duel.vocab;
    var NV = duel.n_vocab;

    // ---- decoding -----------------------------------------------------------
    function b64bytes(b64) {
      var s = atob(b64);
      var out = new Uint8Array(s.length);
      for (var i = 0; i < s.length; i++) out[i] = s.charCodeAt(i);
      return out;
    }
    function decodePairs(b64) {
      // varint stream: idx0, c0, delta1, c1, ... — returns parallel arrays
      var data = b64bytes(b64);
      var vals = [];
      var n = 0, shift = 0;
      for (var i = 0; i < data.length; i++) {
        n |= (data[i] & 0x7F) << shift;
        if (data[i] & 0x80) { shift += 7; }
        else { vals.push(n); n = 0; shift = 0; }
      }
      var count = vals.length / 2;
      var ids = new Int32Array(count);
      var cs = new Int32Array(count);
      var prev = 0;
      for (var k = 0; k < vals.length; k += 2) {
        var idx = vals[k] + (k === 0 ? 0 : prev);
        prev = idx;
        ids[k >> 1] = idx;
        cs[k >> 1] = vals[k + 1];
      }
      return { ids: ids, cs: cs };
    }
    function decodeCurves(b64) {
      // per-character Zipf curve: counts sorted descending (multiset), freq shares
      var pc = decodePairs(b64);
      var cs = Array.prototype.slice.call(pc.cs).sort(function (a, b) { return b - a; });
      var total = 0;
      for (var i = 0; i < cs.length; i++) total += cs[i];
      return cs.map(function (c) { return c / total; });
    }

    var pairsCache = {};
    function pairsFor(nid) {
      if (!pairsCache[nid]) pairsCache[nid] = decodePairs(duel.pairs[nid]);
      return pairsCache[nid];
    }
    var curveCache = {};
    function curveFor(nid) {
      if (!curveCache[nid]) curveCache[nid] = decodeCurves(duel.pairs[nid]);
      return curveCache[nid];
    }

    // ---- live corpus state --------------------------------------------------
    var added = [];                     // ids in add order
    var inUnion = new Uint8Array(NV);   // 1 = word seen somewhere already
    var accCount = new Int32Array(NV);  // merged per-word counts
    var accTypes = 0;                   // distinct words seen
    var accTokens = 0;                  // merged tokens

    function marginalFor(nid) {
      var pc = pairsFor(nid);
      var ids = pc.ids;
      var dV = 0;
      for (var i = 0; i < ids.length; i++) {
        if (!inUnion[ids[i]]) dV++;
      }
      return dV;
    }

    function addPage(nid) {
      if (added.indexOf(nid) !== -1) return false;
      var pc = pairsFor(nid);
      var ids = pc.ids, cs = pc.cs;
      for (var i = 0; i < ids.length; i++) {
        var w = ids[i];
        if (!inUnion[w]) { inUnion[w] = 1; accTypes++; }
        accCount[w] += cs[i];
        accTokens += cs[i];
      }
      added.push(nid);
      return true;
    }

    function reset() {
      added = [];
      inUnion = new Uint8Array(NV);
      accCount = new Int32Array(NV);
      accTypes = 0;
      accTokens = 0;
      refreshAll();
    }

    // ---- dom ----------------------------------------------------------------
    var svgHost = document.getElementById("dl-stage");
    var leftHost = document.getElementById("dl-summary");
    var stripHost = document.getElementById("dl-strip");
    var topZipfBtn = document.getElementById("dl-top-zipf");
    var topHeapsBtn = document.getElementById("dl-top-heaps");
    var searchIn = document.getElementById("dl-search");
    var goBtn = document.getElementById("dl-go");
    var msgHost = document.getElementById("dl-msg");
    var addBtns = document.getElementById("dl-add-buttons");
    var cbChar = document.getElementById("dl-layer-char");
    var cbAcc = document.getElementById("dl-layer-acc");
    var cbIdeal = document.getElementById("dl-layer-ideal");
    var usedHost = document.getElementById("dl-used");
    var resetBtn = document.getElementById("dl-reset");
    var errHost = document.getElementById("dl-error");
    if (!svgHost) return;

    // ---- chart scaffolding ----------------------------------------------------
    var W = 900, H = 520;
    var M = { t: 16, r: 24, b: 46, l: 64 };
    var iw = W - M.l - M.r, ih = H - M.t - M.b;

    // x: log10(rank), 0..4 (rank 1 .. 10000); y: log10(freq share), 0..-RANGE_Y
    var X0 = 0, X1 = 4, YMAX = 0, YMIN = -(16 / 20) * RANGE_Y; // log10 of .99.. tiny
    // y ticks at 10^-1 .. 10^-RANGE_Y
    var Y_TICKS = []; for (var yt = 1; yt <= RANGE_Y; yt++) Y_TICKS.push(-yt);

    function XL(rank) { return M.l + ((Math.log10(rank) - X0) / (X1 - X0)) * iw; }
    function YL(f) { return M.t + (0 - (Math.log10(f) - YMAX)) / (YMAX - YMIN) * ih; }

    var svgNS = "http://www.w3.org/2000/svg";
    var svg = document.createElementNS(svgNS, "svg");
    svg.setAttribute("viewBox", "0 0 " + W + " " + H);
    svg.setAttribute("width", "100%");
    svg.setAttribute("style", "display:block;");
    svgHost.appendChild(svg);

    function el(name, attrs) {
      var e = document.createElementNS(svgNS, name);
      for (var k in attrs) e.setAttribute(k, attrs[k]);
      return e;
    }

    // axis frames
    var gGrid = el("g", {});
    svg.appendChild(gGrid);
    [1, 10, 100, 1000, 10000].forEach(function (r) {
      if (Math.log10(r) > X1) return;
      gGrid.appendChild(el("line", { x1: XL(r), y1: M.t, x2: XL(r), y2: M.t + ih, stroke: GRID, "stroke-width": 1 }));
      var lbl = el("text", { x: XL(r), y: M.t + ih + 18, "text-anchor": "middle", fill: DIM, "font-size": 11, "font-family": "var(--mono)" });
      lbl.textContent = String(r);
      gGrid.appendChild(lbl);
    });
    [1].concat(Y_TICKS).forEach(function (e) {
      var f = Math.pow(10, e);
      gGrid.appendChild(el("line", { x1: M.l, y1: YL(f), x2: W - M.r, y2: YL(f), stroke: GRID, "stroke-width": 1 }));
      var lbl = el("text", { x: M.l - 8, y: YL(f) + 4, "text-anchor": "end", fill: DIM, "font-size": 11, "font-family": "var(--mono)" });
      lbl.textContent = e === 0 ? "1" : "1e" + e;
      gGrid.appendChild(lbl);
    });
    var xCap = el("text", { x: M.l + iw / 2, y: H - 6, "text-anchor": "middle", fill: DIM, "font-size": 11, "font-family": "var(--mono)" });
    xCap.textContent = "word rank r (log)";
    svg.appendChild(xCap);
    var yCap = el("text", { x: 14, y: M.t + ih / 2, fill: DIM, "font-size": 11, "font-family": "var(--mono)", transform: "rotate(-90 14 " + (M.t + ih / 2) + ")", "text-anchor": "middle" });
    yCap.textContent = "frequency share f(r) (log)";
    svg.appendChild(yCap);

    // layers
    var accPath = el("path", { fill: "none", stroke: COLOR_ACC, "stroke-width": 2.5, "stroke-opacity": 0.9 });
    svg.appendChild(accPath);
    var charGroup = el("g", {});
    svg.appendChild(charGroup);
    var idealPath = el("path", { fill: "none", stroke: COLOR_IDEAL, "stroke-width": 2, "stroke-dasharray": "6 5", "stroke-opacity": 0.9 });
    svg.appendChild(idealPath);

    function applyLayerVis() {
      charGroup.style.display = cbChar.checked ? "" : "none";
      accPath.setAttribute("display", cbAcc.checked ? "" : "none");
      idealPath.setAttribute("display", cbIdeal.checked ? "" : "none");
    }
    [cbChar, cbAcc, cbIdeal].forEach(function (cb) {
      cb.addEventListener("change", applyLayerVis);
    });

    function drawCharCurve(nid, color, width) {
      var f = curveFor(nid);
      var d = [];
      for (var i = 0; i < f.length; i++) {
        d.push((i === 0 ? "M" : "L") + XL(i + 1).toFixed(1) + " " + YL(f[i]).toFixed(2));
      }
      var p = el("path", { d: d.join(" "), fill: "none", stroke: color, "stroke-width": width == null ? 1.5 : width,
        "stroke-opacity": 0.85, "stroke-linejoin": "round" });
      var t = el("title", {});
      t.textContent = (pages[nid] ? pages[nid].name : nid) + " — " + fmtInt(f.length) + " distinct words";
      p.appendChild(t);
      charGroup.appendChild(p);
      return p;
    }

    function drawIdeal() {
      // slope exactly -1 anchored on the accumulated corpus's top frequency:
      // f(r) = f(1)/r ; an empty d renders nothing until anything added.
      var d = "";
      if (accTokens) {
        var maxC = 0;
        for (var w = 0; w < NV; w++) if (accCount[w] > maxC) maxC = accCount[w];
        var f1 = maxC / accTokens;
        d = "M" + XL(1).toFixed(1) + " " + YL(f1).toFixed(2);
        for (var r = 1; r <= 10000; r *= 2) {
          d += " L" + XL(r).toFixed(1) + " " + YL(f1 / r).toFixed(2);
        }
      }
      idealPath.setAttribute("d", d);
    }

    function drawAcc() {
      if (!accTokens) { accPath.setAttribute("d", ""); return; }
      var counts = [];
      for (var w = 0; w < NV; w++) if (accCount[w] > 0) counts.push(accCount[w]);
      counts.sort(function (a, b) { return b - a; });
      var d = [];
      for (var i = 0; i < counts.length; i++) {
        d.push((i === 0 ? "M" : "L") + XL(i + 1).toFixed(1) + " " + YL(counts[i] / accTokens).toFixed(2));
      }
      accPath.setAttribute("d", d.join(" "));
    }

    // ---- summary panel (left) ----------------------------------------------
    function renderSummary() {
      if (!added.length) {
        leftHost.innerHTML = "<p class='dl-empty'>Nothing added yet.</p>";
        return;
      }
      var nid = added[added.length - 1];
      var p = pages[nid];
      var gain = marginalAtAdd[nid] != null ? marginalAtAdd[nid] : 0;
      var chipHtml = p.top_tfidf.map(function (w) {
        return "<span class=\"wz-chip\">" + escapeHtml(w) + "</span>";
      }).join("");
      leftHost.innerHTML =
        "<div class=\"dl-head\"><strong>#" + fmtInt(added.length) + " · " + escapeHtml(p.name) + "</strong></div>" +
        "<ul class=\"stats-grid dl-stats\">" +
        statCard("In-degree", fmtInt(p.in_degree)) +
        statCard("Tokens on page", fmtInt(p.tokens)) +
        statCard("Heaps gain ΔV", "<span style='color:" + COLOR_DOT + "'>+" + fmtInt(gain) + "</span>") +
        statCard("Zipf slope s (ideal −1)", fmtFl(p.zipf_s, 2) + " (R² " + fmtFl(p.zipf_r2, 2) + ")") +
        statCard("Vocabulary so far", fmtInt(accTypes) + " words") +
        statCard("Tokens so far", fmtInt(accTokens)) +
        "</ul>" +
        "<div class=\"wz-chips-label\">Most distinctive words:</div>" +
        "<div class=\"wz-chips\">" + chipHtml + "</div>";
    }

    function statCard(label, val) {
      return "<li class=\"stat-card\"><span class=\"stat-label\">" + label +
        "</span><span class=\"stat-value\">" + val + "</span></li>";
    }

    // marginal recorded at the moment the page was added, for the summary
    var marginalAtAdd = {};

    function refreshAll() {
      drawAcc();
      drawIdeal();
      applyLayerVis();
      renderSummary();
      if (!added.length) {
        stripHost.textContent = "0 pages · 0 tokens · 0 words";
        usedHost.textContent = "";
      } else {
        stripHost.textContent = fmtInt(added.length) + " of 303 pages · " +
          fmtInt(accTokens) + " tokens · " + fmtInt(accTypes) + " distinct words";
        usedHost.textContent = "already used: " + added.slice(-12).map(function (nid) {
          return pages[nid].name;
        }).join(", ") + (added.length > 12 ? ", …" : "");
      }
      msgHost.style.display = "none";

      // buttons: disabled state + next-best scores readout
      var remaining = Object.keys(pages).filter(function (nid) { return added.indexOf(nid) === -1; });
      refreshDatalist(remaining);
      if (!remaining.length) {
        bestZipfId = null;
        bestHeapsId = null;
        topZipfBtn.disabled = true;
        topHeapsBtn.disabled = true;
        addBtns.classList.add("is-done");
        topZipfBtn.textContent = "Corpus complete";
        topHeapsBtn.textContent = "Corpus complete";
        msgHost.textContent = "All 303 pages added — the explorer is full. Reset to play again.";
        msgHost.style.display = "block";
        return;
      }
      topZipfBtn.disabled = false;
      topHeapsBtn.disabled = false;
      addBtns.classList.remove("is-done");

      var bz = -Infinity, bzId = null;
      remaining.forEach(function (nid) {
        if (pages[nid].z_zipf > bz) { bz = pages[nid].z_zipf; bzId = nid; }
      });
      topZipfBtn.textContent = "+ Add top-Zipf  (next: " + fmtFl(bz, 2) + ")";

      // live marginal scan
      var bh = -1, bhId = null;
      remaining.forEach(function (nid) {
        var dv = marginalFor(nid);
        if (dv > bh) { bh = dv; bhId = nid; }
      });
      topHeapsBtn.textContent = "+ Add top-Heaps  (next ΔV: " + fmtInt(bh) + ")";
      bestZipfId = bzId;
      bestHeapsId = bhId;
    }

    var bestZipfId = null, bestHeapsId = null;

    // ---- auto-play ------------------------------------------------------------
    var PLAY_SECONDS = 60;                 // a full 303-page run costs ~60 s
    var PER_ADD = PLAY_SECONDS * 1000 / 303;
    var playing = false;
    var strategy = "zipf";
    var nextDue = 0;

    function addOneByPlay() {
      var id = strategy === "zipf" ? bestZipfId : bestHeapsId;
      if (!id) { stopPlay(); return; }
      onChooseAdd(id);
    }

    function playTick(ts) {
      if (!playing) return;
      while (playing && ts >= nextDue) {
        nextDue += PER_ADD;
        var before = added.length;
        addOneByPlay();
        if (!playing || added.length === before) return; // full corpus or stop
      }
      requestAnimationFrame(playTick);
    }

    function stopPlay() {
      playing = false;
      playBtn.textContent = "▶ Play";
      playBtn.setAttribute("aria-pressed", "false");
    }

    function strategyId() { return strategy === "zipf" ? bestZipfId : bestHeapsId; }

    function startPlay() {
      if (added.length >= 303 || !strategyId()) return;
      playing = true;
      playBtn.textContent = "❚❚ Pause";
      playBtn.setAttribute("aria-pressed", "true");
      msgHost.style.display = "none";
      if (REDUCED_MOTION) {
        // jump: add everything the current strategy would pick, in order
        while (added.length < 303 && strategyId()) addOneByPlay();
        stopPlay();
        return;
      }
      nextDue = performance.now();
      requestAnimationFrame(playTick);
    }

    var playBtn = document.getElementById("dl-play");
    playBtn.addEventListener("click", function () {
      if (playing) stopPlay();
      else startPlay();
    });

    var stratBtns = Array.prototype.slice.call(
      document.querySelectorAll("[data-dl-strategy]"));
    strategy = "zipf";
    stratBtns.forEach(function (b) {
      b.addEventListener("click", function () {
        strategy = b.getAttribute("data-dl-strategy");
        stratBtns.forEach(function (x) {
          x.setAttribute("aria-pressed", x === b ? "true" : "false");
        });
      });
    });

    function onChooseAdd(nid) {
      if (added.indexOf(nid) !== -1) {
        msgHost.textContent = pages[nid].name + " is already in the corpus.";
        msgHost.style.display = "block";
        return;
      }
      marginalAtAdd[nid] = marginalFor(nid);
      addPage(nid);
      drawCharCurve(nid, TAB20[(added.length - 1) % 20]);
      refreshAll();
    }

    topZipfBtn.addEventListener("click", function () {
      if (bestZipfId) onChooseAdd(bestZipfId);
    });
    topHeapsBtn.addEventListener("click", function () {
      if (bestHeapsId) onChooseAdd(bestHeapsId);
    });
    resetBtn.addEventListener("click", function () {
      stopPlay();
      reset();
      charGroup.innerHTML = "";
    });

    // name → id (full map; the datalist itself tracks only remaining names)
    var nameToId = {};
    Object.keys(pages).forEach(function (nid) {
      nameToId[pages[nid].name.toLowerCase()] = nid;
    });
    var datalist = document.getElementById("dl-names");
    function refreshDatalist(remaining) {
      while (datalist.firstChild) datalist.removeChild(datalist.firstChild);
      remaining.forEach(function (nid) {
        var o = document.createElement("option");
        o.value = pages[nid].name;
        datalist.appendChild(o);
      });
    }
    function doSearch() {
      var q = searchIn.value.trim().toLowerCase();
      if (nameToId[q]) {
        onChooseAdd(nameToId[q]);
        searchIn.value = "";
      } else {
        msgHost.textContent = "No character by that name — check the spelling.";
        msgHost.style.display = "block";
      }
    }
    goBtn.addEventListener("click", doSearch);
    searchIn.addEventListener("keydown", function (ev) {
      if (ev.key === "Enter") doSearch();
    });

    refreshAll();
  }

  fetchJson("../data/marvel_pages/week5_summary.json")
    .then(function (summary) {
      if (!summary.duel) {
        throw new Error("no duel payload (rerun analysis/build_week5.py)");
      }
      setup(summary);
    })
    .catch(function (err) {
      var host = document.getElementById("dl-error");
      if (host) {
        host.style.display = "block";
        host.textContent = "Explorable failed to load: " + err.message;
      }
      if (window.console) console.error(err);
    });
})();
