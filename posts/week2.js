/*
 * Week 2 interactive explorables: ER random baseline, degree-preserving
 * directed shuffle, directed preferential attachment (Price/BA-style),
 * and the friendship paradox. Reads only the frozen Week 1 data files
 * (nodes/edges) plus data/week2/week2_summary.json (offline reference
 * numbers computed by analysis/build_week2.py). Everything drawn on this
 * page is computed live, in the browser -- no chart library, hand-rolled
 * SVG, matching Week 1's zero-extra-dependency approach.
 */
(function () {
  "use strict";

  var SVG_NS = "http://www.w3.org/2000/svg";

  function el(tag, attrs) {
    var e = document.createElementNS(SVG_NS, tag);
    if (attrs) {
      Object.keys(attrs).forEach(function (k) { e.setAttribute(k, attrs[k]); });
    }
    return e;
  }

  function parseDataLines(text) {
    return text.split(/\r?\n/).filter(function (line) {
      return line.length > 0 && line.charAt(0) !== "#";
    });
  }

  // ---- shared RNG (mulberry32) so "regenerate" behavior is reproducible
  // within a session if ever needed, and so we're not relying on Math.random
  // inside hot loops in a way that's hard to reason about ----
  function makeRng(seed) {
    var a = seed >>> 0;
    return function () {
      a |= 0; a = (a + 0x6D2B79F5) | 0;
      var t = Math.imul(a ^ (a >>> 15), 1 | a);
      t = (t + Math.imul(t ^ (t >>> 7), 61 | t)) ^ t;
      return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
    };
  }

  // =========================================================================
  // CCDF helper: array of raw values (already +1'd by caller if desired) ->
  // ascending step points [[k, P(K>=k)], ...] for a log-log staircase plot.
  // =========================================================================
  function ccdfPoints(values) {
    var sorted = values.slice().sort(function (a, b) { return a - b; });
    var n = sorted.length;
    var uniqK = [];
    var counts = [];
    for (var i = 0; i < n; i++) {
      if (uniqK.length === 0 || sorted[i] !== uniqK[uniqK.length - 1]) {
        uniqK.push(sorted[i]);
        counts.push(1);
      } else {
        counts[counts.length - 1]++;
      }
    }
    var points = [];
    var cum = 0;
    for (i = 0; i < uniqK.length; i++) {
      points.push([uniqK[i], (n - cum) / n]);
      cum += counts[i];
    }
    return points;
  }

  // =========================================================================
  // Chart: log-log CCDF, one or two curves
  // =========================================================================
  function drawCCDFChart(container, curves) {
    container.innerHTML = "";
    var W = 640, H = 340, padL = 46, padR = 14, padT = 14, padB = 34;

    var xmax = 2, ymin = 1;
    curves.forEach(function (c) {
      c.points.forEach(function (p) {
        if (p[0] > xmax) xmax = p[0];
        if (p[1] > 0 && p[1] < ymin) ymin = p[1];
      });
    });
    xmax = Math.pow(10, Math.ceil(Math.log10(xmax)));
    ymin = Math.pow(10, Math.floor(Math.log10(ymin)));
    var xmin = 1, ymax = 1;

    function xScale(k) {
      var kk = Math.max(k, xmin);
      return padL + (Math.log10(kk) - Math.log10(xmin)) / (Math.log10(xmax) - Math.log10(xmin)) * (W - padL - padR);
    }
    function yScale(p) {
      var pp = Math.max(p, ymin);
      return padT + (1 - (Math.log10(pp) - Math.log10(ymin)) / (Math.log10(ymax) - Math.log10(ymin))) * (H - padT - padB);
    }

    var svg = el("svg", { viewBox: "0 0 " + W + " " + H, class: "chart-svg" });

    // gridlines + tick labels, powers of 10
    var xTick = xmin;
    while (xTick <= xmax) {
      var xg = xScale(xTick);
      svg.appendChild(el("line", { x1: xg, y1: padT, x2: xg, y2: H - padB, class: "chart-gridline" }));
      var xl = document.createElementNS(SVG_NS, "text");
      xl.setAttribute("x", xg); xl.setAttribute("y", H - padB + 16);
      xl.setAttribute("text-anchor", "middle"); xl.setAttribute("class", "chart-tick-label");
      xl.textContent = String(Math.round(xTick));
      svg.appendChild(xl);
      xTick *= 10;
    }
    var yTick = ymin;
    while (yTick <= ymax) {
      var yg = yScale(yTick);
      svg.appendChild(el("line", { x1: padL, y1: yg, x2: W - padR, y2: yg, class: "chart-gridline" }));
      var yl = document.createElementNS(SVG_NS, "text");
      yl.setAttribute("x", padL - 6); yl.setAttribute("y", yg + 3);
      yl.setAttribute("text-anchor", "end"); yl.setAttribute("class", "chart-tick-label");
      yl.textContent = yTick >= 1 ? "1" : yTick.toExponential(0).replace("e-", "e-");
      svg.appendChild(yl);
      yTick *= 10;
    }

    // axes
    svg.appendChild(el("line", { x1: padL, y1: padT, x2: padL, y2: H - padB, class: "chart-axis" }));
    svg.appendChild(el("line", { x1: padL, y1: H - padB, x2: W - padR, y2: H - padB, class: "chart-axis" }));

    var xAxisLabel = document.createElementNS(SVG_NS, "text");
    xAxisLabel.setAttribute("x", (padL + W - padR) / 2); xAxisLabel.setAttribute("y", H - 4);
    xAxisLabel.setAttribute("text-anchor", "middle"); xAxisLabel.setAttribute("class", "chart-tick-label");
    xAxisLabel.textContent = "in-degree + 1 (log)";
    svg.appendChild(xAxisLabel);

    // curves, drawn as proper right-continuous staircases
    curves.forEach(function (c) {
      var d = "";
      c.points.forEach(function (p, i) {
        var x = xScale(p[0]), y = yScale(p[1]);
        if (i === 0) {
          d += "M " + x + " " + y + " ";
        } else {
          d += "L " + x + " " + yScale(c.points[i - 1][1]) + " ";
          d += "L " + x + " " + y + " ";
        }
      });
      svg.appendChild(el("path", { d: d, fill: "none", stroke: c.color, "stroke-width": 2 }));
    });

    container.appendChild(svg);
  }

  function renderLegend(container, curves) {
    container.innerHTML = "";
    curves.forEach(function (c) {
      var item = document.createElement("span");
      item.className = "chart-legend-item";
      var sw = document.createElement("span");
      sw.className = "chart-legend-swatch";
      sw.style.background = c.color;
      item.appendChild(sw);
      item.appendChild(document.createTextNode(c.label));
      container.appendChild(item);
    });
  }

  // =========================================================================
  // Chart: histogram with a marked real-value line
  // =========================================================================
  function drawHistogram(container, samples, realValue, color) {
    container.innerHTML = "";
    if (samples.length === 0) {
      var p = document.createElement("p");
      p.className = "inspector-empty";
      p.style.padding = "16px";
      p.textContent = 'No shuffles run yet -- click "Run 15 more shuffles."';
      container.appendChild(p);
      return;
    }

    var W = 640, H = 300, padL = 46, padR = 14, padT = 14, padB = 34;
    var minV = Math.min(Math.min.apply(null, samples), realValue);
    var maxV = Math.max(Math.max.apply(null, samples), realValue);
    var span = (maxV - minV) || 1;
    minV -= span * 0.05;
    maxV += span * 0.05;
    span = maxV - minV;

    var nbins = Math.max(8, Math.min(28, Math.round(Math.sqrt(samples.length) * 2)));
    var binWidth = span / nbins;
    var bins = new Array(nbins).fill(0);
    samples.forEach(function (v) {
      var idx = Math.min(nbins - 1, Math.max(0, Math.floor((v - minV) / binWidth)));
      bins[idx]++;
    });
    var maxCount = Math.max.apply(null, bins);

    function xScale(v) { return padL + (v - minV) / span * (W - padL - padR); }
    function yScale(count) { return H - padB - (count / maxCount) * (H - padT - padB); }

    var svg = el("svg", { viewBox: "0 0 " + W + " " + H, class: "chart-svg" });

    svg.appendChild(el("line", { x1: padL, y1: padT, x2: padL, y2: H - padB, class: "chart-axis" }));
    svg.appendChild(el("line", { x1: padL, y1: H - padB, x2: W - padR, y2: H - padB, class: "chart-axis" }));

    for (var i = 0; i < nbins; i++) {
      var x0 = xScale(minV + i * binWidth);
      var x1 = xScale(minV + (i + 1) * binWidth);
      var y = yScale(bins[i]);
      svg.appendChild(el("rect", {
        x: x0 + 0.5, y: y, width: Math.max(0, x1 - x0 - 1), height: (H - padB) - y,
        fill: color, opacity: 0.55,
      }));
    }

    // real-value marker
    var xr = xScale(realValue);
    svg.appendChild(el("line", { x1: xr, y1: padT, x2: xr, y2: H - padB, stroke: "#e6353a", "stroke-width": 2, "stroke-dasharray": "4 3" }));
    var rl = document.createElementNS(SVG_NS, "text");
    rl.setAttribute("x", xr); rl.setAttribute("y", padT + 12);
    rl.setAttribute("text-anchor", xr > W - 90 ? "end" : "start");
    rl.setAttribute("class", "chart-tick-label"); rl.setAttribute("fill", "#e6353a");
    rl.textContent = "real = " + realValue.toFixed(3);
    svg.appendChild(rl);

    // a few x-axis ticks
    var ticks = 5;
    for (i = 0; i <= ticks; i++) {
      var v = minV + (i / ticks) * span;
      var xt = xScale(v);
      var tl = document.createElementNS(SVG_NS, "text");
      tl.setAttribute("x", xt); tl.setAttribute("y", H - padB + 16);
      tl.setAttribute("text-anchor", "middle"); tl.setAttribute("class", "chart-tick-label");
      tl.textContent = v.toFixed(2);
      svg.appendChild(tl);
    }

    container.appendChild(svg);
  }

  // =========================================================================
  // Chart: log-log scatter with a y=x reference line, clickable points
  // =========================================================================
  function drawScatter(container, points, opts) {
    container.innerHTML = "";
    var W = 640, H = 420, padL = 46, padR = 14, padT = 14, padB = 34;

    var maxV = 2;
    points.forEach(function (pt) {
      if (pt.x > maxV) maxV = pt.x;
      if (pt.y > maxV) maxV = pt.y;
    });
    maxV = Math.pow(10, Math.ceil(Math.log10(maxV)));
    var minV = 1;

    function scale(v) {
      var vv = Math.max(v, minV);
      return (Math.log10(vv) - Math.log10(minV)) / (Math.log10(maxV) - Math.log10(minV));
    }
    function xPix(v) { return padL + scale(v) * (W - padL - padR); }
    function yPix(v) { return H - padB - scale(v) * (H - padT - padB); }

    var svg = el("svg", { viewBox: "0 0 " + W + " " + H, class: "chart-svg" });

    var tick = minV;
    while (tick <= maxV) {
      var xg = xPix(tick), yg = yPix(tick);
      svg.appendChild(el("line", { x1: xg, y1: padT, x2: xg, y2: H - padB, class: "chart-gridline" }));
      svg.appendChild(el("line", { x1: padL, y1: yg, x2: W - padR, y2: yg, class: "chart-gridline" }));
      var xl = document.createElementNS(SVG_NS, "text");
      xl.setAttribute("x", xg); xl.setAttribute("y", H - padB + 16);
      xl.setAttribute("text-anchor", "middle"); xl.setAttribute("class", "chart-tick-label");
      xl.textContent = String(Math.round(tick));
      svg.appendChild(xl);
      var yl = document.createElementNS(SVG_NS, "text");
      yl.setAttribute("x", padL - 6); yl.setAttribute("y", yg + 3);
      yl.setAttribute("text-anchor", "end"); yl.setAttribute("class", "chart-tick-label");
      yl.textContent = String(Math.round(tick));
      svg.appendChild(yl);
      tick *= 10;
    }

    svg.appendChild(el("line", { x1: padL, y1: padT, x2: padL, y2: H - padB, class: "chart-axis" }));
    svg.appendChild(el("line", { x1: padL, y1: H - padB, x2: W - padR, y2: H - padB, class: "chart-axis" }));

    // y = x reference
    svg.appendChild(el("line", {
      x1: xPix(minV), y1: yPix(minV), x2: xPix(maxV), y2: yPix(maxV),
      stroke: "#9a9daa", "stroke-width": 1, "stroke-dasharray": "3 4",
    }));

    var group = el("g");
    points.forEach(function (pt) {
      var isSelected = opts.selectedId && pt.id === opts.selectedId;
      var isChampion = opts.championIds.indexOf(pt.id) !== -1;
      var c = el("circle", {
        cx: xPix(pt.x), cy: yPix(pt.y),
        r: isSelected ? 6 : (isChampion ? 4.5 : 3),
        fill: isSelected ? "#e6353a" : (isChampion ? "#e0a020" : "rgba(77,124,255,0.55)"),
        stroke: isSelected || isChampion ? "#ffffff" : "none",
        "stroke-width": isSelected ? 2 : 1,
        "data-id": pt.id,
        style: "cursor:pointer;",
      });
      c.addEventListener("click", function () { opts.onSelect(pt.id); });
      group.appendChild(c);
    });
    svg.appendChild(group);

    container.appendChild(svg);
  }

  // =========================================================================
  // Directed degree-preserving shuffle (3-edge chain swap; preserves each
  // node's in-degree and out-degree exactly -- see the callout on the page
  // for the undirected-projection-degree caveat). Mirrors the algorithm in
  // networkx.algorithms.swap.directed_edge_swap (a->b->c->d becomes
  // a->c->b->d), which analysis/build_week2.py uses offline.
  // =========================================================================
  function cloneAdjacency(outAdj) {
    return outAdj.map(function (arr) { return arr.slice(); });
  }
  function buildOutSets(outAdj) {
    return outAdj.map(function (arr) { return new Set(arr); });
  }
  function removeEdge(outAdj, outSet, a, b) {
    outSet[a].delete(b);
    var arr = outAdj[a];
    var idx = arr.indexOf(b);
    if (idx !== -1) arr.splice(idx, 1);
  }
  function addEdge(outAdj, outSet, a, b) {
    outSet[a].add(b);
    outAdj[a].push(b);
  }

  function attemptDirectedSwap(outAdj, outSet, n, rng) {
    var start = Math.floor(rng() * n);
    if (outAdj[start].length === 0) return false;
    var second = outAdj[start][Math.floor(rng() * outAdj[start].length)];
    if (second === start) return false;
    if (outAdj[second].length === 0) return false;
    var third = outAdj[second][Math.floor(rng() * outAdj[second].length)];
    if (third === second) return false;
    if (outAdj[third].length === 0) return false;
    var fourth = outAdj[third][Math.floor(rng() * outAdj[third].length)];
    if (fourth === third) return false;
    if (start === third || second === fourth) return false; // self-loop guard
    if (outSet[start].has(third)) return false;
    if (outSet[second].has(fourth)) return false;
    if (outSet[third].has(second)) return false;

    removeEdge(outAdj, outSet, start, second);
    removeEdge(outAdj, outSet, second, third);
    removeEdge(outAdj, outSet, third, fourth);
    addEdge(outAdj, outSet, start, third);
    addEdge(outAdj, outSet, third, second);
    addEdge(outAdj, outSet, second, fourth);
    return true;
  }

  function shuffledRealization(originalOutAdj, n, targetSwaps, rng) {
    var outAdj = cloneAdjacency(originalOutAdj);
    var outSet = buildOutSets(outAdj);
    var successes = 0;
    var attempts = 0;
    var maxAttempts = targetSwaps * 25;
    while (successes < targetSwaps && attempts < maxAttempts) {
      attempts++;
      if (attemptDirectedSwap(outAdj, outSet, n, rng)) successes++;
    }
    return { outAdj: outAdj, outSet: outSet };
  }

  function undirectedProjectionFromOutAdj(outAdj, n) {
    var undirAdj = new Array(n);
    for (var i = 0; i < n; i++) undirAdj[i] = new Set();
    for (var a = 0; a < n; a++) {
      outAdj[a].forEach(function (b) { undirAdj[a].add(b); undirAdj[b].add(a); });
    }
    return undirAdj;
  }

  function averageClustering(undirAdj, n) {
    var total = 0;
    for (var i = 0; i < n; i++) {
      var neighbors = Array.from(undirAdj[i]);
      var k = neighbors.length;
      if (k < 2) continue;
      var links = 0;
      for (var x = 0; x < k; x++) {
        for (var y = x + 1; y < k; y++) {
          if (undirAdj[neighbors[x]].has(neighbors[y])) links++;
        }
      }
      total += links / (k * (k - 1) / 2);
    }
    return total / n;
  }

  function reciprocity(outAdj, outSet, n, m) {
    var mutual = 0;
    for (var a = 0; a < n; a++) {
      outAdj[a].forEach(function (b) { if (outSet[b].has(a)) mutual++; });
    }
    return mutual / m;
  }

  // =========================================================================
  // Directed preferential attachment (Price-model form): seed = m+1 nodes
  // wired as a directed cycle, then each new node adds m outgoing edges to
  // distinct existing nodes chosen with probability proportional to
  // (in-degree + 1). Mirrors analysis/build_week2.py's
  // directed_preferential_attachment().
  // =========================================================================
  function directedPreferentialAttachment(n, m, rng) {
    var seedSize = m + 1;
    var outAdj = [];
    var inDeg = new Array(n).fill(0);
    for (var i = 0; i < n; i++) outAdj.push([]);
    for (i = 0; i < seedSize; i++) {
      var target = (i + 1) % seedSize;
      outAdj[i].push(target);
      inDeg[target]++;
    }
    for (var newNode = seedSize; newNode < n; newNode++) {
      var pool = []; // [nodeIndex, weight]
      for (var e = 0; e < newNode; e++) pool.push([e, inDeg[e] + 1]);
      var targets = [];
      var targetSet = new Set();
      while (targets.length < m && pool.length > 0) {
        var total = 0;
        for (var pi = 0; pi < pool.length; pi++) total += pool[pi][1];
        var r = rng() * total;
        var upto = 0;
        for (pi = 0; pi < pool.length; pi++) {
          upto += pool[pi][1];
          if (upto >= r) {
            targets.push(pool[pi][0]);
            targetSet.add(pool[pi][0]);
            pool.splice(pi, 1);
            break;
          }
        }
      }
      targets.forEach(function (t) {
        outAdj[newNode].push(t);
        inDeg[t]++;
      });
    }
    return { outAdj: outAdj, inDeg: inDeg };
  }

  // =========================================================================
  // Load shared data, then wire up each section
  // =========================================================================
  Promise.all([
    fetch("../data/week1/week1_nodes.tsv").then(function (r) { return r.text(); }),
    fetch("../data/week1/week1_edges.tsv").then(function (r) { return r.text(); }),
    fetch("../data/week2/week2_summary.json").then(function (r) { return r.json(); }),
  ])
    .then(function (results) {
      var nodesText = results[0], edgesText = results[1], summary = results[2];

      var nodeLines = parseDataLines(nodesText);
      var header = nodeLines[0].split("\t");
      var idCol = header.indexOf("node_id");
      var nameCol = header.indexOf("name");
      var nodeRows = nodeLines.slice(1).map(function (line) { return line.split("\t"); });
      var nodeIds = nodeRows.map(function (cols) { return cols[idCol]; });
      var nameById = new Map(nodeRows.map(function (cols) { return [cols[idCol], cols[nameCol]]; }));

      var n = nodeIds.length;
      var idToIndex = new Map(nodeIds.map(function (id, i) { return [id, i]; }));

      var edgeRows = parseDataLines(edgesText).map(function (line) { return line.split("\t"); });
      var m = edgeRows.length;

      var outAdjOriginal = [];
      for (var i = 0; i < n; i++) outAdjOriginal.push([]);
      edgeRows.forEach(function (row) {
        outAdjOriginal[idToIndex.get(row[0])].push(idToIndex.get(row[1]));
      });

      var realInDeg = new Array(n).fill(0);
      edgeRows.forEach(function (row) { realInDeg[idToIndex.get(row[1])]++; });

      var realUndirAdj = undirectedProjectionFromOutAdj(outAdjOriginal, n);
      var realUndirDeg = realUndirAdj.map(function (s) { return s.size; });

      var realCCDF = ccdfPoints(realInDeg.map(function (d) { return d + 1; }));
      var COLOR_REAL = "#4C6EF5";
      var COLOR_ER = "#e6353a";
      var COLOR_BA = "#e0a020";
      var COLOR_CLUSTERING = "#2F9E44";
      var COLOR_RECIPROCITY = "#e6353a";

      initER();
      initShuffle();
      initBA();
      initParadox();

      // -----------------------------------------------------------------
      // Section 2: ER
      // -----------------------------------------------------------------
      function initER() {
        var btn = document.getElementById("er-draw-btn");
        var readout = document.getElementById("er-current-readout");
        var history = document.getElementById("er-history");
        var chart = document.getElementById("er-chart");
        var legend = document.getElementById("er-legend");
        var rng = makeRng(20260909 ^ 0x9e3779b9);
        var draws = [];

        function drawOnce() {
          var edgeSet = new Set();
          var inDeg = new Array(n).fill(0);
          var target = m;
          var guard = 0;
          while (edgeSet.size < target && guard < target * 50) {
            guard++;
            var a = Math.floor(rng() * n);
            var b = Math.floor(rng() * n);
            if (a === b) continue;
            var key = a * 400 + b;
            if (edgeSet.has(key)) continue;
            edgeSet.add(key);
            inDeg[b]++;
          }
          var maxDeg = Math.max.apply(null, inDeg);
          draws.push(maxDeg);
          if (draws.length > 12) draws.shift();

          var curves = [
            { label: "Real network (max in-degree " + Math.max.apply(null, realInDeg) + ")", color: COLOR_REAL, points: realCCDF },
            { label: "Random draw (max in-degree " + maxDeg + ")", color: COLOR_ER, points: ccdfPoints(inDeg.map(function (d) { return d + 1; })) },
          ];
          drawCCDFChart(chart, curves);
          renderLegend(legend, curves);

          readout.textContent = "Latest draw's biggest hub: in-degree " + maxDeg + " (real network: " + Math.max.apply(null, realInDeg) + ")";
          history.innerHTML = "";
          draws.forEach(function (d, idx) {
            var chip = document.createElement("span");
            chip.className = "draw-chip" + (idx === draws.length - 1 ? " is-latest" : "");
            chip.textContent = "max=" + d;
            history.appendChild(chip);
          });
        }

        btn.addEventListener("click", drawOnce);
        drawOnce();
      }

      // -----------------------------------------------------------------
      // Section 3: degree-preserving shuffle
      // -----------------------------------------------------------------
      function initShuffle() {
        var clusteringBtn = document.getElementById("shuffle-clustering-btn");
        var reciprocityBtn = document.getElementById("shuffle-reciprocity-btn");
        var runBtn = document.getElementById("shuffle-run-btn");
        var chart = document.getElementById("shuffle-chart");
        var readout = document.getElementById("shuffle-readout");
        var rng = makeRng(20260909 ^ 0x2545F491);

        var realClustering = summary.baseline.clustering.value;
        var realReciprocity = summary.baseline.reciprocity.mutual_edge_fraction;

        var clusteringSamples = [];
        var reciprocitySamples = [];
        var activeStat = "clustering";
        // Matches the swap count analysis/build_week2.py uses offline (3000
        // swaps/realization) -- reciprocity's null mean was still visibly
        // under-mixed at 2000 swaps when checked against a higher-swap-count
        // reference (0.083 vs. a converged ~0.065), so this isn't just
        // "more samples = smoother," it's "too few swaps = biased mean."
        var SWAPS_PER_REALIZATION = 3000;
        var REALIZATIONS_PER_CLICK = 15;

        function currentSamples() { return activeStat === "clustering" ? clusteringSamples : reciprocitySamples; }
        function currentReal() { return activeStat === "clustering" ? realClustering : realReciprocity; }
        function currentColor() { return activeStat === "clustering" ? COLOR_CLUSTERING : COLOR_RECIPROCITY; }
        function currentLabel() { return activeStat === "clustering" ? "clustering coefficient" : "reciprocity"; }

        function render() {
          var samples = currentSamples();
          drawHistogram(chart, samples, currentReal(), currentColor());

          readout.innerHTML = "";
          function stat(label, value) {
            var li = document.createElement("li");
            li.className = "stat-card";
            li.innerHTML = '<span class="stat-label">' + label + '</span><span class="stat-value">' + value + "</span>";
            readout.appendChild(li);
          }
          stat("Shuffles run", samples.length);
          if (samples.length > 0) {
            var mean = samples.reduce(function (a, b) { return a + b; }, 0) / samples.length;
            var variance = samples.reduce(function (a, b) { return a + (b - mean) * (b - mean); }, 0) / samples.length;
            var sd = Math.sqrt(variance);
            var z = sd > 0 ? (currentReal() - mean) / sd : NaN;
            var pCount = samples.filter(function (v) { return v >= currentReal(); }).length;
            stat("Null mean", mean.toFixed(4));
            stat("Null sd", sd.toFixed(4));
            stat("z-score", isFinite(z) ? z.toFixed(2) : "n/a");
            stat("Empirical p (real ≥ null)", (pCount / samples.length).toFixed(4));
          }
        }

        function runBatch() {
          runBtn.disabled = true;
          runBtn.textContent = "Running…";
          setTimeout(function () {
            for (var i = 0; i < REALIZATIONS_PER_CLICK; i++) {
              var result = shuffledRealization(outAdjOriginal, n, SWAPS_PER_REALIZATION, rng);
              var undir = undirectedProjectionFromOutAdj(result.outAdj, n);
              clusteringSamples.push(averageClustering(undir, n));
              reciprocitySamples.push(reciprocity(result.outAdj, result.outSet, n, m));
            }
            render();
            runBtn.disabled = false;
            runBtn.textContent = "Run 15 more shuffles";
          }, 10);
        }

        clusteringBtn.addEventListener("click", function () {
          activeStat = "clustering";
          clusteringBtn.classList.add("is-active"); clusteringBtn.setAttribute("aria-pressed", "true");
          reciprocityBtn.classList.remove("is-active"); reciprocityBtn.setAttribute("aria-pressed", "false");
          render();
        });
        reciprocityBtn.addEventListener("click", function () {
          activeStat = "reciprocity";
          reciprocityBtn.classList.add("is-active"); reciprocityBtn.setAttribute("aria-pressed", "true");
          clusteringBtn.classList.remove("is-active"); clusteringBtn.setAttribute("aria-pressed", "false");
          render();
        });
        runBtn.addEventListener("click", runBatch);

        render();
      }

      // -----------------------------------------------------------------
      // Section 4: directed preferential attachment
      // -----------------------------------------------------------------
      function initBA() {
        var slider = document.getElementById("ba-m-slider");
        var mValueEl = document.getElementById("ba-m-value");
        var regenBtn = document.getElementById("ba-regen-btn");
        var chart = document.getElementById("ba-chart");
        var legend = document.getElementById("ba-legend");
        var readout = document.getElementById("ba-readout");
        var rng = makeRng(20260909 ^ 0x85EBCA6B);

        function draw() {
          var mVal = parseInt(slider.value, 10);
          mValueEl.textContent = String(mVal);
          var result = directedPreferentialAttachment(n, mVal, rng);
          var maxDeg = Math.max.apply(null, result.inDeg);
          var meanDeg = result.inDeg.reduce(function (a, b) { return a + b; }, 0) / n;
          var outDegThisDraw = result.outAdj.map(function (arr) { return arr.length; });
          var isolatesThisDraw = 0;
          for (var idx = 0; idx < n; idx++) {
            if (result.inDeg[idx] === 0 && outDegThisDraw[idx] === 0) isolatesThisDraw++;
          }

          var curves = [
            { label: "Real network (max in-degree " + Math.max.apply(null, realInDeg) + ")", color: COLOR_REAL, points: realCCDF },
            { label: "Preferential attachment, m=" + mVal + " (max in-degree " + maxDeg + ")", color: COLOR_BA, points: ccdfPoints(result.inDeg.map(function (d) { return d + 1; })) },
          ];
          drawCCDFChart(chart, curves);
          renderLegend(legend, curves);

          readout.innerHTML = "";
          function stat(label, value) {
            var li = document.createElement("li");
            li.className = "stat-card";
            li.innerHTML = '<span class="stat-label">' + label + '</span><span class="stat-value">' + value + "</span>";
            readout.appendChild(li);
          }
          stat("This draw's max in-degree", maxDeg);
          stat("This draw's mean in-degree", meanDeg.toFixed(2));
          stat("Real max / mean in-degree", Math.max.apply(null, realInDeg) + " / " + (realInDeg.reduce(function (a, b) { return a + b; }, 0) / n).toFixed(2));
          stat("Isolated characters in this draw", isolatesThisDraw + " (real: 17)");
        }

        slider.addEventListener("input", draw);
        regenBtn.addEventListener("click", draw);
        draw();
      }

      // -----------------------------------------------------------------
      // Section 5: friendship paradox
      // -----------------------------------------------------------------
      function initParadox() {
        var searchForm = document.getElementById("paradox-search-form");
        var searchInput = document.getElementById("paradox-search-input");
        var searchStatus = document.getElementById("paradox-search-status");
        var searchDatalist = document.getElementById("paradox-character-list");
        var clearBtn = document.getElementById("paradox-clear-btn");
        var chart = document.getElementById("paradox-chart");
        var inspector = document.getElementById("paradox-inspector");

        var championIds = summary.baseline.friendship_paradox.local_degree_champions.slice();
        var points = [];
        var knnById = new Map();
        for (var i = 0; i < n; i++) {
          var deg = realUndirDeg[i];
          if (deg === 0) continue;
          var neighbors = Array.from(realUndirAdj[i]);
          var knn = neighbors.reduce(function (acc, nb) { return acc + realUndirDeg[nb]; }, 0) / neighbors.length;
          var id = nodeIds[i];
          knnById.set(id, knn);
          points.push({ id: id, x: deg, y: knn });
        }

        function byName(a, b) { return (nameById.get(a) || a).localeCompare(nameById.get(b) || b); }
        nodeIds.slice().sort(byName).forEach(function (id) {
          if (realUndirDeg[idToIndex.get(id)] === 0) return;
          var opt = document.createElement("option");
          opt.value = nameById.get(id) || id;
          searchDatalist.appendChild(opt);
        });

        var selectedId = null;

        function renderInspector(id) {
          var idx = idToIndex.get(id);
          var deg = realUndirDeg[idx];
          var knn = knnById.get(id);
          var neighbors = Array.from(realUndirAdj[idx])
            .map(function (nb) { return { id: nodeIds[nb], deg: realUndirDeg[nb] }; })
            .sort(function (a, b) { return b.deg - a.deg; });

          var CAP = 12;
          var neighborHtml = neighbors.slice(0, CAP).map(function (nb) {
            return '<span class="neighbor-pill">' + (nameById.get(nb.id) || nb.id) + " (" + nb.deg + ")</span>";
          }).join("");
          var extra = neighbors.length > CAP ? '<span class="neighbor-more">+' + (neighbors.length - CAP) + " more</span>" : "";

          var comparison = knn > deg
            ? "This hero's neighbors average <strong>more</strong> connections than they have -- the paradox holds for them."
            : (knn < deg
              ? "This hero has <strong>more</strong> connections than their average neighbor -- the paradox runs the other way for them."
              : "This hero's degree exactly matches their average neighbor's degree.");
          var championNote = championIds.indexOf(id) !== -1
            ? '<p class="network-note">Local degree-champion: no neighbor of this hero has a higher degree.</p>'
            : "";

          inspector.innerHTML =
            '<h4 class="inspector-name">' + (nameById.get(id) || id) + "</h4>" +
            '<div class="inspector-stats">' +
              '<div class="inspector-stat"><span class="stat-label">Own degree</span><span class="stat-value">' + deg + "</span></div>" +
              '<div class="inspector-stat"><span class="stat-label">Avg. neighbor degree</span><span class="stat-value">' + knn.toFixed(1) + "</span></div>" +
            "</div>" +
            "<p>" + comparison + "</p>" +
            championNote +
            '<div class="inspector-lists"><div class="inspector-section"><h5>Neighbors, by degree (' + neighbors.length + ")</h5>" + neighborHtml + extra + "</div></div>";
        }

        function clearInspector() {
          inspector.innerHTML = '<p class="inspector-empty">No hero selected yet — click a dot or find one above.</p>';
        }

        function select(id) {
          selectedId = id;
          drawScatter(chart, points, { selectedId: selectedId, championIds: championIds, onSelect: select });
          renderInspector(id);
        }

        function clear() {
          selectedId = null;
          drawScatter(chart, points, { selectedId: null, championIds: championIds, onSelect: select });
          clearInspector();
        }

        searchForm.addEventListener("submit", function (e) {
          e.preventDefault();
          var query = searchInput.value.trim().toLowerCase();
          if (!query) return;
          var match = nodeIds.find(function (id) { return (nameById.get(id) || "").toLowerCase() === query; });
          if (!match) match = nodeIds.find(function (id) { return (nameById.get(id) || "").toLowerCase().indexOf(query) === 0; });
          if (!match || realUndirDeg[idToIndex.get(match)] === 0) {
            searchStatus.textContent = "No connected character found with that name — isolated characters have no neighbors to compare.";
            return;
          }
          searchStatus.textContent = "";
          select(match);
        });

        searchInput.addEventListener("input", function () {
          var value = searchInput.value.trim().toLowerCase();
          if (!value) return;
          var exact = nodeIds.find(function (id) { return (nameById.get(id) || "").toLowerCase() === value; });
          if (exact && realUndirDeg[idToIndex.get(exact)] > 0) {
            searchStatus.textContent = "";
            select(exact);
          }
        });

        clearBtn.addEventListener("click", function () {
          searchInput.value = "";
          searchStatus.textContent = "";
          clear();
        });

        clear();
      }
    })
    .catch(function (err) {
      ["er-chart", "shuffle-chart", "ba-chart", "paradox-chart"].forEach(function (id) {
        var box = document.getElementById(id);
        if (box) {
          box.textContent =
            "Interactive figure could not load (this page needs to be served over http://, e.g. via " +
            "'python -m http.server' locally -- it will not load if opened directly as a file). " + err;
        }
      });
    });
})();
