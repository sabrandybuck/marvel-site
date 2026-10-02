/*
 * Week 5 heaps explorable — "Heaps' law of the Marvel universe".
 *
 * We add the 303 character pages one at a time and watch the vocabulary V
 * grow against the token budget N. The order is the experiment: most-linked
 * character first (week1 in-degree), reversed, alphabetical, or one of three
 * random shuffles — all frozen into data/marvel_pages/week5_summary.json by
 * analysis/build_week5.py, including a 10/50/90-percent band over 24
 * shuffles. The browser only looks numbers up and animates them.
 *
 * Must be manually in sync with the JSON (see build_week5.py): heaps.{mode}
 * arrays order/t/v/new/seen, heaps.random.{runs,band}, heaps.famous_vs_minor.
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
  var DIM = "#9a9ea9";
  var GRID = "rgba(233,234,238,0.08)";
  var COLOR_BAND = "rgba(76, 110, 245, 0.16)";   // accent-2 blue wash
  var COLOR_GHOST = "rgba(150, 153, 163, 0.45)";
  var COLOR_MAIN = "#e6353a";                    // site accent red
  var COLOR_DOT = "#F76707";                     // accent-3 amber
  var COLOR_FINAL = "#0ca678";
  var COLOR_FAMOUS = "#4c6ef5";
  var COLOR_MINOR = "#e6353a";

  var PLAY_SECONDS = 10;

  function escapeHtml(s) {
    return String(s).replace(/[&<>"']/g, function (c) {
      return { "&": "&amp;", "<": "&lt;", ">": "&gt;", '"': "&quot;", "'": "&#39;" }[c];
    });
  }
  function fmtInt(nN) { return String(Math.round(nN)).replace(/\B(?=(\d{3})+(?!\d))/g, ","); }

  function setup(S) {
    var pages = S.pages;
    var heaps = S.heaps;

    var modes = {
      indegree: heaps.indegree,
      reverse: heaps.reverse,
      alpha: heaps.alpha,
      random: null // resolved at playback: one of heaps.random.runs
    };
    var randomRuns = heaps.random.runs || [];
    var randomIdx = 0;
    var band = heaps.random.band;
    var fvm = heaps.famous_vs_minor;

    var svgHost = document.getElementById("hp-stage");
    var tip = document.getElementById("hp-tooltip");
    var modeBox = document.getElementById("hp-modes");
    var runBtn = document.getElementById("hp-random-next");
    var playBtn = document.getElementById("hp-play-btn");
    var scrub = document.getElementById("hp-scrub");
    var readout = document.getElementById("hp-readout");
    var lastOut = document.getElementById("hp-last");
    var barsHost = document.getElementById("hp-bars");
    var errHost = document.getElementById("hp-error");

    if (!svgHost) return;

    var nSteps = heaps.indegree.t.length;
    var finalV = heaps.indegree.v[nSteps - 1];
    var finalT = heaps.indegree.t[nSteps - 1];
    scrub.max = String(nSteps - 1);
    scrub.value = "0";

    // ---- svg scaffolding ----------------------------------------------------
    var W = 900, H = 460;
    var M = { t: 18, r: 22, b: 44, l: 70 };
    var iw = W - M.l - M.r, ih = H - M.t - M.b;
    var svg = document.createElementNS("http://www.w3.org/2000/svg", "svg");
    svg.setAttribute("viewBox", "0 0 " + W + " " + H);
    svg.setAttribute("width", "100%");
    svg.setAttribute("style", "display:block;background:transparent;");
    svgHost.appendChild(svg);

    var MAXX = finalT * 1.02, MAXY = finalV * 1.05;
    function X(tK) { return M.l + (tK / MAXX) * iw; }
    function Y(vK) { return M.t + ih - (vK / MAXY) * ih; }

    function el(name, attrs) {
      var e = document.createElementNS("http://www.w3.org/2000/svg", name);
      for (var k in attrs) e.setAttribute(k, attrs[k]);
      return e;
    }

    // grid + axes
    var gGrid = el("g", {});
    svg.appendChild(gGrid);
    [0.25, 0.5, 0.75, 1].forEach(function (f) {
      gGrid.appendChild(el("line", { x1: M.l, y1: Y(MAXY * f), x2: W - M.r, y2: Y(MAXY * f), stroke: GRID, "stroke-width": 1 }));
      var lbl = el("text", { x: M.l - 8, y: Y(MAXY * f) + 4, "text-anchor": "end", fill: DIM, "font-size": 11, "font-family": "var(--mono, monospace)" });
      lbl.textContent = fmtInt(MAXY * f);
      gGrid.appendChild(lbl);
    });
    [0, 100000, 250000, 500000, 700000].forEach(function (tK) {
      if (tK > MAXX) return;
      gGrid.appendChild(el("line", { x1: X(tK), y1: M.t, x2: X(tK), y2: M.t + ih, stroke: GRID, "stroke-width": 1 }));
      var lbl = el("text", { x: X(tK), y: M.t + ih + 18, "text-anchor": "middle", fill: DIM, "font-size": 11, "font-family": "var(--mono, monospace)" });
      lbl.textContent = tK === 0 ? "0" : (tK / 1000) + "k";
      gGrid.appendChild(lbl);
    });
    var xCap = el("text", { x: M.l + iw / 2, y: H - 6, "text-anchor": "middle", fill: DIM, "font-size": 11, "font-family": "var(--mono, monospace)" });
    xCap.textContent = "tokens read so far (N)";
    svg.appendChild(xCap);
    var yCap = el("text", { x: 14, y: M.t + ih / 2, fill: DIM, "font-size": 11, "font-family": "var(--mono, monospace)", transform: "rotate(-90 14 " + (M.t + ih / 2) + ")", "text-anchor": "middle" });
    yCap.textContent = "distinct words (V)";
    svg.appendChild(yCap);

    // random band polygon
    var bandPoly = el("polygon", { fill: COLOR_BAND, stroke: "none" });
    svg.appendChild(bandPoly);

    // final vocab line
    svg.appendChild(el("line", { x1: M.l, y1: Y(finalV), x2: W - M.r, y2: Y(finalV), stroke: COLOR_FINAL, "stroke-width": 1, "stroke-dasharray": "5 5", opacity: 0.7 }));
    var finLbl = el("text", { x: W - M.r - 4, y: Y(finalV) - 6, "text-anchor": "end", fill: COLOR_FINAL, "font-size": 11, "font-family": "var(--mono, monospace)" });
    finLbl.textContent = "final V = " + fmtInt(finalV);
    svg.appendChild(finLbl);

    // ghost curve (another mode's full run, for comparison)
    var ghostPath = el("path", { fill: "none", stroke: COLOR_GHOST, "stroke-width": 1.5, "stroke-dasharray": "3 4" });
    svg.appendChild(ghostPath);

    // live curve
    var mainPath = el("path", { fill: "none", stroke: COLOR_MAIN, "stroke-width": 2.5, "stroke-linejoin": "round" });
    svg.appendChild(mainPath);
    // leading dot + label
    var dot = el("circle", { r: 4.5, fill: COLOR_DOT, stroke: "#16181f", "stroke-width": 1.5 });
    svg.appendChild(dot);
    var dotLbl = el("text", { fill: INK, "font-size": 12, "font-family": "var(--mono, monospace)", style: "paint-order:stroke;stroke:rgba(12,14,20,0.9);stroke-width:4px;" });
    svg.appendChild(dotLbl);

    function modeRun() {
      if (currentMode === "random") {
        return randomRuns[Math.min(randomIdx, randomRuns.length - 1)] || heaps.indegree;
      }
      return modes[currentMode];
    }

    function currentGhost() {
      return currentMode === "indegree" ? heaps.random.runs[0] || heaps.alpha : heaps.indegree;
    }

    // ---- state ----------------------------------------------------------------
    var currentMode = "indegree";
    var step = 0;          // pages added (0..nSteps)
    var playing = false, playStart = null, playFrom = 0;

    function updateBandPoly() {
      var showBand = currentMode === "random";
      bandPoly.setAttribute("display", showBand ? "" : "none");
      if (!showBand) return;
      var pts = [];
      var run = modeRun();
      var T = band.t || run.t;
      var i;
      for (i = 0; i < T.length; i++) pts.push(X(T[i]) + "," + Y(band.q90[i]));
      for (i = T.length - 1; i >= 0; i--) pts.push(X(T[i]) + "," + Y(band.q10[i]));
      bandPoly.setAttribute("points", pts.join(" "));
    }

    function drawCurve() {
      var run = modeRun();
      var k = Math.max(1, step);
      var dParts = [];
      var i;
      for (i = 0; i < k; i++) {
        dParts.push((i === 0 ? "M" : "L") + X(run.t[i]).toFixed(1) + " " + Y(run.v[i]).toFixed(1));
      }
      var showCurve = step > 0;
      mainPath.setAttribute("display", showCurve ? "" : "none");
      mainPath.setAttribute("d", dParts.join(" "));

      var gr = currentGhost();
      var gd = [];
      for (i = 0; i < gr.v.length; i++) {
        gd.push((i === 0 ? "M" : "L") + X(gr.t[i]).toFixed(1) + " " + Y(gr.v[i]).toFixed(1));
      }
      ghostPath.setAttribute("d", gd.join(" "));

      if (showCurve) {
        dot.setAttribute("display", "");
        dot.setAttribute("cx", X(run.t[k - 1]).toFixed(1));
        dot.setAttribute("cy", Y(run.v[k - 1]).toFixed(1));
        dotLbl.setAttribute("x", (X(run.t[k - 1]) + 10).toFixed(1));
        dotLbl.setAttribute("y", (Y(run.v[k - 1]) - 8).toFixed(1));
        dotLbl.textContent = "N=" + fmtInt(run.t[k - 1]) + "  V=" + fmtInt(run.v[k - 1]);
      } else {
        dot.setAttribute("display", "none");
        dotLbl.textContent = "";
      }
    }

    function refresh() {
      var run = modeRun();
      var k = Math.max(0, step);
      drawCurve();
      updateBandPoly();
      scrub.value = String(k);
      if (k === 0) {
        readout.textContent = "No pages added yet — press play.";
        lastOut.innerHTML = "";
      } else {
        var nid = run.order[k - 1];
        var pg = pages[nid] || {};
        readout.textContent =
          fmtInt(k) + " pages · " + fmtInt(run.t[k - 1]) + " tokens · " +
          fmtInt(run.v[k - 1]) + " distinct words";
        lastOut.innerHTML =
          "Last added: <strong>" + escapeHtml(pg.name || nid) + "</strong> " +
          "(linked from " + (pg.in_degree || 0) + " pages) — " +
          fmtInt(pg.tokens || 0) + " tokens arrived, " +
          "<span style=\"color:" + COLOR_DOT + "\">" + fmtInt(run.new[k - 1]) + " brand-new</span>, " +
          "the other " + (Math.round((run.seen[k - 1] || 0) * 100)) + "% were words we had already seen.";
      }
    }

    function setStep(k) {
      step = Math.max(0, Math.min(nSteps, k));
      playing = false;
      playBtn.textContent = "▶ Play";
      refresh();
    }

    function tick(ts) {
      if (!playing) return;
      if (!playStart) playStart = ts;
      var frac = (ts - playStart) / (PLAY_SECONDS * 1000);
      var k = Math.round(playFrom + frac * (nSteps - playFrom));
      if (REDUCED_MOTION) k = nSteps;
      step = Math.min(nSteps, k);
      scrub.value = String(step);
      refresh();
      if (step >= nSteps || REDUCED_MOTION) { playing = false; playBtn.textContent = "▶ Play"; return; }
      requestAnimationFrame(tick);
    }

    // ---- controls ---------------------------------------------------------------
    var modeBtns = Array.prototype.slice.call(modeBox.querySelectorAll("[data-hp-mode]"));
    function setMode(m) {
      currentMode = m;
      modeBtns.forEach(function (b) {
        b.setAttribute("aria-pressed", b.getAttribute("data-hp-mode") === m ? "true" : "false");
      });
      runBtn.style.display = m === "random" ? "" : "none";
      refresh();
    }
    modeBtns.forEach(function (b) {
      b.addEventListener("click", function () { setMode(b.getAttribute("data-hp-mode")); });
    });
    runBtn.addEventListener("click", function () {
      randomIdx = (randomIdx + 1) % Math.max(1, randomRuns.length);
      runBtn.textContent = "Random run " + (randomIdx + 1) + "/" + randomRuns.length + " — reshuffle";
      refresh();
    });
    playBtn.addEventListener("click", function () {
      playing = !playing;
      if (playing) {
        if (step >= nSteps) setStep(0);
        playFrom = Math.max(1, step);
        playStart = null;
        playBtn.textContent = "❚❚ Pause";
        if (REDUCED_MOTION) { tick(performance.now()); } else { requestAnimationFrame(tick); }
      } else {
        playBtn.textContent = "▶ Play";
      }
    });
    scrub.addEventListener("input", function () {
      playing = false;
      playBtn.textContent = "▶ Play";
      step = parseInt(scrub.value, 10);
      refresh();
    });

    // pointer hover → snap to nearest step on the active curve
    svg.addEventListener("mousemove", function (ev) {
      var rect = svg.getBoundingClientRect();
      var sx = (ev.clientX - rect.left) * (W / rect.width);
      var run = modeRun();
      if (!run || step < 1) return;
      var best = 0, bestD = Infinity, i;
      var lim = Math.max(1, step);
      for (i = 0; i < lim; i++) {
        var d = Math.abs(X(run.t[i]) - sx);
        if (d < bestD) { bestD = d; best = i; }
      }
      var k2 = best + 1;
      if (k2 !== step) {
        step = k2;
        scrub.value = String(step);
        refresh();
        var nid = run.order[best];
        var pg = pages[nid] || {};
        tip.style.display = "block";
        tip.innerHTML = "<strong>" + escapeHtml(pg.name || nid) + "</strong><br>" +
          "+" + fmtInt(pg.tokens || 0) + " tokens · +" + fmtInt(run.new[best]) + " new words" +
          "<br>in-degree " + (pg.in_degree || 0) + " · page #" + k2 + " added";
      }
    });
    svg.addEventListener("mouseleave", function () {
      tip.style.display = "none";
    });

    // ---- famous vs minor bars panel ------------------------------------------------
    if (barsHost && fvm && fvm.famous && fvm.minor) {
      var F = fvm.famous, Mi = fvm.minor;
      var rows = [
        { label: "pages", fam: F.n, min: Mi.n },
        { label: "tokens", fam: F.tokens, min: Mi.tokens, div: 1000, suffix: "K" },
        { label: "brand-new words while the corpus is built in linked-first order", fam: F.new, min: Mi.new },
        { label: "new words per 1,000 tokens", fam: F.rate_per_1k, min: Mi.rate_per_1k, round: 1 },
        { label: "words found only in this bucket (private vocabulary)", fam: (fvm.exclusive ? fvm.exclusive.famous_count : 0), min: (fvm.exclusive ? fvm.exclusive.minor_count : 0) }
      ];
      function disp(v, r) {
        if (r.div) return fmtInt(v / r.div) + r.suffix;
        if (r.round != null) return v.toFixed(r.round);
        return fmtInt(v);
      }
      var html = "";
      html += "<div class=\"hp-bar-title\">Famous vs minor: the split is in-degree &ge; " +
        fvm.famous_in_degree_at_least + " → " + F.n + " famous pages, " + Mi.n + " minor pages.</div>";
      rows.forEach(function (r) {
        var max = Math.max(r.fam, r.min) || 1;
        function w(v) { return (v / max * 100).toFixed(1); }
        html += "<div class=\"hp-bar-row\">" +
          "<span class=\"hp-bar-name\">" + escapeHtml(r.label) + "</span>" +
          "<span class=\"hp-bar-famous\" style=\"width:" + w(r.fam) + "%\"></span>" +
          "<span class=\"hp-bar-val\">" + disp(r.fam, r) + "</span>" +
          "</div>";
        html += "<div class=\"hp-bar-row\">" +
          "<span class=\"hp-bar-name\"></span>" +
          "<span class=\"hp-bar-minor\" style=\"width:" + w(r.min) + "%\"></span>" +
          "<span class=\"hp-bar-val\">" + disp(r.min, r) + "</span>" +
          "</div>";
      });
      barsHost.innerHTML = html;
      var legend = document.getElementById("hp-bars-legend");
      if (legend) {
        legend.innerHTML =
          "<span><span class=\"hp-swatch\" style=\"background:" + COLOR_FAMOUS + "\"></span> famous (in-degree &ge; " + fvm.famous_in_degree_at_least + ")</span>" +
          "<span><span class=\"hp-swatch\" style=\"background:" + COLOR_MINOR + "\"></span> minor</span>";
      }
    }

    setMode("indegree");
    refresh();
  }

  fetchJson("../data/marvel_pages/week5_summary.json")
    .then(function (summary) {
      if (!summary.heaps) {
        throw new Error("no heaps payload (rerun analysis/build_week5.py)");
      }
      setup(summary);
    })
    .catch(function (err) {
      var host = document.getElementById("hp-error");
      if (host) {
        host.style.display = "block";
        host.textContent = "Explorable failed to load: " + err.message;
      }
      if (window.console) console.error(err);
    });
})();
