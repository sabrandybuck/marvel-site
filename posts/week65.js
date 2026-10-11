/*
 * Week 6-5 explorable — "which characters live between topics?"
 *
 * One question, one figure, in the spirit of the 6.11 Go-nuts list.
 *
 * Every page's names-removed LDA mixture (8 topics, frozen in
 * week6_summary.json as theta_n) is drawn as a thin stacked horizontal bar,
 * one row per character, sorted by mixture entropy — most ambiguous first.
 * Pure pages are one solid block; straddlers show two or three colored
 * chunks. Clicking a row opens a drawer with the page's top-3 topics and
 * sentences from the actual page that carry the MINORITY topic's words —
 * the check-against-the-text part of the week.
 *
 * The only control is a name search. A pure reader.
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
  function commColor(ci) {
    return ci < 8 ? TAB20[ci * 2] : TAB20[((ci - 8) * 2 + 1) % 20];
  }
  var TOPIC_COLOR = [
    "#e6353a", "#ff7f0e", "#0ca678", "#4d7cff",
    "#9c6ade", "#e0a020", "#d63384", "#17a2b8",
  ];

  var S = null;      // week6_summary
  var SENTS = null;  // lazy
  var SENTS_DUE = false;
  var openRow = null; // currently selected nid

  function fetchJson(url) {
    return fetch(url).then(function (r) {
      if (!r.ok) throw new Error("HTTP " + r.status + " fetching " + url);
      return r.json();
    });
  }

  function entropy(theta) {
    var h = 0;
    theta.forEach(function (p) {
      if (p > 1e-9) h -= p * Math.log2(p);
    });
    return h;
  }

  // sorted args: dominant, second, third — shares with indices
  function sortedTheta(theta) {
    return theta.map(function (p, k) { return { k: k, p: p }; })
      .sort(function (a, b) { return b.p - a.p; });
  }

  // ---------- the figure --------------------------------------------------------

  function build() {
    var rows = Object.keys(S.pages).map(function (nid) {
      var p = S.pages[nid];
      return { nid: nid, name: p.name, c: p.community,
               e: entropy(p.theta_n), st: sortedTheta(p.theta_n) };
    }).sort(function (a, b) { return b.e - a.e; });

    var labels = S.topics.no_names.labels;
    var panel = document.getElementById("w65-panel");
    panel.innerHTML = rows.map(function (r, i) {
      var segs = r.st.map(function (t) {
        if (t.p < 0.012) return "";
        return '<span class="w65-seg" style="width:' + (t.p * 100).toFixed(1) +
          '%;background:' + TOPIC_COLOR[t.k] + '"></span>';
      }).join("");
      var driver = r.st[0];
      var second = r.st[1];
      var title = r.name + " — C" + r.c +
        "&#10;" + labels[driver.k] + " " + (100 * driver.p).toFixed(1) + "%" +
        (second.p > 0.05 ? "&#10;…then " + labels[second.k] + " " + (100 * second.p).toFixed(1) + "%" : "") +
        "&#10;entropy " + r.e.toFixed(2) + " of max 3.00" +
        "&#10;(click to inspect + read the sentences)";
      return '<div class="w65-row' + (i < 20 ? " w65-top20" : "") + '" data-nid="' + esc(r.nid) +
        '" title="' + title + '">' +
        '<span class="w65-rank">' + (i + 1) + "</span>" +
        '<span class="w65-cdot" style="background:' + commColor(r.c) + '"></span>' +
        '<span class="w65-name">' + esc(r.name) + "</span>" +
        '<span class="w65-barrow"><span class="w65-bar">' + segs + "</span></span>" +
        '<span class="w65-val">' + r.e.toFixed(2) + "</span></div>";
    }).join("");

    panel.querySelectorAll(".w65-row").forEach(function (row) {
      row.addEventListener("click", function () { openDive(row.getAttribute("data-nid")); });
    });

    // search box
    var input = document.getElementById("w65-input");
    var dl = document.getElementById("w65-list");
    dl.innerHTML = rows.map(function (r) {
      return '<option value="' + esc(r.name) + '">';
    }).join("");
    input.addEventListener("change", function () {
      var q = this.value.trim().toLowerCase();
      this.value = "";
      var row = Array.prototype.find.call(panel.children, function (el) {
        return S.pages[el.getAttribute("data-nid")].name.toLowerCase() === q;
      });
      if (!row) return;
      openRowRows().forEach(function (r2) { r2.classList.remove("w65-active"); });
      row.classList.add("w65-active");
      row.scrollIntoView({ block: "center" });
      openDive(row.getAttribute("data-nid"));
    });
  }

  function openRowRows() {
    return Array.prototype.slice.call(
      document.getElementById("w65-panel").children);
  }

  // ---------- the drawer -----------------------------------------------------------

  function openDive(nid) {
    openRow = nid;
    openRowRows().forEach(function (r) {
      r.classList.toggle("w65-active", r.getAttribute("data-nid") === nid);
    });
    var p = S.pages[nid];
    var st = sortedTheta(p.theta_n);
    var labels = S.topics.no_names.labels;
    var top3 = st.slice(0, 3).filter(function (t) { return t.p > 0.04; });
    var minority = st.filter(function (t) { return t.k !== st[0].k && t.p > 0.06; }).slice(0, 2);

    var topicsHtml = top3.map(function (t) {
      return '<li class="w6-bar-row"><span class="w6-bar-word" style="font-size:11.5px">' +
        esc(labels[t.k]) + "</span>" +
        '<span class="w6-bar-track"><span class="w6-bar-fill" style="background:' +
        TOPIC_COLOR[t.k] + ';width:' + (100 * t.p).toFixed(1) +
        '%"></span></span><span class="w6-bar-val">' + (100 * t.p).toFixed(1) + "%</span></li>";
    }).join("");

    document.getElementById("w65-drawer").innerHTML =
      '<div class="w6-drawer"><h4>' + esc(p.name) + "</h4>" +
      '<p class="cos-note">C' + p.community + " · " + p.links.length +
      " linked neighbors · entropy " + entropy(p.theta_n).toFixed(2) + " / 3.00</p>" +
      '<div style="margin-bottom:10px"><span class="inspector-group">Topics (names removed)</span></div>' +
      '<ul class="w6-bar-list" style="max-width:520px">' + topicsHtml + "</ul>" +
      '<p class="cos-note" style="margin:-4px 0 8px">Bar = share of the page (topics sum to 100%).</p>' +
      '<div class="w6-chips" style="margin-top:12px">' +
      (minority.length
        ? minority.map(function (t) {
            return '<span class="w6-chip">' + esc(labels[t.k]) + "</span>";
          }).join("")
        : '<span class="w6-chip">no second topic above 6%</span>') +
      "</div>" +
      '<div class="w6-sents" id="w65-sents">' +
      (SENTS ? "" : '<p class="cos-note">loading sentences…</p>') + "</div>" +
      '<p class="cos-note">Does the page really carry the second theme in its words —' +
      " or is the model double-counting boilerplate? Yours to judge.</p></div>";

    function fill() {
      if (openRow !== nid) return;
      var words = [];
      minority.forEach(function (t) {
        S.topics.no_names.topics[t.k].forEach(function (tw) {
          if (tw.w.length >= 4 && words.indexOf(tw.w) < 0) words.push(tw.w);
        });
      });
      var pool = (SENTS.pages[nid] || []);
      var hits = [];
      for (var i = 0; i < pool.length && hits.length < 4; i++) {
        var found = null;
        for (var j = 0; j < words.length; j++) {
          var rx = new RegExp("\\b" + words[j].replace(/[.*+?^${}()|[\]\\]/g, "\\$&") + "\\b", "i");
          if (rx.test(pool[i])) { found = words[j]; break; }
        }
        if (found) {
          hits.push(pool[i].replace(
            new RegExp("\\b(" + found.replace(/[.*+?^${}()|[\]\\]/g, "\\$&") + ")\\b", "i"),
            function (m) { return "<mark>" + esc(m) + "</mark>"; }));
        }
      }
      var box = document.getElementById("w65-sents");
      if (box) box.innerHTML = (hits.length
        ? hits.map(function (s) {
            return '<p class="w6-sent">' + s + "</p>";
          }).join("")
        : '<p class="cos-note">No sentence carries the minority-topic words — ' +
          "likely the model pairing generic boilerplate, not a second theme.</p>");
    }

    if (SENTS) fill();
    else if (!SENTS_DUE) {
      SENTS_DUE = true;
      fetchJson("../data/marvel_pages/week6_sents.json").then(function (d) {
        SENTS = d;
        fill();
      });
    }
  }

  // ---------- boot -------------------------------------------------------------------

  fetchJson("../data/marvel_pages/week6_summary.json").then(function (d) {
    S = d;
    build();
  });
})();
