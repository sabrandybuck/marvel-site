/*
 * Week 7 explorable — "Semantically close, structurally far".
 *
 * Two lenses over the same 370 Marvel supervillains:
 *   - SEMANTIC: all-MiniLM-L6-v2 document embeddings (cosine similarity)
 *   - STRUCTURAL: Wikipedia hyperlink network (shortest path length)
 *
 * The divergence pairs are where the lenses disagree: high cosine similarity
 * but long (or no) path in the link network. The scatter plot shows the PCA
 * projection of the embeddings; blue lines mark semantic neighbors, red lines
 * mark divergent pairs (drawn on top of blue).
 *
 * Divergent pairs are computed on-the-fly from DATA.pairs using the current
 * slider values — no pre-computed list. This keeps the sliders honest: what
 * you set is what you see.
 *
 * Controls: projection toggle (PCA/t-SNE), cosine threshold, path-length
 * threshold, max divergent pairs, layer toggles, search. Click a dot to
 * inspect a villain's neighborhoods. Click a red line to compare pages.
 */
(function () {
  "use strict";

  function esc(s) {
    return String(s).replace(/[&<>"']/g, function (c) {
      return { "&": "&amp;", "<": "&lt;", ">": "&gt;", '"': "&quot;", "'": "&#39;" }[c];
    });
  }

  // Community colors (TAB20, same as other weeks)
  var TAB20 = [
    "#1f77b4", "#aec7e8", "#ff7f0e", "#ffbb78", "#2ca02c", "#98df8a",
    "#d62728", "#ff9896", "#9467bd", "#c5b0d5", "#8c564b", "#c49c94",
    "#e377c2", "#f7b6d2", "#7f7f7f", "#c7c7c7", "#bcbd22", "#dbdb8d",
    "#17becf", "#9edae5"
  ];
  function commColor(ci) {
    return ci < 10 ? TAB20[ci * 2] : TAB20[((ci - 10) * 2 + 1) % 20];
  }

  var DATA = null;
  var ids = [];
  var nameOf = {};
  var state = {
    projection: "pca",       // "pca" | "tsne"
    minCos: 0.5,             // minimum cosine to show semantic links
    minPath: 3,              // minimum path length to be "divergent"
    maxDivergent: 50,        // max number of divergent (red) lines to draw
    selected: null,          // selected node id
    selectedPair: null,      // selected pair "a|b"
    showSemantic: true,      // blue lines
    showDivergent: true,     // red lines
    showLinks: false,        // faint gray hyperlinks
    search: "",
  };

  // DOM elements
  var els = {};

  function fetchJson(url) {
    return fetch(url).then(function (r) {
      if (!r.ok) throw new Error("HTTP " + r.status + " fetching " + url);
      return r.json();
    });
  }

  function fetchText(url) {
    return fetch(url).then(function (r) {
      if (!r.ok) throw new Error("HTTP " + r.status + " fetching " + url);
      return r.text();
    });
  }

  function pairKey(a, b) {
    return a < b ? a + "|" + b : b + "|" + a;
  }

  function getPair(a, b) {
    return DATA.pairs[pairKey(a, b)] || null;
  }

  // Compute divergent pairs on-the-fly from DATA.pairs using current sliders.
  // Returns top N sorted by divergence score (highest first).
  function computeDivergentPairs() {
    var divergent = [];
    Object.keys(DATA.pairs).forEach(function (key) {
      var p = DATA.pairs[key];
      // Skip directly-linked pairs
      if (p.linked) return;
      // Must be semantically close
      if (p.cos < state.minCos) return;
      // Must be structurally far (path >= minPath, or disconnected)
      if (p.path >= 0 && p.path < state.minPath) return;
      divergent.push(p);
    });
    // Sort by divergence score, descending
    divergent.sort(function (a, b) { return b.divergence - a.divergence; });
    // Limit to maxDivergent
    return divergent.slice(0, state.maxDivergent);
  }

  // ---------- initialization ----------

  function init() {
    els.svg = document.getElementById("w7-scatter");
    els.search = document.getElementById("w7-search");
    els.searchList = document.getElementById("w7-search-list");
    els.projPca = document.getElementById("w7-proj-pca");
    els.projTsne = document.getElementById("w7-proj-tsne");
    els.cosSlider = document.getElementById("w7-cos-slider");
    els.cosValue = document.getElementById("w7-cos-value");
    els.pathSlider = document.getElementById("w7-path-slider");
    els.pathValue = document.getElementById("w7-path-value");
    els.maxDivSlider = document.getElementById("w7-maxdiv-slider");
    els.maxDivValue = document.getElementById("w7-maxdiv-value");
    els.toggleSemantic = document.getElementById("w7-toggle-semantic");
    els.toggleDivergent = document.getElementById("w7-toggle-divergent");
    els.toggleLinks = document.getElementById("w7-toggle-links");
    els.detail = document.getElementById("w7-detail");
    els.pairView = document.getElementById("w7-pair-view");
    els.legend = document.getElementById("w7-legend");
    els.stats = document.getElementById("w7-stats");

    fetchJson("../data/week7/week7_supervillains.json").then(function (d) {
      DATA = d;
      ids = Object.keys(d.nodes);
      ids.forEach(function (nid) {
        nameOf[nid] = d.nodes[nid].name;
      });
      buildSearchDatalist();
      buildLineLegend();
      renderStats();
      draw();
    }).catch(function (err) {
      els.svg.innerHTML = '<text x="50%" y="50%" text-anchor="middle" fill="#e6353a">' +
        esc(String(err)) + "</text>";
    });

    // Event listeners
    els.projPca.addEventListener("click", function () {
      state.projection = "pca";
      updateProjButtons();
      draw();
    });
    els.projTsne.addEventListener("click", function () {
      state.projection = "tsne";
      updateProjButtons();
      draw();
    });
    els.cosSlider.addEventListener("input", function () {
      state.minCos = parseFloat(els.cosSlider.value);
      els.cosValue.textContent = state.minCos.toFixed(2);
      draw();
    });
    els.pathSlider.addEventListener("input", function () {
      state.minPath = parseInt(els.pathSlider.value, 10);
      els.pathValue.textContent = state.minPath === 99 ? "∞" : String(state.minPath);
      draw();
    });
    els.maxDivSlider.addEventListener("input", function () {
      state.maxDivergent = parseInt(els.maxDivSlider.value, 10);
      els.maxDivValue.textContent = String(state.maxDivergent);
      draw();
    });
    els.toggleSemantic.addEventListener("change", function () {
      state.showSemantic = els.toggleSemantic.checked;
      draw();
    });
    els.toggleDivergent.addEventListener("change", function () {
      state.showDivergent = els.toggleDivergent.checked;
      draw();
    });
    els.toggleLinks.addEventListener("change", function () {
      state.showLinks = els.toggleLinks.checked;
      draw();
    });
    els.search.addEventListener("input", function () {
      state.search = els.search.value.toLowerCase();
      draw();
    });
  }

  function updateProjButtons() {
    els.projPca.classList.toggle("active", state.projection === "pca");
    els.projTsne.classList.toggle("active", state.projection === "tsne");
  }

  function buildSearchDatalist() {
    var html = "";
    ids.forEach(function (nid) {
      html += '<option value="' + esc(nameOf[nid]) + '">';
    });
    els.searchList.innerHTML = html;
    els.search.addEventListener("change", function () {
      var val = els.search.value;
      var found = ids.find(function (nid) {
        return nameOf[nid].toLowerCase() === val.toLowerCase();
      });
      if (found) {
        state.selected = found;
        state.selectedPair = null;
        draw();
        showDetail(found);
      }
    });
  }

  function renderStats() {
    var m = DATA.meta;
    var ps = DATA.path_stats;
    els.stats.innerHTML =
      '<span><strong>' + m.n_nodes + '</strong> villains</span>' +
      '<span><strong>' + m.n_directed_edges + '</strong> links</span>' +
      '<span><strong>' + Object.keys(DATA.pairs).length + '</strong> pairs measured</span>' +
      '<span><strong>' + ps.disconnected + '</strong> close-but-disconnected</span>';
  }

  // Static legend explaining the line colors (always visible, above the plot)
  function buildLineLegend() {
    var html =
      '<span class="w7-legend-item">' +
        '<span class="w7-legend-line" style="background:#4d7cff"></span>' +
        'Semantically close (cosine ≥ threshold)</span>' +
      '<span class="w7-legend-item">' +
        '<span class="w7-legend-line" style="background:#e6353a"></span>' +
        '<span id="w7-div-count">Divergent (close in meaning, far in structure)</span></span>' +
      '<span class="w7-legend-item">' +
        '<span class="w7-legend-line" style="background:#3a3d47"></span>' +
        'Wikipedia hyperlink (toggle below)</span>' +
      '<span class="w7-legend-sep">·</span>' +
      '<span class="w7-legend-item">Dots colored by community, sized by in-degree</span>';
    els.legend.innerHTML = html;
  }

  // Update the live count of divergent pairs shown in the legend
  function updateDivergentCount(n) {
    var el = document.getElementById("w7-div-count");
    if (el) {
      el.textContent = "Divergent: " + n + " pairs shown (close in meaning, far in structure)";
    }
  }

  // ---------- drawing ----------

  function getCoords(nid) {
    var n = DATA.nodes[nid];
    return state.projection === "pca" ? n.pca : n.tsne;
  }

  function computeBounds() {
    var minX = Infinity, maxX = -Infinity, minY = Infinity, maxY = -Infinity;
    ids.forEach(function (nid) {
      var c = getCoords(nid);
      if (c[0] < minX) minX = c[0];
      if (c[0] > maxX) maxX = c[0];
      if (c[1] < minY) minY = c[1];
      if (c[1] > maxY) maxY = c[1];
    });
    return { minX: minX, maxX: maxX, minY: minY, maxY: maxY };
  }

  function draw() {
    var svg = els.svg;
    var W = svg.clientWidth || 800;
    var H = Math.max(400, W * 0.6);
    svg.setAttribute("viewBox", "0 0 " + W + " " + H);
    svg.innerHTML = "";

    var bounds = computeBounds();
    var pad = 40;
    var scaleX = (W - pad * 2) / (bounds.maxX - bounds.minX || 1);
    var scaleY = (H - pad * 2) / (bounds.maxY - bounds.minY || 1);
    var scale = Math.min(scaleX, scaleY);

    function sx(x) {
      return pad + (x - bounds.minX) * scale + (W - pad * 2 - (bounds.maxX - bounds.minX) * scale) / 2;
    }
    function sy(y) {
      return H - (pad + (y - bounds.minY) * scale + (H - pad * 2 - (bounds.maxY - bounds.minY) * scale) / 2);
    }

    // Search highlight
    var searchMatch = null;
    if (state.search) {
      searchMatch = ids.find(function (nid) {
        return nameOf[nid].toLowerCase().indexOf(state.search) >= 0;
      });
    }

    // Build a set of visible nodes (search filter)
    var visible = {};
    ids.forEach(function (nid) {
      visible[nid] = !state.search || nameOf[nid].toLowerCase().indexOf(state.search) >= 0;
    });

    // --- draw direct hyperlinks (optional, faint) ---
    if (state.showLinks) {
      var linkGroup = document.createElementNS("http://www.w3.org/2000/svg", "g");
      linkGroup.setAttribute("class", "w7-links");
      var seenLinks = {};
      DATA.edges.forEach(function (e) {
        var key = pairKey(e[0], e[1]);
        if (seenLinks[key]) return;
        seenLinks[key] = true;
        if (!visible[e[0]] && !visible[e[1]]) return;
        var c1 = getCoords(e[0]);
        var c2 = getCoords(e[1]);
        var line = document.createElementNS("http://www.w3.org/2000/svg", "line");
        line.setAttribute("x1", sx(c1[0]));
        line.setAttribute("y1", sy(c1[1]));
        line.setAttribute("x2", sx(c2[0]));
        line.setAttribute("y2", sy(c2[1]));
        line.setAttribute("stroke", "#3a3d47");
        line.setAttribute("stroke-width", "0.5");
        line.setAttribute("opacity", "0.3");
        linkGroup.appendChild(line);
      });
      svg.appendChild(linkGroup);
    }

    // --- draw semantic links (blue, thin) — ALL pairs, no skip logic ---
    // Divergent pairs get a red line drawn on top (see below).
    if (state.showSemantic) {
      var semGroup = document.createElementNS("http://www.w3.org/2000/svg", "g");
      semGroup.setAttribute("class", "w7-semantic");
      var seenSem = {};
      ids.forEach(function (nid) {
        if (!visible[nid]) return;
        var nlist = DATA.neighbors[nid] || [];
        nlist.forEach(function (item) {
          var other = item.o;
          if (!visible[other]) return;
          var key = pairKey(nid, other);
          if (seenSem[key]) return;
          if (item.c < state.minCos) return;
          seenSem[key] = true;

          var c1 = getCoords(nid);
          var c2 = getCoords(other);
          var line = document.createElementNS("http://www.w3.org/2000/svg", "line");
          line.setAttribute("x1", sx(c1[0]));
          line.setAttribute("y1", sy(c1[1]));
          line.setAttribute("x2", sx(c2[0]));
          line.setAttribute("y2", sy(c2[1]));
          line.setAttribute("stroke", "#4d7cff");
          line.setAttribute("stroke-width", "0.6");
          line.setAttribute("opacity", "0.25");
          semGroup.appendChild(line);
        });
      });
      svg.appendChild(semGroup);
    }

    // --- draw divergent pairs (red, thicker, on top of blue) ---
    // Computed on-the-fly from DATA.pairs using current slider values.
    if (state.showDivergent) {
      var divergentPairs = computeDivergentPairs();
      var divGroup = document.createElementNS("http://www.w3.org/2000/svg", "g");
      divGroup.setAttribute("class", "w7-divergent");
      divergentPairs.forEach(function (p) {
        if (!visible[p.a] || !visible[p.b]) return;

        var c1 = getCoords(p.a);
        var c2 = getCoords(p.b);
        var isSelected = state.selectedPair === pairKey(p.a, p.b);

        var line = document.createElementNS("http://www.w3.org/2000/svg", "line");
        line.setAttribute("x1", sx(c1[0]));
        line.setAttribute("y1", sy(c1[1]));
        line.setAttribute("x2", sx(c2[0]));
        line.setAttribute("y2", sy(c2[1]));
        line.setAttribute("stroke", isSelected ? "#ff6b6e" : "#e6353a");
        line.setAttribute("stroke-width", isSelected ? "2.5" : "1.5");
        line.setAttribute("opacity", isSelected ? "1" : "0.85");
        line.style.cursor = "pointer";
        line.addEventListener("click", function (ev) {
          ev.stopPropagation();
          selectPair(p.a, p.b);
        });
        // tooltip
        var title = document.createElementNS("http://www.w3.org/2000/svg", "title");
        title.textContent = nameOf[p.a] + " ↔ " + nameOf[p.b] +
          "\ncos=" + p.cos.toFixed(3) +
          "  path=" + (p.path >= 0 ? p.path : "∞") +
          "\ndivergence=" + p.divergence.toFixed(3) +
          "\n(click to compare pages)";
        line.appendChild(title);
        divGroup.appendChild(line);
      });
      svg.appendChild(divGroup);

      // Update the legend with the live count of divergent pairs shown
      updateDivergentCount(divergentPairs.length);
    } else {
      updateDivergentCount(0);
    }

    // --- draw nodes ---
    var nodeGroup = document.createElementNS("http://www.w3.org/2000/svg", "g");
    nodeGroup.setAttribute("class", "w7-nodes");
    ids.forEach(function (nid) {
      if (!visible[nid]) return;
      var c = getCoords(nid);
      var node = DATA.nodes[nid];
      var isSelected = state.selected === nid;
      var isSearchMatch = searchMatch === nid;
      var isInPair = state.selectedPair &&
        (state.selectedPair.indexOf(nid + "|") === 0 ||
         state.selectedPair.indexOf("|" + nid) >= 0);

      var g = document.createElementNS("http://www.w3.org/2000/svg", "g");
      g.setAttribute("class", "w7-node");
      g.style.cursor = "pointer";

      var circle = document.createElementNS("http://www.w3.org/2000/svg", "circle");
      circle.setAttribute("cx", sx(c[0]));
      circle.setAttribute("cy", sy(c[1]));
      var r = 3 + Math.min(node.in_degree, 20) * 0.3;
      circle.setAttribute("r", isSelected ? r + 2 : r);
      circle.setAttribute("fill", commColor(node.community));
      circle.setAttribute("stroke", isSelected || isSearchMatch || isInPair ? "#fff" : "rgba(255,255,255,0.3)");
      circle.setAttribute("stroke-width", isSelected || isSearchMatch || isInPair ? "2" : "1");
      circle.setAttribute("opacity", (state.search && !visible[nid]) ? "0.15" : "0.85");
      g.appendChild(circle);

      // tooltip
      var title = document.createElementNS("http://www.w3.org/2000/svg", "title");
      title.textContent = node.name +
        "\nin-degree=" + node.in_degree + "  out-degree=" + node.out_degree +
        "\ncommunity=C" + node.community + "  words=" + node.words;
      g.appendChild(title);

      // label for selected or search match
      if (isSelected || isSearchMatch || isInPair) {
        var label = document.createElementNS("http://www.w3.org/2000/svg", "text");
        label.setAttribute("x", sx(c[0]) + r + 4);
        label.setAttribute("y", sy(c[1]) + 4);
        label.setAttribute("fill", "#e9eaee");
        label.setAttribute("font-size", "11");
        label.setAttribute("font-family", "-apple-system, sans-serif");
        label.textContent = node.name;
        g.appendChild(label);
      }

      g.addEventListener("click", function (ev) {
        ev.stopPropagation();
        selectNode(nid);
      });

      nodeGroup.appendChild(g);
    });
    svg.appendChild(nodeGroup);

    // Click on empty space deselects
    svg.addEventListener("click", function () {
      if (state.selected || state.selectedPair) {
        state.selected = null;
        state.selectedPair = null;
        els.detail.innerHTML = '<p class="w7-hint">Click a villain to inspect their semantic and structural neighborhoods, or click a red line to compare a divergent pair.</p>';
        els.pairView.innerHTML = "";
        draw();
      }
    });
  }

  // ---------- selection & detail ----------

  function selectNode(nid) {
    state.selected = nid;
    state.selectedPair = null;
    draw();
    showDetail(nid);
  }

  function selectPair(a, b) {
    state.selectedPair = pairKey(a, b);
    state.selected = null;
    draw();
    showPairDetail(a, b);
  }

  function showDetail(nid) {
    var node = DATA.nodes[nid];
    var semNeighbors = (DATA.neighbors[nid] || []).slice(0, 8);

    // Compute this node's divergent partners on-the-fly using current sliders
    var myDivergent = [];
    Object.keys(DATA.pairs).forEach(function (key) {
      var p = DATA.pairs[key];
      if (p.a !== nid && p.b !== nid) return;
      if (p.linked) return;
      if (p.cos < state.minCos) return;
      if (p.path >= 0 && p.path < state.minPath) return;
      myDivergent.push(p);
    });
    myDivergent.sort(function (a, b) { return b.divergence - a.divergence; });
    myDivergent = myDivergent.slice(0, 5);

    // Structural neighbors (from edges)
    var structNeighbors = {};
    DATA.edges.forEach(function (e) {
      if (e[0] === nid) structNeighbors[e[1]] = true;
      if (e[1] === nid) structNeighbors[e[0]] = true;
    });
    var structList = Object.keys(structNeighbors).slice(0, 8);

    var html = '<div class="w7-detail-header">' +
      '<h3>' + esc(node.name) + '</h3>' +
      '<div class="w7-detail-meta">' +
      '<span>Community C' + node.community + '</span>' +
      '<span>in-degree ' + node.in_degree + '</span>' +
      '<span>out-degree ' + node.out_degree + '</span>' +
      '<span>' + node.words + ' words</span>' +
      '</div></div>';

    // Semantic neighbors (highlight divergent ones using current slider values)
    html += '<div class="w7-detail-section"><h4>Semantically close (MiniLM cosine)</h4><ul class="w7-nn-list">';
    semNeighbors.forEach(function (item) {
      var pair = getPair(nid, item.o);
      var pathStr = pair ? (pair.path >= 0 ? pair.path : "∞") : "?";
      var isDiv = pair && !pair.linked &&
        (pair.path >= state.minPath || pair.path < 0) &&
        pair.cos >= state.minCos;
      html += '<li' + (isDiv ? ' class="w7-divergent-item"' : '') + '>' +
        '<a href="#" data-nid="' + esc(item.o) + '">' + esc(nameOf[item.o]) + '</a>' +
        '<span class="w7-nn-cos">cos ' + item.c.toFixed(3) + '</span>' +
        '<span class="w7-nn-path">path ' + pathStr + '</span>' +
        (isDiv ? '<span class="w7-nn-flag">divergent</span>' : '') +
        '</li>';
    });
    html += '</ul></div>';

    // Structural neighbors
    html += '<div class="w7-detail-section"><h4>Linked on Wikipedia</h4><ul class="w7-nn-list">';
    structList.forEach(function (other) {
      var pair = getPair(nid, other);
      var cosStr = pair && pair.cos > 0 ? pair.cos.toFixed(3) : "—";
      html += '<li>' +
        '<a href="#" data-nid="' + esc(other) + '">' + esc(nameOf[other]) + '</a>' +
        '<span class="w7-nn-cos">cos ' + cosStr + '</span>' +
        '<span class="w7-nn-path">linked</span>' +
        '</li>';
    });
    html += '</ul></div>';

    // Divergent pairs (computed on-the-fly with current sliders)
    if (myDivergent.length > 0) {
      html += '<div class="w7-detail-section"><h4>Divergent pairs (close in meaning, far in structure)</h4><ul class="w7-nn-list">';
      myDivergent.forEach(function (p) {
        var other = p.a === nid ? p.b : p.a;
        var pathStr = p.path >= 0 ? p.path : "∞";
        html += '<li class="w7-divergent-item">' +
          '<a href="#" data-pair="' + esc(pairKey(p.a, p.b)) + '">' + esc(nameOf[other]) + '</a>' +
          '<span class="w7-nn-cos">cos ' + p.cos.toFixed(3) + '</span>' +
          '<span class="w7-nn-path">path ' + pathStr + '</span>' +
          '<span class="w7-nn-flag">div ' + p.divergence.toFixed(3) + '</span>' +
          '</li>';
      });
      html += '</ul></div>';
    }

    els.detail.innerHTML = html;
    els.pairView.innerHTML = "";

    // Wire up links
    els.detail.querySelectorAll("a[data-nid]").forEach(function (a) {
      a.addEventListener("click", function (ev) {
        ev.preventDefault();
        selectNode(a.getAttribute("data-nid"));
      });
    });
    els.detail.querySelectorAll("a[data-pair]").forEach(function (a) {
      a.addEventListener("click", function (ev) {
        ev.preventDefault();
        var key = a.getAttribute("data-pair");
        var parts = key.split("|");
        selectPair(parts[0], parts[1]);
      });
    });
  }

  function showPairDetail(a, b) {
    var pair = getPair(a, b);
    var nodeA = DATA.nodes[a];
    var nodeB = DATA.nodes[b];

    els.detail.innerHTML = '<div class="w7-detail-header">' +
      '<h3>' + esc(nodeA.name) + ' ↔ ' + esc(nodeB.name) + '</h3>' +
      '<div class="w7-detail-meta">' +
      '<span>cosine <strong>' + (pair ? pair.cos.toFixed(3) : "?") + '</strong></span>' +
      '<span>path <strong>' + (pair ? (pair.path >= 0 ? pair.path : "disconnected") : "?") + '</strong></span>' +
      '<span>divergence <strong>' + (pair ? pair.divergence.toFixed(3) : "?") + '</strong></span>' +
      '</div></div>';

    // Fetch and show excerpts. Filenames on disk are node_id + ".txt"
    // (all special chars in node_ids — (), ', . — are kept unencoded by
    // Python's quote(safe="()'"), so no URL encoding needed here).
    var pathA = "../data/Marvel_Comics_supervillains/pages/" + a + ".txt";
    var pathB = "../data/Marvel_Comics_supervillains/pages/" + b + ".txt";

    els.pairView.innerHTML = '<div class="w7-pair-loading">Loading page excerpts…</div>';

    Promise.all([fetchText(pathA).catch(function () { return null; }),
                 fetchText(pathB).catch(function () { return null; })])
      .then(function (texts) {
        var html = '<div class="w7-pair-grid">';
        html += renderExcerpt(a, nodeA.name, texts[0]);
        html += renderExcerpt(b, nodeB.name, texts[1]);
        html += '</div>';
        els.pairView.innerHTML = html;
      });
  }

  function renderExcerpt(nid, name, text) {
    if (!text) {
      return '<div class="w7-excerpt"><h4>' + esc(name) + '</h4>' +
        '<p class="w7-excerpt-error">Page text not available.</p></div>';
    }
    // Get first 3 non-empty paragraphs, truncate each
    var paras = text.split(/\n+/).filter(function (p) {
      return p.trim().length > 50;
    }).slice(0, 3);
    var html = '<div class="w7-excerpt"><h4>' + esc(name) + '</h4>';
    paras.forEach(function (p) {
      var trimmed = p.trim();
      if (trimmed.length > 400) trimmed = trimmed.substring(0, 400) + "…";
      html += '<p>' + esc(trimmed) + '</p>';
    });
    html += '</div>';
    return html;
  }

  // ---------- boot ----------

  if (document.readyState === "loading") {
    document.addEventListener("DOMContentLoaded", init);
  } else {
    init();
  }
})();
