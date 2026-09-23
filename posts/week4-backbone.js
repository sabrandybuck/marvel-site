/*
 * Week 4 backbone explorable: "Break the backbone".
 *
 * The learner drags a log-scale alpha slider (disparity-filter significance
 * level) and watches the philosopher network's giant component erode. Two
 * quests: (1) find the alpha where the giant first spans less than half the
 * network; (2) work out whose links are holding it together.
 *
 * Architecture, in the house spirit of week3.js: everything expensive is
 * precomputed offline by analysis/build_week4.py into
 * data/philosophers/week4_summary.json (section3_interactive) -- a frozen
 * spring layout and per-edge death thresholds (an edge is kept at alpha iff
 * its union-rule disparity threshold is below alpha). The only live
 * computation here is cheap: filtering 9,139 edges against one number and a
 * BFS over whichever edges survive, fast enough to run on every slider tick.
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

  var COLOR_ALIVE = "rgba(76, 110, 245, 0.30)";   // accent-2 blue
  var COLOR_NODE = "rgba(70, 74, 84, 0.60)";
  var COLOR_ZOMBIE = "rgba(150, 153, 163, 0.25)";
  var COLOR_HUB = "#F76707";                       // accent-3 amber
  var COLOR_PIN = "#c92a2a";
  var COLOR_FINAL = "#0ca678";                     // last links standing

  var LOG_MIN = -6;                // slider right end -> alpha = 1e-6
  var CRITICAL_ALPHA = 0.16;
  var TOLERANCE = 0.02;
  var PLAY_SECONDS = 9;

  function escapeHtml(s) {
    return String(s).replace(/[&<>"']/g, function (c) {
      return { "&": "&amp;", "<": "&lt;", ">": "&gt;", '"': "&quot;", "'": "&#39;" }[c];
    });
  }
  function fmtInt(nN) { return String(Math.round(nN)).replace(/\B(?=(\d{3})+(?!\d))/g, ","); }
  function normalizeName(s) {
    return String(s).toLowerCase()
      .normalize("NFD").replace(/[\u0300-\u036f]/g, "")
      .replace(/[^a-z]/g, "");
  }

  function setup(I) {
    var names = I.node_names;
    var pos = I.pos;
    var n = names.length;
    var answer = I.answer;

    var edgeU = I.edge_u, edgeV = I.edge_v, edgeD = I.edge_d, edgeW = I.edge_w;
    var m = edgeU.length;

    // normalize frozen layout into a square [0,1]^2 (y up)
    var minX = Infinity, minY = Infinity, maxX = -Infinity, maxY = -Infinity;
    var i;
    for (i = 0; i < n; i++) {
      if (pos[i][0] < minX) minX = pos[i][0];
      if (pos[i][0] > maxX) maxX = pos[i][0];
      if (pos[i][1] < minY) minY = pos[i][1];
      if (pos[i][1] > maxY) maxY = pos[i][1];
    }
    var s = Math.max(maxX - minX, maxY - minY) * 1.08 || 1;
    var cx2 = (minX + maxX) / 2, cy2 = (minY + maxY) / 2;
    var NX = new Float64Array(n), NY = new Float64Array(n);
    for (i = 0; i < n; i++) {
      NX[i] = 0.5 + (pos[i][0] - cx2) / s;
      NY[i] = 0.5 + (pos[i][1] - cy2) / s;
    }

    // ---- dom ---------------------------------------------------------------
    var canvas = document.getElementById("bb-canvas");
    var ctx = canvas.getContext("2d");
    var slider = document.getElementById("bb-alpha-slider");
    var alphaOut = document.getElementById("bb-alpha-value");
    var readout = document.getElementById("bb-readout");
    var hubsList = document.getElementById("bb-hubs");
    var questMsg = document.getElementById("bb-quest1-msg");
    var guessInput = document.getElementById("bb-guess-input");
    var guessMsg = document.getElementById("bb-quest2-msg");
    var reveal = document.getElementById("bb-reveal");
    var playBtn = document.getElementById("bb-play-btn");
    var resetBtn = document.getElementById("bb-reset-btn");
    var lockBtn = document.getElementById("bb-lock-btn");
    var guessBtn = document.getElementById("bb-guess-btn");
    var tip = document.getElementById("bb-tooltip");

    var datalist = document.getElementById("bb-names");
    names.forEach(function (nm) {
      var o = document.createElement("option");
      o.value = nm;
      datalist.appendChild(o);
    });

    var stepBtns = Array.prototype.slice.call(
      document.querySelectorAll("[data-bb-step]"));

    // ---- state -------------------------------------------------------------
    var alpha = 1.0;
    var hover = -1;
    var solved1 = false, solved2 = false;
    var playing = false, playStart = null;

    function sliderToAlpha(x) { return Math.pow(10, LOG_MIN * x); }         // x in [0,1]
    function alphaToSliderX(a) { return -Math.log10(Math.max(a, 1e-12)) / -LOG_MIN; }

    function setAlpha(a) {
      alpha = a;
      slider.value = String(Math.round(alphaToSliderX(a) * 1000));
      refresh();
    }

    // ---- live computation ---------------------------------------------------
    var aliveDeg = new Int32Array(n);
    var adjacency = new Array(n);
    var lastStats = null;

    function recompute() {
      var j;
      for (i = 0; i < n; i++) { adjacency[i] = null; aliveDeg[i] = 0; }
      var edgeCount = 0;
      for (i = 0; i < m; i++) {
        if (edgeD[i] < alpha) {
          edgeCount++;
          var u = edgeU[i], v = edgeV[i];
          aliveDeg[u]++; aliveDeg[v]++;
          if (!adjacency[u]) adjacency[u] = [];
          adjacency[u].push(v);
          if (!adjacency[v]) adjacency[v] = [];
          adjacency[v].push(u);
        }
      }
      var compId = new Int32Array(n);
      var queue = new Int32Array(n);
      var ncomps = 0, giant = 0;
      for (i = 0; i < n; i++) {
        if (compId[i] !== -1) continue;
        var qe = 0, qi = 0;
        queue[qe++] = i; compId[i] = i;
        while (qi < qe) {
          var cur = queue[qi++];
          var nbrs = adjacency[cur];
          if (!nbrs) continue;
          for (j = 0; j < nbrs.length; j++) {
            var w = nbrs[j];
            if (compId[w] === -1) { compId[w] = i; queue[qe++] = w; }
          }
        }
        ncomps++;
        if (qe > giant) giant = qe;
      }
      lastStats = { ncomps: ncomps, giant: giant, edges: edgeCount };
      return lastStats;
    }

    // ---- drawing ------------------------------------------------------------
    var rectW = 0, rectH = 0;

    function resize() {
      var rect = canvas.getBoundingClientRect();
      rectW = rect.width; rectH = rect.height;
      var dpr = window.devicePixelRatio || 1;
      canvas.width = Math.round(rectW * dpr);
      canvas.height = Math.round(rectH * dpr);
      refresh();
    }

    function X(i) { return NX[i] * rectW; }
    function Y(i) { return rectH - NY[i] * rectH; }   // flip y (y up)

    function draw() {
      var dpr = window.devicePixelRatio || 1;
      ctx.setTransform(dpr, 0, 0, dpr, 0, 0);
      ctx.fillStyle = "#ffffff";
      ctx.fillRect(0, 0, rectW, rectH);

      // edges, batched in one path
      ctx.beginPath();
      for (i = 0; i < m; i++) {
        if (edgeD[i] >= alpha) continue;
        ctx.moveTo(X(edgeU[i]), Y(edgeU[i]));
        ctx.lineTo(X(edgeV[i]), Y(edgeV[i]));
      }
      ctx.strokeStyle = COLOR_ALIVE;
      ctx.lineWidth = 1;
      ctx.stroke();

      // the heavyweight final ties in green once we're near the end
      if (alpha <= 0.0006) {
        ctx.beginPath();
        for (i = 0; i < m; i++) {
          if (edgeD[i] >= alpha || edgeW[i] < 11) continue;
          ctx.moveTo(X(edgeU[i]), Y(edgeU[i]));
          ctx.lineTo(X(edgeV[i]), Y(edgeV[i]));
        }
        ctx.strokeStyle = COLOR_FINAL;
        ctx.lineWidth = 2.2;
        ctx.stroke();
      }

      // nodes: alive first, then dim zombies
      ctx.fillStyle = COLOR_NODE;
      for (i = 0; i < n; i++) {
        if (aliveDeg[i] === 0) continue;
        ctx.beginPath();
        ctx.arc(X(i), Y(i), 2.4, 0, 6.283185);
        ctx.fill();
      }
      ctx.fillStyle = COLOR_ZOMBIE;
      for (i = 0; i < n; i++) {
        if (aliveDeg[i] !== 0) continue;
        ctx.beginPath();
        ctx.arc(X(i), Y(i), 2.4, 0, 6.283185);
        ctx.fill();
      }

      // top-5 living hubs
      var hubs = topHubs(5);
      for (i = 0; i < hubs.length; i++) {
        var h = hubs[i];
        ctx.beginPath();
        ctx.fillStyle = COLOR_HUB;
        ctx.arc(X(h), Y(h), 5.2, 0, 6.283185);
        ctx.fill();
        ctx.fillStyle = "#212529";
        ctx.font = "600 11px -apple-system, 'Segoe UI', Roboto, sans-serif";
        ctx.fillText(short(names[h]), X(h) + 7, Y(h) + 4);
      }

      // highlight + label Aristotle once the guess is solved
      if (solved2) {
        var ar = nameIndex("Aristotle");
        if (ar >= 0) {
          ctx.beginPath();
          ctx.fillStyle = COLOR_PIN;
          ctx.arc(X(ar), Y(ar), 7, 0, 6.283185);
          ctx.fill();
          ctx.fillStyle = COLOR_PIN;
          ctx.font = "700 12px -apple-system, 'Segoe UI', Roboto, sans-serif";
          ctx.fillText("Aristotle \u2605", X(ar) + 10, Y(ar) - 8);
        }
      }

      // hover ring
      if (hover >= 0) {
        ctx.beginPath();
        ctx.strokeStyle = "rgba(33, 37, 41, 0.55)";
        ctx.lineWidth = 1.5;
        ctx.arc(X(hover), Y(hover), 8, 0, 6.283185);
        ctx.stroke();
      }
    }

    function drawHubs() {
      var hubs = topHubs(5);
      hubsList.innerHTML = hubs.length
        ? hubs.map(function (ii) {
            return "<li><strong>" + escapeHtml(short(names[ii])) + "</strong> &mdash; " +
              aliveDeg[ii] + " surviving backbone link" + (aliveDeg[ii] === 1 ? "" : "s") + "</li>";
          }).join("")
        : "<li>every substantive link has died &mdash; only leaf keepsakes remain</li>";
    }

    function short(name) {
      return name.length <= 20 ? name : name.slice(0, 20) + "\u2026";
    }

    function nameIndex(name) {
      var want = normalizeName(name);
      for (var i = 0; i < n; i++) {
        if (normalizeName(names[i]) === want) return i;
      }
      return -1;
    }

    // ---- readouts -----------------------------------------------------------
    function refresh() {
      var st = recompute();
      alphaOut.textContent = fmtAlpha(alpha);
      var broken = st.giant < answer.half;
      var pctBroken = broken ? "No &mdash; <strong>broken</strong>" : "Yes";
      readout.innerHTML =
        li("Edges kept", fmtInt(st.edges)) +
        li("Components", fmtInt(st.ncomps)) +
        li("Giant component", fmtInt(st.giant) + " of " + n) +
        li("Spans &ge;&nbsp;&frac12;?", pctBroken, broken ? "is-broken" : "");
      drawHubs();
      draw();
    }

    function li(label, value, cls) {
      return '<li class="stat-card' + (cls ? " " + cls : "") + '">' +
             '<span class="stat-label">' + label + '</span>' +
             '<span class="stat-value">' + value + "</span></li>";
    }

    function fmtAlpha(a) {
      var e = Math.floor(Math.log10(a));
      if (e >= -3) return "\u03b1 = " + a.toFixed(a >= 0.01 ? 3 : 4);
      var mant = a / Math.pow(10, e);
      return "\u03b1 \u2248 " + mant.toFixed(1) + "e" + e;
    }

    // ---- quest 1 ------------------------------------------------------------
    lockBtn.addEventListener("click", function () {
      if (alpha >= 1) {
        questMsg.innerHTML = "The slider starts at \u03b1 = 1 &mdash; every link passes. " +
          "Drag it right to tighten the test, and lock in when the giant first holds fewer than half.";
        questMsg.className = "bb-msg";
        return;
      }
      if (Math.abs(alpha - CRITICAL_ALPHA) <= TOLERANCE) {
        solved1 = true;
        lockBtn.textContent = "\u03b1* found \u2713";
        questMsg.className = "bb-msg is-right";
        questMsg.innerHTML = "<strong>Correct.</strong> The giant last spans half the network at " +
          "\u03b1 = 0.165 (707 philosophers); at \u03b1 = 0.16 it first dips below half (685). " +
          "You found the break within \u00b10.02.";
        maybeReveal(false);
      } else if (alpha > CRITICAL_ALPHA) {
        questMsg.innerHTML = "Not yet &mdash; at " + fmtAlpha(alpha) + " the largest piece still holds " +
          fmtInt(lastStats.giant) + " philosophers, more than half. Tighten a little more.";
        questMsg.className = "bb-msg is-wrong";
      } else {
        questMsg.innerHTML = "Too tight &mdash; at " + fmtAlpha(alpha) + " the giant is already down to " +
          fmtInt(lastStats.giant) + ". Loosen slightly: you want the <em>first</em> moment under half.";
        questMsg.className = "bb-msg is-wrong";
      }
    });

    // ---- quest 2 ------------------------------------------------------------
    guessBtn.addEventListener("click", function () {
      var g = normalizeName(guessInput.value);
      if (!g) {
        guessMsg.textContent = "Type a philosopher's name first.";
        guessMsg.className = "bb-msg is-wrong";
        return;
      }
      if (g === "aristotle") {
        solved2 = true;
        guessMsg.className = "bb-msg is-right";
        guessMsg.innerHTML = "<strong>Correct.</strong> Aristotle carries 58 surviving backbone " +
          "links at \u03b1 = 0.2 (Kant, second, has 35), 11 at \u03b1 = 0.05 (next: Kant 9, Marx 8), " +
          "and even at \u03b1 = 0.005 his are among the very last alive. The two final multi-node " +
          "fragments: the Hegel \u2192 Marx cluster (dies \u2248 0.0035 on Bauer \u2192 Marx, w = 11) " +
          "and his own chain Aristotle \u2192 Heraclitus (w = 13) \u2192 Plutarch \u2192 held by " +
          "Heraclitus \u2192 Plutarch (w = 17) \u2014 the single last link standing anywhere in the " +
          "network, dying at \u03b1 \u2248 0.0001.";
        maybeReveal(false);
      } else {
        var gi = nameIndex(guessInput.value);
        if (gi < 0) {
          guessMsg.innerHTML = "No such philosopher in the giant component \u2014 try one of the datalist suggestions.";
        } else if (aliveDeg[gi] === 0) {
          guessMsg.innerHTML = escapeHtml(names[gi]) + " is fully cut off at this \u03b1 &mdash; " +
            "whoever breaks the giant is still carrying links <em>right at the break</em>. " +
            "Slide to just under \u03b1 = 0.16 and watch the top-5 list.";
        } else {
          guessMsg.innerHTML = escapeHtml(names[gi]) + " is carrying " + aliveDeg[gi] +
            " surviving backbone link" + (aliveDeg[gi] === 1 ? "" : "s") +
            " at this \u03b1. The answer is whoever carries the <em>most, longest</em>.";
        }
        guessMsg.className = "bb-msg is-wrong";
      }
    });

    function maybeReveal(force) {
      if (!reveal) return;
      if ((solved1 && solved2) || force === true) {
        if (!reveal.open) {
          reveal.open = true;
          reveal.scrollIntoView({ behavior: REDUCED_MOTION ? "auto" : "smooth", block: "nearest" });
        }
      }
    }

    // ---- controls -----------------------------------------------------------
    slider.addEventListener("input", function () {
      alpha = sliderToAlpha(parseInt(slider.value, 10) / 1000);
      refresh();
    });

    playBtn.addEventListener("click", function () {
      if (playing) { stopPlay(); return; }
      playing = true;
      playBtn.textContent = "Stop";
      playBtn.setAttribute("aria-pressed", "true");
      if (REDUCED_MOTION) { stopPlay(); setAlpha(1e-6); return; }
      playStart = null;
      requestAnimationFrame(playFrame);
    });

    function playFrame(ts) {
      if (!playing) return;
      if (playStart === null) playStart = ts;
      var t = Math.min((ts - playStart) / (PLAY_SECONDS * 1000), 1);
      setAlpha(Math.pow(10, LOG_MIN * t));
      if (t < 1) { requestAnimationFrame(playFrame); return; }
      stopPlay();
    }

    function stopPlay() {
      playing = false; playStart = null;
      playBtn.textContent = "Play";
      playBtn.setAttribute("aria-pressed", "false");
    }

    resetBtn.addEventListener("click", function () { stopPlay(); setAlpha(1.0); });

    stepBtns.forEach(function (b) {
      b.addEventListener("click", function () {
        stopPlay();
        setAlpha(parseFloat(b.getAttribute("data-bb-step")));
      });
    });

    // hover inspector (brute-force nearest node; 1,374 nodes is nothing)
    canvas.addEventListener("mousemove", function (ev) {
      var r = canvas.getBoundingClientRect();
      var mx = ev.clientX - r.left, my = ev.clientY - r.top;
      var best = -1, bestD = 14;
      for (var j = 0; j < n; j++) {
        var dx = X(j) - mx, dy = Y(j) - my;
        var d2 = dx * dx + dy * dy;
        if (d2 < bestD * bestD) { bestD = Math.sqrt(d2); best = j; }
      }
      if (best !== hover) { hover = best; draw(); }
      if (best >= 0) {
        tip.style.display = "block";
        tip.style.left = Math.min(X(best) + 16, r.width - 190) + "px";
        tip.style.top = Math.max(Y(best) - 14, 4) + "px";
        var d = aliveDeg[best];
        tip.innerHTML = "<strong>" + escapeHtml(names[best]) + "</strong><br>" +
          (d === 0 ? "fully cut off at this \u03b1" : d + " surviving backbone link" + (d === 1 ? "" : "s"));
      } else {
        tip.style.display = "none";
      }
    });
    canvas.addEventListener("mouseleave", function () {
      hover = -1;
      tip.style.display = "none";
      draw();
    });

    window.addEventListener("resize", resize);
    resize();
    setAlpha(1.0);
  }

  fetchJson("../data/philosophers/week4_summary.json")
    .then(function (summary) {
      if (!summary.section3_interactive) {
        throw new Error("no interactive payload (rerun analysis/build_week4.py)");
      }
      setup(summary.section3_interactive);
    })
    .catch(function (err) {
      var host = document.getElementById("bb-error");
      if (host) {
        host.style.display = "block";
        host.textContent = "Explorable failed to load: " + err.message;
      }
      if (window.console) console.error(err);
    });
})();