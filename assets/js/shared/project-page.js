// Small enhancements for the tool project and guide pages:
// highlights the on-page navigation link for the section in view, and wires
// "Copy" buttons for command blocks. Everything works without this script.
(function () {
  "use strict";
  var nav = document.querySelector(".pj-localnav");
  if (nav && "IntersectionObserver" in window) {
    var links = Array.prototype.slice.call(nav.querySelectorAll("a[href^='#']"));
    var byId = {};
    links.forEach(function (link) { byId[link.getAttribute("href").slice(1)] = link; });
    var observer = new IntersectionObserver(function (entries) {
      entries.forEach(function (entry) {
        if (!entry.isIntersecting) return;
        links.forEach(function (link) { link.removeAttribute("aria-current"); });
        var active = byId[entry.target.id];
        if (active) active.setAttribute("aria-current", "true");
      });
    }, { rootMargin: "-20% 0px -70% 0px" });
    Object.keys(byId).forEach(function (id) {
      var section = document.getElementById(id);
      if (section) observer.observe(section);
    });
  }
  Array.prototype.forEach.call(document.querySelectorAll("[data-copy-target]"), function (button) {
    button.hidden = !(navigator.clipboard && window.isSecureContext);
    button.addEventListener("click", function () {
      var source = document.getElementById(button.getAttribute("data-copy-target"));
      if (!source) return;
      navigator.clipboard.writeText(source.textContent.trim()).then(function () {
        var label = button.textContent;
        button.textContent = "Copied";
        setTimeout(function () { button.textContent = label; }, 1500);
      }, function () { button.textContent = "Copy failed"; });
    });
  });
})();
