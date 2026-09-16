/*
 * Week 3 interactives: centrality comparison, directed-vs-undirected rank
 * changes, a general Six Degrees of Marvel shortest-path explorer,
 * node-removal fragmentation playback, and a maximal-clique explorer.
 *
 * Architecture: everything expensive (all five centrality measures, the
 * 200-realization degree-preserving-shuffle null models, the three
 * fragmentation removal curves, every maximal clique) is precomputed
 * offline by analysis/build_week3.py into data/week3/week3_summary.json.
 * This script only looks numbers up and draws them -- the one live
 * computation left in the browser is the Six Degrees BFS, which has to
 * answer an arbitrary character pair chosen at click time and is cheap
 * enough (a single BFS on a 277-node graph) to just run directly, in the
 * same spirit as week2.js recomputing its own statistics live from the
 * raw Week 1 TSVs.
 *
 * All four network views share one precomputed node layout (a seeded
 * spring_layout computed once in build_week3.py) so the shape of the
 * network stays stable across every interaction -- nothing here re-runs
 * force-directed physics in the browser.
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

  function fetchText(url) {
    return fetch(url).then(function (r) {
      if (!r.ok) throw new Error("HTTP " + r.status + " fetching " + url);
      return r.text();
    });
  }
  function fetchJson(url) {
    return fetch(url).then(function (r) {
      if (!r.ok) throw new Error("HTTP " + r.status + " fetching " + url);
      return r.json();
    });
  }

  var REDUCED_MOTION = !!(window.matchMedia && window.matchMedia("(prefers-reduced-motion: reduce)").matches);

  // ---- palette (reusing the site's existing three accents, nothing new) ----
  var COLOR_ACCENT = "#e6353a";     // --accent, Marvel red
  var COLOR_ACCENT_2 = "#4d7cff";   // --accent-2, blue
  var COLOR_ACCENT_3 = "#e0a020";   // --accent-3, amber
  var COLOR_DIM = "rgba(154,157,170,0.30)";
  var COLOR_EDGE = "#3a3d46";

  function fmtInt(n) { return String(Math.round(n)); }
  function fmtFloat(n, d) { return (typeof n === "number") ? n.toFixed(d == null ? 3 : d) : "–"; }
  function fmtPercent(fraction, d) { return (fraction * 100).toFixed(d == null ? 1 : d) + "%"; }

  // =========================================================================
  // Shared network view: draws the 277-node giant component once, at fixed
  // (precomputed, seeded) positions, and exposes cheap restyle functions --
  // every interactive below recolors/resizes/dims the same static SVG
  // rather than rebuilding or re-laying-out the graph.
  // =========================================================================
  function createNetworkView(container, nodeIds, layout, edgeList, opts) {
    opts = opts || {};
    var W = 1000, H = 640, margin = 22;
    container.innerHTML = "";

    function px(id) {
      var p = layout[id];
      if (!p) return null;
      return [margin + p[0] * (W - 2 * margin), margin + p[1] * (H - 2 * margin)];
    }

    var svg = el("svg", { viewBox: "0 0 " + W + " " + H, class: "chart-svg" });
    var edgeGroup = el("g");
    var nodeGroup = el("g");
    svg.appendChild(edgeGroup);
    svg.appendChild(nodeGroup);

    var edgeEls = [];
    var edgeIndexByKey = {};
    edgeList.forEach(function (pair) {
      var a = px(pair[0]), b = px(pair[1]);
      if (!a || !b) return;
      var line = el("line", {
        x1: a[0], y1: a[1], x2: b[0], y2: b[1],
        stroke: COLOR_EDGE, "stroke-width": 0.6, opacity: 0.35,
      });
      edgeGroup.appendChild(line);
      var idx = edgeEls.length;
      edgeEls.push({ a: pair[0], b: pair[1], el: line });
      var key = pair[0] < pair[1] ? pair[0] + "|" + pair[1] : pair[1] + "|" + pair[0];
      edgeIndexByKey[key] = idx;
    });

    var nodeEls = {};
    nodeIds.forEach(function (id) {
      var p = px(id);
      if (!p) return;
      var c = el("circle", {
        cx: p[0], cy: p[1], r: 2.4, fill: COLOR_DIM, stroke: "none", "stroke-width": 1,
      });
      c.style.cursor = "pointer";
      if (opts.onNodeClick) {
        c.addEventListener("click", function () { opts.onNodeClick(id); });
      }
      if (opts.onNodeHover) {
        c.addEventListener("mouseenter", function () { opts.onNodeHover(id); });
        c.addEventListener("mouseleave", function () { opts.onNodeHover(null); });
      }
      var title = document.createElementNS(SVG_NS, "title");
      title.textContent = opts.titleFor ? opts.titleFor(id) : id;
      c.appendChild(title);
      nodeGroup.appendChild(c);
      nodeEls[id] = c;
    });

    container.appendChild(svg);

    function setNodeStyle(id, style) {
      var c = nodeEls[id];
      if (!c) return;
      if (style.r != null) c.setAttribute("r", style.r);
      if (style.fill != null) c.setAttribute("fill", style.fill);
      if (style.stroke != null) c.setAttribute("stroke", style.stroke);
      if (style.strokeWidth != null) c.setAttribute("stroke-width", style.strokeWidth);
      if (style.opacity != null) c.setAttribute("opacity", style.opacity);
    }
    function setEdgeStyleByIndex(idx, style) {
      var e = edgeEls[idx];
      if (!e) return;
      if (style.stroke != null) e.el.setAttribute("stroke", style.stroke);
      if (style.strokeWidth != null) e.el.setAttribute("stroke-width", style.strokeWidth);
      if (style.opacity != null) e.el.setAttribute("opacity", style.opacity);
    }
    function edgeIndexFor(a, b) {
      var key = a < b ? a + "|" + b : b + "|" + a;
      return edgeIndexByKey.hasOwnProperty(key) ? edgeIndexByKey[key] : -1;
    }
    function resetNodes(style) {
      Object.keys(nodeEls).forEach(function (id) { setNodeStyle(id, style); });
    }
    function resetEdges(style) {
      edgeEls.forEach(function (_, i) { setEdgeStyleByIndex(i, style); });
    }

    return {
      svg: svg,
      nodeIds: Object.keys(nodeEls),
      setNodeStyle: setNodeStyle,
      setEdgeStyleByIndex: setEdgeStyleByIndex,
      edgeIndexFor: edgeIndexFor,
      edgeCount: edgeEls.length,
      resetNodes: resetNodes,
      resetEdges: resetEdges,
    };
  }

  // =========================================================================
  // Compact linear line chart (fragmentation curves) -- three series, shared
  // linear x/y axes, no log scale needed here (unlike week2.js's CCDF chart).
  // =========================================================================
  function drawLineChart(container, series, opts) {
    container.innerHTML = "";
    opts = opts || {};
    var W = 640, H = 300, padL = 40, padR = 14, padT = 14, padB = 30;
    var xmax = opts.xmax || 0, ymax = opts.ymax || 0;
    series.forEach(function (s) {
      s.points.forEach(function (p) {
        if (p[0] > xmax) xmax = p[0];
        if (p[1] > ymax) ymax = p[1];
      });
    });
    function xScale(x) { return padL + (x / xmax) * (W - padL - padR); }
    function yScale(y) { return H - padB - (y / ymax) * (H - padT - padB); }

    var svg = el("svg", { viewBox: "0 0 " + W + " " + H, class: "chart-svg" });

    [0, 0.25, 0.5, 0.75, 1].forEach(function (t) {
      var y = yScale(ymax * t);
      svg.appendChild(el("line", { x1: padL, y1: y, x2: W - padR, y2: y, class: "chart-gridline" }));
      var yl = document.createElementNS(SVG_NS, "text");
      yl.setAttribute("x", padL - 6); yl.setAttribute("y", y + 3);
      yl.setAttribute("text-anchor", "end"); yl.setAttribute("class", "chart-tick-label");
      yl.textContent = Math.round(ymax * t);
      svg.appendChild(yl);
    });
    [0, 0.25, 0.5, 0.75, 1].forEach(function (t) {
      var x = xScale(xmax * t);
      var xl = document.createElementNS(SVG_NS, "text");
      xl.setAttribute("x", x); xl.setAttribute("y", H - padB + 14);
      xl.setAttribute("text-anchor", "middle"); xl.setAttribute("class", "chart-tick-label");
      xl.textContent = Math.round(xmax * t);
      svg.appendChild(xl);
    });

    svg.appendChild(el("line", { x1: padL, y1: padT, x2: padL, y2: H - padB, class: "chart-axis" }));
    svg.appendChild(el("line", { x1: padL, y1: H - padB, x2: W - padR, y2: H - padB, class: "chart-axis" }));

    series.forEach(function (s) {
      var d = "";
      s.points.forEach(function (p, i) {
        d += (i === 0 ? "M " : "L ") + xScale(p[0]) + " " + yScale(p[1]) + " ";
      });
      svg.appendChild(el("path", { d: d, fill: "none", stroke: s.color, "stroke-width": s.width || 2, opacity: s.opacity == null ? 1 : s.opacity }));
    });

    if (opts.markerX != null) {
      var mx = xScale(opts.markerX);
      svg.appendChild(el("line", { x1: mx, y1: padT, x2: mx, y2: H - padB, stroke: "#e9eaee", "stroke-width": 1, "stroke-dasharray": "3 3", opacity: 0.7 }));
    }

    container.appendChild(svg);
  }

  // =========================================================================
  // Load shared data: the offline summary, plus the raw Week 1 TSVs (needed
  // live only by the Six Degrees explorer and for building the giant
  // component's undirected edge list every network view draws).
  // =========================================================================
  Promise.all([
    fetchJson("../data/week3/week3_summary.json"),
    fetchText("../data/week1/week1_nodes.tsv"),
    fetchText("../data/week1/week1_edges.tsv"),
  ])
    .then(function (results) {
      var summary = results[0];
      var nodesText = results[1];
      var edgesText = results[2];

      var nodeLines = parseDataLines(nodesText);
      var header = nodeLines[0].split("\t");
      var idCol = header.indexOf("node_id");
      var nameCol = header.indexOf("name");
      var names = {};
      nodeLines.slice(1).forEach(function (line) {
        var cols = line.split("\t");
        names[cols[idCol]] = cols[nameCol];
      });

      var edgeRows = parseDataLines(edgesText)
        .filter(function (line) { return line !== "source\ttarget"; })
        .map(function (line) { return line.split("\t"); });

      var layout = summary.layout;
      var giantIds = Object.keys(layout);
      var giantIdSet = {};
      giantIds.forEach(function (id) { giantIdSet[id] = true; });

      // full directed adjacency (all 303 nodes) -- needed for the Six
      // Degrees directed mode; a directed path between two giant-component
      // characters can never leave the giant component (any directed edge
      // implies an undirected one), so no filtering is needed for
      // correctness, only for building it once.
      var outAdjFull = {};
      var inAdjFull = {};
      Object.keys(names).forEach(function (id) { outAdjFull[id] = []; inAdjFull[id] = []; });
      edgeRows.forEach(function (row) {
        var s = row[0], t = row[1];
        if (!(s in outAdjFull) || !(t in outAdjFull) || s === t) return;
        outAdjFull[s].push(t);
        inAdjFull[t].push(s);
      });

      // undirected adjacency + deduplicated edge list, giant component only
      // -- this is what every network view on the page draws.
      var giantUndAdj = {};
      giantIds.forEach(function (id) { giantUndAdj[id] = {}; });
      var edgeKeySeen = {};
      var giantEdges = [];
      edgeRows.forEach(function (row) {
        var s = row[0], t = row[1];
        if (!giantIdSet[s] || !giantIdSet[t] || s === t) return;
        giantUndAdj[s][t] = true;
        giantUndAdj[t][s] = true;
        var key = s < t ? s + "|" + t : t + "|" + s;
        if (!edgeKeySeen[key]) {
          edgeKeySeen[key] = true;
          giantEdges.push(s < t ? [s, t] : [t, s]);
        }
      });
      function undirectedNeighbors(id) { return Object.keys(giantUndAdj[id] || {}); }

      function byName(a, b) { return (names[a] || a).localeCompare(names[b] || b); }

      function titleFor(id) { return names[id] || id; }

      // ---- generic BFS with predecessors, used by Six Degrees for both modes ----
      function bfs(source, neighborsFn) {
        var dist = {}; dist[source] = 0;
        var prev = {};
        var queue = [source]; var qi = 0;
        while (qi < queue.length) {
          var cur = queue[qi++];
          var d = dist[cur];
          var neighbors = neighborsFn(cur);
          for (var i = 0; i < neighbors.length; i++) {
            var nb = neighbors[i];
            if (!(nb in dist)) { dist[nb] = d + 1; prev[nb] = cur; queue.push(nb); }
          }
        }
        return { dist: dist, prev: prev };
      }
      function reconstructPath(prev, source, target) {
        if (source === target) return [source];
        if (!(target in prev)) return null;
        var path = [target];
        var cur = target;
        while (cur !== source) { cur = prev[cur]; path.push(cur); }
        path.reverse();
        return path;
      }

      initCentrality();
      initDirectedVsUndirected();
      initSixDegrees();
      initFragmentation();
      initCliques();

      // ======================================================================
      // Section: Centrality comparison
      // ======================================================================
      function initCentrality() {
        var rankListEl = document.getElementById("centrality-rank-list");
        var networkContainer = document.getElementById("centrality-network");
        var inspectorEl = document.getElementById("centrality-inspector");
        var badgeEl = document.getElementById("centrality-graph-badge");
        var defTextEl = document.getElementById("centrality-definition-text");
        var buttons = {
          degree: document.getElementById("centrality-btn-degree"),
          closeness: document.getElementById("centrality-btn-closeness"),
          harmonic: document.getElementById("centrality-btn-harmonic"),
          betweenness: document.getElementById("centrality-btn-betweenness"),
          pagerank: document.getElementById("centrality-btn-pagerank"),
        };
        if (!rankListEl || !networkContainer || !inspectorEl) return;

        var currentMeasure = "degree";
        var selectedId = null;

        var view = createNetworkView(networkContainer, giantIds, layout, giantEdges, {
          titleFor: titleFor,
          onNodeClick: function (id) { selectCharacter(id); },
        });

        function valueFor(measure, id) {
          var all = summary.centrality[measure].all;
          return all.hasOwnProperty(id) ? all[id] : null;
        }

        function formatValue(measure, value) {
          if (value == null) return "–";
          if (measure === "degree") return fmtInt(value) + (value === 1 ? " link" : " links");
          if (measure === "pagerank") return value.toFixed(5);
          return value.toFixed(4);
        }

        function renderRankList() {
          rankListEl.innerHTML = "";
          var top = summary.centrality[currentMeasure].top;
          var topIds = {};
          top.forEach(function (row) {
            topIds[row.node_id] = true;
            var li = document.createElement("li");
            li.style.cursor = "pointer";
            if (row.node_id === selectedId) li.style.borderColor = COLOR_ACCENT;
            li.innerHTML =
              '<span class="rank">' + row.rank + '</span>' +
              '<span class="name">' + row.name + '</span>' +
              '<span class="metric">' + formatValue(currentMeasure, row.value) + '</span>';
            li.addEventListener("click", function () { selectCharacter(row.node_id); });
            rankListEl.appendChild(li);
          });
          return topIds;
        }

        function renderNetwork(topIds) {
          var top = summary.centrality[currentMeasure].top;
          var rankById = {};
          top.forEach(function (row) { rankById[row.node_id] = row.rank; });

          view.resetEdges({ stroke: COLOR_EDGE, strokeWidth: 0.5, opacity: 0.25 });
          giantIds.forEach(function (id) {
            if (id === selectedId) {
              view.setNodeStyle(id, { r: 9, fill: COLOR_ACCENT, stroke: "#fff", strokeWidth: 2, opacity: 1 });
            } else if (topIds[id]) {
              var rank = rankById[id];
              var r = 4 + (16 - rank) / 16 * 6;
              view.setNodeStyle(id, { r: r, fill: COLOR_ACCENT_2, stroke: "none", strokeWidth: 0, opacity: 0.95 });
            } else {
              view.setNodeStyle(id, { r: 2.2, fill: COLOR_DIM, stroke: "none", strokeWidth: 0, opacity: 1 });
            }
          });
        }

        function renderBadgeAndDefinition() {
          var info = summary.centrality[currentMeasure];
          defTextEl.textContent = info.definition;
          if (info.graph === "directed_full_network") {
            badgeEl.textContent = "Directed full network";
            badgeEl.className = "tag tag-scope-directed";
          } else {
            badgeEl.textContent = "Undirected giant component";
            badgeEl.className = "tag tag-scope-undirected";
          }
        }

        function renderInspector() {
          if (!selectedId) {
            inspectorEl.innerHTML = '<p class="inspector-empty">Click a character above to inspect their numbers.</p>';
            return;
          }
          var name = names[selectedId];
          var value = valueFor(currentMeasure, selectedId);
          var topEntry = summary.centrality[currentMeasure].top.find(function (r) { return r.node_id === selectedId; });
          var rankText = topEntry ? ("rank " + topEntry.rank + " of the top 15") : "outside the top 15 for this measure";

          var html =
            '<h4 class="inspector-name">' + name + '</h4>' +
            '<div class="inspector-stats">' +
            '<div class="inspector-stat"><span class="stat-label">' + currentMeasure + '</span>' +
            '<span class="stat-value">' + formatValue(currentMeasure, value) + '</span></div>' +
            '<div class="inspector-stat"><span class="stat-label">Ranking</span>' +
            '<span class="stat-value" style="font-size:13px;">' + rankText + '</span></div>' +
            '</div>';

          var nullBlock = null;
          if (currentMeasure === "betweenness" && summary.null_models.betweenness[selectedId]) {
            nullBlock = summary.null_models.betweenness[selectedId];
          } else if (currentMeasure === "closeness" && summary.null_models.closeness[selectedId]) {
            nullBlock = summary.null_models.closeness[selectedId];
          }
          if (nullBlock) {
            html +=
              '<div class="inspector-section"><h5>Against 200 degree-preserving shuffles</h5>' +
              '<ul class="test-readout">' +
              '<li class="stat-card"><span class="stat-label">Real value</span><span class="stat-value">' + fmtFloat(nullBlock.real, 4) + '</span></li>' +
              '<li class="stat-card"><span class="stat-label">Shuffle mean &plusmn; SD</span><span class="stat-value" style="font-size:14px;">' + fmtFloat(nullBlock.shuffle_mean, 4) + ' &plusmn; ' + fmtFloat(nullBlock.shuffle_sd, 4) + '</span></li>' +
              '<li class="stat-card"><span class="stat-label">z-score</span><span class="stat-value">' + (nullBlock.z == null ? "n/a" : nullBlock.z.toFixed(2)) + '</span></li>' +
              '<li class="stat-card"><span class="stat-label">Extreme shuffles</span><span class="stat-value">' + nullBlock.extreme_count + ' / ' + nullBlock.n_shuffles + '</span></li>' +
              '</ul></div>';
          } else if (currentMeasure === "betweenness" || currentMeasure === "closeness") {
            html += '<p class="inspector-empty">No null-model comparison was computed for this character (only the characters discussed on this page, or in either measure’s real top 15, were run through the 200-shuffle null).</p>';
          } else {
            html += '<p class="inspector-empty">Null-model comparisons on this page are computed for betweenness and closeness -- switch measures to see one.</p>';
          }
          inspectorEl.innerHTML = html;
        }

        function selectCharacter(id) {
          selectedId = id;
          render();
        }

        function render() {
          renderBadgeAndDefinition();
          var topIds = renderRankList();
          renderNetwork(topIds);
          renderInspector();
        }

        Object.keys(buttons).forEach(function (key) {
          if (!buttons[key]) return;
          buttons[key].addEventListener("click", function () {
            currentMeasure = key;
            Object.keys(buttons).forEach(function (k2) {
              if (!buttons[k2]) return;
              buttons[k2].classList.toggle("is-active", k2 === key);
              buttons[k2].setAttribute("aria-pressed", String(k2 === key));
            });
            render();
          });
        });

        render();
      }

      // ======================================================================
      // Section: Directed vs. undirected (static comparison tables)
      // ======================================================================
      function initDirectedVsUndirected() {
        var betwList = document.getElementById("dvu-betweenness-list");
        var prList = document.getElementById("dvu-pagerank-list");
        if (!betwList || !prList) return;

        var dvu = summary.directed_vs_undirected;

        betwList.innerHTML = "";
        dvu.betweenness_rank_changes.slice(0, 8).forEach(function (row, i) {
          var li = document.createElement("li");
          li.innerHTML =
            '<span class="rank">' + (i + 1) + '</span>' +
            '<span class="name">' + row.name + '</span>' +
            '<span class="metric">#' + row.undirected_rank + ' &rarr; #' + row.directed_rank + '</span>';
          betwList.appendChild(li);
        });

        prList.innerHTML = "";
        dvu.pagerank_vs_in_degree_surprises.forEach(function (row, i) {
          var li = document.createElement("li");
          li.innerHTML =
            '<span class="rank">' + (i + 1) + '</span>' +
            '<span class="name">' + row.name + '</span>' +
            '<span class="metric">PR #' + row.pagerank_rank + ', in-deg #' + row.in_degree_rank + '</span>';
          prList.appendChild(li);
        });

        var out = summary.six_degrees_notes.spiderman_out_degree_directed;
        ["dvu-spidey-out", "dvu-spidey-out-2"].forEach(function (id) {
          var elx = document.getElementById(id);
          if (elx) elx.textContent = out + " out of 303 characters";
        });
      }

      // ======================================================================
      // Section: Six Degrees of Marvel
      // ======================================================================
      function initSixDegrees() {
        var sourceInput = document.getElementById("sixdeg-source-input");
        var targetInput = document.getElementById("sixdeg-target-input");
        var swapBtn = document.getElementById("sixdeg-swap-btn");
        var datalistEl = document.getElementById("sixdeg-character-list");
        var modeUndirectedBtn = document.getElementById("sixdeg-mode-undirected-btn");
        var modeDirectedBtn = document.getElementById("sixdeg-mode-directed-btn");
        var modeDefEl = document.getElementById("sixdeg-mode-definition");
        var networkContainer = document.getElementById("sixdeg-network");
        var statsEl = document.getElementById("sixdeg-stats");
        var legendEl = document.getElementById("sixdeg-legend");
        var pathPanelEl = document.getElementById("sixdeg-path-panel");
        if (!sourceInput || !targetInput || !networkContainer || !statsEl) return;

        var sortedGiant = giantIds.slice().sort(byName);
        sortedGiant.forEach(function (id) {
          var opt = document.createElement("option");
          opt.value = names[id];
          datalistEl.appendChild(opt);
        });
        var idByName = {};
        sortedGiant.forEach(function (id) { idByName[(names[id] || "").toLowerCase()] = id; });

        var mode = "undirected"; // "undirected" | "directed"
        var sourceId = null, targetId = null;
        var animationToken = 0;

        var view = createNetworkView(networkContainer, giantIds, layout, giantEdges, { titleFor: titleFor });

        var DIST_COLORS = ["#ffffff", "#8fb1ff", "#6690ff", "#4d7cff", "#3c63d6", "#2c4aa8", "#1f3480"];
        function colorForDistance(d) {
          if (d === 0) return COLOR_ACCENT;
          return DIST_COLORS[Math.min(d, DIST_COLORS.length - 1)];
        }
        function radiusForDistance(d) {
          return Math.max(2.6, 7.5 - d * 0.9);
        }

        function neighborsForMode(id) {
          return mode === "undirected" ? undirectedNeighbors(id) : outAdjFull[id];
        }

        function renderLegend(maxDist, hasUnreachable) {
          legendEl.innerHTML = "";
          function row(label, color) {
            var div = document.createElement("div");
            div.className = "legend-row";
            div.innerHTML =
              '<span class="legend-swatch"><span style="display:inline-block;width:10px;height:10px;border-radius:50%;background:' + color + ';"></span></span>' +
              label;
            legendEl.appendChild(div);
          }
          row("0 &mdash; source character", COLOR_ACCENT);
          for (var d = 1; d <= Math.max(1, maxDist); d++) {
            row(d + (d === 1 ? " hop" : " hops"), colorForDistance(d));
          }
          if (hasUnreachable) row("Unreachable in this mode", COLOR_DIM);
        }

        function renderStats(bfsResult, maxDist) {
          var dists = Object.keys(bfsResult.dist).filter(function (id) { return id !== sourceId; }).map(function (id) { return bfsResult.dist[id]; });
          var reachable = dists.length;
          var avg = reachable ? dists.reduce(function (a, b) { return a + b; }, 0) / reachable : 0;
          var byDist = {};
          dists.forEach(function (d) { byDist[d] = (byDist[d] || 0) + 1; });

          var distRows = Object.keys(byDist).map(Number).sort(function (a, b) { return a - b; }).map(function (d) {
            return '<div class="legend-row"><span class="legend-swatch"><span style="display:inline-block;width:10px;height:10px;border-radius:50%;background:' + colorForDistance(d) + ';"></span></span>distance ' + d + ': ' + byDist[d] + ' character' + (byDist[d] === 1 ? "" : "s") + '</div>';
          }).join("");

          statsEl.innerHTML =
            '<h4 class="inspector-name">' + names[sourceId] + '</h4>' +
            '<span class="inspector-group">' + (mode === "undirected" ? "Undirected" : "Directed, following arrows out") + '</span>' +
            '<div class="inspector-stats">' +
            '<div class="inspector-stat"><span class="stat-label">Reachable</span><span class="stat-value">' + reachable + ' / 276</span></div>' +
            '<div class="inspector-stat"><span class="stat-label">Avg. distance</span><span class="stat-value">' + fmtFloat(avg, 2) + '</span></div>' +
            '<div class="inspector-stat"><span class="stat-label">Eccentricity</span><span class="stat-value">' + maxDist + '</span></div>' +
            '</div>' +
            '<div class="inspector-section"><h5>Distance distribution</h5>' + distRows + '</div>';
        }

        function renderPathPanel(bfsResult) {
          if (!targetId) {
            pathPanelEl.innerHTML = "Choose a target character to find the shortest path.";
            return;
          }
          if (sourceId === targetId) {
            pathPanelEl.innerHTML = "Source and target are the same character.";
            return;
          }
          var path = reconstructPath(bfsResult.prev, sourceId, targetId);
          if (!path) {
            var modeLabel = mode === "undirected" ? "undirected path" : "directed path";
            pathPanelEl.innerHTML =
              '<strong>No path.</strong> There is no ' + modeLabel + ' from ' + names[sourceId] +
              ' to ' + names[targetId] + (mode === "directed"
                ? " -- following Wikipedia's links exactly as written, there's no chain of outgoing links that gets from one article to the other."
                : " in the giant component (this should not happen for two giant-component characters in undirected mode -- please report it as a bug if you see it).");
            return null;
          }
          var chain = path.map(function (id) { return names[id]; }).join(" &rarr; ");
          pathPanelEl.innerHTML =
            '<strong>Shortest path, length ' + (path.length - 1) + ':</strong> ' + chain;
          return path;
        }

        function animatePath(path) {
          var myToken = ++animationToken;
          if (!path || path.length < 2) return;

          // dim everything first so the path pops
          view.resetNodes({ opacity: 0.15 });
          view.resetEdges({ opacity: 0.05 });

          var reveal = REDUCED_MOTION ? 0 : 260;
          path.forEach(function (id, i) {
            setTimeout(function () {
              if (animationToken !== myToken) return;
              var isEnd = i === 0 || i === path.length - 1;
              view.setNodeStyle(id, {
                r: isEnd ? 9 : 6.5,
                fill: isEnd ? COLOR_ACCENT : COLOR_ACCENT_3,
                stroke: "#fff", strokeWidth: 2, opacity: 1,
              });
              if (i > 0) {
                var prevId = path[i - 1];
                var idx = view.edgeIndexFor(prevId, id);
                if (idx >= 0) view.setEdgeStyleByIndex(idx, { stroke: COLOR_ACCENT, strokeWidth: 2.6, opacity: 1 });
              }
            }, i * reveal);
          });
        }

        function render() {
          if (!sourceId) {
            statsEl.innerHTML = '<p class="inspector-empty">Choose a source character above.</p>';
            legendEl.innerHTML = "";
            pathPanelEl.innerHTML = "";
            view.resetNodes({ r: 2.2, fill: COLOR_DIM, opacity: 1 });
            view.resetEdges({ stroke: COLOR_EDGE, strokeWidth: 0.5, opacity: 0.25 });
            return;
          }
          var bfsResult = bfs(sourceId, neighborsForMode);
          var distsPresent = Object.keys(bfsResult.dist).map(function (id) { return bfsResult.dist[id]; });
          var maxDist = distsPresent.length ? Math.max.apply(null, distsPresent) : 0;
          var hasUnreachable = (mode === "directed") && (Object.keys(bfsResult.dist).length < giantIds.length);

          view.resetEdges({ stroke: COLOR_EDGE, strokeWidth: 0.5, opacity: 0.2 });
          giantIds.forEach(function (id) {
            var d = bfsResult.dist[id];
            if (d == null) {
              view.setNodeStyle(id, { r: 2.2, fill: COLOR_DIM, stroke: "none", strokeWidth: 0, opacity: 0.6 });
            } else {
              view.setNodeStyle(id, { r: radiusForDistance(d), fill: colorForDistance(d), stroke: "none", strokeWidth: 0, opacity: 0.95 });
            }
          });

          renderLegend(maxDist, hasUnreachable);
          renderStats(bfsResult, maxDist);
          var path = renderPathPanel(bfsResult);
          if (path) animatePath(path);
          else animationToken++; // cancel any in-flight animation, nothing more to reveal
        }

        function commitSource(id) { sourceId = id; render(); }
        function commitTarget(id) { targetId = id; render(); }

        function tryCommitFromInput(inputEl, commitFn) {
          var value = inputEl.value.trim().toLowerCase();
          if (!value) return;
          var id = idByName[value];
          if (id) commitFn(id);
        }

        sourceInput.addEventListener("input", function () { tryCommitFromInput(sourceInput, commitSource); });
        sourceInput.addEventListener("change", function () { tryCommitFromInput(sourceInput, commitSource); });
        targetInput.addEventListener("input", function () { tryCommitFromInput(targetInput, commitTarget); });
        targetInput.addEventListener("change", function () { tryCommitFromInput(targetInput, commitTarget); });

        if (swapBtn) {
          swapBtn.addEventListener("click", function () {
            var srcName = sourceInput.value, tgtName = targetInput.value;
            sourceInput.value = tgtName; targetInput.value = srcName;
            var newSource = targetId, newTarget = sourceId;
            sourceId = newSource; targetId = newTarget;
            render();
          });
        }

        function setMode(newMode) {
          mode = newMode;
          modeUndirectedBtn.classList.toggle("is-active", mode === "undirected");
          modeUndirectedBtn.setAttribute("aria-pressed", String(mode === "undirected"));
          modeDirectedBtn.classList.toggle("is-active", mode === "directed");
          modeDirectedBtn.setAttribute("aria-pressed", String(mode === "directed"));
          modeDefEl.textContent = mode === "undirected"
            ? "Treat connections as mutual when finding paths."
            : "Follow links only in their original direction.";
          render();
        }
        modeUndirectedBtn.addEventListener("click", function () { setMode("undirected"); });
        modeDirectedBtn.addEventListener("click", function () { setMode("directed"); });

        // sensible starting example -- not a hard-coded narrative, just a
        // prefilled pair the visitor is free to change immediately.
        var defaultSourceId = idByName["wolverine (character)"] || sortedGiant[0];
        var defaultTargetId = idByName["spider-man"] || sortedGiant[1];
        sourceInput.value = names[defaultSourceId];
        targetInput.value = names[defaultTargetId];
        sourceId = defaultSourceId;
        targetId = defaultTargetId;
        render();
      }

      // ======================================================================
      // Section: Fragmentation
      // ======================================================================
      function initFragmentation() {
        var networkContainer = document.getElementById("frag-network");
        var chartContainer = document.getElementById("frag-chart");
        var readoutEl = document.getElementById("frag-readout");
        var scrubber = document.getElementById("frag-scrubber");
        var scrubberValue = document.getElementById("frag-scrubber-value");
        var playBtn = document.getElementById("frag-play-btn");
        var stepBtn = document.getElementById("frag-step-btn");
        var resetBtn = document.getElementById("frag-reset-btn");
        var summaryCallout = document.getElementById("frag-summary-callout");
        var buttons = {
          degree_desc: document.getElementById("frag-btn-degree"),
          betweenness_desc: document.getElementById("frag-btn-betweenness"),
          random: document.getElementById("frag-btn-random"),
        };
        if (!networkContainer || !chartContainer || !scrubber) return;

        var frag = summary.fragmentation;
        var giantTotal = frag.giant_component_total;
        var strategyColors = { degree_desc: COLOR_ACCENT, betweenness_desc: COLOR_ACCENT_2, random: COLOR_ACCENT_3 };
        var strategyLabels = { degree_desc: "Highest degree first", betweenness_desc: "Highest betweenness first", random: "Random" };

        var currentStrategy = "degree_desc";
        var currentK = 0;
        var playing = false;
        var playTimer = null;

        var view = createNetworkView(networkContainer, giantIds, layout, giantEdges, { titleFor: titleFor });

        function removedSet(strategyKey, k) {
          var order = frag.strategies[strategyKey].order_ids;
          var s = {};
          for (var i = 0; i < k; i++) s[order[i]] = true;
          return s;
        }

        function renderNetwork() {
          var order = frag.strategies[currentStrategy].order_ids;
          var removed = removedSet(currentStrategy, currentK);
          var justRemoved = currentK > 0 ? order[currentK - 1] : null;

          view.resetEdges({ stroke: COLOR_EDGE, strokeWidth: 0.5, opacity: 0.22 });
          giantIds.forEach(function (id) {
            if (id === justRemoved) {
              view.setNodeStyle(id, { r: 6, fill: COLOR_ACCENT_3, stroke: "#fff", strokeWidth: 1.5, opacity: 1 });
            } else if (removed[id]) {
              view.setNodeStyle(id, { r: 1.6, fill: "rgba(154,157,170,0.12)", stroke: "none", strokeWidth: 0, opacity: 1 });
            } else {
              view.setNodeStyle(id, { r: 3.4, fill: COLOR_ACCENT_2, stroke: "none", strokeWidth: 0, opacity: 0.9 });
            }
          });
        }

        function renderChart() {
          var series = Object.keys(frag.strategies).map(function (key) {
            var curve = frag.strategies[key].giant_size_after_k;
            return {
              color: strategyColors[key],
              width: key === currentStrategy ? 2.6 : 1.4,
              opacity: key === currentStrategy ? 1 : 0.45,
              points: curve.map(function (size, k) { return [k, size]; }),
            };
          });
          drawLineChart(chartContainer, series, { xmax: giantTotal, ymax: giantTotal, markerX: currentK });
        }

        function renderReadout() {
          var order = frag.strategies[currentStrategy].order_ids;
          var names_ = frag.strategies[currentStrategy].order_names;
          var giantNow = frag.strategies[currentStrategy].giant_size_after_k[currentK];
          var justRemovedName = currentK > 0 ? names_[currentK - 1] : "—";

          readoutEl.innerHTML = "";
          function stat(label, value) {
            var li = document.createElement("li");
            li.className = "stat-card";
            li.innerHTML = '<span class="stat-label">' + label + '</span><span class="stat-value">' + value + "</span>";
            readoutEl.appendChild(li);
          }
          stat("Removed so far", currentK + " of " + giantTotal);
          stat("Currently removing", justRemovedName);
          stat("Giant component", giantNow + " (" + fmtPercent(giantNow / giantTotal) + ")");

          scrubber.value = currentK;
          scrubberValue.textContent = currentK;
        }

        function render() {
          renderNetwork();
          renderChart();
          renderReadout();
        }

        function stopPlaying() {
          playing = false;
          playBtn.textContent = "Play";
          if (playTimer) { clearTimeout(playTimer); playTimer = null; }
        }

        function stepOnce() {
          if (currentK >= giantTotal) { stopPlaying(); return; }
          currentK++;
          render();
          if (currentK >= giantTotal) stopPlaying();
        }

        function playTick() {
          if (!playing) return;
          stepOnce();
          if (currentK < giantTotal) {
            playTimer = setTimeout(playTick, REDUCED_MOTION ? 0 : 90);
          } else {
            stopPlaying();
          }
        }

        playBtn.addEventListener("click", function () {
          if (playing) { stopPlaying(); return; }
          playing = true;
          playBtn.textContent = "Pause";
          playTick();
        });
        stepBtn.addEventListener("click", function () { stopPlaying(); stepOnce(); });
        resetBtn.addEventListener("click", function () { stopPlaying(); currentK = 0; render(); });
        scrubber.addEventListener("input", function () {
          stopPlaying();
          currentK = parseInt(scrubber.value, 10);
          render();
        });

        Object.keys(buttons).forEach(function (key) {
          if (!buttons[key]) return;
          buttons[key].addEventListener("click", function () {
            stopPlaying();
            currentStrategy = key;
            Object.keys(buttons).forEach(function (k2) {
              buttons[k2].classList.toggle("is-active", k2 === key);
              buttons[k2].setAttribute("aria-pressed", String(k2 === key));
            });
            render();
          });
        });

        var mf = frag.max_fragmenter;
        summaryCallout.innerHTML =
          '<strong>The single biggest structural point of failure:</strong> removing ' +
          '<strong>' + mf.name + '</strong> alone shrinks the giant component from ' + giantTotal +
          ' to ' + mf.giant_size_after_removal + ' (splitting off ' + mf.delta + ' extra character' + (mf.delta === 1 ? "" : "s") + ', ' +
          (mf.components_after) + ' pieces total) &mdash; the largest single-node drop in the network. ' +
          'That matches ' + (frag.matches_top_degree ? "both the top-degree and top-betweenness character" : (frag.matches_top_betweenness ? "the top-betweenness character" : "neither the top-degree nor the top-betweenness character")) +
          ' here. But keep the scale honest: that is a ' + fmtPercent(mf.delta / giantTotal) + ' shrink, and the giant component has only ' +
          frag.articulation_point_count + ' articulation points among its ' + giantTotal + ' characters &mdash; ' +
          'high centrality correlates with fragmentation impact on this network, but the network is not fragile.';

        render();
      }

      // ======================================================================
      // Section: Clique explorer
      // ======================================================================
      function initCliques() {
        var toggleEl = document.getElementById("clique-size-toggle");
        var networkContainer = document.getElementById("clique-network");
        var listEl = document.getElementById("clique-list");
        var inspectorEl = document.getElementById("clique-inspector");
        var countReadoutEl = document.getElementById("clique-count-readout");
        if (!toggleEl || !networkContainer || !listEl) return;

        var sizes = [8, 7, 6, 5, 4];
        var currentSize = 8;
        var activeCliqueId = null;

        var view = createNetworkView(networkContainer, giantIds, layout, giantEdges, { titleFor: titleFor });

        toggleEl.innerHTML = "";
        var buttons = {};
        sizes.forEach(function (size) {
          var count = summary.cliques.by_size[String(size)].count;
          var btn = document.createElement("button");
          btn.type = "button";
          btn.className = "arrow-toggle-btn" + (size === currentSize ? " is-active" : "");
          btn.setAttribute("aria-pressed", String(size === currentSize));
          btn.textContent = size + "-cliques (" + count + ")";
          btn.addEventListener("click", function () { selectSize(size); });
          toggleEl.appendChild(btn);
          buttons[size] = btn;
        });

        function cliquesForSize(size) { return summary.cliques.by_size[String(size)].cliques; }

        function renderList() {
          listEl.innerHTML = "";
          cliquesForSize(currentSize).forEach(function (clique, i) {
            var li = document.createElement("li");
            li.style.cursor = "pointer";
            if (clique.id === activeCliqueId) li.style.borderColor = COLOR_ACCENT;
            var preview = clique.members.slice(0, 2).join(", ") + (clique.members.length > 2 ? "…" : "");
            li.innerHTML =
              '<span class="rank">' + (i + 1) + '</span>' +
              '<span class="name">' + preview + '</span>' +
              '<span class="metric">' + clique.members.length + ' members</span>';
            li.addEventListener("mouseenter", function () { setActive(clique.id); });
            li.addEventListener("click", function () { setActive(clique.id); });
            listEl.appendChild(li);
          });
        }

        function renderNetwork() {
          var cliques = cliquesForSize(currentSize);
          var baseMemberIds = {};
          var baseEdgeIdx = {};
          cliques.forEach(function (c) {
            c.member_ids.forEach(function (id) { baseMemberIds[id] = true; });
            for (var i = 0; i < c.member_ids.length; i++) {
              for (var j = i + 1; j < c.member_ids.length; j++) {
                var idx = view.edgeIndexFor(c.member_ids[i], c.member_ids[j]);
                if (idx >= 0) baseEdgeIdx[idx] = true;
              }
            }
          });

          view.resetEdges({ stroke: COLOR_EDGE, strokeWidth: 0.5, opacity: 0.12 });
          giantIds.forEach(function (id) {
            view.setNodeStyle(id, { r: 2, fill: COLOR_DIM, stroke: "none", strokeWidth: 0, opacity: 0.5 });
          });
          Object.keys(baseMemberIds).forEach(function (id) {
            view.setNodeStyle(id, { r: 5, fill: COLOR_ACCENT_2, stroke: "none", strokeWidth: 0, opacity: 0.9 });
          });
          Object.keys(baseEdgeIdx).forEach(function (idx) {
            view.setEdgeStyleByIndex(Number(idx), { stroke: COLOR_ACCENT_2, strokeWidth: 1.6, opacity: 0.55 });
          });

          var active = cliques.find(function (c) { return c.id === activeCliqueId; });
          if (active) {
            active.member_ids.forEach(function (id) {
              view.setNodeStyle(id, { r: 7.5, fill: COLOR_ACCENT, stroke: "#fff", strokeWidth: 2, opacity: 1 });
            });
            for (var i = 0; i < active.member_ids.length; i++) {
              for (var j = i + 1; j < active.member_ids.length; j++) {
                var idx2 = view.edgeIndexFor(active.member_ids[i], active.member_ids[j]);
                if (idx2 >= 0) view.setEdgeStyleByIndex(idx2, { stroke: COLOR_ACCENT, strokeWidth: 2.6, opacity: 1 });
              }
            }
          }
        }

        function renderInspector() {
          var cliques = cliquesForSize(currentSize);
          var active = cliques.find(function (c) { return c.id === activeCliqueId; });
          if (!active) {
            inspectorEl.innerHTML = '<p class="inspector-empty">Hover or click a clique to see its members.</p>';
            return;
          }
          var k = active.members.length;
          var internalEdges = k * (k - 1) / 2;
          var idx = cliques.indexOf(active) + 1;
          var pills = active.members.map(function (n) { return '<span class="neighbor-pill">' + n + '</span>'; }).join("");
          inspectorEl.innerHTML =
            '<h4 class="inspector-name">Clique #' + idx + '</h4>' +
            '<div class="inspector-stats">' +
            '<div class="inspector-stat"><span class="stat-label">Members</span><span class="stat-value">' + k + '</span></div>' +
            '<div class="inspector-stat"><span class="stat-label">Internal edges</span><span class="stat-value">' + internalEdges + '</span></div>' +
            '</div>' +
            '<p style="color:var(--text-dim);font-size:13.5px;margin:0 0 12px;">All ' + k + '&times;(' + k + '&minus;1)/2 = ' + internalEdges + ' possible pairs among these ' + k + ' characters are directly connected &mdash; that completeness is what makes this a clique, not just a densely-connected group.</p>' +
            '<div class="inspector-section"><h5>Members</h5>' + pills + '</div>';
        }

        function renderCountReadout() {
          var info = summary.cliques.by_size[String(currentSize)];
          countReadoutEl.textContent =
            info.count + " maximal " + currentSize + "-clique" + (info.count === 1 ? "" : "s") + " found, each with all " +
            info.internal_edges + " possible internal links present.";
        }

        function setActive(cliqueId) {
          activeCliqueId = cliqueId;
          renderList();
          renderNetwork();
          renderInspector();
        }

        function selectSize(size) {
          currentSize = size;
          Object.keys(buttons).forEach(function (s) {
            buttons[s].classList.toggle("is-active", Number(s) === size);
            buttons[s].setAttribute("aria-pressed", String(Number(s) === size));
          });
          var first = cliquesForSize(currentSize)[0];
          activeCliqueId = first ? first.id : null;
          renderCountReadout();
          renderList();
          renderNetwork();
          renderInspector();
        }

        selectSize(currentSize);
      }
    })
    .catch(function (err) {
      var containers = [
        "centrality-network", "sixdeg-network", "frag-network", "clique-network",
      ];
      containers.forEach(function (id) {
        var c = document.getElementById(id);
        if (c) {
          c.textContent =
            "Week 3 data could not load (this page needs to be served over http://, e.g. via " +
            "'python -m http.server' locally -- it will not load if index.html is opened directly " +
            "as a file). " + err;
        }
      });
      // eslint-disable-next-line no-console
      console.error("week3.js failed to initialize:", err);
    });
})();
