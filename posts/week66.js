/*
 * Week 6-6 explorable — "the analogy slot machine".
 *
 * King − man + woman = queen, but with Marvel pages in the seat of the
 * answer. The recipe is the week-6 map's own: every character is the
 * TF-IDF-weighted average of their fingerprint words in the shipped
 * Word2Vec space (week63_vecs.json + week63_map.json). The player picks a
 * starting character, trades one vocabulary word away for another, and the
 * direction `char − vec(neg) + vec(pos)` is cosine-scored against all 303
 * fingerprint averages. Nothing is precomputed — the arithmetic runs live.
 *
 * Verified presets (from the frozen payload, computed at build time):
 *   Spider-Man − man + woman → Spider-Girl (#2, Wild Child #1)
 *   Luke Cage − street + magic → Doctor Druid (#1, majesty family)
 *   Venom − aliens + technology → Eddie Brock (#1, the echo-machine trap)
 * Self and near-duplicate pages are dropped from the podium, because
 * "Wolverine → Ultimate Wolverine" is not a winning move.
 *
 * Winner drawer: the words that moved, then actual sentences from the
 * winner's page containing either traded word. The verdict stays human.
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

  var MAP = null;     // fingerprints
  var VECS = null;    // quantized word vectors
  var SENTS = null;   // lazy
  var SENTS_DUE = false;

  var V = {};         // word -> Float32Array
  var FP = {};        // nid -> Float32Array
  var WORDS = [];     // shipped vocabulary
  var dims = 0;

  var state = {
    nid: null,
    minus: "man",
    plus: "woman",
    winner: null,
  };

  function fetchJson(url) {
    return fetch(url).then(function (r) {
      if (!r.ok) throw new Error("HTTP " + r.status + " fetching " + url);
      return r.json();
    });
  }

  function decode(d) {
    var bytes = atob(d.vectors_b64);
    dims = d.meta.dims;
    var scale = d.meta.scale / 127;
    WORDS = d.words;
    WORDS.forEach(function (w, i) {
      var v = new Float32Array(dims);
      for (var j = 0; j < dims; j++) {
        var b = bytes.charCodeAt(i * dims + j);
        v[j] = (b < 128 ? b : b - 256) * scale;
      }
      V[w] = v;
    });
  }

  function fpAvg(nid) {
    if (FP[nid]) return FP[nid];
    var a = new Float32Array(dims), den = 0;
    MAP.pages[nid].fpw.forEach(function (p) {
      var v = V[p[0]];
      if (!v) return;
      for (var j = 0; j < dims; j++) a[j] += p[1] * v[j];
      den += p[1];
    });
    for (var j = 0; j < dims; j++) a[j] /= (den || 1);
    FP[nid] = a;
    return a;
  }

  function zero() { return new Float32Array(dims); }
  function cos(a, b) {
    var d = 0, na = 0, nb = 0;
    for (var j = 0; j < dims; j++) { d += a[j] * b[j]; na += a[j] * a[j]; nb += b[j] * b[j]; }
    return d / Math.sqrt((na * nb) || 1);
  }

  // ---------- game core -------------------------------------------------------

  function spin() {
    var vm = V[state.minus], vp = V[state.plus];
    var msg = document.getElementById("w66-error");
    msg.textContent = "";
    if (!vm || !vp) {
      var miss = [];
      if (!vm) miss.push(state.minus);
      if (!vp) miss.push(state.plus);
      msg.textContent = "Not in the machine's Marvel vocabulary (it only knows " +
        WORDS.length.toLocaleString() + " words): " + miss.filter(Boolean).join(", ");
      document.getElementById("w66-results").innerHTML = "";
      return;
    }
    var base = fpAvg(state.nid);
    var dir = new Float32Array(dims);
    for (var j = 0; j < dims; j++) dir[j] = base[j] - vm[j] + vp[j];

    var results = Object.keys(MAP.pages)
      .filter(function (nid) { return nid !== state.nid; })
      .filter(function (nid) { return MAP.pages[nid].name.indexOf("Ultimate") < 0; })
      .map(function (nid) {
        return { nid: nid, name: MAP.pages[nid].name,
                 c: cos(dir, fpAvg(nid)), community: MAP.pages[nid].community };
      })
      .sort(function (a, b) { return b.c - a.c; });
    state.winner = results[0];

    // which fingerprint words moved the needle, toward each traded pole
    var deltaDir = new Float32Array(dims);
    for (j = 0; j < dims; j++) deltaDir[j] = vp[j] - vm[j];
    var moves = MAP.pages[state.nid].fpw.map(function (p) {
      var v = V[p[0]];
      if (!v) return null;
      return { w: p[0], d: p[1] * cos(v, deltaDir) };
    }).filter(Boolean).sort(function (a, b) { return b.d - a.d; });

    renderResults(results, moves);
  }

  function renderResults(results, moves) {
    var root = document.getElementById("w66-results");
    var winner = results[0];
    root.innerHTML =
      '<ul class="w6-nb-list w66-podium">' + results.slice(0, 5).map(function (r, i) {
        return '<li class="w6-nb-row' + (i === 0 ? " w66-win" : "") + '" data-nid="' + esc(r.nid) + '">' +
          '<span class="w6-rank">' + (i + 1) + "</span>" +
          '<span class="w6-cdot" style="background:' + commColor(r.community) + '"></span>' +
          '<span class="w6-nname" >' + esc(r.name) + "</span>" +
          '<span class="w6-cos">' + r.c.toFixed(2) + "</span>" +
          '<span class="w6-link">' + (i === 0 ? "the machine says…" : "") + "</span></li>";
      }).join("") + "</ul>" +
      '<p class="cos-note">Starting fingerprint words pulled toward <strong>−</strong>' +
      esc(state.minus) + ': ' +
      (moves.filter(function (m) { return m.d < 0; }).slice(-3).reverse().map(function (m) {
        return "<code>" + esc(m.w) + "</code>";
      }).join(", ") || "—") +
      " · toward <strong>+</strong>" + esc(state.plus) + ': ' +
      (moves.filter(function (m) { return m.d > 0; }).slice(0, 3).map(function (m) {
        return "<code>" + esc(m.w) + "</code>";
      }).join(", ") || "—") + "</p>" +
      '<div id="w66-evidence"></div>';

    root.querySelectorAll("[data-nid]").forEach(function (row) {
      row.addEventListener("click", function () {
        setFrom(row.getAttribute("data-nid"));
      });
    });

    showEvidence(winner);
  }

  function showEvidence(winner) {
    var box = document.getElementById("w66-evidence");
    box.innerHTML =
      '<div class="w6-drawer"><h4>Why ' + esc(winner.name) + "?</h4>" +
      '<p class="cos-note">Actual sentences from the winner&rsquo;s page that mention ' +
      "<code>" + esc(state.minus) + "</code> or <code>" + esc(state.plus) +
      "</code> — the reading before you believe the machine:</p>" +
      '<div class="w6-sents" id="w66-sents">' +
      (SENTS ? "" : '<p class="cos-note">loading sentences…</p>') + "</div></div>";
    if (SENTS) { fillEvidence(winner); return; }
    if (SENTS_DUE) return;
    SENTS_DUE = true;
    fetchJson("../data/marvel_pages/week6_sents.json").then(function (d) {
      SENTS = d;
      if (state.winner) fillEvidence(state.winner);
    });
  }

  function fillEvidence(winner) {
    var box = document.getElementById("w66-sents");
    if (!box) return;
    var words = [state.minus, state.plus];
    var pool = (SENTS.pages[winner.nid] || []);
    var out = [];
    for (var i = 0; i < pool.length && out.length < 3; i++) {
      var s = pool[i], found = null;
      out2: for (var k = 0; k < words.length; k++) {
        var rx = new RegExp("\\b" + words[k].replace(/[.*+?^${}()|[\]\\]/g, "\\$&") + "\\b", "i");
        if (rx.test(s)) { found = words[k]; break out2; }
      }
      if (found) {
        var mark = new RegExp("\\b(" + found.replace(/[.*+?^${}()|[\]\\]/g, "\\$&") + ")\\b", "i");
        out.push(s.replace(mark, function (m) { return "<mark>" + esc(m) + "</mark>"; }));
      }
    }
    box.innerHTML = out.length
      ? out.map(function (s) { return '<p class="w6-sent">' + s + "</p>"; }).join("")
      : '<p class="cos-note">The winner&rsquo;s page never mentions the traded words — the match is pure fingerprint geometry. Suspicious? Good.</p>';
  }

  // ---------- controls ----------------------------------------------------------

  function setFrom(nid) {
    state.nid = nid;
    document.getElementById("w66-from").value = nid;
    document.getElementById("w66-from-name").value = "";
    spin();
  }

  function randomFrom() {
    var ids = Object.keys(MAP.pages);
    return ids[Math.floor(Math.random() * ids.length)];
  }

  function randomNonsensical() {
    var ids = Object.keys(MAP.pages);
    state.nid = ids[Math.floor(Math.random() * ids.length)];
    state.minus = WORDS[Math.floor(Math.random() * WORDS.length)];
    state.plus = WORDS[Math.floor(Math.random() * WORDS.length)];
    // a random round only makes sense if both words exist, which they do
    document.getElementById("w66-from").value = state.nid;
    document.getElementById("w66-minus").value = state.minus;
    document.getElementById("w66-plus").value = state.plus;
    spin();
  }

  function bindControls(root) {
    // starting character: select + free text
    var sel = root.querySelector("#w66-from");
    sel.innerHTML = Object.keys(MAP.pages).sort(function (a, b) {
      return MAP.pages[a].name.localeCompare(MAP.pages[b].name);
    }).map(function (nid) {
      return '<option value="' + esc(nid) + '">' + esc(MAP.pages[nid].name) + "</option>";
    }).join("");
    sel.value = state.nid;
    sel.addEventListener("change", function () { setFrom(this.value); });

    var input = root.querySelector("#w66-from-name");
    var dl = root.querySelector("#w66-from-datalist");
    dl.innerHTML = Object.keys(MAP.pages).map(function (nid) {
      return '<option value="' + esc(MAP.pages[nid].name) + '">';
    }).join("");
    input.addEventListener("change", function () {
      var q = this.value.trim().toLowerCase();
      this.value = "";
      var hit = Object.keys(MAP.pages).find(function (nid) {
        return MAP.pages[nid].name.toLowerCase() === q;
      });
      if (hit) setFrom(hit);
    });

    // traded words
    ["minus", "plus"].forEach(function (slot) {
      var w = root.querySelector("#w66-" + slot);
      var wdl = root.querySelector("#w66-" + slot + "-datalist");
      wdl.innerHTML = WORDS.map(function (x) {
        return '<option value="' + esc(x) + '">';
      }).join("");
      w.value = state[slot];
      w.addEventListener("change", function () {
        state[slot] = this.value.trim().toLowerCase();
        spin();
      });
    });

    root.querySelector("#w66-lever").addEventListener("click", spin);

    // verified preset equations
    var presets = [
      { from: "Spider-Man", minus: "man", plus: "woman", label: "spider−man+woman" },
      { from: "Luke Cage", minus: "street", plus: "magic", label: "street to magic" },
      { from: "Venom (character)", minus: "aliens", plus: "technology", label: "the echo trap" },
    ];
    var chipRow = root.querySelector("#w66-presets");
    chipRow.innerHTML =
      '<button class="w6-chip" id="w66-random">🎲 random round</button>' +
      presets.map(function (p, i) {
        return '<button class="w6-chip" data-i="' + i + '">' + esc(p.label) + "</button>";
      }).join("");
    chipRow.querySelectorAll("[data-i]").forEach(function (b) {
      b.addEventListener("click", function () {
        var p = presets[+b.getAttribute("data-i")];
        setFrom(Object.keys(MAP.pages).find(function (nid) {
          return MAP.pages[nid].name === p.from;
        }));
        state.minus = p.minus;
        state.plus = p.plus;
        document.getElementById("w66-minus").value = p.minus;
        document.getElementById("w66-plus").value = p.plus;
        spin();
      });
    });
    root.querySelector("#w66-random").addEventListener("click", randomNonsensical);
  }

  // ---------- boot -----------------------------------------------------------------

  Promise.all([
    fetchJson("../data/marvel_pages/week63_map.json"),
    fetchJson("../data/marvel_pages/week63_vecs.json"),
  ]).then(function (r) {
    MAP = r[0]; VECS = r[1];
    decode(VECS);
    state.nid = Object.keys(MAP.pages).find(function (nid) {
      return MAP.pages[nid].name === "Spider-Man";
    });
    bindControls(document.getElementById("w66-controls"));
    spin();
  });
})();
