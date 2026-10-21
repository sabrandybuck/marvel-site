/*
 * Week 7 test — "links vs. meaning".
 *
 * Two independent vis-network explorables over the same 370 Marvel
 * supervillains:
 *
 *   Explorer 1 — the Wikipedia link network (directed edges from the
 *   crawl TSVs), node size = in-degree, colors = Louvain communities of
 *   the link graph (toggle: weakly connected components instead).
 *
 *   Explorer 2 — the MiniLM skeleton: the same nodes, but an edge means
 *   "one of the k nearest pages by cosine similarity in the frozen
 *   384-dimensional embedding space". Neighbourhoods were computed in the
 *   ORIGINAL space (analysis/build_week7_test.py); the sliders only prune
 *   the frozen lists. Edges are classified like week-6-2:
 *   green = pair also linked on Wikipedia either way,
 *   red   = meaning-only.
 *
 * Node colors are the same Louvain communities in both cards so you can
 * watch the link-network's grouping fall out of the meaning representation.
 *
 * Data: ../data/week7/week7_supervillains.json — a pure reader page.
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

  var COLORS = {
    meaningOnly: "#e6353a",
    linked: "#0ca678",
    dimNode: "#c9ccd2",
  };

  var state = {
    semK: 5,
    semMinCos: 0,
    showMeaningOnly: true,
    showLinked: true,
    linkSelected: null,
    semSelected: null,
  };

  var S = null;            // frozen payload
  var ids = [];
  var nameOf = null;
  var commColors = {};     // node id -> TAB20 color (Louvain community)
  var commLabel = {};      // community id -> "C1 · Hulk"
  var linkedPairSet = {};  // "a|b" -> true (undirected, sorted join)

  var sortByName = function (a, b) {
    return (nameOf(a) || a).localeCompare(nameOf(b) || b);
  };
  var sortByName = function (a, b) {
    return (nameOf(a) || a).localeCompare(nameOf(b) || b);
  };

  function commColor(c) { return TAB20[c % 20]; }

  function commTag(nid) {
    var c = S.nodes[nid].community;
    return '<span class="neighbor-pill" style="color:#e9eaee;border-color:' + commColor(c) + '">' +
      '<span style="display:inline-block;width:8px;height:8px;border-radius:50%;background:' +
      commColor(c) + ';margin-right:5px;"></span>' + esc(commLabel[c] || ("C" + c)) + "</span>";
  }

  function vitals(nid) {
    var p = S.nodes[nid];
    return " — " + p.in_degree + " in / " + p.out_degree + " out · " + p.words + " words";
  }

  function neighborListHtml(entries) {
    if (!entries.length) return '<p class="neighbor-more">None.</p>';
    var CAP = 12;
    var shown = entries.slice(0, CAP).map(function (e) {
      return '<span class="neighbor-pill">' + esc(e) + "</span>";
    }).join("");
    var extra = entries.length > CAP
      ? '<span class="neighbor-more">+' + (entries.length - CAP) + " more</span>" : "";
    return shown + extra;
  }

  function setSearchStatus(id, msg) {
    var el = document.getElementById(id);
    if (el) el.textContent = msg || "";
  }

  function pairKey(a, b) { return a < b ? a + "|" + b : b + "|" + a; }

  function fetchJson(url) {
    return fetch(url).then(function (r) {
      if (!r.ok) throw new Error("HTTP " + r.status + " fetching " + url);
      return r.json();
    });
  }

  // ============================================================ explorer 1
  // the link network

  var linkNetwork = null;
  var linkNodesData = null;
  var linkEdgesData = null;
  var linkEdgeRows = [];
  var linkMode = "comm";          // "comm" | "comp"

  var showLinkIsolates = true;
  var linkIsolateSet = {};
  var linkInDeg = {}, linkOutDeg = {};
  var linkComponentColor = {};
  var nLinkIsolates = 0;

  function linkNodeStyle(id, opts) {
    opts = opts || {};
    var dim = !!opts.dim;
    var selected = !!opts.selected;
    var col = linkMode === "comm" ? commColors[id] : linkComponentColor[id];
    return {
      id: id,
      hidden: (linkIsolateSet[id] && !showLinkIsolates),
      label: (selected || S.nodes[id].in_degree >= 25) ? (nameOf(id) || id) : "",
      color: {
        background: dim ? "rgba(180,182,190,0.12)" : col,
        border: selected ? "#ffffff" : "#555b66",
      },
      borderWidth: selected ? 4 : 1.5,
    };
  }

  function linkEdgeStyle(e, i, opts) {
    opts = opts || {};
    var sel = state.linkSelected;
    var hidden = (linkIsolateSet[e.from] && !showLinkIsolates) ||
      (linkIsolateSet[e.to] && !showLinkIsolates) ||
      (!!sel && e.from !== sel && e.to !== sel);
    return {
      id: i, from: e.from, to: e.to, hidden: hidden,
      color: { color: "#495057", opacity: opts.highlighted ? 0.9 : 0.35 },
      width: opts.highlighted ? 1.6 : 0.5,
    };
  }

  function bootLink() {
    var container = document.getElementById("wk7t-link-network");
    var inspectorEl = document.getElementById("wk7t-link-inspector");

    linkInDeg = {}; linkOutDeg = {};

    var inList = {}, outList = {};
    ids.forEach(function (id) { inList[id] = []; outList[id] = []; linkInDeg[id] = 0; linkOutDeg[id] = 0; });
    S.edges.forEach(function (e) {
      inList[e[1]].push(e[0]);
      outList[e[0]].push(e[1]);
      linkInDeg[e[1]]++;
      linkOutDeg[e[0]]++;
    });

    linkEdgeRows = S.edges.map(function (e) { return { from: e[0], to: e[1] }; });

    // isolates + component-mode colors
    linkIsolateSet = {};
    nLinkIsolates = 0;
    ids.forEach(function (id) {
      if (!inList[id].length && !outList[id].length) {
        linkIsolateSet[id] = true;
        nLinkIsolates++;
      }
    });

    var compSizes = {};
    ids.forEach(function (id) {
      var c = S.nodes[id].component;
      compSizes[c] = (compSizes[c] || 0) + 1;
    });
    ids.forEach(function (id) {
      var c = S.nodes[id].component;
      // giant = blue, multi-node islands = amber, singletons = gray
      linkComponentColor[id] = compSizes[c] === 1 ? "#9a9daa" : (c === 0 ? "#4d7cff" : "#e0a020");
    });

    linkNodesData = new vis.DataSet(ids.map(function (id) {
      var st = linkNodeStyle(id);
      st.value = S.nodes[id].in_degree;
      st.title = esc(nameOf(id)) + vitals(id);
      return st;
    }));
    linkEdgesData = new vis.DataSet(linkEdgeRows.map(function (e, i) {
      return linkEdgeStyle(e, i);
    }));

    linkNetwork = new vis.Network(container, { nodes: linkNodesData, edges: linkEdgesData }, {
      nodes: { shape: "dot", scaling: { min: 5, max: 30 }, font: { size: 11, color: "#141318" } },
      edges: { smooth: false, arrows: { to: { enabled: true, scaleFactor: 0.4 } } },
      physics: {
        barnesHut: { gravitationalConstant: -4800, springLength: 90, springConstant: 0.03 },
        stabilization: { iterations: 240, fit: true },
      },
      interaction: { hover: true, tooltipDelay: 100 },
    });

    var giant = ids.filter(function (id) { return S.nodes[id].component === 0; });
    function applyDefaultView(animated) {
      linkNetwork.fit({ nodes: giant, animation: animated ? { duration: 400 } : false });
    }
    linkNetwork.once("stabilizationIterationsDone", function () {
      linkNetwork.setOptions({ physics: false });
      applyDefaultView(false);
    });

    function renderInspector(id) {
      state.linkSelected = id;
      var connected = new Set([id].concat(inList[id], outList[id]));
      linkNodesData.update(ids.map(function (nid) {
        return linkNodeStyle(nid, { selected: nid === id, dim: !connected.has(nid) });
      }));
      linkEdgesData.update(linkEdgeRows.map(function (e, i) {
        return linkEdgeStyle(e, i, { highlighted: true });
      }));

      var p = S.nodes[id];
      inspectorEl.innerHTML =
        "<h4 class='inspector-name'>" + esc(nameOf(id)) + "</h4>" +
        "<div style='margin-bottom:10px'>" + commTag(id) + "</div>" +
        "<div class='inspector-stats'>" +
        "<div class='inspector-stat'><span class='stat-label'>In-degree</span><span class='stat-value'>" + p.in_degree + "</span></div>" +
        "<div class='inspector-stat'><span class='stat-label'>Out-degree</span><span class='stat-value'>" + p.out_degree + "</span></div>" +
        "</div>" +
        "<div class='inspector-lists'>" +
        "<div class='inspector-section'><h5>Linked from (" + inList[id].length + ")</h5>" +
        neighborListHtml(inList[id].slice().sort(sortByName)) + "</div>" +
        "<div class='inspector-section'><h5>Links to (" + outList[id].length + ")</h5>" +
        neighborListHtml(outList[id].slice().sort(sortByName)) + "</div>" +
        "</div>";
    }

    function clearInspector() {
      state.linkSelected = null;
      linkNodesData.update(ids.map(function (id) { return linkNodeStyle(id); }));
      linkEdgesData.update(linkEdgeRows.map(function (e, i) { return linkEdgeStyle(e, i); }));
      inspectorEl.innerHTML =
        "<p class='inspector-empty'>No villain selected yet — click a node or find one above.</p>";
    }

    function focusAndSelect(id) {
      renderInspector(id);
      linkNetwork.focus(id, { scale: 1.6, animation: { duration: 450, easingFunction: "easeInOutQuad" } });
    }

    linkNetwork.on("click", function (params) {
      if (params.nodes.length) focusAndSelect(params.nodes[0]);
      else clearInspector();
    });

    // ---- controls: search
    var input = document.getElementById("wk7t-link-search-input");
    var form = document.getElementById("wk7t-link-search-form");
    var dl = document.getElementById("wk7t-link-datalist");
    dl.innerHTML = ids.map(function (id) {
      return '<option value="' + esc(nameOf(id)) + '">';
    }).join("");

    function doSearch(q, statusId) {
      q = (q || "").trim().toLowerCase();
      if (!q) return "";
      var hit = ids.find(function (id) { return (nameOf(id) || "").toLowerCase() === q; })
        || ids.find(function (id) { return (nameOf(id) || "").toLowerCase().indexOf(q) === 0; });
      if (!hit) return "No villain found with that name — try one of the suggestions.";
      focusAndSelect(hit);
      return "";
    }

    form.addEventListener("submit", function (e) {
      e.preventDefault();
      setSearchStatus("wk7t-link-search-status", doSearch(input.value, "wk7t-link-search-status"));
    });
    input.addEventListener("input", function () {
      var q = input.value.trim().toLowerCase();
      if (!q) return;
      var exact = ids.find(function (id) { return (nameOf(id) || "").toLowerCase() === q; });
      if (exact) { setSearchStatus("wk7t-link-search-status", ""); focusAndSelect(exact); }
    });
    document.getElementById("wk7t-link-clear-btn").addEventListener("click", function () {
      input.value = "";
      setSearchStatus("wk7t-link-search-status", "");
      clearInspector();
      applyDefaultView(true);
    });

    // ---- controls: layers
    document.getElementById("wk7t-isolate-btn").addEventListener("click", function () {
      showLinkIsolates = !showLinkIsolates;
      this.setAttribute("aria-pressed", String(showLinkIsolates));
      this.textContent = showLinkIsolates ? "Show isolates" : "Hide isolates";
      if (state.linkSelected && linkIsolateSet[state.linkSelected] && !showLinkIsolates) {
        state.linkSelected = null;
        inspectorEl.innerHTML =
          "<p class='inspector-empty'>No villain selected yet — click a node or find one above.</p>";
      }
      linkNodesData.update(ids.map(function (id) {
        return linkNodeStyle(id, { selected: id === state.linkSelected, dim: false });
      }));
      linkEdgesData.update(linkEdgeRows.map(function (e, i) {
        return linkEdgeStyle(e, i, { highlighted: !!state.linkSelected });
      }));
    });

    document.getElementById("wk7t-color-btn").addEventListener("click", function () {
      linkMode = linkMode === "comm" ? "comp" : "comm";
      this.textContent = linkMode === "comm" ? "Color by component" : "Color by community";
      linkNodesData.update(ids.map(function (id) {
        return linkNodeStyle(id, { selected: id === state.linkSelected, dim: false });
      }));
    });

    setText("wk7t-link-note",
      S.meta.n_directed_edges + " directed links among " + ids.length +
      " characters; " + nLinkIsolates + " villains have no link in either direction.");
  }

  // ============================================================ explorer 2
  // the MiniLM skeleton

  var semNetwork = null;
  var semNodesData = null;
  var semEdgesData = null;
  var semInspectorEl = null;

  function semNodeStyle(id, dim) {
    var p = S.nodes[id];
    return {
      id: id,
      label: p.in_degree >= 25 ? nameOf(id) : "",
      value: p.in_degree,
      color: {
        background: dim ? COLORS.dimNode : commColors[id],
        border: dim ? "rgba(85,91,102,0.4)" : "#555b66",
        highlight: { background: "#fff", border: COLORS.meaningOnly },
      },
      font: { color: "#33373e", size: 11 },
      title: esc(nameOf(id)) + vitals(id),
    };
  }

  // Rebuild the semantic graph from the frozen neighbour lists under the
  // current k / minCos / class toggles. Runs on every slider move: pure
  // pruning of frozen data, no recomputation.
  function rebuildSemantic() {
    var k = state.semK;
    var minCos = state.semMinCos;

    // one row per unordered pair, keeping the max cosine of the two directions
    var best = {};
    ids.forEach(function (nid) {
      S.neighbors[nid].slice(0, k).forEach(function (it) {
        if (it.c < minCos) return;
        var pk = pairKey(nid, it.o);
        if (!best[pk]) best[pk] = { from: nid, to: it.o, c: it.c };
        else if (it.c > best[pk].c) best[pk] = { from: nid, to: it.o, c: it.c };
      });
    });

    var counts = { meaningOnly: 0, linked: 0 };
    var keep = new Set();
    var visibleEdges = [];
    Object.keys(best).forEach(function (pk) {
      var e = best[pk];
      e.cls = linkedPairSet[pk] ? "linked" : "meaningOnly";
      var visible = (e.cls === "linked" && state.showLinked) ||
                    (e.cls === "meaningOnly" && state.showMeaningOnly);
      if (visible) {
        counts[e.cls]++;
        keep.add(e.from); keep.add(e.to);
        visibleEdges.push({
          id: pk, from: e.from, to: e.to, hidden: false,
          cls: e.cls, c: e.c,
          color: {
            color: e.cls === "linked" ? COLORS.linked : COLORS.meaningOnly,
            opacity: e.cls === "linked" ? 0.85 : 0.7,
          },
          width: e.cls === "linked" ? 1.5 : 2.2,
        });
      }
    });

    if (!semNodesData) {
      semNodesData = new vis.DataSet(ids.map(function (id) { return semNodeStyle(id, false); }));
      semEdgesData = new vis.DataSet(visibleEdges);
      semNetwork = new vis.Network(document.getElementById("wk7t-sem-network"),
        { nodes: semNodesData, edges: semEdgesData }, {
        nodes: { shape: "dot", scaling: { min: 5, max: 30 }, font: { size: 11 } },
        edges: { smooth: false, selectionWidth: 1.5 },
        physics: {
          barnesHut: { gravitationalConstant: -4800, springLength: 90, springConstant: 0.03 },
          stabilization: { iterations: 240, fit: true },
        },
        interaction: { hover: true, tooltipDelay: 120 },
      });
      semNetwork.once("stabilizationIterationsDone", function () {
        semNetwork.setOptions({ physics: false });
        semNetwork.fit({ animation: false });
      });
      semNetwork.on("click", function (params) {
        if (params.nodes.length) openSemInspector(params.nodes[0]);
        else if (params.edges.length) {
          var eo = semEdgesData.get(params.edges[0]);
          if (eo) openPairInspector(eo.from, eo.to);
        } else closeSemInspector();
      });
    } else {
      // keep node positions stable: never hide nodes, only dim the ones
      // with no visible edge
      semNodesData.update(ids.map(function (id) { return semNodeStyle(id, !keep.has(id)); }));
      semEdgesData.update(visibleEdges);
    }

    setText("wk7t-c-meaningonly", counts.meaningOnly);
    setText("wk7t-c-linked", counts.linked);
    setNote();
  }

  function setNote() {
    setText("wk7t-sem-note",
      "the same " + ids.length + " characters, each wired to its " + state.semK +
      " nearest neighbours in the frozen 384-dimensional embedding space" +
      " (cosine ≥ " + state.semMinCos.toFixed(2) + "; sliders prune the frozen" +
      " neighbour lists live).");
  }

  function openSemInspector(nid) {
    state.semSelected = nid;
    var p = S.nodes[nid];
    var neigh = S.neighbors[nid].slice(0, state.semK);
    var pills = neigh.map(function (it) {
      var linked = linkedPairSet[pairKey(nid, it.o)];
      var col = linked ? COLORS.linked : COLORS.meaningOnly;
      var mark = linked ? " ✓" : " ✗";
      return '<span class="neighbor-pill" style="border-color:' + col + ';color:inherit">' +
        esc(S.nodes[it.o].name) +
        ' <span style="font-family:var(--mono);font-size:10px;color:' + col + '">' +
        it.c.toFixed(2) + mark + "</span></span>";
    }).join("");

    semInspectorEl.innerHTML =
      "<h4 class='inspector-name'>" + esc(nameOf(nid)) + "</h4>" +
      "<div style='margin-bottom:10px'>" + commTag(nid) + "</div>" +
      "<div class='inspector-stats'>" +
      "<div class='inspector-stat'><span class='stat-label'>Wikipedia links (in+out)</span><span class='stat-value'>" + (p.in_degree + p.out_degree) + "</span></div>" +
      "<div class='inspector-stat'><span class='stat-label'>MiniLM neighbours (top-" + state.semK + ")</span><span class='stat-value'>" + neigh.length + "</span></div>" +
      "</div>" +
      "<div class='inspector-lists'>" +
      "<div class='inspector-section'><h5>Closest pages under MiniLM (✓ also linked on Wikipedia)</h5>" +
      "<div style='margin-bottom:8px'>" + (pills || "—") + "</div></div>" +
      "</div>";
  }

  function openPairInspector(a, b) {
    var cos = 0;
    S.neighbors[a].forEach(function (it) { if (it.o === b) cos = it.c; });
    if (!cos) S.neighbors[b].forEach(function (it) { if (it.o === a) cos = it.c; });
    var linked = linkedPairSet[pairKey(a, b)];
    semInspectorEl.innerHTML =
      "<h4 class='inspector-name'>" + esc(nameOf(a)) + " ↔ " + esc(nameOf(b)) + "</h4>" +
      "<div style='margin-bottom:10px'>" + commTag(a) + " " + commTag(b) + "</div>" +
      "<div class='inspector-stats'>" +
      "<div class='inspector-stat'><span class='stat-label'>Link</span><span class='stat-value' style='font-size:13px;color:" +
      (linked ? COLORS.linked : COLORS.meaningOnly) + "'>" +
      (linked ? "linked on Wikipedia" : "not linked on Wikipedia") + "</span></div>" +
      "<div class='inspector-stat'><span class='stat-label'>MiniLM cosine</span><span class='stat-value'>" +
      cos.toFixed(3) + "</span></div>" +
      "</div>" +
      "<p class='network-note'>Judge it: teammates and aliases, a shared costume or origin story," +
      " or just two pages about the same kind of trouble?</p>";
  }

  function closeSemInspector() {
    state.semSelected = null;
    semInspectorEl.innerHTML =
      "<p class='inspector-empty'>No villain selected yet — click a node or find one above.</p>";
  }

  function bootSemantic() {
    semInspectorEl = document.getElementById("wk7t-sem-inspector");

    // ---- controls
    var kSlider = document.getElementById("wk7t-sem-k");
    var cosSlider = document.getElementById("wk7t-sem-mincos");
    kSlider.value = state.semK;
    setText("wk7t-k-val", String(state.semK));
    kSlider.addEventListener("input", function () {
      state.semK = +this.value;
      setText("wk7t-k-val", String(state.semK));
      rebuildSemantic();
    });
    cosSlider.value = state.semMinCos;
    setText("wk7t-mincos-val", state.semMinCos.toFixed(2));
    cosSlider.addEventListener("input", function () {
      state.semMinCos = +this.value;
      setText("wk7t-mincos-val", state.semMinCos.toFixed(2));
      rebuildSemantic();
    });

    var input = document.getElementById("wk7t-sem-search-input");
    var dl = document.getElementById("wk7t-sem-datalist");
    dl.innerHTML = ids.map(function (id) {
      return '<option value="' + esc(nameOf(id)) + '">';
    }).join("");

    function selectAndZoom(nid) {
      state.semSelected = nid;
      semNetwork.selectNodes([nid]);
      semNetwork.focus(nid, { scale: 0.9, animation: true });
      openSemInspector(nid);
    }

    input.addEventListener("change", function () {
      var q = this.value.trim().toLowerCase();
      this.value = "";
      var hit = ids.find(function (id) {
        return (nameOf(id) || "").toLowerCase() === q;
      });
      if (hit) selectAndZoom(hit);
      else setSearchStatus("wk7t-sem-search-status",
        "No villain found with that name — try one of the suggestions.");
    });
    input.addEventListener("input", function () {
      var q = this.value.trim().toLowerCase();
      if (!q) { setSearchStatus("wk7t-sem-search-status", ""); return; }
      var exact = ids.find(function (id) { return (nameOf(id) || "").toLowerCase() === q; });
      if (exact) { setSearchStatus("wk7t-sem-search-status", ""); selectAndZoom(exact); }
    });

    document.getElementById("wk7t-sem-clear-btn").addEventListener("click", function () {
      input.value = "";
      setSearchStatus("wk7t-sem-search-status", "");
      closeSemInspector();
      state.semK = 5; state.semMinCos = 0;
      kSlider.value = 5; cosSlider.value = 0;
      setText("wk7t-k-val", "5");
      setText("wk7t-mincos-val", "0.00");
      rebuildSemantic();
    });

    rebuildSemantic();
  }

  function setText(id, v) {
    var el = document.getElementById(id);
    if (el) el.textContent = v;
  }

  // ---------------------------------------------------------------- boot

  function boot(payload) {
    S = payload;
    ids = Object.keys(S.nodes);
    nameOf = function (nid) { return S.nodes[nid].name; };

    // community labels: biggest in-degree member names each community
    var bestByComm = {};
    ids.forEach(function (nid) {
      var c = S.nodes[nid].community;
      if (!bestByComm[c] || S.nodes[nid].in_degree > S.nodes[bestByComm[c]].in_degree) {
        bestByComm[c] = nid;
      }
    });
    Object.keys(bestByComm).forEach(function (c) {
      commLabel[c] = "C" + c + " · " + S.nodes[bestByComm[c]].name;
    });
    ids.forEach(function (nid) {
      commColors[nid] = commColor(S.nodes[nid].community);
    });

    S.edges.forEach(function (e) {
      linkedPairSet[pairKey(e[0], e[1])] = true;
    });

    bootLink();
    bootSemantic();
  }

  fetchJson("../data/week7/week7_supervillains.json").then(boot)
    .catch(function (err) {
      var el = document.getElementById("wk7t-link-network");
      if (el) el.textContent =
        "Interactive network could not load (this view requires the page to be served over" +
        " http://, e.g. via 'python -m http.server' locally — it will not load if opened" +
        " directly as a file). " + err;
    });
})();
