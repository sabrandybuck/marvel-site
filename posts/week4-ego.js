/*
 * Week 4 Aristotle ego explorable — "the philosopher holding the web".
 *
 * The static figure (assets/week4/week4_aristotle_ego.png) was drawn offline
 * by analysis/build_week4.py: Aristotle at the centre, his 300 giant-component
 * neighbours placed on a ring ordered by (Louvain community, descending
 * degree), one spoke per neighbour coloured by the neighbour's community
 * (matplotlib tab20 in size-rank order), the neighbours' links to each other
 * drawn as faint grey chords, node sizes scaling with giant degree, famous
 * neighbours labelled. This file rebuilds that layout in the browser and
 * renders it as a CANVAS explorable (house style of week4-backbone.js): one
 * 2D canvas redrawn per event, hover found with a nearest-node scan over the
 * 301 nodes — the canvas half of the rendering A/B that the alluvial settled
 * for SVG. The 1,540 grey chords cost one batched path; the SVG twin would
 * have shipped ~2.5k live elements plus listeners for the same scene.
 *
 * Interaction:
 *   - hover any node: tooltip with name, Louvain community, giant degree and
 *     the union weight of Aristotle's link to them; everything unconnected
 *     dims. Hover Aristotle for his own totals.
 *   - click pins (same node again, Esc or background click clears).
 *   - the seven legend chips pin whole communities; focus buttons jump to
 *     famous neighbours.
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

  // matplotlib tab20 as hex — the palette figure2() colours Louvain with.
  var TAB20 = [
    "#1f77b4", "#aec7e8", "#ff7f0e", "#ffbb78", "#2ca02c", "#98df8a",
    "#d62728", "#ff9896", "#9467bd", "#c5b0d5", "#8c564b", "#c49c94",
    "#e377c2", "#f7b6d2", "#7f7f7f", "#c7c7c7", "#bcbd22", "#dbdb8d",
    "#17becf", "#9edae5"
  ];
  function tab20Hex(i) { return TAB20[((i % 20) + 20) % 20]; }

  var BG = "#ffffff";
  var INK = "#212529";
  var GREY = "#8a8d96";
  var CENTER = "#222222";

  // runtime-built lookup: avoids writing HTML entity strings literally,
  // which the authoring pipeline would decode back into raw characters.
  var ESCAPES = { };
  ESCAPES["&"] = "&" + "amp;";
  ESCAPES["<"] = "&" + "lt;";
  ESCAPES[">"] = "&" + "gt;";
  ESCAPES[String.fromCharCode(34)] = "&" + "quot;";
  ESCAPES["'"] = "&" + "#39;";
  function escapeHtml(s) {
    return String(s).replace(/[&<>"']/g, function (c) { return ESCAPES[c]; });
  }
  function fmtInt(n) { return String(Math.round(n)).replace(/\B(?=(\d{3})+(?!\d))/g, ","); }

  // FAMOUS + SHORT, replicated from analysis/build_week4.py (sname())
  var FAMOUS = new Set([
    "Aristotle", "Plato", "Socrates", "Immanuel Kant", "Karl Marx",
    "Friedrich Nietzsche", "David Hume", "Bertrand Russell",
    "Thomas Aquinas", "Ludwig Wittgenstein", "Georg Wilhelm Friedrich Hegel",
    "Baruch Spinoza", "Confucius", "Laozi", "Zhu Xi", "René Descartes",
    "John Locke", "John Stuart Mill", "Augustine of Hippo", "Averroes",
    "Avicenna", "Al-Ghazali", "Al-Farabi", "Al-Kindi", "Moses Maimonides",
    "William of Ockham", "John Duns Scotus", "Gottfried Wilhelm Leibniz",
    "Gottlob Frege", "Martin Heidegger", "Edmund Husserl",
    "Arthur Schopenhauer", "Søren Kierkegaard", "Jean-Paul Sartre",
    "Michel Foucault", "Jacques Derrida", "Gilles Deleuze", "Henri Bergson",
    "Émile Durkheim", "Auguste Comte", "Friedrich Engels", "Vladimir Lenin",
    "Karl Popper", "Thomas Kuhn", "Willard Van Orman Quine", "Saul Kripke",
    "David Lewis", "Hilary Putnam", "John Rawls", "Hannah Arendt",
    "Jürgen Habermas", "Zeno of Citium", "Epictetus", "Chrysippus",
    "Marcus Aurelius", "Cicero", "Seneca the Younger", "Plotinus",
    "Epicurus", "Lucretius", "Democritus", "Heraclitus", "Parmenides",
    "Pythagoras", "John Dewey", "William James", "Charles Sanders Peirce",
    "Rudolf Carnap", "George Berkeley", "Denis Diderot", "Voltaire",
    "Jean-Jacques Rousseau", "Montesquieu", "Ayn Rand", "Sigmund Freud",
    "Charles Darwin", "Adam Smith", "Edmund Burke", "Alexius Meinong",
    "Franz Brentano", "Max Scheler", "Wilfrid Sellars", "Nelson Goodman",
    "Alfred North Whitehead", "Axel Hägerström", "Simone de Beauvoir",
    "Maurice Merleau-Ponty", "Emmanuel Levinas", "Hans-Georg Gadamer",
    "Anicius Manlius Severinus Boethius", "Averroes",
    "Porphyry (philosopher)", "Proclus", "Themistius",
    "Alexander of Aphrodisias", "Simplicius of Cilicia", "John Philoponus",
    "Diogenes Laertius", "Plutarch", "Theophrastus", "Sextus Empiricus",
    "Xenophanes", "Anaxagoras", "Melissus of Samos", "Simon of Faversham",
    "Bruno Bauer", "Friedrich Wilhelm Joseph Schelling", "Johann Gottlieb Fichte",
    "Erasmus", "Isaac Newton"
  ]);
  var SHORT_PAIRS = [
    ["Immanuel Kant", "Kant"], ["Karl Marx", "Marx"],
    ["Friedrich Nietzsche", "Nietzsche"], ["David Hume", "Hume"],
    ["Thomas Aquinas", "Aquinas"], ["Ludwig Wittgenstein", "Wittgenstein"],
    ["Georg Wilhelm Friedrich Hegel", "Hegel"], ["Baruch Spinoza", "Spinoza"],
    ["René Descartes", "Descartes"], ["John Stuart Mill", "J.S. Mill"],
    ["Augustine of Hippo", "Augustine"], ["Moses Maimonides", "Maimonides"],
    ["William of Ockham", "Ockham"], ["John Duns Scotus", "Duns Scotus"],
    ["Gottfried Wilhelm Leibniz", "Leibniz"],
    ["Arthur Schopenhauer", "Schopenhauer"],
    ["Søren Kierkegaard", "Kierkegaard"], ["Jean-Paul Sartre", "Sartre"],
    ["Zeno of Citium", "Zeno"], ["Seneca the Younger", "Seneca"],
    ["Marcus Aurelius", "M. Aurelius"],
    ["Porphyry (philosopher)", "Porphyry"],
    ["Alexander of Aphrodisias", "Alex. Aphrodisias"],
    ["Simplicius of Cilicia", "Simplicius"],
    ["Diogenes Laertius", "D. Laertius"],
    ["Charles Sanders Peirce", "Peirce"],
    ["Willard Van Orman Quine", "Quine"],
    ["Alfred North Whitehead", "Whitehead"],
    ["Anicius Manlius Severinus Boethius", "Boethius"],
    ["Marcelino Menéndez y Pelayo", "Menéndez Pelayo"],
    ["Hermann Friedrich Wilhelm Hinrichs", "Hinrichs"]
  ];
  function sname(name) {
    for (var i = 0; i < SHORT_PAIRS.length; i++) {
      if (name === SHORT_PAIRS[i][0]) return SHORT_PAIRS[i][1];
    }
    for (i = 0; i < SHORT_PAIRS.length; i++) {
      if (name.indexOf(SHORT_PAIRS[i][0]) === 0) return SHORT_PAIRS[i][1];
    }
    return name;
  }

  // =========================================================================
  // Scene: ring layout, community colours, grey chords — all from the JSON
  // =========================================================================
  // Returns { lay, aris, names, ring[], inner[[ringA,ringB]], commMeta,
  //           shortName }
  function buildScene(s1, s2, s3i) {
    var names = s3i.node_names;
    var n = names.length;
    var edgeU = s3i.edge_u, edgeV = s3i.edge_v, edgeW = s3i.edge_w;
    var m = edgeU.length;

    var labOf = {};          // display name -> louvain label id
    Object.keys(s1.louvain_labels).forEach(function (nm) {
      labOf[nm] = s1.louvain_labels[nm];
    });

    // Aristotle's node index in the giant list
    var aris = names.indexOf("Aristotle");
    if (aris < 0) throw new Error("Aristotle not in giant component names");

    // giant degrees + Aristotle's neighbour list with their weights
    var deg = new Int32Array(n);
    var nbWeight = {};
    var nbrs = [];
    for (var i = 0; i < m; i++) {
      var u = edgeU[i], v = edgeV[i];
      deg[u]++; deg[v]++;
      if (u === aris) { nbrs.push(v); nbWeight[v] = edgeW[i]; }
      else if (v === aris) { nbrs.push(u); nbWeight[u] = edgeW[i]; }
    }

    // ring order — figure2's exact rule: neighbours ascending by node index,
    // then a STABLE sort by (community, descending degree).
    nbrs.sort(function (a, b) { return a - b; });
    nbrs.sort(function (a, b) {
      var la = labOf[names[a]] || 0, lb = labOf[names[b]] || 0;
      return (la - lb) || (deg[b] - deg[a]);
    });

    // tab20 colour per community: rank by community size (as figure1/figure2)
    var commCounts = {};
    Object.keys(s1.louvain_labels).forEach(function (nm) {
      var g = s1.louvain_labels[nm];
      commCounts[g] = (commCounts[g] || 0) + 1;
    });
    var commOrder = Object.keys(commCounts).map(Number).sort(function (a, b) {
      return commCounts[b] - commCounts[a] || a - b;
    });
    var rankOfComm = {};
    commOrder.forEach(function (g, k) { rankOfComm[g] = k; });

    var LAY = { W: LAYW, H: LAYH, cx: 500, cy: 520, R: 380 };

    var ring = nbrs.map(function (idx, j) {
      var ang = 2 * Math.PI * j / nbrs.length;
      var lab = labOf[names[idx]] || 0;
      return {
        idx: idx, gi: lab,
        x: LAY.cx + Math.cos(ang) * LAY.R,
        y: LAY.cy + Math.sin(ang) * LAY.R,
        deg: deg[idx],
        w: nbWeight[idx] || 0,
        marked: FAMOUS.has(names[idx]) || deg[idx] > 60,
        r: 4 + Math.sqrt(deg[idx]) * 1.1
      };
    });

    // grey chords: edges with both endpoints among the neighbours. The frozen
    // edge list stores each undirected pair once with arbitrary orientation,
    // so normalise on ring slot order and de-duplicate explicitly.
    var inRing = new Set(ring.map(function (rN) { return rN.idx; }));
    var ringPos = {};
    ring.forEach(function (rN, j) { ringPos[rN.idx] = j; });
    var inner = [];
    var seenPair = new Set();
    for (i = 0; i < m; i++) {
      var a = ringPos[edgeU[i]], b = ringPos[edgeV[i]];
      if (a === undefined || b === undefined || a === b) continue;
      var lo = Math.min(a, b), hi = Math.max(a, b);
      var key = lo + "|" + hi;
      if (seenPair.has(key)) continue;
      seenPair.add(key);
      inner.push([lo, hi]);
    }

    // legend data: communities present among the 300, ordered by count —
    // the frozen strings in section2 match the static figure's legend.
    var byCount = Object.keys(s2.neighbor_community_counts)
      .map(function (g) { return { g: +g, count: s2.neighbor_community_counts[g] }; })
      .sort(function (p, q) { return q.count - p.count || p.g - q.g; });
    var commMeta = {};
    byCount.forEach(function (p) {
      commMeta[p.g] = {
        gi: p.g,
        rank: rankOfComm[p.g] !== undefined ? rankOfComm[p.g] : 0,
        count: p.count,
        sample: s2.neighbor_communities[p.g] || [],
        color: tab20Hex(rankOfComm[p.g] !== undefined ? rankOfComm[p.g] : 0)
      };
    });

    return {
      lay: LAY, aris: aris, names: names,
      ring: ring, inner: inner, commMeta: commMeta,
      shortName: sname
    };
  }

  // =========================================================================
  // Canvas renderer
  // =========================================================================
  var LAYW = 1000, LAYH = 1000;

  function renderCanvas(stage, scene) {
    var canvas = document.createElement("canvas");
    canvas.style.cssText = "width:100%;height:100%;display:block;background:" + BG + ";";
    canvas.setAttribute("role", "img");
    canvas.setAttribute("aria-label",
      "Aristotle's ego network: 300 neighbours on a ring, spokes coloured by Louvain community");
    stage.appendChild(canvas);
    var ctx = canvas.getContext("2d");
    var tip = makeTooltip(stage);

    function draw() {
      var dpr = window.devicePixelRatio || 1;
      var r = stage.getBoundingClientRect();
      var dW = Math.max(1, Math.round(r.width * dpr));
      var dH = Math.max(1, Math.round(r.height * dpr));
      if (canvas.width !== dW || canvas.height !== dH) {
        canvas.width = dW; canvas.height = dH;
      }
      var s = Math.min(r.width / LAYW, r.height / LAYH);
      var ox = (r.width - LAYW * s) / 2;
      var oy = (r.height - LAYH * s) / 2;
      ctx.setTransform(dpr, 0, 0, dpr, 0, 0);
      ctx.fillStyle = BG;
      ctx.fillRect(0, 0, r.width, r.height);
      ctx.setTransform(dpr * s, 0, 0, dpr * s, dpr * ox, dpr * oy);

      var keepN = new Set(), keepInner = false;
      if (active) {
        if (active.kind === "comm") {
          scene.ring.forEach(function (rN) {
            if (rN.gi === active.comm) keepN.add(rN.idx);
          });
        } else {
          keepN.add(active.id);
          keepInner = true;
        }
      }

      // grey chords between neighbours
      ctx.globalAlpha = (active ? (keepInner ? 0.10 : 0.02) : 0.10);
      ctx.beginPath();
      scene.inner.forEach(function (pr) {
        var A = scene.ring[pr[0]], B = scene.ring[pr[1]];
        ctx.moveTo(A.x, A.y);
        ctx.lineTo(B.x, B.y);
      });
      ctx.strokeStyle = GREY;
      ctx.lineWidth = 0.7;
      ctx.stroke();

      // spokes from the centre, coloured by the neighbour's community
      scene.ring.forEach(function (rN) {
        ctx.globalAlpha = (!active || keepN.has(rN.idx)) ? 0.55 : 0.06;
        ctx.beginPath();
        ctx.moveTo(scene.lay.cx, scene.lay.cy);
        ctx.lineTo(rN.x, rN.y);
        ctx.strokeStyle = scene.commMeta[rN.gi]
          ? scene.commMeta[rN.gi].color : tab20Hex(rN.gi);
        ctx.lineWidth = 0.9;
        ctx.stroke();
      });
      ctx.globalAlpha = 1;

      // nodes
      scene.ring.forEach(function (rN) {
        ctx.globalAlpha = (!active || keepN.has(rN.idx)) ? 1 : 0.15;
        ctx.beginPath();
        ctx.arc(rN.x, rN.y, rN.r, 0, 6.283185);
        ctx.fillStyle = scene.commMeta[rN.gi]
          ? scene.commMeta[rN.gi].color : tab20Hex(rN.gi);
        ctx.fill();
        ctx.lineWidth = 0.8;
        ctx.strokeStyle = "#ffffff";
        ctx.stroke();
      });
      ctx.globalAlpha = 1;

      // Aristotle centre: star marker + label
      drawStar(ctx, scene.lay.cx, scene.lay.cy, 17, CENTER);
      ctx.fillStyle = INK;
      ctx.font = "700 26px -apple-system, 'Segoe UI', Roboto, sans-serif";
      ctx.textAlign = "center";
      ctx.fillText("Aristotle", scene.lay.cx, scene.lay.cy + 46);

      // static famous labels (dim with the nodes they belong to)
      ctx.font = "24px -apple-system, 'Segoe UI', Roboto, sans-serif";
      scene.ring.forEach(function (rN) {
        if (!rN.marked) return;
        var dimmed = active && !keepN.has(rN.idx);
        ctx.globalAlpha = dimmed ? 0.18 : 0.92;
        ctx.fillStyle = dimmed ? GREY : INK;
        var dx = 0, anchor = "center", dy = 0;
        if (rN.x > scene.lay.cx + 6) { anchor = "left"; dx = 8; }
        else if (rN.x < scene.lay.cx - 6) { anchor = "right"; dx = -8; }
        dy = rN.y > scene.lay.cy ? 18 : -12;
        ctx.textAlign = anchor;
        ctx.fillText(scene.shortName(scene.names[rN.idx]),
          rN.x + dx, rN.y + dy);
      });
      ctx.globalAlpha = 1;
      ctx.textAlign = "start";

      // hover ring (drawn last)
      if (active && active.kind === "node" && active.id !== scene.aris) {
        var hr = scene.ring.find(function (rN) { return rN.idx === active.id; });
        if (hr) {
          ctx.beginPath();
          ctx.arc(hr.x, hr.y, hr.r + 5, 0, 6.283185);
          ctx.strokeStyle = "rgba(33,37,41,0.7)";
          ctx.lineWidth = 1.7;
          ctx.stroke();
        }
      }
    }

    function drawStar(ctx, x, y, R, color) {
      var r2 = R * 0.42;
      ctx.beginPath();
      for (var k = 0; k < 10; k++) {
        var ang = -Math.PI / 2 + k * Math.PI / 5;
        var rad = (k % 2 === 0) ? R : r2;
        var px = x + Math.cos(ang) * rad;
        var py = y + Math.sin(ang) * rad;
        if (k === 0) ctx.moveTo(px, py); else ctx.lineTo(px, py);
      }
      ctx.closePath();
      ctx.fillStyle = color;
      ctx.fill();
    }

    // ---- hit testing ---------------------------------------------------------
    function toScene(ev) {
      var r = stage.getBoundingClientRect();
      var s = Math.min(r.width / LAYW, r.height / LAYH);
      var ox = (r.width - LAYW * s) / 2;
      var oy = (r.height - LAYH * s) / 2;
      return {
        x: (ev.clientX - r.left - ox) / s,
        y: (ev.clientY - r.top - oy) / s,
        px: ev.clientX - r.left,
        py: ev.clientY - r.top
      };
    }

    function pickNode(x, y) {
      var best = null, bestD = 18;
      scene.ring.forEach(function (rN) {
        var dx = rN.x - x, dy = rN.y - y;
        var d = Math.sqrt(dx * dx + dy * dy);
        if (d < bestD) { bestD = d; best = rN; }
      });
      if (best) return { kind: "node", id: best.idx };
      var dx2 = scene.lay.cx - x, dy2 = scene.lay.cy - y;
      if (Math.sqrt(dx2 * dx2 + dy2 * dy2) < 40) {
        return { kind: "node", id: scene.aris };
      }
      return null;
    }

    var active = null, pinned = false;

    function hitContent(hit) {
      var esc = escapeHtml;
      if (hit.kind === "comm") {
        var m = scene.commMeta[hit.comm];
        return "<strong>Louvain community c" + hit.comm + "</strong><br>" +
          fmtInt(m.count) + " of Aristotle's 300 neighbours" +
          "<br><span style='opacity:.8'>" +
          (m.sample.length
            ? "e.g. " + esc(m.sample.slice(0, 4).map(scene.shortName).join(", "))
            : "no famous members recorded") + "</span>";
      }
      var rN = scene.ring.find(function (q) { return q.idx === hit.id; });
      if (!rN) {           // Aristotle himself (or the centre hover)
        var nComms = Object.keys(scene.commMeta).length;
        return "<strong>Aristotle</strong><br>" +
          fmtInt(scene.ring.length) + " giant neighbours &middot; 521 weighted" +
          "<br><span style='opacity:.8'>links land in " + nComMs(nComms) +
          " of his 9 communities</span>";
      }
      var meta = scene.commMeta[rN.gi];
      return "<strong>" + esc(scene.shortName(scene.names[rN.idx])) + "</strong><br>" +
        "Louvain community c" + rN.gi +
        " &middot; giant degree " + fmtInt(rN.deg) +
        "<br>Aristotle link weight: " + fmtInt(rN.w) +
        "<br><span style='opacity:.8'>c" + rN.gi + " supplies " +
        fmtInt(meta.count) + " of his 300 neighbours</span>";
    }
    function nComMs(c) { return c === 7 ? "seven" : c; }

    // ---- events ---------------------------------------------------------------
    canvas.addEventListener("mousemove", function (ev) {
      var sc = toScene(ev);
      var hit = pickNode(sc.x, sc.y);
      if (hit) {
        canvas.style.cursor = "pointer";
        if (!pinned) {
          var changed = !active || active.kind !== hit.kind || active.id !== hit.id;
          active = hit;
          if (changed || tip.isPinnedFor()) draw();
          tip.show(hitContent(hit), sc.px, sc.py);
        } else {
          tip.move(sc.px, sc.py);
        }
      } else {
        canvas.style.cursor = "default";
        if (active && !pinned) { active = null; draw(); }
        if (!pinned) tip.hide();
      }
    });
    canvas.addEventListener("mouseleave", function () {
      if (!pinned) { active = null; tip.hide(); draw(); }
    });
    canvas.addEventListener("click", function (ev) {
      var sc = toScene(ev);
      var hit = pickNode(sc.x, sc.y);
      if (!hit) { clear(); return; }
      if (pinned && active && active.id === hit.id) { clear(); return; }
      active = hit;
      pinned = true;
      draw();
      tip.show(hitContent(hit), sc.px, sc.py);
      tip.markPinned();
    });
    document.addEventListener("keydown", function (ev) {
      if (ev.key === "Escape") clear();
    });
    function clear() {
      pinned = false;
      active = null;
      tip.hideHard();
      draw();
    }

    if (window.ResizeObserver) {
      var ro = new ResizeObserver(function () { draw(); });
      ro.observe(stage);
    }
    draw();

    // external pin control (legend chips + focus buttons)
    return {
      canvas: canvas,
      pin(hit) {
        active = hit;
        pinned = true;
        draw();
        tip.show(hitContent(hit), 20, 24);
        tip.markPinned();
      },
      isPinnedOn(hit) {
        return pinned && !!active &&
          (hit.kind === "comm" ? active.kind === "comm" && active.comm === hit.comm
                               : active.kind === "node" && active.id === hit.id);
      },
      unpin: function () { pinned = false; active = null; tip.hideHard(); draw(); }
    };
  }

  // shared tooltip (same visual language as the alluvial explorables)
  function makeTooltip(stage) {
    var el = document.createElement("div");
    el.className = "ego-tip";
    el.style.cssText = "display:none;position:absolute;pointer-events:none;" +
      "background:#212529;color:#f8f9fa;font-size:12px;line-height:1.5;" +
      "padding:8px 11px;border-radius:8px;z-index:6;" +
      "box-shadow:0 4px 18px rgba(0,0,0,.35);max-width:250px;";
    stage.appendChild(el);
    var wasPinned = false;
    function show(html, x, y) {
      el.innerHTML = html;
      el.style.display = "block";
      move(x, y);
    }
    function move(x, y) {
      el.style.left = Math.max(4, Math.min(x + 14, stage.clientWidth - 258)) + "px";
      el.style.top = Math.max(4, y - 12) + "px";
    }
    function hide() { if (!wasPinned) el.style.display = "none"; }
    function markPinned() { wasPinned = true; }
    function hideHard() { wasPinned = false; el.style.display = "none"; }
    return { show: show, move: move, hide: hide, markPinned: markPinned, hideHard: hideHard };
  }

  // =========================================================================
  // Legend chips + focus buttons
  // =========================================================================
  function wireLegend(scene, view) {
    var host = document.getElementById("ego-chips");
    if (host) {
      Object.keys(scene.commMeta)
        .sort(function (a, b) {
          return scene.commMeta[b].count - scene.commMeta[a].count || (+a) - (+b);
        })
        .forEach(function (g) {
          var meta = scene.commMeta[g];
          var chip = document.createElement("button");
          chip.type = "button";
          chip.className = "btn ego-chip";
          chip.setAttribute("data-ego-comm", g);
          chip.innerHTML = "<span style='display:inline-block;width:10px;height:10px;" +
            "border-radius:50%;background:" + meta.color + ";margin-right:6px;'></span>" +
            "c" + g + " (" + meta.count + " nbrs" +
            (meta.sample.length ? ": " + escapeHtml(meta.sample.slice(0, 3).join(", ")) : "") + ")";
          chip.addEventListener("click", function () {
            if (view.isPinnedOn({ kind: "comm", comm: +g })) view.unpin();
            else view.pin({ kind: "comm", comm: +g });
          });
          host.appendChild(chip);
        });
    }

    Array.prototype.slice.call(document.querySelectorAll("[data-ego-jump]"))
      .forEach(function (b) {
        b.addEventListener("click", function () {
          var nm = b.getAttribute("data-ego-jump");
          var rN = scene.ring.find(function (q) { return scene.names[q.idx] === nm; });
          if (!rN) return;
          view.pin({ kind: "node", id: rN.idx });
          var fig = document.getElementById("ego-explorer");
          if (fig) fig.scrollIntoView({
            behavior: REDUCED_MOTION ? "auto" : "smooth", block: "start"
          });
        });
      });
  }

  // =========================================================================
  // Boot
  // =========================================================================
  function showError(err) {
    var host = document.getElementById("ego-error");
    if (host) {
      host.style.display = "block";
      host.textContent = "Explorable failed to load: " + err.message;
    }
    if (window.console) console.error(err);
  }

  function setup(summary) {
    var scene = buildScene(summary.section1, summary.section2,
                           summary.section3_interactive);
    var stage = document.getElementById("ego-stage");
    if (!stage) throw new Error("ego stage missing");
    var view = renderCanvas(stage, scene);
    wireLegend(scene, view);
  }

  fetchJson("../data/philosophers/week4_summary.json")
    .then(function (summary) {
      if (!summary.section1 || !summary.section2 || !summary.section3_interactive) {
        throw new Error("sections 1/2/3 missing (rerun analysis/build_week4.py)");
      }
      setup(summary);
    })
    .catch(showError);
})();