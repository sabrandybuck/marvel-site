/*
 * Week 7 topics explorable — "What are the villains about?"
 *
 * NMF topic modeling (TF-IDF, 10 topics) on the 370 Marvel supervillain
 * pages. Shows topic cards, and clicking a topic reveals:
 *   - the villains that belong to it (ranked by topic weight)
 *   - a scatter plot with those villains highlighted (PCA coords from
 *     week7_supervillains.json)
 *   - the divergent pairs within that topic (semantically close,
 *     structurally far, AND topically similar — the three lenses agree
 *     on meaning but disagree on structure)
 *
 * Data: data/week7/week7_topics.json + data/week7/week7_supervillains.json
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

  // Topic colors (distinct from community colors — these are categorical)
  var TOPIC_COLORS = [
    "#e6353a", "#4d7cff", "#e0a020", "#0ca678", "#9467bd",
    "#e377c2", "#17becf", "#8c564b", "#7f7f7f", "#bcbd22"
  ];
  function topicColor(tid) {
    return TOPIC_COLORS[tid % TOPIC_COLORS.length];
  }
  function commColor(ci) {
    return ci < 10 ? TAB20[ci * 2] : TAB20[((ci - 10) * 2 + 1) % 20];
  }

  var TOPICS = null;       // week7_topics.json
  var SUPER = null;        // week7_supervillains.json (for coords + names)
  var ids = [];
  var nameOf = {};
  var state = {
    selectedTopic: null,   // topic id
    selectedVillain: null, // villain nid
    colorBy: "community",  // "community" | "topic"
  };

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

  // ---------- initialization ----------

  function init() {
    els.cards = document.getElementById("w7t-cards");
    els.detail = document.getElementById("w7t-detail");
    els.scatter = document.getElementById("w7t-scatter");
    els.villainList = document.getElementById("w7t-villain-list");
    els.pairList = document.getElementById("w7t-pair-list");
    els.colorCommunity = document.getElementById("w7t-color-community");
    els.colorTopic = document.getElementById("w7t-color-topic");
    els.stats = document.getElementById("w7t-stats");
    els.excerpt = document.getElementById("w7t-excerpt");

    Promise.all([
      fetchJson("../data/week7/week7_topics.json"),
      fetchJson("../data/week7/week7_supervillains.json"),
    ]).then(function (results) {
      TOPICS = results[0];
      SUPER = results[1];
      ids = Object.keys(SUPER.nodes);
      ids.forEach(function (nid) {
        nameOf[nid] = SUPER.nodes[nid].name;
      });
      renderStats();
      renderTopicCards();
      drawScatter();
    }).catch(function (err) {
      els.cards.innerHTML = '<p class="w7t-error">Error loading data: ' + esc(String(err)) + '</p>';
    });

    // Event listeners
    els.colorCommunity.addEventListener("click", function () {
      state.colorBy = "community";
      updateColorButtons();
      drawScatter();
    });
    els.colorTopic.addEventListener("click", function () {
      state.colorBy = "topic";
      updateColorButtons();
      drawScatter();
    });
  }

  function updateColorButtons() {
    els.colorCommunity.classList.toggle("active", state.colorBy === "community");
    els.colorTopic.classList.toggle("active", state.colorBy === "topic");
  }

  function renderStats() {
    var m = TOPICS.meta;
    els.stats.innerHTML =
      '<span><strong>' + m.n_docs + '</strong> villains</span>' +
      '<span><strong>' + m.n_topics + '</strong> topics</span>' +
      '<span><strong>' + m.method + '</strong></span>' +
      '<span><strong>' + m.max_features + '</strong> TF-IDF features</span>';
  }

  // ---------- topic cards ----------

  function renderTopicCards() {
    var html = "";
    TOPICS.topics.forEach(function (t) {
      var divCount = TOPICS.topic_div_counts[t.id] || 0;
      var words = (t.top_words || []).map(function (w) {
        return '<span class="w7t-word">' + esc(w) + '</span>';
      }).join(" ");
      var alsoClose = (t.also_close || []).map(function (w) {
        return '<span class="w7t-word w7t-word-dim">' + esc(w) + '</span>';
      }).join(" ");
      html += '<div class="w7t-card" data-topic="' + t.id + '" style="border-left-color:' + topicColor(t.id) + '">' +
        '<div class="w7t-card-header">' +
        '<span class="w7t-topic-badge" style="background:' + topicColor(t.id) + '">T' + t.id + '</span>' +
        '<span class="w7t-topic-label">' + esc(t.label) + '</span>' +
        '<span class="w7t-topic-size">' + t.size + '</span>' +
        (divCount > 0 ? '<span class="w7t-topic-div">' + divCount + ' div</span>' : '') +
        '</div>' +
        '<div class="w7t-topic-words">' + words + '</div>' +
        (alsoClose ? '<div class="w7t-also-close"><span class="w7t-also-label">also:</span> ' + alsoClose + '</div>' : '') +
        '</div>';
    });
    els.cards.innerHTML = html;

    // Wire up clicks
    els.cards.querySelectorAll(".w7t-card").forEach(function (card) {
      card.addEventListener("click", function () {
        var tid = parseInt(card.getAttribute("data-topic"), 10);
        selectTopic(tid);
      });
    });
  }

  function selectTopic(tid) {
    state.selectedTopic = tid;
    state.selectedVillain = null;

    // Highlight selected card
    els.cards.querySelectorAll(".w7t-card").forEach(function (card) {
      card.classList.toggle("selected", parseInt(card.getAttribute("data-topic"), 10) === tid);
    });

    renderTopicDetail(tid);
    drawScatter();
  }

  function renderTopicDetail(tid) {
    var topic = TOPICS.topics[tid];
    var divCount = TOPICS.topic_div_counts[tid] || 0;

    // Get villains in this topic, sorted by weight
    var villains = [];
    ids.forEach(function (nid) {
      var a = TOPICS.assignments[nid];
      if (a && a.dominant === tid) {
        villains.push({
          nid: nid,
          name: nameOf[nid],
          weight: a.distribution[String(tid)] || 0,
          community: SUPER.nodes[nid].community,
          in_degree: SUPER.nodes[nid].in_degree,
        });
      }
    });
    villains.sort(function (a, b) { return b.weight - a.weight; });

    // Build detail HTML
    var allWords = (topic.words || []).map(function (w) {
      return '<span class="w7t-word" title="weight ' + w[1] + '">' + esc(w[0]) + '</span>';
    }).join(" ");
    var alsoClose = (topic.also_close || []).map(function (w) {
      return '<span class="w7t-word w7t-word-dim">' + esc(w) + '</span>';
    }).join(" ");

    var html = '<div class="w7t-detail-header">' +
      '<h3><span class="w7t-topic-badge" style="background:' + topicColor(tid) + '">T' + tid + '</span> ' +
      esc(topic.label) + '</h3>' +
      '<div class="w7t-detail-meta">' +
      '<span>' + topic.size + ' villains</span>' +
      '<span>' + divCount + ' divergent pairs within topic</span>' +
      '<span class="w7t-auto-label">auto: ' + esc(topic.auto_label) + '</span>' +
      '</div>' +
      '<div class="w7t-topic-words-full">' + allWords + '</div>' +
      (alsoClose ? '<div class="w7t-also-close"><span class="w7t-also-label">also close:</span> ' + alsoClose + '</div>' : '') +
      '</div>';

    els.detail.innerHTML = html;

    // Villain list (top 15)
    var vlist = '<h4>Villains in this topic (top 15 of ' + villains.length + ')</h4><ul class="w7t-villain-list">';
    villains.slice(0, 15).forEach(function (v, i) {
      vlist += '<li data-nid="' + esc(v.nid) + '">' +
        '<span class="w7t-rank">#' + (i + 1) + '</span>' +
        '<span class="w7t-vname">' + esc(v.name) + '</span>' +
        '<span class="w7t-vweight">' + (v.weight * 100).toFixed(0) + '%</span>' +
        '<span class="w7t-vdeg">in-degree ' + v.in_degree + '</span>' +
        '</li>';
    });
    vlist += '</ul>';
    if (villains.length > 15) {
      vlist += '<p class="w7t-more">…and ' + (villains.length - 15) + ' more. ' +
        'All are highlighted in the scatter plot below.</p>';
    }
    els.villainList.innerHTML = vlist;

    // Wire up villain clicks
    els.villainList.querySelectorAll("li[data-nid]").forEach(function (li) {
      li.addEventListener("click", function () {
        selectVillain(li.getAttribute("data-nid"));
      });
    });

    // Divergent pairs within this topic
    var pairs = TOPICS.topic_pairs[String(tid)] || [];
    var plist = '<h4>Divergent pairs within this topic (' + pairs.length + ')</h4>';
    if (pairs.length === 0) {
      plist += '<p class="w7t-hint">No divergent pairs in this topic — the villains here are both topically similar AND structurally connected.</p>';
    } else {
      plist += '<ul class="w7t-pair-list">';
      pairs.slice(0, 10).forEach(function (p) {
        var pathStr = p.path >= 0 ? p.path : "∞";
        plist += '<li data-pair="' + esc(pairKey(p.a, p.b)) + '">' +
          '<span class="w7t-pair-names">' + esc(nameOf[p.a]) + ' ↔ ' + esc(nameOf[p.b]) + '</span>' +
          '<span class="w7t-pair-nums">cos ' + p.cos.toFixed(3) + ' · path ' + pathStr + ' · div ' + p.divergence.toFixed(3) + '</span>' +
          '</li>';
      });
      plist += '</ul>';
      if (pairs.length > 10) {
        plist += '<p class="w7t-more">…and ' + (pairs.length - 10) + ' more divergent pairs in this topic.</p>';
      }
    }
    els.pairList.innerHTML = plist;

    // Wire up pair clicks
    els.pairList.querySelectorAll("li[data-pair]").forEach(function (li) {
      li.addEventListener("click", function () {
        var parts = li.getAttribute("data-pair").split("|");
        showPairExcerpts(parts[0], parts[1]);
      });
    });

    els.excerpt.innerHTML = "";
  }

  function selectVillain(nid) {
    state.selectedVillain = nid;
    // Highlight in list
    els.villainList.querySelectorAll("li[data-nid]").forEach(function (li) {
      li.classList.toggle("selected", li.getAttribute("data-nid") === nid);
    });
    drawScatter();
    showVillainExcerpt(nid);
  }

  function showVillainExcerpt(nid) {
    var path = "../data/Marvel_Comics_supervillains/pages/" + nid + ".txt";
    els.excerpt.innerHTML = '<div class="w7t-loading">Loading…</div>';
    fetchText(path).then(function (text) {
      var paras = text.split(/\n+/).filter(function (p) {
        return p.trim().length > 50;
      }).slice(0, 2);
      var html = '<div class="w7t-excerpt-card">' +
        '<h4>' + esc(nameOf[nid]) + '</h4>';
      // Show topic distribution
      var vt = TOPICS.villain_topics[nid] || [];
      if (vt.length > 0) {
        html += '<div class="w7t-vtopics">';
        vt.slice(0, 3).forEach(function (t) {
          html += '<span class="w7t-vtopic" style="background:' + topicColor(t.topic) + '">' +
            'T' + t.topic + ' ' + (t.weight * 100).toFixed(0) + '%</span>';
        });
        html += '</div>';
      }
      paras.forEach(function (p) {
        var trimmed = p.trim();
        if (trimmed.length > 300) trimmed = trimmed.substring(0, 300) + "…";
        html += '<p>' + esc(trimmed) + '</p>';
      });
      html += '</div>';
      els.excerpt.innerHTML = html;
    }).catch(function () {
      els.excerpt.innerHTML = '<p class="w7t-error">Could not load page.</p>';
    });
  }

  function showPairExcerpts(a, b) {
    var pathA = "../data/Marvel_Comics_supervillains/pages/" + a + ".txt";
    var pathB = "../data/Marvel_Comics_supervillains/pages/" + b + ".txt";
    els.excerpt.innerHTML = '<div class="w7t-loading">Loading both pages…</div>';
    Promise.all([
      fetchText(pathA).catch(function () { return null; }),
      fetchText(pathB).catch(function () { return null; }),
    ]).then(function (texts) {
      var html = '<div class="w7t-pair-grid">';
      html += renderExcerpt(a, texts[0]);
      html += renderExcerpt(b, texts[1]);
      html += '</div>';
      els.excerpt.innerHTML = html;
    });
  }

  function renderExcerpt(nid, text) {
    if (!text) {
      return '<div class="w7t-excerpt-card"><h4>' + esc(nameOf[nid]) + '</h4>' +
        '<p class="w7t-error">Page not available.</p></div>';
    }
    var paras = text.split(/\n+/).filter(function (p) {
      return p.trim().length > 50;
    }).slice(0, 2);
    var html = '<div class="w7t-excerpt-card"><h4>' + esc(nameOf[nid]) + '</h4>';
    var vt = TOPICS.villain_topics[nid] || [];
    if (vt.length > 0) {
      html += '<div class="w7t-vtopics">';
      vt.slice(0, 3).forEach(function (t) {
        html += '<span class="w7t-vtopic" style="background:' + topicColor(t.topic) + '">' +
          'T' + t.topic + ' ' + (t.weight * 100).toFixed(0) + '%</span>';
      });
      html += '</div>';
    }
    paras.forEach(function (p) {
      var trimmed = p.trim();
      if (trimmed.length > 300) trimmed = trimmed.substring(0, 300) + "…";
      html += '<p>' + esc(trimmed) + '</p>';
    });
    html += '</div>';
    return html;
  }

  // ---------- scatter plot ----------

  function getCoords(nid) {
    var n = SUPER.nodes[nid];
    return n.pca;
  }

  function getNodeColor(nid) {
    if (state.colorBy === "topic") {
      var a = TOPICS.assignments[nid];
      return a ? topicColor(a.dominant) : "#555";
    }
    return commColor(SUPER.nodes[nid].community);
  }

  function isHighlighted(nid) {
    if (state.selectedTopic !== null) {
      var a = TOPICS.assignments[nid];
      return a && a.dominant === state.selectedTopic;
    }
    return false;
  }

  function drawScatter() {
    var svg = els.scatter;
    var W = svg.clientWidth || 800;
    var H = Math.max(350, W * 0.5);
    svg.setAttribute("viewBox", "0 0 " + W + " " + H);
    svg.innerHTML = "";

    // Compute bounds
    var minX = Infinity, maxX = -Infinity, minY = Infinity, maxY = -Infinity;
    ids.forEach(function (nid) {
      var c = getCoords(nid);
      if (c[0] < minX) minX = c[0];
      if (c[0] > maxX) maxX = c[0];
      if (c[1] < minY) minY = c[1];
      if (c[1] > maxY) maxY = c[1];
    });
    var pad = 30;
    var scaleX = (W - pad * 2) / (maxX - minX || 1);
    var scaleY = (H - pad * 2) / (maxY - minY || 1);
    var scale = Math.min(scaleX, scaleY);
    function sx(x) {
      return pad + (x - minX) * scale + (W - pad * 2 - (maxX - minX) * scale) / 2;
    }
    function sy(y) {
      return H - (pad + (y - minY) * scale + (H - pad * 2 - (maxY - minY) * scale) / 2);
    }

    // Draw nodes
    var nodeGroup = document.createElementNS("http://www.w3.org/2000/svg", "g");
    ids.forEach(function (nid) {
      var c = getCoords(nid);
      var node = SUPER.nodes[nid];
      var highlighted = isHighlighted(nid);
      var selected = state.selectedVillain === nid;
      var r = 3 + Math.min(node.in_degree, 15) * 0.25;

      var g = document.createElementNS("http://www.w3.org/2000/svg", "g");
      g.style.cursor = "pointer";

      var circle = document.createElementNS("http://www.w3.org/2000/svg", "circle");
      circle.setAttribute("cx", sx(c[0]));
      circle.setAttribute("cy", sy(c[1]));
      circle.setAttribute("r", selected ? r + 2.5 : (highlighted ? r + 1.5 : r));
      circle.setAttribute("fill", getNodeColor(nid));
      circle.setAttribute("stroke", selected ? "#fff" : (highlighted ? "#fff" : "rgba(255,255,255,0.2)"));
      circle.setAttribute("stroke-width", selected || highlighted ? "2" : "0.5");
      // Dim non-highlighted nodes when a topic is selected
      if (state.selectedTopic !== null && !highlighted) {
        circle.setAttribute("opacity", "0.15");
      } else {
        circle.setAttribute("opacity", "0.85");
      }
      g.appendChild(circle);

      // Tooltip
      var title = document.createElementNS("http://www.w3.org/2000/svg", "title");
      var a = TOPICS.assignments[nid];
      title.textContent = node.name +
        (a ? "\nDominant topic: T" + a.dominant + " (" + (a.distribution[String(a.dominant)] * 100).toFixed(0) + "%)" : "") +
        "\nCommunity C" + node.community + " · in-degree " + node.in_degree;
      g.appendChild(title);

      // Label for highlighted/selected
      if (highlighted || selected) {
        var label = document.createElementNS("http://www.w3.org/2000/svg", "text");
        label.setAttribute("x", sx(c[0]) + r + 4);
        label.setAttribute("y", sy(c[1]) + 4);
        label.setAttribute("fill", "#e9eaee");
        label.setAttribute("font-size", "10");
        label.setAttribute("font-family", "-apple-system, sans-serif");
        label.textContent = node.name;
        g.appendChild(label);
      }

      g.addEventListener("click", function (ev) {
        ev.stopPropagation();
        selectVillain(nid);
      });

      nodeGroup.appendChild(g);
    });
    svg.appendChild(nodeGroup);

    // Click empty space to deselect
    svg.addEventListener("click", function () {
      if (state.selectedVillain) {
        state.selectedVillain = null;
        els.excerpt.innerHTML = "";
        drawScatter();
      }
    });
  }

  // ---------- boot ----------

  if (document.readyState === "loading") {
    document.addEventListener("DOMContentLoaded", init);
  } else {
    init();
  }
})();
