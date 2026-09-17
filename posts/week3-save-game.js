/*
 * "Save the Marvel Network" -- a network-crisis-simulator game illustrating
 * structural fragmentation: the player gets three attempts to pick the
 * character whose removal disrupts the network the most, watches a
 * choreographed attack-and-reaction sequence on the real network each time,
 * then sees their picks measured against the network's own numbers.
 *
 * Visual identity is deliberately its own (dark HUD / command-center),
 * independent of the analytical Week 3 page -- see css/style.css's
 * "Save the Marvel Network" block (the .sg-* rules) for the full design
 * system. This file is independent of posts/week3.js: separate data fetch,
 * separate rendering, separate state.
 *
 * Reused read-only from data/week3/week3_summary.json: the precomputed
 * giant-component layout and the fragmentation/centrality reference numbers
 * for the final report. Nothing here recomputes or overwrites that file.
 *
 * Methodology, stated plainly:
 *  - Undirected giant component (277 of 303 characters) for "what's
 *    connected," exactly like the rest of Week 3 -- but ALL 303 characters
 *    are loaded and selectable, so picking one of the 26 outside the giant
 *    component is handled gracefully (see below) rather than disallowed.
 *  - Component membership and sizes are computed live, in the browser, by
 *    BFS over the real undirected edge list every time -- nothing is
 *    hard-coded (not even the 277 baseline, which this script verifies
 *    against the frozen summary rather than assuming).
 *  - Node removal is literal: the character is taken out of the active node
 *    set and every edge touching them is dropped, then components are
 *    recomputed from scratch on what's left.
 */
(function () {
  "use strict";

  var SVG_NS = "http://www.w3.org/2000/svg";
  var REDUCED_MOTION = !!(window.matchMedia && window.matchMedia("(prefers-reduced-motion: reduce)").matches);

  var COLOR_CYAN = "#35e0ff";
  var COLOR_DANGER = "#ff3b4e";
  var COLOR_AMBER = "#ffb020";
  var COLOR_DIM = "rgba(137,147,168,0.35)";
  var COLOR_EDGE = "#232838";

  var BASE_R = 2.6;
  var DEG_R_SCALE = 1.9;
  var MAX_R = 15;

  var TIMING = REDUCED_MOTION
    ? { warning: 20, countdownStep: 20, pulse: 20, shrink: 20, neighborPulse: 20, drift: 20, settle: 20 }
    : { warning: 500, countdownStep: 360, pulse: 420, shrink: 280, neighborPulse: 320, drift: 780, settle: 260 };

  function el(tag, attrs) {
    var e = document.createElementNS(SVG_NS, tag);
    if (attrs) Object.keys(attrs).forEach(function (k) { e.setAttribute(k, attrs[k]); });
    return e;
  }
  function wait(ms) { return new Promise(function (resolve) { setTimeout(resolve, ms); }); }

  function parseDataLines(text) {
    return text.split(/\r?\n/).filter(function (line) { return line.length > 0 && line.charAt(0) !== "#"; });
  }
  function fetchText(url) {
    return fetch(url).then(function (r) { if (!r.ok) throw new Error("HTTP " + r.status + " fetching " + url); return r.text(); });
  }
  function fetchJson(url) {
    return fetch(url).then(function (r) { if (!r.ok) throw new Error("HTTP " + r.status + " fetching " + url); return r.json(); });
  }

  Promise.all([
    fetchJson("../data/week3/week3_summary.json"),
    fetchText("../data/week1/week1_nodes.tsv"),
    fetchText("../data/week1/week1_edges.tsv"),
  ])
    .then(function (results) {
      var summary = results[0];
      var nodesText = results[1];
      var edgesText = results[2];

      // ---- parse raw data ----
      var nodeLines = parseDataLines(nodesText);
      var header = nodeLines[0].split("\t");
      var idCol = header.indexOf("node_id");
      var nameCol = header.indexOf("name");
      var names = {};
      var allIds = [];
      nodeLines.slice(1).forEach(function (line) {
        var cols = line.split("\t");
        allIds.push(cols[idCol]);
        names[cols[idCol]] = cols[nameCol];
      });

      var edgeRows = parseDataLines(edgesText)
        .filter(function (line) { return line !== "source\ttarget"; })
        .map(function (line) { return line.split("\t"); });

      // undirected adjacency over ALL 303 characters -- the game explicitly
      // allows selecting characters outside the giant component, so the
      // full graph (not just the 277-node giant subset) has to exist here.
      var fullUndAdj = {};
      allIds.forEach(function (id) { fullUndAdj[id] = {}; });
      edgeRows.forEach(function (row) {
        var s = row[0], t = row[1];
        if (!(s in fullUndAdj) || !(t in fullUndAdj) || s === t) return;
        fullUndAdj[s][t] = true;
        fullUndAdj[t][s] = true;
      });
      function neighborsOf(id) { return Object.keys(fullUndAdj[id] || {}); }

      // ---- live connected-components (BFS), used for baseline verification
      // and after every simulated removal -- nothing about component sizes
      // is ever assumed rather than computed. ----
      function computeComponents(activeSet) {
        var visited = {};
        var components = [];
        Object.keys(activeSet).forEach(function (start) {
          if (visited[start]) return;
          var queue = [start], qi = 0, comp = [];
          visited[start] = true;
          while (qi < queue.length) {
            var cur = queue[qi++];
            comp.push(cur);
            neighborsOf(cur).forEach(function (nb) {
              if (activeSet[nb] && !visited[nb]) { visited[nb] = true; queue.push(nb); }
            });
          }
          components.push(comp);
        });
        components.sort(function (a, b) { return b.length - a.length; });
        return components;
      }
      function toSet(ids) { var s = {}; ids.forEach(function (id) { s[id] = true; }); return s; }

      var fullActiveSet = toSet(allIds);
      var baselineComponents = computeComponents(fullActiveSet);
      var baselineGiant = baselineComponents[0];
      var baselineGiantSet = toSet(baselineGiant);
      var baselineGiantSize = baselineGiant.length;
      var baselineComponentCount = baselineComponents.length;

      if (baselineGiantSize !== summary.giant_component.size) {
        // eslint-disable-next-line no-console
        console.warn(
          "week3-save-game.js: live giant-component size (" + baselineGiantSize +
          ") does not match data/week3/week3_summary.json (" + summary.giant_component.size +
          ") -- using the live, verified value throughout."
        );
      }

      function liveDegree(id, activeSet) {
        var count = 0;
        neighborsOf(id).forEach(function (nb) { if (activeSet[nb]) count++; });
        return count;
      }

      // ====================================================================
      // Layout: giant-component positions come straight from the Week 3
      // analysis's own precomputed spring_layout (so this page's network
      // looks like the same network, not a fresh, unrelated arrangement).
      // The 26 characters outside it get a compact, clearly separate region
      // of their own -- computed here, not hand-placed -- so every one of
      // the 303 characters has a stable position before the game starts.
      // ====================================================================
      var W = 1000, H = 640, MARGIN = 22;
      var GIANT_X0 = 0.24; // giant component's own [0,1] layout is remapped into [GIANT_X0, 1]

      var basePos = {}; // id -> [vbX, vbY], viewBox units, fixed for the round
      baselineGiant.forEach(function (id) {
        var p = summary.layout[id];
        if (!p) return;
        var x = GIANT_X0 + p[0] * (1 - GIANT_X0);
        var y = p[1];
        basePos[id] = [MARGIN + x * (W - 2 * MARGIN), MARGIN + y * (H - 2 * MARGIN)];
      });

      var nonGiant = baselineComponents.slice(1); // everything outside the giant component
      var multiNode = nonGiant.filter(function (c) { return c.length > 1; });
      var singles = nonGiant.filter(function (c) { return c.length === 1; });
      var stripCenterX = (GIANT_X0 * 0.5);
      var yCursor = 0.08;
      multiNode.forEach(function (comp) {
        var clusterR = Math.min(0.09, 0.02 + comp.length * 0.006);
        var cy = yCursor + clusterR;
        comp.forEach(function (id, i) {
          var angle = (i / comp.length) * Math.PI * 2;
          var x = stripCenterX + Math.cos(angle) * clusterR * (W / H);
          var y = cy + Math.sin(angle) * clusterR;
          basePos[id] = [MARGIN + x * (W - 2 * MARGIN), MARGIN + y * (H - 2 * MARGIN)];
        });
        yCursor = cy + clusterR + 0.05;
      });
      if (singles.length) {
        var cols = Math.max(2, Math.ceil(Math.sqrt(singles.length * 1.4)));
        var cellW = (GIANT_X0 * 0.82) / cols;
        var cellH = 0.055;
        singles.forEach(function (comp, i) {
          var id = comp[0];
          var row = Math.floor(i / cols), col = i % cols;
          var x = 0.05 + col * cellW;
          var y = yCursor + row * cellH;
          basePos[id] = [MARGIN + x * (W - 2 * MARGIN), MARGIN + y * (H - 2 * MARGIN)];
        });
      }
      // safety net: any id that somehow got no position (shouldn't happen) --
      // drop it in the middle of the reserved strip rather than leaving it
      // undefined and breaking rendering.
      allIds.forEach(function (id) {
        if (!basePos[id]) basePos[id] = [MARGIN + stripCenterX * (W - 2 * MARGIN), H / 2];
      });

      var curPos = {}; // mutable "current" position, reset to basePos each round
      allIds.forEach(function (id) { curPos[id] = basePos[id].slice(); });

      // ====================================================================
      // SVG scaffold
      // ====================================================================
      var container = document.getElementById("save-network");
      container.innerHTML = "";
      var svg = el("svg", { viewBox: "0 0 " + W + " " + H, class: "chart-svg" });
      var edgeGroup = el("g");
      var nodeGroup = el("g");
      svg.appendChild(edgeGroup);
      svg.appendChild(nodeGroup);

      var edgeEls = [];
      var edgeSeen = {};
      edgeRows.forEach(function (row) {
        var s = row[0], t = row[1];
        if (!(s in fullUndAdj) || !(t in fullUndAdj) || s === t) return;
        var key = s < t ? s + "|" + t : t + "|" + s;
        if (edgeSeen[key]) return;
        edgeSeen[key] = true;
        var a = curPos[s], b = curPos[t];
        var line = el("line", { x1: a[0], y1: a[1], x2: b[0], y2: b[1], stroke: COLOR_EDGE, "stroke-width": 0.55, opacity: 0.35 });
        edgeGroup.appendChild(line);
        edgeEls.push({ a: s, b: t, el: line });
      });
      var edgesByNode = {};
      edgeEls.forEach(function (e, idx) {
        (edgesByNode[e.a] = edgesByNode[e.a] || []).push(idx);
        (edgesByNode[e.b] = edgesByNode[e.b] || []).push(idx);
      });

      var nodeEls = {};
      allIds.forEach(function (id) {
        var p = curPos[id];
        var c = el("circle", { cx: p[0], cy: p[1], r: BASE_R, fill: COLOR_DIM, stroke: "none", "stroke-width": 0, opacity: 1 });
        c.classList.add("is-drifting");
        c.style.setProperty("--sg-drift-dx", (2 + Math.random() * 3).toFixed(1) + "px");
        c.style.setProperty("--sg-drift-dy", (2 + Math.random() * 3).toFixed(1) + "px");
        c.style.setProperty("--sg-drift-duration", (3.5 + Math.random() * 3).toFixed(1) + "s");
        c.style.setProperty("--sg-drift-delay", (-Math.random() * 4).toFixed(1) + "s");
        nodeGroup.appendChild(c);
        nodeEls[id] = c;
      });

      // dedicated ring element for the impact shockwave -- not tied to any
      // single character node, repositioned and re-triggered on every attack
      var shockwaveEl = el("circle", { r: 0, fill: "none", stroke: COLOR_DANGER, "stroke-width": 2, opacity: 0 });
      shockwaveEl.style.pointerEvents = "none";
      nodeGroup.appendChild(shockwaveEl);

      container.appendChild(svg);

      function edgePositions() {
        edgeEls.forEach(function (e) {
          var a = curPos[e.a], b = curPos[e.b];
          e.el.setAttribute("x1", a[0]); e.el.setAttribute("y1", a[1]);
          e.el.setAttribute("x2", b[0]); e.el.setAttribute("y2", b[1]);
        });
      }

      var viewportEl = document.getElementById("sg-viewport");

      function triggerShockwave(id) {
        var p = curPos[id];
        shockwaveEl.classList.remove("is-shockwave");
        shockwaveEl.setAttribute("cx", p[0]);
        shockwaveEl.setAttribute("cy", p[1]);
        shockwaveEl.setAttribute("r", 4);
        shockwaveEl.setAttribute("opacity", 0.9);
        void shockwaveEl.getBoundingClientRect(); // force reflow so the animation restarts every time
        shockwaveEl.classList.add("is-shockwave");
      }
      function triggerShake() {
        if (REDUCED_MOTION) return;
        viewportEl.classList.remove("is-shaking");
        void viewportEl.offsetWidth; // force reflow
        viewportEl.classList.add("is-shaking");
      }

      // ====================================================================
      // Tooltip
      // ====================================================================
      var pane = viewportEl;
      var tooltip = document.createElement("div");
      tooltip.className = "sg-tooltip";
      tooltip.innerHTML = '<div class="sg-tooltip-name"></div><div class="sg-tooltip-degree"></div>';
      pane.appendChild(tooltip);
      var tooltipName = tooltip.querySelector(".sg-tooltip-name");
      var tooltipDegree = tooltip.querySelector(".sg-tooltip-degree");

      function showTooltip(id) {
        var rect = svg.getBoundingClientRect();
        var paneRect = pane.getBoundingClientRect();
        var p = curPos[id];
        var px = (p[0] / W) * rect.width + (rect.left - paneRect.left);
        var py = (p[1] / H) * rect.height + (rect.top - paneRect.top);
        tooltip.style.left = px + "px";
        tooltip.style.top = py + "px";
        tooltipName.textContent = names[id];
        tooltipDegree.textContent = liveDegree(id, state.activeSet) + " connection" + (liveDegree(id, state.activeSet) === 1 ? "" : "s") + (baselineGiantSet[id] ? "" : " · outside the giant component");
        tooltip.classList.add("is-visible");
      }
      function hideTooltip() { tooltip.classList.remove("is-visible"); }

      // ====================================================================
      // Game state
      // ====================================================================
      var state = {
        phase: "selecting", // selecting | animating | result
        round: 1,
        totalRounds: 3,
        activeSet: toSet(allIds),
        selectedId: null,
        hoveredId: null,
        rounds: [], // {id, name, giantBefore, giantAfter, componentsBefore, componentsAfter, delta, wasInGiant}
      };

      var hudStatusEl = document.querySelector(".sg-hud-status");
      var statusTextEl = document.getElementById("sg-status-text");
      var pipEls = Array.prototype.slice.call(document.querySelectorAll("#sg-pip-row .sg-pip"));
      var attemptValueEl = document.getElementById("save-attempt-value");
      var statGiantEl = document.getElementById("save-stat-giant");
      var statCompEl = document.getElementById("save-stat-comp");
      var statRemovedEl = document.getElementById("save-stat-removed");
      var selectionEmptyEl = document.getElementById("save-selection-empty");
      var selectionCardEl = document.getElementById("save-selection-card");
      var selectionNameEl = document.getElementById("save-selection-name");
      var selectionDegreeEl = document.getElementById("save-selection-degree");
      var attackBtn = document.getElementById("save-attack-btn");
      var overlayEl = document.getElementById("sg-overlay");
      var overlayBannerTextEl = document.getElementById("sg-overlay-banner");
      var overlayCountEl = document.getElementById("sg-overlay-count");
      var resultBlockEl = document.getElementById("save-result-block");
      var resultTitleEl = document.getElementById("save-result-title");
      var resultGiantEl = document.getElementById("save-result-giant");
      var resultComponentsEl = document.getElementById("save-result-components");
      var resultTextEl = document.getElementById("save-result-text");
      var continueBtn = document.getElementById("save-continue-btn");
      var gameHintEl = document.getElementById("save-game-hint");
      var legendEl = document.getElementById("save-network-legend");

      legendEl.innerHTML =
        '<span class="legend-row"><span style="display:inline-block;width:9px;height:9px;border-radius:50%;background:' + COLOR_CYAN + ';"></span>Giant component (277)</span>' +
        '<span class="legend-row"><span style="display:inline-block;width:9px;height:9px;border-radius:50%;background:' + COLOR_DIM + ';"></span>Outside it (26)</span>' +
        '<span class="legend-row"><span style="display:inline-block;width:9px;height:9px;border-radius:50%;background:' + COLOR_DANGER + ';"></span>Targeted</span>';

      function setHudStatus(mode, text) {
        hudStatusEl.classList.remove("is-armed", "is-critical", "is-resolved");
        if (mode) hudStatusEl.classList.add(mode);
        statusTextEl.textContent = text;
      }
      function renderPips() {
        pipEls.forEach(function (pip, i) {
          var n = i + 1;
          pip.classList.toggle("is-done", n < state.round);
          pip.classList.toggle("is-current", n === state.round);
        });
      }

      function tweenNumber(elx, from, to) {
        if (from === to) { elx.textContent = to; return; }
        if (REDUCED_MOTION) { elx.textContent = to; return; }
        var start = null, duration = 550;
        function frame(ts) {
          if (start === null) start = ts;
          var t = Math.min(1, (ts - start) / duration);
          elx.textContent = Math.round(from + (to - from) * t);
          if (t < 1) requestAnimationFrame(frame);
        }
        requestAnimationFrame(frame);
      }

      function renderLiveStats(giantSize, componentCount, animate) {
        var prevGiant = parseInt(statGiantEl.textContent, 10);
        var prevComp = parseInt(statCompEl.textContent, 10);
        if (isNaN(prevGiant)) prevGiant = baselineGiantSize;
        if (isNaN(prevComp)) prevComp = baselineComponentCount;
        if (animate) { tweenNumber(statGiantEl, prevGiant, giantSize); tweenNumber(statCompEl, prevComp, componentCount); }
        else { statGiantEl.textContent = giantSize; statCompEl.textContent = componentCount; }
        statRemovedEl.textContent = 303 - Object.keys(state.activeSet).length;
      }

      function nodeBaseFill(id) {
        if (!state.activeSet[id]) return COLOR_DIM;
        return baselineGiantSet[id] ? COLOR_CYAN : COLOR_DIM;
      }

      function renderBaseStyles() {
        allIds.forEach(function (id) {
          var c = nodeEls[id];
          var active = !!state.activeSet[id];
          var r = active ? Math.min(MAX_R, BASE_R + Math.sqrt(liveDegree(id, state.activeSet)) * DEG_R_SCALE) : 0;
          c.setAttribute("r", r);
          c.setAttribute("opacity", active ? 1 : 0);
          c.style.pointerEvents = active && state.phase === "selecting" ? "auto" : "none";
          c.classList.toggle("is-targeted", id === state.selectedId && state.phase === "selecting");
          if (id === state.selectedId) {
            c.setAttribute("fill", COLOR_DANGER);
            c.setAttribute("stroke", "#ffffff");
            c.setAttribute("stroke-width", 2);
          } else {
            c.setAttribute("fill", nodeBaseFill(id));
            c.setAttribute("stroke", "none");
            c.setAttribute("stroke-width", 0);
          }
        });
        edgeEls.forEach(function (e) {
          var visible = state.activeSet[e.a] && state.activeSet[e.b];
          e.el.setAttribute("opacity", visible ? 0.35 : 0);
          e.el.setAttribute("stroke", COLOR_EDGE);
          e.el.setAttribute("stroke-width", 0.55);
        });
      }

      // ---- hover: enlarge + highlight neighbors + tooltip ----
      function applyHover(id) {
        if (state.phase !== "selecting") return;
        state.hoveredId = id;
        var c = nodeEls[id];
        if (id !== state.selectedId) {
          c.setAttribute("r", Math.min(MAX_R + 3, parseFloat(c.getAttribute("r")) * 1.35));
          c.setAttribute("stroke", "#ffffff");
          c.setAttribute("stroke-width", 1.5);
        }
        (edgesByNode[id] || []).forEach(function (idx) {
          var e = edgeEls[idx];
          if (!(state.activeSet[e.a] && state.activeSet[e.b])) return;
          e.el.setAttribute("opacity", 0.9);
          e.el.setAttribute("stroke", "#ffffff");
          var otherId = e.a === id ? e.b : e.a;
          if (otherId !== state.selectedId) {
            nodeEls[otherId].setAttribute("stroke", COLOR_AMBER);
            nodeEls[otherId].setAttribute("stroke-width", 1.5);
          }
        });
        showTooltip(id);
      }
      function clearHover() {
        if (state.hoveredId) {
          state.hoveredId = null;
          hideTooltip();
          renderBaseStyles(); // simplest correct way to undo hover + neighbor highlight
        }
      }

      function attachHandlers() {
        allIds.forEach(function (id) {
          var c = nodeEls[id];
          c.addEventListener("mouseenter", function () { applyHover(id); });
          c.addEventListener("mouseleave", function () { clearHover(); });
          c.addEventListener("click", function () { onNodeClick(id); });
        });
      }

      function onNodeClick(id) {
        if (state.phase !== "selecting" || !state.activeSet[id]) return;
        state.selectedId = id;
        hideTooltip();
        renderBaseStyles();
        var deg = liveDegree(id, state.activeSet);
        selectionEmptyEl.hidden = true;
        selectionCardEl.hidden = false;
        selectionNameEl.textContent = names[id].toUpperCase();
        selectionDegreeEl.textContent = deg + " connection" + (deg === 1 ? "" : "s") + (baselineGiantSet[id] ? "" : " · outside the 277-character giant component");
        gameHintEl.textContent = "Confirm the attack, or select another character to retarget.";
        setHudStatus("is-armed", "TARGET LOCKED");
      }

      // ====================================================================
      // Attack sequence
      // ====================================================================
      function componentsOf(activeSet) { return computeComponents(activeSet); }

      function centroid(ids) {
        var sx = 0, sy = 0;
        ids.forEach(function (id) { sx += curPos[id][0]; sy += curPos[id][1]; });
        return [sx / ids.length, sy / ids.length];
      }

      async function runAttack() {
        var targetId = state.selectedId;
        if (!targetId) return;
        state.phase = "animating";
        renderBaseStyles(); // disables further node clicks
        setHudStatus("is-critical", "ATTACK IN PROGRESS");

        var beforeComponents = componentsOf(state.activeSet);
        var beforeGiant = beforeComponents[0];
        var beforeGiantSize = beforeGiant.length;
        var beforeCompCount = beforeComponents.length;
        var wasInGiant = beforeGiant.indexOf(targetId) !== -1;
        var neighbors = neighborsOf(targetId).filter(function (nb) { return state.activeSet[nb]; });

        selectionCardEl.hidden = true;
        gameHintEl.textContent = "";

        overlayEl.hidden = false;
        overlayBannerTextEl.textContent = "NETWORK TARGETED";
        overlayCountEl.textContent = "";
        await wait(TIMING.warning);

        var counts = ["3", "2", "1"];
        for (var i = 0; i < counts.length; i++) {
          overlayCountEl.textContent = counts[i];
          await wait(TIMING.countdownStep);
        }
        overlayBannerTextEl.textContent = "IMPACT";
        overlayCountEl.textContent = "";
        triggerShake();
        triggerShockwave(targetId);

        var targetEl = nodeEls[targetId];
        targetEl.classList.remove("is-targeted");
        targetEl.classList.add("is-pulsing");
        (edgesByNode[targetId] || []).forEach(function (idx) {
          var e = edgeEls[idx];
          e.el.setAttribute("opacity", 0);
          e.el.setAttribute("stroke-width", 0);
        });
        await wait(TIMING.pulse);
        targetEl.classList.remove("is-pulsing");
        overlayEl.hidden = true; // reveal the reacting network as the target goes offline

        // remove the node from the model, then shrink/fade it visually
        var newActiveSet = {};
        Object.keys(state.activeSet).forEach(function (id) { if (id !== targetId) newActiveSet[id] = true; });
        state.activeSet = newActiveSet;
        targetEl.setAttribute("r", 0);
        targetEl.setAttribute("opacity", 0);
        targetEl.style.pointerEvents = "none";

        neighbors.forEach(function (nb) { nodeEls[nb].classList.add("is-pulsing"); });
        await wait(TIMING.neighborPulse);
        neighbors.forEach(function (nb) { nodeEls[nb].classList.remove("is-pulsing"); });

        var afterComponents = componentsOf(state.activeSet);
        var afterGiant = afterComponents[0];
        var afterGiantSize = afterGiant.length;
        var afterCompCount = afterComponents.length;
        var fragmented = afterCompCount > beforeCompCount;

        if (fragmented) {
          var overallCentroid = centroid(afterGiant.concat.apply(afterGiant, afterComponents.slice(1)));
          var pieces = afterComponents.filter(function (comp) { return comp !== afterGiant; });
          pieces.forEach(function (comp) {
            var compCentroid = centroid(comp);
            var dx = compCentroid[0] - overallCentroid[0];
            var dy = compCentroid[1] - overallCentroid[1];
            var dist = Math.sqrt(dx * dx + dy * dy) || 1;
            var push = 95;
            var ux = dx / dist, uy = dy / dist;
            comp.forEach(function (id) {
              nodeEls[id].classList.add("is-relaxing");
              var np = [
                Math.min(W - MARGIN, Math.max(MARGIN, curPos[id][0] + ux * push)),
                Math.min(H - MARGIN, Math.max(MARGIN, curPos[id][1] + uy * push)),
              ];
              curPos[id] = np;
              nodeEls[id].setAttribute("cx", np[0]);
              nodeEls[id].setAttribute("cy", np[1]);
            });
          });
          edgePositions();
          await wait(TIMING.drift);
          allIds.forEach(function (id) { nodeEls[id].classList.remove("is-relaxing"); });
        } else {
          await wait(TIMING.settle);
        }

        renderLiveStats(afterGiantSize, afterCompCount, true);
        await wait(TIMING.settle);

        var delta = beforeGiantSize - afterGiantSize;
        var componentsDelta = afterCompCount - beforeCompCount;

        var record = {
          id: targetId, name: names[targetId],
          giantBefore: beforeGiantSize, giantAfter: afterGiantSize,
          componentsBefore: beforeCompCount, componentsAfter: afterCompCount,
          delta: delta, componentsDelta: componentsDelta, wasInGiant: wasInGiant,
        };
        state.rounds.push(record);

        showResult(record);
        state.phase = "result";
      }

      function showResult(record) {
        resultBlockEl.hidden = false;
        resultGiantEl.textContent = record.giantBefore + " → " + record.giantAfter;
        resultComponentsEl.textContent = record.componentsBefore + " → " + record.componentsAfter;

        var severity, title, text, hudLabel;
        if (!record.wasInGiant) {
          severity = "low";
          title = "MINIMAL EFFECT";
          hudLabel = "NETWORK STABLE";
          text = record.name + " isn't part of the 277-character giant component, so taking them offline " +
            "doesn't touch the network's main connectivity" + (record.componentsDelta > 0 ? " — it only affects their own small, separate part of the network." : ".");
        } else if (record.componentsDelta > 0) {
          severity = "high";
          title = "NETWORK FRAGMENTED";
          hudLabel = "NETWORK FRAGMENTED";
          text = "Removing " + record.name + " splits off " + record.componentsDelta + " new piece" + (record.componentsDelta === 1 ? "" : "s") +
            ", cutting " + record.delta + " character" + (record.delta === 1 ? "" : "s") + " off from the main network.";
        } else {
          severity = "medium";
          title = "GIANT COMPONENT SHRUNK";
          hudLabel = "NETWORK WEAKENED";
          text = "Removing " + record.name + " shrinks the giant component by " + record.delta +
            " character" + (record.delta === 1 ? "" : "s") + ", but doesn't break it apart — everyone else stays connected another way.";
        }
        resultBlockEl.setAttribute("data-severity", severity);
        resultTitleEl.textContent = title;
        resultTextEl.textContent = text;
        setHudStatus("is-resolved", hudLabel);

        continueBtn.textContent = state.round < state.totalRounds
          ? "CONTINUE → ATTEMPT " + (state.round + 1) + " / " + state.totalRounds
          : "SEE FINAL REPORT";
      }

      function startNextRoundOrFinish() {
        resultBlockEl.hidden = true;
        selectionCardEl.hidden = true;
        selectionEmptyEl.hidden = false;
        state.selectedId = null;

        if (state.round >= state.totalRounds) {
          showFinalScreen();
          return;
        }
        state.round += 1;
        attemptValueEl.textContent = state.round + " / " + state.totalRounds;
        renderPips();

        // restore the ORIGINAL network before the next choice
        state.activeSet = toSet(allIds);
        state.phase = "selecting";
        allIds.forEach(function (id) { curPos[id] = basePos[id].slice(); nodeEls[id].setAttribute("cx", curPos[id][0]); nodeEls[id].setAttribute("cy", curPos[id][1]); });
        edgePositions();
        renderLiveStats(baselineGiantSize, baselineComponentCount, false);
        renderBaseStyles();
        setHudStatus(null, "MONITORING");
        gameHintEl.textContent = "Network restored. Select a character to target them.";
      }

      attackBtn.addEventListener("click", function () {
        if (state.phase === "selecting" && state.selectedId) runAttack();
      });
      continueBtn.addEventListener("click", startNextRoundOrFinish);

      var resetBtn = document.getElementById("save-reset-btn");
      resetBtn.addEventListener("click", function () { restartGame(true); });

      function restartGame(goToIntro) {
        state.round = 1;
        state.rounds = [];
        state.selectedId = null;
        state.phase = "selecting";
        state.activeSet = toSet(allIds);
        allIds.forEach(function (id) { curPos[id] = basePos[id].slice(); nodeEls[id].setAttribute("cx", curPos[id][0]); nodeEls[id].setAttribute("cy", curPos[id][1]); });
        edgePositions();
        attemptValueEl.textContent = "1 / 3";
        renderPips();
        resultBlockEl.hidden = true;
        overlayEl.hidden = true;
        selectionCardEl.hidden = true;
        selectionEmptyEl.hidden = false;
        renderLiveStats(baselineGiantSize, baselineComponentCount, false);
        renderBaseStyles();
        setHudStatus(null, "MONITORING");
        gameHintEl.textContent = "Select a character to target them.";
        showScreen(goToIntro ? "screen-intro" : "screen-game");
      }

      // ====================================================================
      // Screens
      // ====================================================================
      function showScreen(id) {
        ["screen-intro", "screen-game", "screen-final"].forEach(function (sid) {
          document.getElementById(sid).classList.toggle("is-active", sid === id);
        });
      }

      var startBtn = document.getElementById("save-start-btn");
      startBtn.disabled = false;
      startBtn.addEventListener("click", function () {
        showScreen("screen-game");
        renderLiveStats(baselineGiantSize, baselineComponentCount, false);
        renderBaseStyles();
        renderPips();
        setHudStatus(null, "MONITORING");
      });

      // intro background: a dim, non-interactive echo of the real network
      (function renderIntroBg() {
        var bg = document.getElementById("save-intro-bg");
        var bw = 600, bh = 420;
        var bgSvg = el("svg", { viewBox: "0 0 " + bw + " " + bh });
        var sampled = baselineGiant.filter(function (_, i) { return i % 2 === 0; });
        var pos = {};
        sampled.forEach(function (id) {
          var p = summary.layout[id];
          if (!p) return;
          pos[id] = [8 + p[0] * (bw - 16), 8 + p[1] * (bh - 16)];
        });
        edgeEls.forEach(function (e) {
          if (!pos[e.a] || !pos[e.b]) return;
          bgSvg.appendChild(el("line", { x1: pos[e.a][0], y1: pos[e.a][1], x2: pos[e.b][0], y2: pos[e.b][1] }));
        });
        Object.keys(pos).forEach(function (id, i) {
          var c = el("circle", { cx: pos[id][0], cy: pos[id][1], r: 2.2, fill: COLOR_CYAN });
          c.style.animationDelay = (-(i % 20) * 0.25).toFixed(2) + "s";
          bgSvg.appendChild(c);
        });
        bg.appendChild(bgSvg);
      })();

      attachHandlers();
      renderLiveStats(baselineGiantSize, baselineComponentCount, false);
      renderBaseStyles();
      renderPips();

      // ====================================================================
      // Final report
      // ====================================================================
      function buildRankLookup(allValues) {
        var ranked = Object.keys(allValues).sort(function (a, b) { return allValues[b] - allValues[a]; });
        var rank = {};
        ranked.forEach(function (id, i) { rank[id] = i + 1; });
        return rank;
      }

      function findGenuineBroker() {
        var betweennessTop = summary.centrality.betweenness.top.slice(0, 15);
        var degreeRank = buildRankLookup(summary.centrality.degree.all);
        var betweennessRank = buildRankLookup(summary.centrality.betweenness.all);
        var best = null;
        betweennessTop.forEach(function (row) {
          var dRank = degreeRank[row.node_id];
          var bRank = betweennessRank[row.node_id];
          if (dRank == null || bRank == null) return;
          var gap = dRank - bRank;
          if (!best || gap > best.gap) best = { name: row.name, degreeRank: dRank, betweennessRank: bRank, gap: gap };
        });
        return best;
      }

      // Looks across every pair of the player's own three picks for a case
      // where the LOWER-degree pick caused AT LEAST as much disruption as
      // the higher-degree one. Prefers a genuine reversal (strictly more
      // disruption) over a tie, and among several candidates picks the one
      // with the largest degree gap -- the most convincing example the
      // player's own three attempts actually produced, not just the first
      // pair found.
      function findPlayerReversal() {
        var rounds = state.rounds;
        var strictCandidates = [], tieCandidates = [];
        for (var i = 0; i < rounds.length; i++) {
          for (var j = 0; j < rounds.length; j++) {
            if (i === j) continue;
            var a = rounds[i], b = rounds[j];
            var degA = summary.centrality.degree.all[a.id] || 0;
            var degB = summary.centrality.degree.all[b.id] || 0;
            if (degA >= degB || a.delta <= 0 || a.delta < b.delta) continue;
            var candidate = { lower: a, higher: b, lowerDeg: degA, higherDeg: degB, gap: degB - degA };
            (a.delta > b.delta ? strictCandidates : tieCandidates).push(candidate);
          }
        }
        var pool = strictCandidates.length ? strictCandidates : tieCandidates;
        if (!pool.length) return null;
        pool.sort(function (x, y) { return y.gap - x.gap; });
        return pool[0];
      }

      function singleNodeReferenceFromStrategy(strategyKey, label) {
        var strat = summary.fragmentation.strategies[strategyKey];
        var name = strat.order_names[0];
        var before = strat.giant_size_after_k[0];
        var after = strat.giant_size_after_k[1];
        return { label: label, name: name, before: before, after: after, delta: before - after };
      }

      function showFinalScreen() {
        showScreen("screen-final");

        var mineEl = document.getElementById("save-final-mine");
        mineEl.innerHTML = "";
        state.rounds.forEach(function (r, i) {
          var li = document.createElement("li");
          li.innerHTML =
            '<span class="rank">' + (i + 1) + '</span>' +
            '<span class="name">' + r.name + '</span>' +
            '<span class="metric">giant ' + r.giantBefore + '→' + r.giantAfter + ', pieces ' + r.componentsBefore + '→' + r.componentsAfter + '</span>';
          mineEl.appendChild(li);
        });

        var refEl = document.getElementById("save-final-reference");
        refEl.innerHTML = "";
        var mf = summary.fragmentation.max_fragmenter;
        var mfBefore = summary.fragmentation.giant_component_total;
        var refs = [
          // NOTE: delta here is plain (before - after), the same definition
          // used everywhere else on this screen -- NOT summary.fragmentation
          // .max_fragmenter.delta, which encodes a different quantity
          // (disruption beyond the trivial "minus the removed node itself").
          { label: "Biggest single-node fragmenter (all 277 tested individually)", name: mf.name, before: mfBefore, after: mf.giant_size_after_removal, delta: mfBefore - mf.giant_size_after_removal },
          singleNodeReferenceFromStrategy("degree_desc", "Highest-degree character"),
          singleNodeReferenceFromStrategy("betweenness_desc", "Highest-betweenness character"),
          singleNodeReferenceFromStrategy("random", "A random character"),
        ];
        refs.forEach(function (r) {
          var li = document.createElement("li");
          li.innerHTML =
            '<span class="rank">–</span>' +
            '<span class="name">' + r.label + ': ' + r.name + '</span>' +
            '<span class="metric">giant ' + r.before + '→' + r.after + ' (−' + r.delta + ')</span>';
          refEl.appendChild(li);
        });

        var messageEl = document.getElementById("save-final-message");
        var reversal = findPlayerReversal();
        var broker = findGenuineBroker();
        var html = "";
        if (reversal) {
          html += "<p><strong>From your own experiment:</strong> " + reversal.lower.name + " has fewer connections (" +
            reversal.lowerDeg + ") than " + reversal.higher.name + " (" + reversal.higherDeg + "), yet caused " +
            (reversal.lower.delta === reversal.higher.delta ? "just as much" : "as much or more") +
            " disruption when removed (−" + reversal.lower.delta + " vs. −" + reversal.higher.delta + "). " +
            "The most connected character is not necessarily the one whose removal causes the greatest structural disruption.</p>";
        }
        if (broker) {
          html += "<p><strong>Across the whole network:</strong> " + broker.name + " ranks #" + broker.degreeRank +
            " by raw connections but #" + broker.betweennessRank + " by betweenness — far more central to the network's shortest paths than its degree alone would suggest.</p>";
        }
        html += "<p style='color:var(--sg-text-dim);font-size:13.5px;'>In this particular network, the single biggest fragmenter (" + mf.name +
          ") also happens to be the highest-degree and highest-betweenness character" +
          (summary.fragmentation.matches_top_degree && summary.fragmentation.matches_top_betweenness ? " — the three measures agree at the very top here, even though they don't always agree further down the ranking, as your own experiment or the comparison above may already have shown." : ".") + "</p>";
        messageEl.innerHTML = html;
      }

      document.getElementById("save-play-again-btn").addEventListener("click", function (e) {
        e.preventDefault();
        restartGame(false);
      });
    })
    .catch(function (err) {
      var c = document.getElementById("save-network");
      if (c) {
        c.textContent =
          "The simulation could not load (this page needs to be served over http://, e.g. via " +
          "'python -m http.server' locally -- it will not load if index.html is opened directly " +
          "as a file). " + err;
      }
      // eslint-disable-next-line no-console
      console.error("week3-save-game.js failed to initialize:", err);
    });
})();
