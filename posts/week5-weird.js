/*
 * Week 5 weirdness explorable — "Who has the weirdest Wikipedia page?".
 *
 * Every metric is computed offline by analysis/build_week5.py and frozen in
 * data/marvel_pages/week5_summary.json (data/marvel_pages pages dict):
 * tokens/types/TTR/hapax share/entropy/mean TF-IDF/Zipf slope+R2+deviation,
 * each z-scored across the 303 pages, plus the equal-weight composite.
 * The browser ranks, filters, and displays — nothing computed here except
 * sorting and layout.
 */
(function () {
  "use strict";

  function fetchJson(url) {
    return fetch(url).then(function (r) {
      if (!r.ok) throw new Error("HTTP " + r.status + " fetching " + url);
      return r.json();
    });
  }

  var COLOR_MAIN = "#e6353a";
  var COLOR_DOT = "#F76707";
  var COLOR_GREEN = "#0ca678";
  var COLOR_BLUE = "#4c6ef5";

  function escapeHtml(s) {
    return String(s).replace(/[&<>"']/g, function (c) {
      return { "&": "&amp;", "<": "&lt;", ">": "&gt;", '"': "&quot;", "'": "&#39;" }[c];
    });
  }
  function fmtInt(v) { return String(Math.round(v)).replace(/\B(?=(\d{3})+(?!\d))/g, ","); }
  function fmtFl(v, d) { return Number(v).toFixed(d == null ? 2 : d); }

  var METRICS = {
    composite: { label: "Composite", get: function (p) { return p.weird; }, fmt: function (p) { return fmtFl(p.weird, 3); }, desc: "equal-weight mean of the five z-scores below — weirdest overall profile vs the corpus" },
    ttr: { label: "Diversity (TTR)", get: function (p) { return p.z_ttr; }, fmt: function (p) { return "z " + fmtFl(p.z_ttr, 2) + " · TTR " + fmtFl(p.ttr, 3); }, desc: "type-token ratio — share of distinct words; z-scored across pages" },
    hapax: { label: "One-offs", get: function (p) { return p.z_hapax; }, fmt: function (p) { return "z " + fmtFl(p.z_hapax, 2) + " · hapax " + fmtFl(p.hapax * 100, 1) + "%"; }, desc: "share of the page's distinct words that appear exactly once" },
    entropy: { label: "Low entropy", get: function (p) { return -(p.z_entropy); }, fmt: function (p) { return "z " + fmtFl(-p.z_entropy, 2) + " · H " + fmtFl(p.entropy, 2); }, desc: "repetitive pages have low word-order entropy; sorted most repetitive first" },
    tfidf: { label: "TF-IDF", get: function (p) { return p.z_tfidf; }, fmt: function (p) { return "z " + fmtFl(p.z_tfidf, 2) + " · mean " + fmtFl(p.tfidf, 2); }, desc: "mean TF-IDF weight — a page built from words nobody else uses" },
    zipf: { label: "Zipf dev ↑", get: function (p) { return p.z_zipf; }, fmt: function (p) { return "z " + fmtFl(p.z_zipf, 2) + " · s " + fmtFl(p.zipf_s, 2) + " (R² " + fmtFl(p.zipf_r2, 2) + ")"; }, desc: "deviation of the page's own Zipf slope from the ideal −1" }
  };

  function setup(S) {
    var pages = S.pages;
    var ids = Object.keys(pages);
    if (!ids.length) throw new Error("pages payload empty");

    var listHost = document.getElementById("wz-list");
    var detailHost = document.getElementById("wz-detail");
    var tabBox = document.getElementById("wz-tabs");
    var dirBox = document.getElementById("wz-dir");
    var searchIn = document.getElementById("wz-search");
    var msgHost = document.getElementById("wz-msg");
    var descHost = document.getElementById("wz-desc");
    var errHost = document.getElementById("wz-error");
    if (!listHost) return;

    var metric = "composite";
    var dir = 1; // 1 = most weird first, -1 = least weird first
    var selected = null;

    function sortedIds() {
      var m = METRICS[metric];
      return ids.slice().sort(function (a, b) {
        return dir === 1 ? m.get(pages[b]) - m.get(pages[a]) : m.get(pages[a]) - m.get(pages[b]);
      });
    }

    function rowHtml(rank, nid, p, maxAbs, m) {
      var v = Math.abs(m.get(p));
      var w = Math.max(2, (v / maxAbs) * 100);
      var sign = metric === "composite" ? (p.weird >= 0 ? COLOR_DOT : COLOR_GREEN)
        : (dir === 1 ? COLOR_MAIN : COLOR_GREEN);
      return "<li class=\"wz-row" + (selected === nid ? " is-active\" data-active=\"1\"" : "\"") + " data-wz=\"" + escapeHtml(nid) + "\">" +
        "<span class=\"wz-rank\">" + rank + "</span>" +
        "<span class=\"wz-name\">" + escapeHtml(p.name) + "</span>" +
        "<span class=\"wz-meta\">" + escapeHtml(m.fmt(p)) + "</span>" +
        "<span class=\"wz-bar\"><span style=\"width:" + w + "%;background:" + sign + "\"></span></span>" +
        "</li>";
    }

    function renderList() {
      var m = METRICS[metric];
      if (descHost) descHost.textContent = m.desc;
      var sorted = sortedIds();
      var maxAbs = 1e-9;
      sorted.slice(0, 25).forEach(function (nid) {
        maxAbs = Math.max(maxAbs, Math.abs(m.get(pages[nid])));
      });
      var html = "";
      sorted.slice(0, 25).forEach(function (nid, i) {
        html += rowHtml(dir === 1 ? i + 1 : sorted.length - i, nid, pages[nid], maxAbs, m);
      });
      listHost.innerHTML = html;
      bindRows();
      msgHost.style.display = "none";
    }

    function bindRows() {
      Array.prototype.slice.call(listHost.querySelectorAll("[data-wz]")).forEach(function (li) {
        li.addEventListener("click", function () {
          select(li.getAttribute("data-wz"));
        });
      });
    }

    function chipHtml(word) {
      return "<span class=\"wz-chip\">" + escapeHtml(word) + "</span>";
    }

    function statLine(label, val) {
      return "<li class=\"stat-card\"><span class=\"stat-label\">" + label +
        "</span><span class=\"stat-value\">" + val + "</span></li>";
    }

    function select(nid) {
      selected = nid;
      var p = pages[nid];
      if (!p) return;
      var m = METRICS[metric];
      var zrows = [
        ["TTR", p.z_ttr], ["Hapax share", p.z_hapax], ["Entropy", p.z_entropy],
        ["TF-IDF", p.z_tfidf], ["Zipf deviation", p.z_zipf]
      ];
      var zHtml = zrows.map(function (zr) {
        var z = zr[1];
        var col = z >= 0 ? COLOR_DOT : COLOR_GREEN;
        var wpx = Math.min(50, Math.abs(z) * 16);
        return "<div class=\"wz-zrow\"><span class=\"wz-zname\">" + escapeHtml(zr[0]) + "</span>" +
          "<span class=\"wz-zbar\"><span style=\"width:" + wpx + "%;background:" + col + "\"></span></span>" +
          "<span class=\"wz-zval\" style=\"color:" + col + "\">" + (z >= 0 ? "+" : "") + fmtFl(z, 2) + "</span>" +
          "</div>";
      }).join("");
      detailHost.innerHTML =
        "<div class=\"wz-detail-head\">" +
        "<strong>" + escapeHtml(p.name) + "</strong> " +
        "<span class=\"wz-detail-score\" style=\"color:" + (p.weird >= 0 ? COLOR_DOT : COLOR_GREEN) + "\">composite " + (p.weird >= 0 ? "+" : "") + fmtFl(p.weird, 2) + "</span>" +
        "</div>" +
        "<ul class=\"stats-grid wz-stats\">" +
        statLine("Tokens /types", fmtInt(p.tokens) + " / " + fmtInt(p.types)) +
        statLine("In-degree", fmtInt(p.in_degree) + " hero pages link in") +
        statLine("TTR / hapax", fmtFl(p.ttr, 3) + " / " + fmtFl(p.hapax * 100, 0) + "%") +
        statLine("Entropy (bits)", fmtFl(p.entropy, 2)) +
        statLine("Mean TF-IDF", fmtFl(p.tfidf, 2)) +
        statLine("Zipf slope (ideal −1)", fmtFl(p.zipf_s, 2) + " · R² " + fmtFl(p.zipf_r2, 2)) +
        "</ul>" +
        "<div class=\"wz-zwrap\">" + zHtml + "</div>" +
        "<div class=\"wz-chips-label\">Most distinctive words on this page (TF-IDF):</div>" +
        "<div class=\"wz-chips\">" + p.top_tfidf.map(chipHtml).join("") + "</div>";
      detailHost.style.display = "";
      renderList();
      if (msgHost) msgHost.style.display = "none";
      detailHost.scrollIntoView({ behavior: REDUCED_MOTION ? "auto" : "smooth", block: "nearest" });
    }

    var REDUCED_MOTION = !!(window.matchMedia &&
      window.matchMedia("(prefers-reduced-motion: reduce)").matches);

    //tabs
    var tabBtns = Array.prototype.slice.call(tabBox.querySelectorAll("[data-wz-metric]"));
    tabBtns.forEach(function (b) {
      b.addEventListener("click", function () {
        metric = b.getAttribute("data-wz-metric");
        tabBtns.forEach(function (x) {
          x.setAttribute("aria-pressed", x === b ? "true" : "false");
        });
        renderList();
      });
    });

    var dirBtns = Array.prototype.slice.call(dirBox.querySelectorAll("[data-wz-dir]"));
    dirBtns.forEach(function (b) {
      b.addEventListener("click", function () {
        dir = parseInt(b.getAttribute("data-wz-dir"), 10);
        dirBtns.forEach(function (x) {
          x.setAttribute("aria-pressed", x === b ? "true" : "false");
        });
        renderList();
      });
    });

    // search: mention a name → jump
    var datalist = document.getElementById("wz-names");
    ids.forEach(function (nid) {
      var o = document.createElement("option");
      o.value = pages[nid].name;
      datalist.appendChild(o);
    });
    var nameToId = {};
    ids.forEach(function (nid) { nameToId[pages[nid].name.toLowerCase()] = nid; });
    var searchBtn = document.getElementById("wz-go");
    function doSearch() {
      var q = searchIn.value.trim().toLowerCase();
      if (nameToId[q]) { select(nameToId[q]); searchIn.value = ""; }
      else msgHost.style.display = "block";
    }
    searchBtn.addEventListener("click", doSearch);
    searchIn.addEventListener("keydown", function (ev) {
      if (ev.key === "Enter") doSearch();
    });

    renderList();
  }

  fetchJson("../data/marvel_pages/week5_summary.json")
    .then(function (summary) {
      if (!summary.pages) {
        throw new Error("no pages payload (rerun analysis/build_week5.py)");
      }
      setup(summary);
    })
    .catch(function (err) {
      var host = document.getElementById("wz-error");
      if (host) {
        host.style.display = "block";
        host.textContent = "Explorable failed to load: " + err.message;
      }
      if (window.console) console.error(err);
    });
})();
