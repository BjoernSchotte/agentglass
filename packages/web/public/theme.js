// agentglass theme without a flash: runs blocking in <head> before the app, sets data-theme from localStorage
// ("dark" | "light" | "system", default system) and follows prefers-color-scheme live under system
(function () {
  var KEY = "agentglass.theme", t = "system";
  try { t = localStorage.getItem(KEY) || "system"; } catch (e) { /* storage blocked: system */ }
  var m = window.matchMedia ? window.matchMedia("(prefers-color-scheme: dark)") : null;
  function apply() { document.documentElement.setAttribute("data-theme", t === "system" ? (m && m.matches ? "dark" : "light") : t); }
  apply();
  if (m && m.addEventListener) m.addEventListener("change", function () { if (t === "system") apply(); });
  window.agTheme = { get: function () { return t; }, set: function (v) { t = v; try { localStorage.setItem(KEY, v); } catch (e) { /* not kept */ } apply(); } };
})();
