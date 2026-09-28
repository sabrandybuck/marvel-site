// Week 4: data-driven size bar for the Aristotle neighbour breakdown.
// Each bar's width is count / total-neighbours, where "total neighbours" is
// not a number typed into this file -- it's read straight out of the list's
// own text ("... of his 300 neighbours ..."), so if that sentence's number
// ever changes, the bars follow it without needing a second edit here.
(function () {
  "use strict";

  document.querySelectorAll(".community-list[data-dynamic-bars]").forEach(function (list) {
    var totalMatch = list.textContent.match(/(\d+)\s+neighbours/);
    var total = totalMatch ? parseInt(totalMatch[1], 10) : 0;
    if (!total) return;

    list.querySelectorAll("li").forEach(function (li) {
      var countEl = li.querySelector(".community-count");
      var barFill = li.querySelector(".community-bar > span");
      if (!countEl || !barFill) return;
      var count = parseInt(countEl.textContent, 10) || 0;
      barFill.style.width = (count / total * 100) + "%";
    });
  });
})();
