/* Week 5 investigation: who adds the vocabulary, who is weird, are they the
 * same pages? Three static SVG charts over data/marvel_pages/week5_investigation.json
 * (frozen by analysis/build_week5_investigation.py). One shared selection:
 * clicking a page in any chart highlights it in all three and fills each
 * inspector. Independent of week5-duel.js. */
(function () {
  "use strict";
  var NS = "http://www.w3.org/2000/svg";
  var DIM = "#9a9daa", LINE = "#262932", TEXT = "#e9eaee", RED = "#e6353a", BLUE = "#4d7cff";
  var MONO = "ui-monospace, SFMono-Regular, Menlo, Consolas, monospace";

  function el(parent, name, attrs, text) {
    var e = document.createElementNS(NS, name);
    for (var k in attrs) e.setAttribute(k, attrs[k]);
    if (text != null) e.textContent = text;
    if (parent) parent.appendChild(e);
    return e;
  }
  function fmt(n) { return n.toLocaleString("en-US"); }
  function esc(t) { return String(t).replace(/&/g, "&amp;").replace(/</g, "&lt;"); }
  function svgIn(id, w, h) {
    var s = el(null, "svg", { viewBox: "0 0 " + w + " " + h, width: "100%", role: "img" });
    s.style.display = "block";
    document.getElementById(id).appendChild(s);
    return s;
  }
  function tick(s, x, y, txt, anchor) {
    el(s, "text", { x: x, y: y, fill: DIM, "font-size": 11, "text-anchor": anchor, "font-family": MONO }, txt);
  }
  function pct(v) { return (v * 100).toFixed(1) + "%"; }
  function short(n) { return n.length > 26 ? n.slice(0, 25) + "…" : n; }

  function getJson(url) {
    return fetch(url).then(function (r) {
      if (!r.ok) throw new Error("HTTP " + r.status);
      return r.json();
    });
  }

  // takeaway numbers are read from the same frozen data the charts use
  function fillTakeaways(summary, inv) {
    var pages = inv.pages;
    var first = pages.filter(function (p) { return p.r === 1; })[0];
    var weird = pages.slice().sort(function (a, b) { return b.w - a.w; })[0];
    var vals = {
      "beta": summary.meta.heaps_exponent.toFixed(2),
      "first-name": first.n,
      "first-dv": fmt(first.dv),
      "rare-max": String(inv.rare_max),
      "weird-name": weird.n,
      "weird-pct": pct(weird.w)
    };
    Object.keys(vals).forEach(function (k) {
      var n = document.querySelector('[data-k="' + k + '"]');
      if (n) n.textContent = vals[k];
    });
  }

  Promise.all([getJson("../data/marvel_pages/week5_investigation.json"),
               getJson("../data/marvel_pages/week5_summary.json")]).then(function (r) {
    fillTakeaways(r[1], r[0]);
    return r[0];
  }).then(init).catch(function (e) {
    var n = document.getElementById("inv-error");
    if (n) { n.style.display = ""; n.textContent = "Could not load the investigation data: " + e.message; }
  });

  function init(data) {
    var pages = data.pages, byId = {}, marks = [], selected = null, TOP = 15;
    var byW = pages.slice().sort(function (a, b) { return b.w - a.w; });
    byW.forEach(function (p, i) { byId[p.id] = p; p.wr = i + 1; });

    function inspect(p) {
      return '<span class="inv-title">' + esc(p.n) + "</span><br>" +
        fmt(p.t) + " tokens &middot; linked-first #" + p.r + " &middot; " + p.k + (p.k === 1 ? " in-link" : " in-links") + "<br>" +
        "<strong>Weirdness:</strong> " + pct(p.w) + " &middot; rank " + p.wr + " of " + pages.length + "<br>" +
        "<strong>Rare-word tokens:</strong> " + fmt(p.rt) + " of " + fmt(p.t) + "<br>" +
        "<strong>New words:</strong> " + fmt(p.dv) + " (linked-first reading)<br>" +
        "<strong>Most-used rare words:</strong> " +
        p.rare.map(function (w) { return '<span class="ctl">' + esc(w) + "</span>"; }).join(" ");
    }
    function select(id) {
      selected = id;
      marks.forEach(function (m) { m.set(m.id === id); });
      var html = id ? inspect(byId[id]) : "Click a page to inspect it.";
      ["inv-info-b", "inv-info-c"].forEach(function (k) {
        document.getElementById(k).innerHTML = html;
      });
    }
    function toggle(id) { select(selected === id ? null : id); }

    function rowChart(host, list, cfg) {
      var W = 760, rowH = 24, M = { l: 190, r: 70, t: 8, b: 26 }, H = M.t + TOP * rowH + M.b;
      var s = svgIn(host, W, H), iw = W - M.l - M.r;
      cfg.ticks.forEach(function (t) {
        var x = M.l + iw * cfg.pos(t);
        el(s, "line", { x1: x, x2: x, y1: M.t, y2: H - M.b, stroke: LINE });
        tick(s, x, H - 8, cfg.tickLabel(t), "middle");
      });
      if (cfg.extra) cfg.extra(s, M, iw, H);
      list.slice(0, TOP).forEach(function (p, i) {
        var y = M.t + i * rowH, g = el(s, "g", { style: "cursor:pointer" });
        el(g, "rect", { x: 0, y: y, width: W, height: rowH, fill: "transparent" });
        el(g, "text", { x: M.l - 8, y: y + 16, fill: TEXT, "font-size": 12, "text-anchor": "end" }, short(p.n));
        var m = cfg.draw(g, p, M.l, iw, y);
        el(g, "title", {}, p.n + " — " + cfg.tip(p));
        g.addEventListener("click", function () { toggle(p.id); });
        marks.push({ id: p.id, set: m });
      });
    }

    // Ranked weirdness (dot plot)
    var lo = 0, hi = 0.16, med = byW[Math.floor(byW.length / 2)].w;
    rowChart("inv-chart-b", byW, {
      ticks: [0, 0.04, 0.08, 0.12, 0.16],
      pos: function (t) { return (t - lo) / (hi - lo); },
      tickLabel: function (t) { return Math.round(t * 100) + "%"; },
      tip: function (p) { return "weirdness " + pct(p.w); },
      extra: function (s, M, iw, H) {
        var x = M.l + iw * (med - lo) / (hi - lo);
        el(s, "line", { x1: x, x2: x, y1: M.t, y2: H - M.b, stroke: DIM, "stroke-dasharray": "3 3" });
        tick(s, x + 4, H - M.b - 4, "median page", "start");
      },
      draw: function (g, p, x0, iw, y) {
        var x = x0 + iw * (p.w - lo) / (hi - lo);
        el(g, "line", { x1: x0, x2: x, y1: y + 12, y2: y + 12, stroke: LINE });
        var dot = el(g, "circle", { cx: x, cy: y + 12, r: 5, fill: BLUE, opacity: 0.85 });
        tick(g, x + 10, y + 16, pct(p.w), "start");
        return function (on) { dot.setAttribute("fill", on ? RED : BLUE); dot.setAttribute("r", on ? 7 : 5); };
      }
    });

    // C: scatter, new words (log) vs weirdness; all pages
    (function () {
      var W = 760, H = 380, M = { l: 56, r: 16, t: 12, b: 42 };
      var s = svgIn("inv-chart-c", W, H), iw = W - M.l - M.r, ih = H - M.t - M.b;
      var xl1 = Math.log10(3000), y0 = 0, y1 = 0.16;
      function X(v) { return M.l + iw * Math.log10(v) / xl1; }
      function Y(v) { return M.t + ih * (1 - (v - y0) / (y1 - y0)); }
      [1, 10, 100, 1000].forEach(function (v) {
        el(s, "line", { x1: X(v), x2: X(v), y1: M.t, y2: M.t + ih, stroke: LINE });
        tick(s, X(v), M.t + ih + 16, fmt(v), "middle");
      });
      [0, 0.04, 0.08, 0.12, 0.16].forEach(function (v) {
        el(s, "line", { x1: M.l, x2: M.l + iw, y1: Y(v), y2: Y(v), stroke: LINE });
        tick(s, M.l - 8, Y(v) + 4, Math.round(v * 100) + "%", "end");
      });
      tick(s, M.l + iw / 2, H - 6, "new words contributed (log scale)", "middle");
      var yl = el(s, "text", { x: 14, y: M.t + ih / 2, fill: DIM, "font-size": 11, "text-anchor": "middle", "font-family": MONO,
        transform: "rotate(-90 14 " + (M.t + ih / 2) + ")" }, "weirdness (rare-word share)");
      var dots = el(s, "g", {});
      pages.forEach(function (p) {
        var c = el(dots, "circle", { cx: X(p.dv), cy: Y(p.w), r: 4, fill: BLUE, opacity: 0.55, style: "cursor:pointer" });
        el(c, "title", {}, p.n + " — " + fmt(p.dv) + " new words, weirdness " + pct(p.w));
        c.addEventListener("click", function () { toggle(p.id); });
        marks.push({ id: p.id, set: function (on) {
          c.setAttribute("fill", on ? RED : BLUE); c.setAttribute("r", on ? 7 : 4); c.setAttribute("opacity", on ? 1 : 0.55);
          if (on) dots.appendChild(c);
        } });
      });
    })();

    select(null);
  }
})();
