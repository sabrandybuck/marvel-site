/*
 * Week 6-2 explorable — "the similarity cascade".
 *
 * Two neighborhood graphs over the same 303 Marvel characters, drawn as one
 * network: the STRUCTURAL layer is the week-1 Wikipedia link graph
 * (undirected, 1434 edges); the TEXTUAL layer is the week-6 TF-IDF (or raw
 * count) cosine neighborhood (top-k per character, unique pairs). Every
 * edge in the view is then classified:
 *
 *   both            — linked on Wikipedia AND in the text top-k   (green)
 *   structural-only — linked on Wikipedia, not textually close    (dashed gray)
 *   text-only       — textually close but structurally unrelated  (red)
 *
 * Text-only edges are the cascade's headline: they are where representation
 * disagrees with structure (surnames, teammates, near-duplicate pages).
 *
 * Controls: representation, top-k, minimum cosine, community filter, the
 * three class toggles, hero search. Clicking a node or edge opens the
 * inspector. Data: the frozen week6_summary.json — a pure reader.
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
    textOnly: "#e6353a",
    both: "#0ca678",
    structOnly: "#98a0ad",
    dimNode: "#c9ccd2",
  };

  var state = {
    mode: "tfidf",
    k: 10,
    minCos: 0,
    comm: "all",           // 'all' | community id | 'small'
    showTextOnly: true,
    showStructOnly: true,
    showBoth: true,
    selected: null,        // node id
  };

  var S = null;
  var ids = [];
  var nameOf = null;      // nid -> display name
  var commLabel = {};     // community id -> "C1 · Wolverine"
  var network = null;
  var pairIndex = null;   // re-built per state: 'a|b' -> {cls, c, w}

  // ---------- data ----------------------------------------------------------

  function fetchJson(url) {
    return fetch(url).then(function (r) {
      if (!r.ok) throw new Error("HTTP " + r.status + " fetching " + url);
      return r.json();
    });
  }

  function pairKey(a, b) { return a < b ? a + "|" + b : b + "|" + a; }

  function visibleNids() {
    if (state.comm === "all") return ids;
    if (state.comm === "small") {
      return ids.filter(function (nid) {
        return S.pages[nid].community >= 8;  // singleton fringes in the frozen layout
      });
    }
    return ids.filter(function (nid) {
      return String(S.pages[nid].community) === String(state.comm);
    });
  }

  function rebuild() {
    var shown = new Set(visibleNids());

    // --- textual pairs (top-k per character, both directions unioned) ---
    var text = new Map();
    ids.forEach(function (nid) {
      if (!shown.has(nid)) return;
      S.neighbors[state.mode][nid].slice(0, state.k).forEach(function (it) {
        if (it.c < state.minCos || !shown.has(it.o)) return;
        var key = pairKey(nid, it.o);
        var prev = text.get(key);
        if (!prev || it.c > prev.c) {
          text.set(key, { c: it.c, w: it.w && it.w.length ? it.w : (prev && prev.w) || [] });
        }
      });
    });

    // --- structural pairs ---
    var structural = new Set();
    ids.forEach(function (nid) {
      if (!shown.has(nid)) return;
      S.pages[nid].links.forEach(function (l) {
        if (shown.has(l)) structural.add(pairKey(nid, l));
      });
    });

    pairIndex = { text: text, structural: structural, cls: {} };
    var counts = { textOnly: 0, structOnly: 0, both: 0 };
    var edgeRows = [];
    text.forEach(function (v, key) {
      var cls = structural.has(key) ? "both" : "textOnly";
      pairIndex.cls[key] = cls;
      counts[cls]++;
      if ((cls === "textOnly" && state.showTextOnly) ||
          (cls === "both" && state.showBoth)) {
        var p = key.split("|");
        edgeRows.push({
          from: p[0], to: p[1], cls: cls, c: v.c, w: v.w,
          title: titleFor(p[0], p[1], cls, v.c, v.w),
        });
      }
    });
    structural.forEach(function (key) {
      if (text.has(key)) return;
      pairIndex.cls[key] = "structOnly";
      counts.structOnly++;
      if (state.showStructOnly) {
        var p = key.split("|");
        edgeRows.push({
          from: p[0], to: p[1], cls: "structOnly", c: null, w: [],
          title: titleFor(p[0], p[1], "structOnly", null, []),
        });
      }
    });

    // node = "unattached" in the current view only if no visible edge touches it
    var keep = new Set(edgeRows.flatMap(function (e) { return [e.from, e.to]; }));
    var nodes = ids.filter(function (nid) { return shown.has(nid); })
      .map(function (nid) {
        var p = S.pages[nid];
        var dim = !keep.has(nid);
        return {
          id: nid,
          label: p.name,
          group: p.community,
          value: p.in_degree,
          color: {
            background: dim ? COLORS.dimNode : TAB20[(p.community < 8 ? p.community * 2 : (p.community - 8) * 2 + 1) % 20],
            border: "#555b66",
            highlight: { background: "#fff", border: COLORS.textOnly },
          },
          font: { color: "#33373e", size: 11 },
          title: p.name + " — C" + p.community,
        };
      });

    var edges = edgeRows.map(function (e) {
      var style;
      if (e.cls === "textOnly") {
        style = { color: COLORS.textOnly, width: 2.2, dashes: false };
      } else if (e.cls === "both") {
        style = { color: COLORS.both, width: 1.8, dashes: false };
      } else {
        style = { color: COLORS.structOnly, width: 0.8, dashes: true };
      }
      return {
        from: e.from, to: e.to, title: e.title,
        color: { color: style.color, opacity: e.cls === "structOnly" ? 0.7 : 0.85 },
        width: style.width, dashes: style.dashes,
      };
    });

    draw(nodes, edges, counts);
  }

  function titleFor(a, b, cls, cos, words) {
    var tag = cls === "textOnly" ? "text only (structurally unrelated)"
      : cls === "both" ? "linked AND textually close"
      : "structural link, not in the text top-k";
    return esc(S.pages[a].name) + " ↔ " + esc(S.pages[b].name) + "<br>" + tag +
      (cos != null ? " · cosine " + cos.toFixed(3) : "") +
      (words && words.length ? "<br>shared: " + esc(words.join(", ")) : "");
  }

  // ---------- vis-network ----------------------------------------------------

  var lastCounts = { textOnly: 0, structOnly: 0, both: 0 };

  function draw(nodes, edges, counts) {
    lastCounts = counts;
    updateLegend(counts);
    var container = document.getElementById("w62-network");
    var nodesData = new vis.DataSet(nodes);
    var edgesData = new vis.DataSet(edges);
    if (network) { network.destroy(); network = null; }
    network = new vis.Network(container, { nodes: nodesData, edges: edgesData }, {
      nodes: {
        shape: "dot",
        scaling: { min: 5, max: 34 },
        font: { size: 11, color: "#33373e", face: "inherit" },
      },
      edges: {
        smooth: false,
        selectionWidth: 1.5,
      },
      physics: {
        barnesHut: { gravitationalConstant: -5500, springLength: 90, springConstant: 0.03 },
        stabilization: { iterations: 220, fit: true },
      },
      interaction: { hover: true, tooltipDelay: 120 },
    });
    network.on("click", function (params) {
      if (params.edges.length) {
        var e = params.edges[0];
        var edgeObj = network.body.data.edges.get(e);
        openPairInspector(edgeObj.from, edgeObj.to);
      } else if (params.nodes.length) {
        openNodeInspector(params.nodes[0]);
      } else {
        closeInspector();
      }
    });
    // re-select after a rebuild only if the node survived the new filter
    if (state.selected && nodesData.get(state.selected)) {
      openNodeInspector(state.selected);
    }
  }

  // ---------- legend / inspector / controls ----------------------------------

  function updateLegend(counts) {
    setText("w62-c-textonly", counts.textOnly);
    setText("w62-c-structonly", counts.structOnly);
    setText("w62-c-both", counts.both);
  }

  function setText(id, v) {
    var el = document.getElementById(id);
    if (el) el.textContent = v;
  }

  function closeInspector() {
    state.selected = null;
    document.getElementById("w62-inspector").innerHTML =
      '<p class="inspector-empty">No hero or edge selected yet — click the graph, or search above.</p>';
  }

  function commTag(nid) {
    var c = S.pages[nid].community;
    var col = TAB20[(c < 8 ? c * 2 : (c - 8) * 2 + 1) % 20];
    return C0(commLabel[c] || ("C" + c), col);
  }

  function C0(label, col) {
    return '<span class="neighbor-pill" style="color:#e9eaee;border-color:' + col + '">' +
      '<span style="display:inline-block;width:8px;height:8px;border-radius:50%;background:' + col + ';margin-right:5px;"></span>' +
      esc(label) + "</span>";
  }

  function openNodeInspector(nid) {
    state.selected = nid;
    var p = S.pages[nid];
    var linked = p.links;
    var textNbs = S.neighbors[state.mode][nid];
    var inBoth = textNbs.filter(function (it) { return linked.indexOf(it.o) >= 0; }).length;
    var pills = textNbs.slice(0, 8).map(function (it) {
      var structural = linked.indexOf(it.o) >= 0;
      var cls = structural ? "in the week-1 network" : "NOT in the week-1 network";
      var col = structural ? COLORS.both : COLORS.textOnly;
      return '<span class="neighbor-pill" style="border-color:' + col + ';color:inherit">' +
        esc(S.pages[it.o].name) + ' <span style="font-family:var(--mono);font-size:10px;color:' + col + '">' +
        it.c.toFixed(2) + (structural ? " ✓" : " ✗") + "</span></span>";
    }).join("");
    var linksPills = linked.slice(0, 12).map(function (l) {
      return '<span class="neighbor-pill">' + esc(S.pages[l].name) + "</span>";
    }).join("") + (linked.length > 12
      ? '<span class="neighbor-more">+ ' + (linked.length - 12) + " more</span>" : "");

    document.getElementById("w62-inspector").innerHTML =
      '<h4 class="inspector-name">' + esc(p.name) + "</h4>" +
      '<div style="margin-bottom:12px"><span class="inspector-group">' + commTag(nid) + "</span></div>" +
      '<div class="inspector-stats">' +
      '<div class="inspector-stat"><span class="stat-label">Wikipedia links</span><span class="stat-value">' + linked.length + "</span></div>" +
      '<div class="inspector-stat"><span class="stat-label">Top-' + state.k + " text neighbors</span><span class=\"stat-value\">" + textNbs.length + "</span></div>" +
      '<div class="inspector-stat"><span class="stat-label">Text∩network</span><span class="stat-value">' + inBoth + "</span></div>" +
      "</div>" +
      '<div class="inspector-lists">' +
      '<div class="inspector-section"><h5>Closest pages under ' +
      (state.mode === "tfidf" ? "TF-IDF" : "raw counts") + '</h5><div style="margin-bottom:8px">' + (pills || "—") + "</div></div>" +
      '<div class="inspector-section"><h5>Linked on Wikipedia (' + linked.length + ")</h5>" +
      '<div style="margin-bottom:8px">' + (linksPills || "no links at all") + "</div></div></div>";
  }

  function openPairInspector(a, b) {
    var key = pairKey(a, b);
    var cls = pairIndex.cls[key];
    var textual = pairIndex.text.get(key);
    var label = cls === "textOnly" ? "text only — the cascade's divergences"
      : cls === "both" ? "linked AND textually close"
      : "structural link outside the text top-k";
    var col = cls === "textOnly" ? COLORS.textOnly
      : cls === "both" ? COLORS.both : COLORS.structOnly;
    var words = (textual && textual.w) || [];
    document.getElementById("w62-inspector").innerHTML =
      '<h4 class="inspector-name">' + esc(S.pages[a].name) + " ↔ " + esc(S.pages[b].name) + "</h4>" +
      '<div style="margin-bottom:12px">' + commTag(a) + " " + commTag(b) + "</div>" +
      '<div class="inspector-stats">' +
      '<div class="inspector-stat"><span class="stat-label">Class</span><span class="stat-value" style="font-size:13px;color:' + col + '">' + label + "</span></div>" +
      '<div class="inspector-stat"><span class="stat-label">TF-IDF cosine</span><span class="stat-value">' +
      (textual ? textual.c.toFixed(3) : "—") + "</span></div>" +
      "</div>" +
      (words.length
        ? '<div class="inspector-section"><h5>Shared fingerprint words</h5><div>' +
          words.map(function (w) { return '<span class="neighbor-pill">' + esc(w) + "</span>"; }).join("") +
          "</div></div>"
        : "") +
      '<p class="network-note">Judge it: a surname, a shared comic, or boilerplate? ' +
      "The page explains the two headline examples.</p>";
  }

  function buildControls(root) {
    var mode = root.querySelector("#w62-mode");
    mode.value = state.mode;
    mode.addEventListener("change", function () {
      state.mode = this.value;
      rebuild();
    });

    var kSlider = root.querySelector("#w62-k");
    kSlider.value = state.k;
    setText("w62-k-val", state.k);
    kSlider.addEventListener("input", function () {
      state.k = +this.value;
      setText("w62-k-val", state.k);
      rebuild();
    });

    var cosSlider = root.querySelector("#w62-mincos");
    cosSlider.value = state.minCos;
    setText("w62-mincos-val", state.minCos.toFixed(2));
    cosSlider.addEventListener("input", function () {
      state.minCos = +this.value;
      setText("w62-mincos-val", state.minCos.toFixed(2));
      rebuild();
    });

    var commSelect = root.querySelector("#w62-community");
    // options: all, top-8 communities, the singleton islands
    var opts = '<option value="all">All characters</option>';
    for (var ci = 0; ci < 8; ci++) {
      opts += '<option value="' + ci + '">' + esc(commLabel[ci]) + "</option>";
    }
    opts += '<option value="small">The small islands (17+ singletons)</option>';
    commSelect.innerHTML = opts;
    commSelect.addEventListener("change", function () {
      state.comm = this.value;
      rebuild();
    });

    [["w62-t-textonly", "showTextOnly"],
     ["w62-t-structonly", "showStructOnly"],
     ["w62-t-both", "showBoth"]].forEach(function (pair) {
      var el = root.querySelector("#" + pair[0]);
      el.checked = state[pair[1]];
      el.addEventListener("change", function () {
        state[pair[1]] = this.checked;
        rebuild();
      });
    });

    var input = root.querySelector("#w62-input");
    var dl = root.querySelector("#w62-datalist");
    dl.innerHTML = ids.map(function (nid) {
      return '<option value="' + esc(nameOf(nid)) + '">';
    }).join("");
    input.addEventListener("change", function () {
      var q = this.value.trim().toLowerCase();
      this.value = "";
      var hit = ids.find(function (nid) {
        return nameOf(nid).toLowerCase() === q;
      });
      if (hit) { selectAndZoom(hit); }
    });

    root.querySelector("#w62-reset").addEventListener("click", function () {
      state.mode = "tfidf"; state.k = 10; state.minCos = 0;
      state.comm = "all"; state.showTextOnly = true; state.showStructOnly = true;
      state.showBoth = true; state.selected = null;
      // re-sync control values directly (no re-bound listeners)
      root.querySelector("#w62-mode").value = state.mode;
      root.querySelector("#w62-k").value = state.k;
      root.querySelector("#w62-mincos").value = state.minCos;
      root.querySelector("#w62-community").value = "all";
      root.querySelector("#w62-t-textonly").checked = true;
      root.querySelector("#w62-t-structonly").checked = true;
      root.querySelector("#w62-t-both").checked = true;
      setText("w62-k-val", state.k);
      setText("w62-mincos-val", state.minCos.toFixed(2));
      closeInspector();
    });
  }

  function selectAndZoom(nid) {
    state.selected = nid;
    if (network) {
      network.selectNodes([nid]);
      network.focus(nid, { scale: 0.9, animation: true });
    }
    openNodeInspector(nid);
  }

  // ---------- boot -------------------------------------------------------------

  function boot(summary) {
    S = summary;
    ids = Object.keys(S.pages);
    nameOf = function (nid) { return S.pages[nid].name; };
    // community labels: biggest in-degree member names each community
    for (var ci = 0; ci < S.meta.stats.community_sizes.length; ci++) {
      var best = null;
      ids.forEach(function (nid) {
        if (S.pages[nid].community !== ci) return;
        if (!best || S.pages[nid].in_degree > S.pages[best].in_degree) best = nid;
      });
      commLabel[ci] = "C" + ci + " · " + S.pages[best].name +
        " (" + S.meta.stats.community_sizes[ci] + ")";
    }
    buildControls(document.getElementById("w62-controls"));
    closeInspector();
    rebuild();
  }

  fetchJson("../data/marvel_pages/week6_summary.json").then(boot);
})();
