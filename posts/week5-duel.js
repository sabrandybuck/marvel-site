/*
 * Week 5 duel explorable — "the Zipf vs Heaps duel": build your own corpus.
 *
 * A vocabulary-building explorable joining the week's two questions. Pages
 * are added one at a time; each addition draws the page's own Zipf curve
 * (log-log rank x frequency) as well as the accumulated corpus's merged
 * curve, with the idealised Zipf curve (slope exactly -1) as the dashed
 * reference. Layers are checkbox-toggled. Four ways to add a character:
 *   - the dropdown        : (Zipf deviation / corpus one-offs / Heaps gain /
 *                           random) drives BOTH "+ One step" and ▶ Play;
 *                           Zipf and corpus-one-offs are argmax of the frozen
 *                           per-page z-scores (precomputed by
 *                           analysis/build_week5.py), Heaps is argmax of the
 *                           LIVE marginal ΔV, random is uniform among the
 *                           remaining characters;
 *   - "+ One step"        : adds one page using the dropdown's strategy;
 *   - a text box          : name any character, add it;
 *   - ▶ Play              : adds one page per ~0.1 s using the dropdown's
 *                           strategy — switch it live mid-run (a full
 *                           303-page run costs ~30 s).
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
      addedColors = [];
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
    var stepBtn = document.getElementById("dl-step");
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

    // axis frames (grid content re-drawn on mode switch, frames static)
    var gGrid = el("g", {});
    svg.appendChild(gGrid);
    var xCap = el("text", { x: M.l + iw / 2, y: H - 6, "text-anchor": "middle", fill: DIM, "font-size": 11, "font-family": "var(--mono)" });
    svg.appendChild(xCap);
    var yCap = el("text", { x: 14, y: M.t + ih / 2, fill: DIM, "font-size": 11, "font-family": "var(--mono)", transform: "rotate(-90 14 " + (M.t + ih / 2) + ")", "text-anchor": "middle" });
    svg.appendChild(yCap);

    // ---- axis modes -----------------------------------------------------------
    // log = log–log decades (the canonical Zipf view); linear = linear both
    // axes, where Zipf's curvature and the hub pages' dominance become
    // dramatic. The grid, captions and every layer re-draw on a mode switch.
    var axisMode = "log";
    var L_X0 = 0, L_X1 = 4;      // log mode: log10 ranks 1..10000
    var LINEAR_Y_MIN = 0.12;     // linear mode y floor before nice-scaling
    var linYMax = 0.15;          // linear y top (nice-rounded, recomputed)
    var linRankMax = 1000;       // linear x top (recomputed)
    var Y_TICKS = []; for (var yt = 1; yt <= RANGE_Y; yt++) Y_TICKS.push(-yt);

    function log10(x) { return Math.log(x) / Math.LN10; }
    function XL(rank) {
      if (axisMode === "log") return M.l + ((log10(Math.max(1, rank)) - L_X0) / (L_X1 - L_X0)) * iw;
      return M.l + (Math.min(rank, linRankMax) / linRankMax) * iw;
    }
    function YL(f) {
      if (axisMode === "log") return M.t + (0 - (log10(Math.max(f, 1e-9)) - 0)) / (0 - (-(16 / 20) * RANGE_Y)) * ih;
      return M.t + ih - (Math.min(f, linYMax) / linYMax) * ih;
    }

    // nice step: round up to 1/2/5 x 10^k
    function niceStep(raw) {
      var p = Math.pow(10, Math.floor(log10(raw)));
      for (var m = 1; m <= 2; m += 0.5) { // 1, 1.5? no: candidates 1,2,2.5..
        if (p * m >= raw) return p * m;
      }
      return p * 5;
    }
    // round a value up to a multiple of step, step-aligned ceiling
    function ceilTo(v, step) { return Math.max(step, Math.ceil(v / step) * step); }

    function redrawAxes() {
      while (gGrid.firstChild) gGrid.removeChild(gGrid.firstChild);
      var i, e, lbl;
      if (axisMode === "log") {
        [1, 10, 100, 1000, 10000].forEach(function (r) {
          if (log10(r) > L_X1) return;
          gGrid.appendChild(el("line", { x1: XL(r), y1: M.t, x2: XL(r), y2: M.t + ih, stroke: GRID, "stroke-width": 1 }));
          lbl = el("text", { x: XL(r), y: M.t + ih + 18, "text-anchor": "middle", fill: DIM, "font-size": 11, "font-family": "var(--mono)" });
          lbl.textContent = String(r);
          gGrid.appendChild(lbl);
        });
        [0].concat(Y_TICKS).forEach(function (exp) {
          var f = Math.pow(10, exp);
          gGrid.appendChild(el("line", { x1: M.l, y1: YL(f), x2: W - M.r, y2: YL(f), stroke: GRID, "stroke-width": 1 }));
          lbl = el("text", { x: M.l - 8, y: YL(f) + 4, "text-anchor": "end", fill: DIM, "font-size": 11, "font-family": "var(--mono)" });
          lbl.textContent = exp === 0 ? "1" : "1e" + exp;
          gGrid.appendChild(lbl);
        });
        xCap.textContent = "word rank r (log)";
        yCap.textContent = "frequency share f(r) (log)";
      } else {
        linRankMax = 1000;
        var needRank = 0;
        added.forEach(function (nid) {
          needRank = Math.max(needRank, curveFor(nid).length);
        });
        linRankMax = ceilTo(Math.max(needRank * 1.05, 1000), niceStep(Math.max(needRank * 1.05, 1000) / 4));
        linYMax = 0.15;
        var needF = 0;
        added.forEach(function (nid) {
          var c = curveFor(nid);
          if (c.length) needF = Math.max(needF, c[0]);
        });
        if (accTokens) {
          for (i = 0; i < NV; i++) if (accCount[i] > 0) { needF = Math.max(needF, accCount[i] / accTokens); break; }
        }
        linYMax = ceilTo(Math.max(needF * 1.08, LINEAR_Y_MIN), niceStep(Math.max(needF * 1.08, LINEAR_Y_MIN) / 4));
        // x ticks: 4 divisions
        for (i = 0; i <= 4; i++) {
          var r = i * (linRankMax / 4);
          gGrid.appendChild(el("line", { x1: XL(r), y1: M.t, x2: XL(r), y2: M.t + ih, stroke: GRID, "stroke-width": 1 }));
          lbl = el("text", { x: XL(r), y: M.t + ih + 18, "text-anchor": "middle", fill: DIM, "font-size": 11, "font-family": "var(--mono)" });
          lbl.textContent = fmtInt(r);
          gGrid.appendChild(lbl);
        }
        // y ticks: 4 divisions
        for (i = 0; i <= 4; i++) {
          var f = i * (linYMax / 4);
          gGrid.appendChild(el("line", { x1: M.l, y1: YL(f), x2: W - M.r, y2: YL(f), stroke: GRID, "stroke-width": 1 }));
          lbl = el("text", { x: M.l - 8, y: YL(f) + 4, "text-anchor": "end", fill: DIM, "font-size": 11, "font-family": "var(--mono)" });
          lbl.textContent = f.toFixed(2);
          gGrid.appendChild(lbl);
        }
        xCap.textContent = "word rank r";
        yCap.textContent = "frequency share f(r)";
      }
    }

    function setAxisMode(m) {
      if (axisMode === m) return;
      axisMode = m;
      redrawAxes();
      redrawAllLayers();
    }

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

    // per-add curve colours, parallel to `added` — kept so an axis-mode flip
    // can re-draw every layer identically
    var addedColors = [];

    function redrawAllLayers() {
      while (charGroup.firstChild) charGroup.removeChild(charGroup.firstChild);
      addedColors.forEach(function (color, i) {
        drawCharCurve(added[i], color);
      });
      drawAcc();
      drawIdeal();
      applyLayerVis();
    }

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
        bestOneoffId = null;
        bestRandomId = null;
        stepBtn.disabled = true;
        addBtns.classList.add("is-done");
        stepBtn.textContent = "Corpus complete";
        msgHost.textContent = "All 303 pages added — the explorer is full. Reset to play again.";
        msgHost.style.display = "block";
        return;
      }
      stepBtn.disabled = false;
      addBtns.classList.remove("is-done");

      var bz = -Infinity, bzId = null;
      remaining.forEach(function (nid) {
        if (pages[nid].z_zipf > bz) { bz = pages[nid].z_zipf; bzId = nid; }
      });
      var bo = -Infinity, boId = null;
      remaining.forEach(function (nid) {
        if (pages[nid].z_oneoff > bo) { bo = pages[nid].z_oneoff; boId = nid; }
      });

      // live marginal scan
      var bh = -1, bhId = null;
      remaining.forEach(function (nid) {
        var dv = marginalFor(nid);
        if (dv > bh) { bh = dv; bhId = nid; }
      });
      bestZipfId = bzId;
      bestOneoffId = boId;
      bestHeapsId = bhId;
      bestRandomId = remaining[Math.floor(Math.random() * remaining.length)];

      // one button does one pick: whatever the dropdown points at
      stepBtn.textContent = "+ One step · " + fmtInt(remaining.length) + " left";
    }

    var bestZipfId = null, bestOneoffId = null;
    var bestHeapsId = null, bestRandomId = null;

    // ---- auto-play ------------------------------------------------------------
    var PLAY_SECONDS = 30;                 // a full 303-page run costs ~30 s
    var PER_ADD = PLAY_SECONDS * 1000 / 303;
    var playing = false;
    var strategy = "zipf";
    var nextDue = 0;

    function strategyPick() {
      return strategy === "zipf" ? bestZipfId
        : strategy === "oneoff" ? bestOneoffId
        : strategy === "random" ? bestRandomId
        : bestHeapsId;
    }

    function addOneByPlay() {
      var id = strategyPick();
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

    function startPlay() {
      if (added.length >= 303 || !strategyPick()) return;
      playing = true;
      playBtn.textContent = "❚❚ Pause";
      playBtn.setAttribute("aria-pressed", "true");
      msgHost.style.display = "none";
      if (REDUCED_MOTION) {
        // jump: add everything the current strategy would pick, in order
        while (added.length < 303 && strategyPick()) addOneByPlay();
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

    // the metric select drives BOTH the "+ One step" button and auto-play
    var metricSel = document.getElementById("dl-metric");
    strategy = metricSel.value || "zipf";
    metricSel.addEventListener("change", function () {
      strategy = metricSel.value;
      refreshAll(); // relabel step (remaining count is all it shows)
    });

    // axis-mode toggle: log–log (default) vs linear
    var axisBtns = Array.prototype.slice.call(
      document.querySelectorAll("[data-dl-axis]"));
    axisBtns.forEach(function (b) {
      b.addEventListener("click", function () {
        setAxisMode(b.getAttribute("data-dl-axis"));
        axisBtns.forEach(function (x) {
          x.setAttribute("aria-pressed", x === b ? "true" : "false");
          if (x === b) x.classList.add("is-active");
          else x.classList.remove("is-active");
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
      addedColors.push(TAB20[(added.length - 1) % 20]);
      drawCharCurve(nid, addedColors[addedColors.length - 1]);
      refreshAll();
    }

    stepBtn.addEventListener("click", function () {
      var id = strategyPick();
      if (id) onChooseAdd(id);
    });
    resetBtn.addEventListener("click", function () {
      stopPlay();
      reset();
      redrawAllLayers();
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

    redrawAxes();
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
