/*
 * Week 7 explorer — two coordinated maps of the same 370 supervillain pages.
 *
 *   View A  PCA projection of the page embeddings, coloured by embedding cluster
 *   View B  the directed link network (precomputed force layout), coloured by
 *           Louvain community
 *
 * Everything is frozen by analysis/build_week7_explore.py in
 * data/week7/week7_explore.json. The only live computation is a directed
 * breadth-first search over the 1,136 edges to draw the shortest path(s) between
 * the two selected pages.
 *
 * Selection model: st.a / st.b are Character A and Character B; either may be empty. The five featured
 * pairs (chips) are the default (the first is selected on load). The ways to change the selection are
 * independent and all write the same two slots, and refresh() mirrors them into the two character
 * inputs: the Character A / B inputs (each changes only its own slot), a dot click (fills the first
 * empty slot; with both filled it starts over with a new A; clicking A again returns to the default
 * pair), the "more disagreements" and "agreements" dropdowns (set both from the frozen case lists), and
 * the neighbour rows (fill the other slot). Clear (resetAll) restores the exact initial state.
 * Numbers for the featured pairs and for case-list pairs are the stored all-pairs values; for any
 * other pair the distances come from the live BFS and the cosine from the stored top-8 neighbour
 * lists. A group (legend row or cross-tab cell) can be highlighted independently.
 */
(function () {
  "use strict";

  var NS = "http://www.w3.org/2000/svg";
  // Two different palettes so that "cluster 3" and "community 3" are never the same colour
  // unless the reader asks for a shared colouring.
  var PAL_A = ["#4d7cff", "#e6353a", "#e0a020", "#0ca678", "#c05bd6", "#2ec4d6", "#f783ac", "#94d82d", "#ff922b", "#9775fa", "#66d9e8", "#adb5bd"];
  var PAL_B = ["#ff922b", "#66d9e8", "#f783ac", "#94d82d", "#9775fa", "#e0a020", "#2ec4d6", "#e6353a", "#adb5bd", "#4d7cff", "#c05bd6", "#0ca678"];
  var NO_COMM = "#5b5e6b";
  var ACCENT = "#e6353a";

  var READING = {
    "Firebrand_(Marvel_Comics)|Firepower_(comics)":
      "Both pages are alias pages shared by several characters, and the first character of each fights Iron Man (Hammer's enforcer; an armour built for the “Armor Wars”). Only one page in the collected graph (Guardsman) links to Firepower.",
    "Doom_2099|Kristoff_Vernard":
      "Both pages are about someone in Doctor Doom's role ruling Latveria, in different eras (a future Doom and his adoptive heir). Doctor Doom himself is not in the category, so any route through his page is missing from the graph. Doom 2099's page does not lead back to Vernard.",
    "Masked_Marauder|Gentleman_(character)":
      "Underworld schemers who use other villains for elaborate plots against Spider-Man, from different decades (1966 comics vs. novels and a 2016 comic). The only pair here with a finite path in both directions.",
    "Gorgon_(Inhuman)|Lady_Gorgon":
      "After reading both pages we found little shared beyond the name and the generic biography layout (an Inhuman royal bodyguard vs. a Hand ninja who fights the Punisher). A name effect is possible but untested.",
    "Condor_(comics)|Flying_Tiger_(Marvel_Comics)":
      "Two flying criminals with short pages, both tied to Zemo's schemes, but enemies of different heroes (Nova vs. Spider-Woman and Iron Man). They do not link to each other and no page links to or from both; both pages mention Zemo and Jack Flag, but neither mentions the other character."
  };

  function el(tag, attrs, text) {
    var e = document.createElement(tag);
    if (attrs) for (var k in attrs) e.setAttribute(k, attrs[k]);
    if (text != null) e.textContent = text;
    return e;
  }
  function sv(tag, attrs) {
    var e = document.createElementNS(NS, tag);
    if (attrs) for (var k in attrs) e.setAttribute(k, attrs[k]);
    return e;
  }
  function $(id) { return document.getElementById(id); }

  fetch("../data/week7/week7_explore.json").then(function (r) {
    if (!r.ok) throw new Error("HTTP " + r.status);
    return r.json();
  }).then(init).catch(function (err) {
    var m = $("w7-evidence");
    if (m) m.textContent = "Could not load data/week7/week7_explore.json (" + err.message + "). Serve the site over HTTP.";
  });

  function init(D) {
    var N = D.nodes, M = D.meta, K = M.K, n = N.length;
    var byId = {};
    N.forEach(function (d, i) { byId[d.id] = i; });

    // ---------- adjacency + directed BFS
    var out = N.map(function () { return []; });
    D.edges.forEach(function (e) { out[e[0]].push(e[1]); });
    function path(s, t) {
      if (s === t) return [s];
      var prev = new Int32Array(n).fill(-1), q = [s], h = 0;
      prev[s] = s;
      while (h < q.length) {
        var u = q[h++];
        for (var j = 0; j < out[u].length; j++) {
          var v = out[u][j];
          if (prev[v] < 0) {
            prev[v] = u;
            if (v === t) {
              var p = [t];
              while (p[0] !== s) p.unshift(prev[p[0]]);
              return p;
            }
            q.push(v);
          }
        }
      }
      return null;
    }

    // ---------- character inputs (Character A / Character B)
    var inA = $("w7-char-a"), inB = $("w7-char-b"), cstat = $("w7-char-status");

    // ---------- state
    var st = { a: null, b: null, colour: "own", group: null };

    // ---------- geometry
    var W = 440, H = 440, PAD = 16;
    function scaler(get, xmax) {
      var xs = N.map(function (d) { return get(d)[0]; }), ys = N.map(function (d) { return get(d)[1]; });
      var x0 = Math.min.apply(null, xs), x1 = Math.max.apply(null, xs), y0 = Math.min.apply(null, ys), y1 = Math.max.apply(null, ys);
      var s = Math.min((W - 2 * PAD) / (x1 - x0), (H - 2 * PAD) / (y1 - y0));
      return function (d) {
        var p = get(d);
        return [PAD + (p[0] - x0) * s, H - PAD - (p[1] - y0) * s];
      };
    }
    var posA = scaler(function (d) { return d.pca; });
    var posB = scaler(function (d) { return d.net; });
    var PA = N.map(posA), PB = N.map(posB);

    // ---------- colours
    function colA(i) {                       // colour of node i in view A
      if (st.colour === "comm") return N[i].comm == null ? NO_COMM : PAL_B[N[i].comm];
      return PAL_A[N[i].cluster];
    }
    function colB(i) {
      if (st.colour === "cluster") return PAL_A[N[i].cluster];
      return N[i].comm == null ? NO_COMM : PAL_B[N[i].comm];
    }

    // ---------- build SVGs
    function makeSvg(host, label) {
      var s = sv("svg", { viewBox: "0 0 " + W + " " + H, role: "img", "aria-label": label });
      s.style.width = "100%"; s.style.height = "auto"; s.style.display = "block";
      s.style.background = "rgba(255,255,255,0.02)"; s.style.border = "1px solid var(--line)"; s.style.borderRadius = "10px";
      host.appendChild(s);
      return s;
    }
    var svgA = makeSvg($("w7-map-a"), "Projection of the page embeddings, coloured by embedding cluster");
    var svgB = makeSvg($("w7-map-b"), "Directed link network, coloured by community");

    var defs = sv("defs");
    ["ab", "ba"].forEach(function (k, j) {
      var m = sv("marker", { id: "w7-arr-" + k, viewBox: "0 0 10 10", refX: 9, refY: 5, markerWidth: 6, markerHeight: 6, orient: "auto-start-reverse" });
      m.appendChild(sv("path", { d: "M0,0 L10,5 L0,10 z", fill: j ? "#e0a020" : "#ffffff" }));
      defs.appendChild(m);
    });
    svgB.appendChild(defs);

    // edges (view B), drawn as straight lines
    var gEdges = sv("g", { stroke: "rgba(233,234,238,0.16)", "stroke-width": 0.6 });
    var edgeEls = D.edges.map(function (e) {
      var l = sv("line", { x1: PB[e[0]][0], y1: PB[e[0]][1], x2: PB[e[1]][0], y2: PB[e[1]][1] });
      gEdges.appendChild(l);
      return l;
    });
    svgB.appendChild(gEdges);
    var gPath = sv("g"); svgB.appendChild(gPath);
    var gLineA = sv("g"); svgA.appendChild(gLineA);

    var dotsA = [], dotsB = [];
    function mkDots(svg, P, arr) {
      var g = sv("g");
      N.forEach(function (d, i) {
        var c = sv("circle", { cx: P[i][0], cy: P[i][1], r: 3.6, "stroke-width": 0 });
        c.style.cursor = "pointer";
        var t = sv("title"); t.textContent = d.name; c.appendChild(t);
        c.addEventListener("click", function () { pick(i); });
        g.appendChild(c); arr.push(c);
      });
      svg.appendChild(g);
    }
    mkDots(svgA, PA, dotsA);
    mkDots(svgB, PB, dotsB);
    // selection rings are overlay circles (the dots themselves are never moved, so the DOM stays identical to a fresh load)
    var gSel = { a: sv("g"), b: sv("g") };
    svgA.appendChild(gSel.a); svgB.appendChild(gSel.b);
    gSel.a.style.pointerEvents = "none"; gSel.b.style.pointerEvents = "none";
    var gLab = { a: sv("g"), b: sv("g") };
    svgA.appendChild(gLab.a); svgB.appendChild(gLab.b);
    gLab.a.style.pointerEvents = "none"; gLab.b.style.pointerEvents = "none";

    // small caption inside view B for the strip of unlinked pages
    var strip = sv("text", { x: W - 6, y: 12, fill: "#9a9daa", "font-size": 10 });
    strip.setAttribute("x", W - 6); strip.setAttribute("text-anchor", "end"); strip.textContent = "pages outside the giant component";
    svgB.appendChild(strip);

    function label(g, i, txt, color, P) {
      var x = P[i][0], y = P[i][1];
      var anchor = x > W * 0.6 ? "end" : "start", dx = anchor === "end" ? -9 : 9;
      var t = sv("text", { x: x + dx, y: y - 8, "text-anchor": anchor, fill: "#fff", "font-size": 12, "font-weight": 600, stroke: "#0e0f13", "stroke-width": 3, "paint-order": "stroke" });
      t.textContent = txt;
      g.appendChild(t);
    }

    // ---------- legends
    function legend(host, kind) {
      host.textContent = "";
      var reps = kind === "A" ? M.cluster_reps : M.comm_reps;
      var sizes = kind === "A" ? M.cluster_sizes_giant : M.comm_sizes;
      var key = kind === "A" ? "cluster" : "comm";
      for (var g = 0; g < K; g++) {
        (function (g) {
          var row = el("button", { type: "button", class: "w7-leg-row", "data-kind": key, "data-g": g });
          var sw = el("span", { class: "w7-leg-sw" }); sw.setAttribute("data-sw", key + g);
          row.appendChild(sw);
          var nm = reps[g].slice(0, 3).map(function (i) { return N[i].name.replace(/ \(.*\)$/, ""); }).join(", ");
          row.appendChild(el("span", { class: "w7-leg-id" }, (kind === "A" ? "E" : "N") + (g + 1)));
          row.appendChild(el("span", { class: "w7-leg-n" }, sizes[g] + " pages"));
          row.appendChild(el("span", { class: "w7-leg-reps" }, nm));
          row.addEventListener("click", function () {
            st.group = (st.group && st.group.kind === key && st.group.id === g) ? null : { kind: key, id: g, label: (kind === "A" ? "embedding cluster E" : "network community N") + (g + 1) };
            refresh();
          });
          host.appendChild(row);
        })(g);
      }
    }
    legend($("w7-legend-a"), "A");
    legend($("w7-legend-b"), "B");

    // ---------- selection
    function setPair(a, b) { st.a = a; st.b = b; refresh(); }
    function defaultPair() { setPair(D.featured[0].a, D.featured[0].b); }
    function pick(i) {
      if (st.a == null) { st.a = i; refresh(); }
      else if (st.b == null) { if (i === st.a) defaultPair(); else { st.b = i; refresh(); } }
      else { st.a = i; st.b = null; refresh(); }
    }

    function inGroup(i) {
      if (!st.group) return true;
      if (st.group.kind === "cell") return N[i].cluster === st.group.c && N[i].comm === st.group.m;
      return N[i][st.group.kind] === st.group.id;
    }

    // ---------- evidence
    function nameOf(i) { return N[i].name; }
    function stat(label, value, sub) {
      var d = el("div", { class: "w7-stat" });
      d.appendChild(el("div", { class: "w7-stat-l" }, label));
      d.appendChild(el("div", { class: "w7-stat-v" }, value));
      if (sub) d.appendChild(el("div", { class: "w7-stat-s" }, sub));
      return d;
    }
    function fmtPath(p) { return p.map(nameOf).join(" → "); }
    function rankIn(i, j) {
      var L = D.neighbours[i] || [];
      for (var r = 0; r < L.length; r++) if (L[r][0] === j) return "#" + (r + 1);
      return "outside top " + L.length;
    }
    function dText(d) { return d == null ? "no path" : d + (d === 1 ? " link" : " links"); }
    function short(i) { return N[i].name.replace(/ \(.*\)$/, ""); }

    // Stored record for a pair (featured first, then the frozen case lists), in the order a, b.
    function lookup(a, b) {
      var lists = [["featured", D.featured], ["farDiff", D.cases.farDiff], ["agree", D.cases.agree], ["farSameComm", D.cases.farSameComm]];
      for (var l = 0; l < lists.length; l++) {
        var L = lists[l][1];
        for (var k = 0; k < L.length; k++) {
          var r = L[k];
          if (r.a === a && r.b === b) return { kind: lists[l][0], cos: r.cos, dab: r.dab, dba: r.dba, stored: true };
          if (r.a === b && r.b === a) return { kind: lists[l][0], cos: r.cos, dab: r.dba, dba: r.dab, stored: true };
        }
      }
      return null;
    }
    function neighbourCos(a, b) {
      var L = D.neighbours[a] || [], r;
      for (r = 0; r < L.length; r++) if (L[r][0] === b) return L[r][1];
      L = D.neighbours[b] || [];
      for (r = 0; r < L.length; r++) if (L[r][0] === a) return L[r][1];
      return null;
    }

    function renderSingle(host, which, note) {
      var si = which === "A" ? st.a : st.b, A = N[si];
      host.appendChild(el("h3", null, "Character " + which + ": " + A.name));
      if (note) host.appendChild(el("p", { class: "w7-hint" }, note));
      host.appendChild(el("p", { class: "w7-hint" },
        "E" + (A.cluster + 1) + " \u00B7 " + (A.comm == null ? "no community" : "N" + (A.comm + 1)) + " \u00B7 " + A.words + " words \u00B7 " + A.inDeg + " links in, " + A.outDeg +
        " links out (inside the collected graph). Its eight most similar pages are below (cosines and distances are stored values from the all-pairs table); click one to " + (note ? "compare." : "set Character " + (which === "A" ? "B" : "A") + ".")));
      var tb = el("table", { class: "w7-table" });
      tb.innerHTML = "<thead><tr><th scope=\"col\">Most similar page</th><th scope=\"col\">Cosine</th><th scope=\"col\">This \u2192 it</th><th scope=\"col\">It \u2192 this</th><th scope=\"col\">Same embedding cluster</th><th scope=\"col\">Same network community</th></tr></thead>";
      var tbody = el("tbody");
      (D.neighbours[si] || []).forEach(function (r) {
        var tr = el("tr", { class: "w7-click", tabindex: "0", role: "button", "aria-label": "Compare " + A.name + " with " + nameOf(r[0]) });
        tr.appendChild(el("td", null, nameOf(r[0])));
        tr.appendChild(el("td", null, r[1].toFixed(4)));
        tr.appendChild(el("td", null, r[2] == null ? "no path" : String(r[2])));
        tr.appendChild(el("td", null, r[3] == null ? "no path" : String(r[3])));
        tr.appendChild(el("td", null, r[4] ? "yes" : "no"));
        tr.appendChild(el("td", null, (A.comm == null || N[r[0]].comm == null) ? "n/a" : (r[5] ? "yes" : "no")));
        function go() { if (which === "A") setPair(st.a, r[0]); else setPair(r[0], st.b); }
        tr.addEventListener("click", go);
        tr.addEventListener("keydown", function (e) { if (e.key === "Enter" || e.key === " ") { e.preventDefault(); go(); } });
        tbody.appendChild(tr);
      });
      tb.appendChild(tbody);
      host.appendChild(tb);
    }

    function renderEvidence() {
      var host = $("w7-evidence");
      host.textContent = "";
      if (st.a == null && st.b == null) {
        host.appendChild(el("p", { class: "w7-hint" }, "Choose a pair above, pick Character A and Character B, or click a dot in either map."));
        return;
      }
      if (st.a == null) { renderSingle(host, "B"); return; }
      if (st.b == null) { renderSingle(host, "A"); return; }
      if (st.a === st.b) {
        renderSingle(host, "A", "Character A and Character B are the same page, so there is nothing to compare. Choose a different Character B (or click a neighbour below).");
        return;
      }
      var A = N[st.a], B = N[st.b];
      var pab = path(st.a, st.b), pba = path(st.b, st.a);
      var rec = lookup(st.a, st.b);
      var dab, dba, cos, kind;
      if (rec) {
        dab = rec.dab; dba = rec.dba; cos = rec.cos; kind = rec.kind;
        // the drawn path must agree with the stored all-pairs distance
        if ((pab ? pab.length - 1 : null) !== dab || (pba ? pba.length - 1 : null) !== dba) {
          if (window.console) console.warn("Week 7: BFS distance differs from stored distance for", A.id, B.id);
        }
      } else {
        dab = pab ? pab.length - 1 : null; dba = pba ? pba.length - 1 : null; cos = neighbourCos(st.a, st.b); kind = "other";
      }

      host.appendChild(el("h3", null, short(st.a) + "  \u2194  " + short(st.b)));
      var grid = el("div", { class: "w7-stats" });
      grid.appendChild(stat("Text similarity (cosine)", cos == null ? "not stored" : cos.toFixed(4),
        cos == null ? "Outside both pages\u2019 top-8 lists and the case lists, so no score is stored for this pair." :
          "Rank of the other page: " + rankIn(st.a, st.b) + " in " + short(st.a) + "\u2019s list, " + rankIn(st.b, st.a) + " in " + short(st.b) + "\u2019s"));
      grid.appendChild(stat("Directed distance A \u2192 B", dText(dab), short(st.a) + " \u2192 " + short(st.b)));
      grid.appendChild(stat("Directed distance B \u2192 A", dText(dba), short(st.b) + " \u2192 " + short(st.a)));
      var sameCl = A.cluster === B.cluster, sameCm = A.comm != null && A.comm === B.comm;
      grid.appendChild(stat("Groups", "E" + (A.cluster + 1) + (sameCl ? " = " : " \u2260 ") + "E" + (B.cluster + 1),
        "Embedding cluster: " + (sameCl ? "same" : "different") + ". Network community " + (A.comm == null ? "none" : "N" + (A.comm + 1)) + " vs " + (B.comm == null ? "none" : "N" + (B.comm + 1)) +
        ": " + (A.comm == null || B.comm == null ? "n/a" : (sameCm ? "same" : "different"))));
      host.appendChild(grid);

      var src = el("p", { class: "w7-source" });
      src.appendChild(el("strong", null, "Source of the numbers: "));
      src.appendChild(document.createTextNode(rec
        ? "cosine and directed distances are stored values from the all-pairs table; only the path drawn below is computed live from the edge list (and checked against the stored distances)."
        : (cos == null ? "no cosine is stored for this pair, so none is shown; " : "cosine is a stored value from the page’s top-8 list; ") +
          "directed distances are computed live from the edge list (a shortest path inside the 370 collected pages), not read from the stored table."));
      host.appendChild(src);

      var pe = el("div", { class: "w7-paths" });
      function pl(txt, p, cls) {
        var d = el("p");
        d.appendChild(el("span", { class: "w7-pathkey " + cls }, txt));
        d.appendChild(document.createTextNode(p ? " " + fmtPath(p) : " no directed path in the collected graph"));
        pe.appendChild(d);
      }
      pl("A \u2192 B", pab, "ab");
      pl("B \u2192 A", pba, "ba");
      host.appendChild(pe);

      var far = [dab, dba].filter(function (x) { return x != null; });
      var why = el("p", { class: "w7-why" });
      if (kind === "featured" || kind === "farDiff") {
        why.appendChild(el("strong", null, "Why this is a disagreement: "));
        why.appendChild(document.createTextNode(
          "the page texts are close (cosine " + cos.toFixed(4) + ", " + (sameCl ? "same embedding cluster" : "different embedding clusters") +
          "), but the shortest directed path takes at least " + Math.min.apply(null, far) + " links in the collected graph" +
          (dab == null || dba == null ? " and does not exist in the other direction" : " in both directions") +
          ", and the pages are in " + (sameCm ? "the same" : "different") + " network communit" + (sameCm ? "y." : "ies.")));
      } else if (kind === "agree") {
        why.appendChild(el("strong", null, "Why this is an agreement: "));
        why.appendChild(document.createTextNode(
          "the page texts are close (cosine " + cos.toFixed(4) + ", same embedding cluster), the pages are in the same network community, and the shortest directed path is only " +
          Math.min.apply(null, far) + (Math.min.apply(null, far) === 1 ? " link." : " links.")));
      } else {
        why.appendChild(el("strong", null, "What the numbers say: "));
        why.appendChild(document.createTextNode(
          (cos == null ? "no stored cosine; " : "cosine " + cos.toFixed(4) + "; ") + "shortest directed path " +
          (far.length ? "A \u2192 B " + dText(dab) + ", B \u2192 A " + dText(dba) : "none in either direction") + (rec ? "" : " (computed live)") + "; embedding cluster " +
          (sameCl ? "same" : "different") + ", network community " + (A.comm == null || B.comm == null ? "n/a" : (sameCm ? "same" : "different")) + "."));
      }
      host.appendChild(why);

      var read = READING[A.id + "|" + B.id] || READING[B.id + "|" + A.id];
      var note = el("div", { class: "w7-reading" });
      if (read && kind === "featured") {
        note.appendChild(el("strong", null, "Reading the pages (our interpretation): "));
        note.appendChild(document.createTextNode(read));
      } else {
        note.appendChild(el("strong", null, "Measured values only. "));
        note.appendChild(document.createTextNode("We have not read these two pages side by side, so no explanation is offered here; check the Wikipedia pages before reading anything into the numbers."));
      }
      host.appendChild(note);
    }

    // ---------- refresh all views
    function refresh() {
      var sel = {};
      if (st.a != null) sel[st.a] = "a";
      if (st.b != null) sel[st.b] = "b";
      N.forEach(function (d, i) {
        var on = inGroup(i), isSel = sel[i] != null;
        [[dotsA[i], colA(i)], [dotsB[i], colB(i)]].forEach(function (p) {
          var c = p[0];
          c.setAttribute("fill", p[1]);
          c.setAttribute("r", st.group && on ? 4.6 : 3.6);
          c.setAttribute("opacity", isSel ? 1 : (st.group ? (on ? 1 : 0.1) : (st.a != null || st.b != null ? 0.55 : 0.9)));
        });
      });
      // selection rings (overlay)
      gSel.a.textContent = ""; gSel.b.textContent = "";
      Object.keys(sel).forEach(function (k) {
        gSel.a.appendChild(sv("circle", { cx: PA[k][0], cy: PA[k][1], r: 7, fill: colA(+k), stroke: "#ffffff", "stroke-width": 2 }));
        gSel.b.appendChild(sv("circle", { cx: PB[k][0], cy: PB[k][1], r: 7, fill: colB(+k), stroke: "#ffffff", "stroke-width": 2 }));
      });

      // labels
      gLab.a.textContent = ""; gLab.b.textContent = "";
      var tag = {};
      if (st.a != null) tag[st.a] = ["A"];
      if (st.b != null) (tag[st.b] = tag[st.b] || []).push("B");
      Object.keys(tag).forEach(function (k) {
        var txt = tag[k].join(" & ") + " \u00B7 " + short(+k);
        label(gLab.a, +k, txt, "#fff", PA);
        label(gLab.b, +k, txt, "#fff", PB);
      });

      // edges + paths in B, connecting line in A
      gPath.textContent = ""; gLineA.textContent = "";
      var onPath = {};
      if (st.a != null && st.b != null && st.a !== st.b) {
        var pab = path(st.a, st.b), pba = path(st.b, st.a);
        [[pab, "#ffffff", "ab"], [pba, "#e0a020", "ba"]].forEach(function (x) {
          var p = x[0];
          if (!p) return;
          for (var k = 0; k + 1 < p.length; k++) {
            onPath[p[k] + ">" + p[k + 1]] = 1;
            var l = sv("line", { x1: PB[p[k]][0], y1: PB[p[k]][1], x2: PB[p[k + 1]][0], y2: PB[p[k + 1]][1], stroke: x[1], "stroke-width": 2, opacity: 0.95, "marker-end": "url(#w7-arr-" + x[2] + ")" });
            gPath.appendChild(l);
          }
          p.forEach(function (i) {
            var c = sv("circle", { cx: PB[i][0], cy: PB[i][1], r: 5, fill: "none", stroke: x[1], "stroke-width": 1.5 });
            gPath.appendChild(c);
          });
        });
        gLineA.appendChild(sv("line", { x1: PA[st.a][0], y1: PA[st.a][1], x2: PA[st.b][0], y2: PA[st.b][1], stroke: "#ffffff", "stroke-width": 1.5, "stroke-dasharray": "4 3", opacity: 0.8 }));
      }
      edgeEls.forEach(function (l, k) {
        var e = D.edges[k];
        l.setAttribute("opacity", st.group ? (inGroup(e[0]) && inGroup(e[1]) ? 1 : 0.2) : 1);
      });

      // legend swatches + active state
      document.querySelectorAll(".w7-leg-sw").forEach(function (s) {
        var k = s.getAttribute("data-sw"), kind = k.indexOf("cluster") === 0 ? "cluster" : "comm", g = +k.replace(kind, "");
        var col = kind === "cluster" ? (st.colour === "comm" ? "transparent" : PAL_A[g]) : (st.colour === "cluster" ? "transparent" : PAL_B[g]);
        s.style.background = col;
        s.style.border = col === "transparent" ? "1px dashed #9a9daa" : "none";
      });
      document.querySelectorAll(".w7-leg-row").forEach(function (r) {
        var on = st.group && r.getAttribute("data-kind") === st.group.kind && +r.getAttribute("data-g") === st.group.id;
        r.classList.toggle("active", !!on);
      });
      var gl = $("w7-group-status");
      gl.textContent = st.group ? "Highlighting " + st.group.label + " (" + N.filter(function (d, i) { return inGroup(i); }).length + " pages in both maps). Click it again to clear." : "";
      document.querySelectorAll(".w7-cell").forEach(function (c) {
        c.classList.toggle("active", !!(st.group && st.group.kind === "cell" && st.group.key === c.getAttribute("data-k")));
      });
      document.querySelectorAll(".w7-case").forEach(function (c) {
        var on = st.a != null && st.b != null && st.a !== st.b && c.getAttribute("data-a") == st.a && c.getAttribute("data-b") == st.b;
        c.classList.toggle("active", on);
        c.setAttribute("aria-pressed", on ? "true" : "false");
      });
      var lab = st.a == null && st.b == null ? "nothing selected" : "highlighting " +
        (st.a == null ? "" : "Character A, " + short(st.a)) + (st.a != null && st.b != null ? " and " : "") + (st.b == null ? "" : "Character B, " + short(st.b));
      svgA.setAttribute("aria-label", "Projection of the page embeddings, coloured by embedding cluster, " + lab);
      svgB.setAttribute("aria-label", "Directed link network, coloured by community, " + lab + " and the shortest directed path");
      var cn = $("w7-colour-note");
      cn.textContent = st.colour === "own"
        ? "Each map uses its own grouping, so colours in the two maps are unrelated."
        : (st.colour === "cluster" ? "Both maps coloured by embedding cluster (E1–E12): the right map shows where text-based groups land in the network."
          : "Both maps coloured by network community (N1–N12): the left map shows where network groups land in embedding space. Pages outside the giant component are grey.");
      // mirror the selection into the two character inputs; they never hold stale text after a refresh
      inA.value = st.a == null ? "" : N[st.a].name;
      inB.value = st.b == null ? "" : N[st.b].name;
      inA.removeAttribute("aria-invalid"); inB.removeAttribute("aria-invalid");
      cstat.textContent = st.a != null && st.a === st.b ? "Character A and Character B are the same page; choose a different one to compare." : "";
      renderEvidence();
    }

    // ---------- the five featured pairs (default) and the further cases
    var chips = $("w7-chips");
    D.featured.forEach(function (r) {
      var b = el("button", { type: "button", class: "btn w7-case", "data-a": r.a, "data-b": r.b, "aria-pressed": "false" });
      b.textContent = short(r.a) + " & " + short(r.b);
      b.addEventListener("click", function () { setPair(r.a, r.b); });
      chips.appendChild(b);
    });
    var sel = $("w7-more");
    var featuredKeys = {};
    D.featured.forEach(function (r) { featuredKeys[r.a + "," + r.b] = featuredKeys[r.b + "," + r.a] = 1; });
    function caseLabel(r, word) {
      var d = [r.dab, r.dba].filter(function (x) { return x != null; });
      return short(r.a) + " & " + short(r.b) + "  \u2014 cos " + r.cos.toFixed(2) + ", " + word + " " + Math.min.apply(null, d);
    }
    D.cases.farDiff.forEach(function (r) {
      if (featuredKeys[r.a + "," + r.b]) return;
      sel.appendChild(el("option", { value: r.a + "," + r.b }, caseLabel(r, "shortest path")));
    });
    D.cases.agree.slice(0, 8).forEach(function (r) {
      $("w7-agree").appendChild(el("option", { value: r.a + "," + r.b }, caseLabel(r, "path")));
    });
    function onMore(e) {
      var v = e.target.value;
      if (!v) return;
      var p = v.split(",");
      setPair(+p[0], +p[1]);
      e.target.value = "";
    }
    sel.addEventListener("change", onMore);
    $("w7-agree-sel").addEventListener("change", onMore);

    // Character A / Character B: two independent inputs sharing one datalist of all 370 names
    var dl = $("w7-names");
    N.forEach(function (d) { dl.appendChild(el("option", { value: d.name })); });

    function resolveName(text) {
      var low = text.toLowerCase(), hits;
      var exact = N.map(function (d, i) { return d.name.toLowerCase() === low ? i : -1; }).filter(function (i) { return i >= 0; });
      if (exact.length === 1) return { i: exact[0] };
      // the name without its bracketed part ("Black Knight" is shared by two pages)
      hits = N.map(function (d, i) { return d.name.replace(/ \(.*\)$/, "").toLowerCase() === low ? i : -1; }).filter(function (i) { return i >= 0; });
      if (hits.length === 1) return { i: hits[0] };
      if (hits.length === 0) hits = N.map(function (d, i) { return d.name.toLowerCase().indexOf(low) >= 0 ? i : -1; }).filter(function (i) { return i >= 0; });
      if (hits.length === 1) return { i: hits[0] };
      return hits.length ? { many: hits } : { none: true };
    }
    function commitChar(which, input) {
      var text = input.value.trim();
      if (!text) { st[which] = null; refresh(); return; }       // emptying a field deselects that character only
      var r = resolveName(text);
      if (r.i != null) { st[which] = r.i; refresh(); return; }
      input.setAttribute("aria-invalid", "true");               // selection stays as it was
      cstat.textContent = r.none
        ? "No character matches \u201C" + text + "\u201D. Pick a name from the list."
        : "\u201C" + text + "\u201D matches " + r.many.length + " characters (" + r.many.slice(0, 4).map(function (i) { return N[i].name; }).join(", ") +
          (r.many.length > 4 ? ", \u2026" : "") + "). Pick one from the list.";
    }
    inA.addEventListener("change", function () { commitChar("a", inA); });
    inB.addEventListener("change", function () { commitChar("b", inB); });

    $("w7-colour").addEventListener("change", function (e) { st.colour = e.target.value; refresh(); });

    // Clear: back to the exact initial state (same code path as the first page load)
    function resetAll() {
      st.colour = "own"; $("w7-colour").value = "own";
      st.group = null; $("w7-cell-list").textContent = "";
      $("w7-more").value = ""; $("w7-agree-sel").value = "";
      st.a = D.featured[0].a; st.b = D.featured[0].b;
      refresh();                                                 // also resets both character inputs and their status
    }
    $("w7-clear").addEventListener("click", resetAll);

    // ---------- cross-tab
    (function crossTab() {
      var host = $("w7-cross"), cross = D.cross, mx = 0;
      cross.forEach(function (r) { r.forEach(function (v) { if (v > mx) mx = v; }); });
      var t = el("table", { class: "w7-cross" });
      var hr = el("tr"); hr.appendChild(el("th", { class: "corner" }, "cluster ↓ / community →"));
      for (var m = 0; m < K; m++) {
        var th = el("th", null, "N" + (m + 1));
        th.style.borderBottom = "3px solid " + PAL_B[m];
        hr.appendChild(th);
      }
      hr.appendChild(el("th", null, "total"));
      t.appendChild(hr);
      for (var c = 0; c < K; c++) {
        var tr = el("tr");
        var rh = el("th", null, "E" + (c + 1)); rh.style.borderLeft = "3px solid " + PAL_A[c];
        tr.appendChild(rh);
        var tot = 0;
        for (m = 0; m < K; m++) {
          var v = cross[c][m]; tot += v;
          var td = el("td", { class: "w7-cell", "data-k": c + "," + m }, v ? String(v) : "");
          td.style.background = v ? "rgba(77,124,255," + (0.12 + 0.75 * v / mx).toFixed(2) + ")" : "transparent";
          if (v) {
            (function (c, m, v) {
              td.style.cursor = "pointer";
              td.addEventListener("click", function () {
                var same = st.group && st.group.kind === "cell" && st.group.key === c + "," + m;
                st.group = same ? null : { kind: "cell", c: c, m: m, key: c + "," + m, label: "the " + v + " pages in embedding cluster E" + (c + 1) + " and community N" + (m + 1) };
                refresh();
                var names = N.filter(function (d) { return d.cluster === c && d.comm === m; }).map(function (d) { return d.name; });
                $("w7-cell-list").textContent = same ? "" : "E" + (c + 1) + " ∩ N" + (m + 1) + ": " + names.join(", ");
              });
            })(c, m, v);
          }
          tr.appendChild(td);
        }
        tr.appendChild(el("td", { class: "tot" }, String(tot)));
        t.appendChild(tr);
      }
      host.appendChild(t);
    })();

    resetAll();
    window.__w7 = { st: st, N: N, D: D, setPair: setPair, pick: pick, resetAll: resetAll };   // for console inspection
  }
})();
