/*
 * Week 4 flows explorable — "With weights vs without", as an SVG alluvial.
 *
 * The original static figure (assets/week4/week4_weighted_vs_unweighted.png,
 * since removed from the site) was drawn offline by analysis/build_week4.py with the same draw_alluvial() the
 * Louvain-vs-Infomap figure uses: Louvain's 9 weighted communities (left)
 * against Louvain's 8 unweighted communities (right), ribbons for every
 * (left, right) cell sharing at least MIN_RIBBON members, slotted by
 * descending shared count, coloured with matplotlib's tab20 in stacking
 * order. This file rebuilds that geometry in the browser from section4 of
 * data/philosophers/week4_summary.json — block heights and ribbon widths ARE
 * the frozen numbers — and renders it as an SVG explorable in exactly the
 * style of week4-alluvial.js (native per-element hover, hover-dimming,
 * click-to-pin, Esc/background clear).
 *
 * Extras specific to this figure:
 *   - a "find a philosopher" box (datalist of all 1,374 names): typed names
 *     highlight the ribbon their membership flows along, so you can see at a
 *     glance whether a philosopher's community number actually moved when the
 *     weights vanished (1,217 of 1,374 did).
 *
 * Logic twins of week4-alluvial.js are deliberately duplicated rather than
 * shared: each explorer stays one self-contained script the way week2.js,
 * week3.js and week4-backbone.js do.
 */
(function () {
  "use strict";

  function fetchJson(url) {
    return fetch(url).then(function (r) {
      if (!r.ok) throw new Error("HTTP " + r.status + " fetching " + url);
      return r.json();
    });
  }

  // matplotlib tab20 as hex — the palette draw_alluvial() uses.
  var TAB20 = [
    "#1f77b4", "#aec7e8", "#ff7f0e", "#ffbb78", "#2ca02c", "#98df8a",
    "#d62728", "#ff9896", "#9467bd", "#c5b0d5", "#8c564b", "#c49c94",
    "#e377c2", "#f7b6d2", "#7f7f7f", "#c7c7c7", "#bcbd22", "#dbdb8d",
    "#17becf", "#9edae5"
  ];
  function tab20Hex(i) { return TAB20[((i % 20) + 20) % 20]; }

  var MIN_RIBBON = 3;   // draw_alluvial's min_ribbon
  var GAP = 2.0;        // block gap in member units (draw_alluvial's gap)
  var BG = "transparent";  // figures sit on the page's dark theme
  var INK = "#e9eaee";  // var(--text)

  // runtime-built lookup: avoids writing entity strings literally,
  // which the authoring pipeline would decode back into raw characters.
  var ESCAPES = { };
  ESCAPES["&"] = "&" + "amp;";
  ESCAPES["<"] = "&" + "lt;";
  ESCAPES[">"] = "&" + "gt;";
  ESCAPES[String.fromCharCode(34)] = "&" + "quot;";
  ESCAPES["'"] = "&" + "#39;";
  function escapeHtml(s) {
    return String(s).replace(/["<>']/g, function (c) { return ESCAPES[c]; });
  }
  function fmtInt(n) { return String(Math.round(n)).replace(/\B(?=(\d{3})+(?!\d))/g, ","); }

  // sname()-shortening rules replicated from analysis/build_week4.py
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
  function labelFor(members, maxNames) {
    var seen = new Set(), out = [];
    members.forEach(function (m) {
      if (!FAMOUS.has(m)) return;
      var s = sname(m);
      if (!seen.has(s)) { seen.add(s); out.push(s); }
    });
    return out.length ? out.slice(0, maxNames).join(", ") : "misc";
  }

  // =========================================================================
  // Scene — same shape as week4-alluvial.js, but section4-partitioned
  // =========================================================================
  function buildScene(s4) {
    var lw = s4.labels_weighted, lu = s4.labels_unweighted;

    var membersL = {}, membersR = {};
    Object.keys(lw).forEach(function (n) {
      (membersL[lw[n]] = membersL[lw[n]] || []).push(n);
    });
    Object.keys(lu).forEach(function (n) {
      (membersR[lu[n]] = membersR[lu[n]] || []).push(n);
    });

    var leftIds = Object.keys(membersL).map(Number).sort(function (a, b) {
      return membersL[b].length - membersL[a].length || a - b;
    });
    var rightIds = Object.keys(membersR).map(Number).sort(function (a, b) {
      return membersR[b].length - membersR[a].length || a - b;
    });
    var indexOfL = {}, indexOfR = {};
    leftIds.forEach(function (id, i) { indexOfL[id] = i; });
    rightIds.forEach(function (id, i) { indexOfR[id] = i; });

    var yL = {}, yR = {}, y = 0, i;
    for (i = 0; i < leftIds.length; i++) {
      yL[leftIds[i]] = y;
      y += membersL[leftIds[i]].length + GAP;
    }
    var totalH = y - GAP;
    y = 0;
    for (i = 0; i < rightIds.length; i++) {
      yR[rightIds[i]] = y;
      y += membersR[rightIds[i]].length + GAP;
    }
    var totalRightH = y - GAP;

    var cells = {};
    Object.keys(lw).forEach(function (n) {
      var k = lw[n] + "|" + lu[n];
      (cells[k] = cells[k] || []).push(n);
    });

    var ribbons = Object.keys(cells).map(function (k) {
      var p = k.split("|");
      return { l: +p[0], r: +p[1], members: cells[k] };
    }).filter(function (rb) { return rb.members.length >= MIN_RIBBON; });

    ribbons.sort(function (a, b) {
      return (indexOfL[a.l] - indexOfL[b.l]) ||
             (b.members.length - a.members.length) ||
             (indexOfR[a.r] - indexOfR[b.r]);
    });
    var usedL = {}, usedR = {};
    ribbons.forEach(function (rb) {
      rb.yl = yL[rb.l] + (usedL[rb.l] || 0);
      rb.yr = yR[rb.r] + (usedR[rb.r] || 0);
      usedL[rb.l] = (usedL[rb.l] || 0) + rb.members.length;
      usedR[rb.r] = (usedR[rb.r] || 0) + rb.members.length;
      rb.key = rb.l + "|" + rb.r;
    });

    function blockMeta(ids, members, stack, descriptors, labelMax, side) {
      return ids.map(function (id, i) {
        var m = members[id];
        var fam;
        if (Array.isArray(descriptors) && i < descriptors.length &&
            descriptors[i].size === m.length) {
          fam = descriptors[i].famous.slice(0, labelMax).join(", ") || "misc";
        } else {
          fam = labelFor(m, labelMax);
        }
        return {
          id: id, y: stack[id], h: m.length, size: m.length,
          members: m, famous: fam, side: side
        };
      });
    }
    var left = blockMeta(leftIds, membersL, yL, s4.weighted_groups, 3, "L");
    var right = blockMeta(rightIds, membersR, yR, s4.unweighted_groups, 2, "R");
    left.forEach(function (b, i) {
      b.si = i; b.key = "L" + b.id;
      b.title = "Weighted Louvain community " + b.id;
    });
    right.forEach(function (b, i) {
      b.si = i; b.key = "R" + b.id;
      b.title = "Unweighted Louvain community " + b.id;
    });

    var byKey = {};
    left.forEach(function (b) { byKey[b.key] = b; });
    right.forEach(function (b) { byKey[b.key] = b; });

    ribbons.forEach(function (rb) {
      var bl = byKey["L" + rb.l], br = byKey["R" + rb.r];
      rb.titleL = bl.title + " — " + bl.famous;
      rb.titleR = br.title + " — " + br.famous;
    });

    // per-member index: name -> ribbon (for the search box)
    var ribbonOfMember = {};
    ribbons.forEach(function (rb) {
      rb.members.forEach(function (m) { ribbonOfMember[m] = rb; });
    });

    return {
      totalH: totalH, totalRightH: totalRightH,
      left: left, right: right,
      ribbons: ribbons, byKey: byKey,
      ribbonOfMember: ribbonOfMember,
      memberNames: Object.keys(lw),
      shortName: sname
    };
  }

  // =========================================================================
  // Layout constants — same 1000x1360 scene as week4-alluvial.js
  // =========================================================================
  var LAY = {
    W: 1000, H: 1360,
    padTop: 64,
    xL0: 40, xL1: 190,
    xR0: 810, xR1: 960,
    labelGap: 14,
    blockLabelMin: 12,
    bottomPad: 24
  };
  function unitFor(scene) {
    var colUnits = Math.max(scene.totalH, scene.totalRightH) + 2 * GAP;
    return (LAY.H - LAY.padTop - LAY.bottomPad) / colUnits;
  }
  function YOf(v, unit) { return LAY.padTop + v * unit; }

  var FONT_TITLE = "600 30px -apple-system, 'Segoe UI', Roboto, sans-serif";
  var FONT_L = "22px -apple-system, 'Segoe UI', Roboto, sans-serif";
  var FONT_R = "18px -apple-system, 'Segoe UI', Roboto, sans-serif";
  var DIM_BLOCK = 0.12;
  var DIM_RIBBON = 0.06;

  function ribbonD(x0, x1, yl, yr, h) {
    var cx = (x0 + x1) / 2;
    return "M" + x0 + "," + yl +
      " C" + cx + "," + yl + " " + cx + "," + yr + " " + x1 + "," + yr +
      " L" + x1 + "," + (yr + h) +
      " C" + cx + "," + (yr + h) + " " + cx + "," + (yl + h) + " " + x0 + "," + (yl + h) +
      " Z";
  }

  function makeTooltip(stage) {
    var el = document.createElement("div");
    el.className = "alluvial-tip";
    el.style.cssText = "display:none;position:absolute;pointer-events:none;" +
      "background:var(--text,#e9eaee);color:var(--bg,#0e0f13);font-size:12px;line-height:1.5;" +
      "padding:8px 11px;border-radius:8px;z-index:6;" +
      "box-shadow:0 4px 18px rgba(0,0,0,.35);max-width:260px;";
    stage.appendChild(el);
    var pinned = null;
    var sceneShort = function (m) { return m; };

    function content(hit) {
      var esc = escapeHtml;
      if (hit.kind === "block") {
        var b = hit.block;
        return "<strong>" + esc(b.title) + "</strong><br>" +
          fmtInt(b.size) + " philosopher" + (b.size === 1 ? "" : "s") +
          "<br><span style='opacity:.8'>famous: " + esc(b.famous) + "</span>";
      }
      var rb = hit.ribbon;
      return "<strong>" + esc(rb.titleL) + "</strong> \u2192<br><strong>" +
        esc(rb.titleR) + "</strong><br>" +
        fmtInt(rb.members.length) + " shared philosopher" +
        (rb.members.length === 1 ? "" : "s") +
        "<br><span style='opacity:.8'>e.g. " +
        esc(rb.members.slice(0, 5).map(function (m) { return sceneShort(m); }).join("; ")) +
        (rb.members.length > 5 ? " et al." : "") + "</span>";
    }
    function show(hit, x, y) {
      el.innerHTML = content(hit);
      el.style.display = "block";
      move(x, y);
    }
    function move(x, y) {
      el.style.left = Math.max(4, Math.min(x + 14, stage.clientWidth - 268)) + "px";
      el.style.top = Math.max(4, y - 14) + "px";
    }
    function hide() { if (!pinned) el.style.display = "none"; }
    function pinToggle(hit, x, y) {
      if (pinned && pinned.key === hit.key) { pinned = null; hide(); return false; }
      pinned = hit;
      show(hit, x, y);
      return true;
    }
    function unpin() { pinned = null; hide(); }
    return {
      show: show, move: move, hide: hide,
      pinToggle: pinToggle, unpin: unpin,
      isPinned: function () { return !!pinned; },
      setTranslator: function (f) { sceneShort = f; }
    };
  }

  function keepSets(scene, key) {
    var blocks = new Set(), ribbons = new Set();
    if (key.charAt(0) === "L" || key.charAt(0) === "R") {
      blocks.add(key);
      scene.ribbons.forEach(function (rb) {
        if (rb.key === key ||
            rb.key.split("|")[0] === key.slice(1) ||
            rb.key.split("|")[1] === key.slice(1)) {
          ribbons.add(rb.key);
        }
      });
    } else {
      ribbons.add(key);
      var p = key.split("|");
      blocks.add("L" + p[0]);
      blocks.add("R" + p[1]);
    }
    return { blocks: blocks, ribbons: ribbons };
  }

  // =========================================================================
  // SVG renderer (same architecture as week4-alluvial.js)
  // =========================================================================
  function renderSvg(stage, scene) {
    var NS = "http://www.w3.org/2000/svg";
    function el(tag, attrs) {
      var e = document.createElementNS(NS, tag);
      for (var k in attrs) e.setAttribute(k, attrs[k]);
      return e;
    }
    var svg = el("svg", {
      viewBox: "0 0 " + LAY.W + " " + LAY.H,
      preserveAspectRatio: "xMidYMid meet",
      style: "width:100%;height:100%;display:block;background:" + BG + ";",
      role: "img",
      "aria-label": "Weighted Louvain communities against unweighted Louvain communities, SVG rendering"
    });
    stage.appendChild(svg);

    var unit = unitFor(scene);

    var gRib = el("g", {});
    svg.appendChild(gRib);
    var gBlock = el("g", {});
    svg.appendChild(gBlock);
    var gLabel = el("g", { "pointer-events": "none" });

    var tip = makeTooltip(stage);
    tip.setTranslator(scene.shortName);

    var mx = 0, my = 0;
    stage.addEventListener("mousemove", function (ev) {
      var r = stage.getBoundingClientRect();
      mx = ev.clientX - r.left;
      my = ev.clientY - r.top;
    });

    var ribEls = [], blockEls = [];
    scene.ribbons.forEach(function (rb) {
      var yl = YOf(rb.yl, unit), yr = YOf(rb.yr, unit),
          h = rb.members.length * unit;
      var p = el("path", {
        d: ribbonD(LAY.xL1, LAY.xR0, yl, yr, h),
        fill: tab20Hex(scene.byKey["L" + rb.l].si),
        "fill-opacity": "0.35", stroke: "none"
      });
      p.style.cursor = "pointer";
      gRib.appendChild(p);
      ribEls.push({ el: p, rb: rb });
    });

    function addBlock(b, x, w, fontSize, anchor, labelled, textFn) {
      var rect = el("rect", {
        x: x, y: YOf(b.y, unit), width: w, height: b.h * unit,
        fill: tab20Hex(b.si), "fill-opacity": "0.9", stroke: "none"
      });
      rect.style.cursor = "pointer";
      gBlock.appendChild(rect);
      blockEls.push({ el: rect, b: b });
      if (labelled) {
        var t = el("text", {
          x: textFn.x, y: YOf(b.y + b.h / 2, unit) + fontSize * 0.34,
          "text-anchor": anchor, "font-size": fontSize,
          "font-family": "-apple-system, 'Segoe UI', Roboto, sans-serif",
          fill: INK
        });
        t.textContent = textFn.text;
        gLabel.appendChild(t);
      }
    }
    scene.left.forEach(function (b) {
      addBlock(b, LAY.xL0, LAY.xL1 - LAY.xL0, 22, "start", true, {
        x: LAY.xL1 + LAY.labelGap,
        text: b.famous + " (" + b.size + ")"
      });
    });
    scene.right.forEach(function (b) {
      var labelled = b.h >= LAY.blockLabelMin;
      addBlock(b, LAY.xR0, LAY.xR1 - LAY.xR0, 18, "end", labelled, {
        x: LAY.xR0 - LAY.labelGap,
        text: "(" + b.size + ") " + b.famous
      });
    });

    [{ x: (LAY.xL0 + LAY.xL1) / 2, text: "Louvain with weights \u2014 9 communities" },
     { x: (LAY.xR0 + LAY.xR1) / 2, text: "Louvain without weights \u2014 8 communities" }]
      .forEach(function (c) {
        var t = el("text", {
          x: c.x, y: 46, "text-anchor": "middle", "font-size": 30,
          "font-weight": 600,
          "font-family": "-apple-system, 'Segoe UI', Roboto, sans-serif",
          fill: INK
        });
        t.textContent = c.text;
        gLabel.appendChild(t);
      });
    svg.appendChild(gLabel);

    function applyKeep(key) {
      var keep = key ? keepSets(scene, key) : null;
      blockEls.forEach(function (rec) {
        rec.el.setAttribute("fill-opacity",
          !keep ? "0.9" : (keep.blocks.has(rec.b.key) ? "0.95" : String(DIM_BLOCK)));
      });
      ribEls.forEach(function (rec) {
        rec.el.setAttribute("fill-opacity",
          !keep ? "0.35" : (keep.ribbons.has(rec.rb.key) ? "0.6" : String(DIM_RIBBON)));
      });
    }

    var activeKey = null;
    function onEnter(key) {
      if (tip.isPinned()) return;
      activeKey = key;
      applyKeep(key);
      tip.show(hitFor(key), mx, my);
    }
    function onLeave() {
      if (tip.isPinned()) return;
      activeKey = null;
      applyKeep(null);
      tip.hide();
    }
    function hitFor(key) {
      if (scene.byKey[key]) return { kind: "block", block: scene.byKey[key], key: key };
      var rb = scene.ribbons.filter(function (r) { return r.key === key; })[0];
      return rb ? { kind: "ribbon", ribbon: rb, key: key } : null;
    }

    blockEls.forEach(function (rec) {
      rec.el.addEventListener("mouseenter", function () { onEnter(rec.b.key); });
      rec.el.addEventListener("mouseleave", onLeave);
      rec.el.addEventListener("click", function () {
        var nowPinned = tip.pinToggle(hitFor(rec.b.key), mx, my);
        activeKey = nowPinned ? rec.b.key : null;
        applyKeep(activeKey);
      });
    });
    ribEls.forEach(function (rec) {
      rec.el.addEventListener("mouseenter", function () { onEnter(rec.rb.key); });
      rec.el.addEventListener("mouseleave", onLeave);
      rec.el.addEventListener("click", function () {
        var nowPinned = tip.pinToggle(hitFor(rec.rb.key), mx, my);
        activeKey = nowPinned ? rec.rb.key : null;
        applyKeep(activeKey);
      });
    });

    stage.addEventListener("click", function (ev) {
      if (ev.target === svg) { tip.unpin(); activeKey = null; applyKeep(null); }
    });
    document.addEventListener("keydown", function (ev) {
      if (ev.key === "Escape") { tip.unpin(); activeKey = null; applyKeep(null); }
    });

    function focus(key) {
      var hit = hitFor(key);
      if (!hit) return false;
      activeKey = key;
      applyKeep(key);
      tip.unpin();
      var b = scene.byKey[key];
      var r = stage.getBoundingClientRect();
      var s = Math.min(r.width / LAY.W, r.height / LAY.H);
      var rb = b ? null : scene.ribbons.filter(function (q) { return q.key === key; })[0];
      var yScene = b ? YOf(b.y + b.h / 2, unit) : YOf(rb.yl + rb.members.length / 2, unit);
      tip.show(hit, 14, Math.max(12, yScene * s));
      return true;
    }

    return { focus: focus, svg: svg, tip: tip };
  }

  // =========================================================================
  // Philosopher finder: look up one member's ribbon across the flows
  // =========================================================================
  function wireFinder(scene, views) {
    var input = document.getElementById("flows-search");
    var btn = document.getElementById("flows-search-btn");
    var datalist = document.getElementById("flows-names");
    if (!input || !datalist) return;

    scene.memberNames.sort().forEach(function (nm) {
      var o = document.createElement("option");
      o.value = nm;
      datalist.appendChild(o);
    });

    function find() {
      var want = input.value.trim().toLowerCase();
      if (!want) return;
      var rb = null;
      var found = scene.memberNames.some(function (nm) {
        if (nm.toLowerCase() === want) { rb = scene.ribbonOfMember[nm]; return true; }
        return false;
      });
      if (!rb) return;
      var ok = false;
      views.forEach(function (v) {
        if (v.focus && v.focus(rb.key)) ok = true;
      });
      if (ok) {
        var figure = document.getElementById("flows-explorer");
        if (figure) {
          figure.scrollIntoView({
            behavior: REDUCED_MOTION ? "auto" : "smooth", block: "start"
          });
        }
      }
    }
    btn.addEventListener("click", find);
    input.addEventListener("change", find);
    input.addEventListener("keydown", function (ev) {
      if (ev.key === "Enter") { ev.preventDefault(); find(); }
    });
  }

  var REDUCED_MOTION = !!(window.matchMedia &&
    window.matchMedia("(prefers-reduced-motion: reduce)").matches);

  function showError(err) {
    var host = document.getElementById("flows-error");
    if (host) {
      host.style.display = "block";
      host.textContent = "Explorable failed to load: " + err.message;
    }
    if (window.console) console.error(err);
  }

  fetchJson("../data/philosophers/week4_summary.json")
    .then(function (summary) {
      if (!summary.section4 || !summary.section4.labels_weighted) {
        throw new Error("section4 payload missing (rerun analysis/build_week4.py)");
      }
      var scene = buildScene(summary.section4);
      var stage = document.getElementById("flows-stage-svg");
      var views = [];
      try { views.push(renderSvg(stage, scene)); }
      catch (err) { showError(err); return; }
      wireFinder(scene, views);
    })
    .catch(showError);
})();
