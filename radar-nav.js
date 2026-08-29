/**
 * Shared navbar — the design spine's navigation, injected as a classic
 * script (the project's shared-component pattern, like promo-enrich.js).
 * Pure presentation: renders links, highlights the active page, and touches
 * nothing else. Engineering surfaces live under the quiet "Radar" menu.
 */
(function () {
  const LINKS = [
    { label: "Flights", href: "/" },
    { label: "Stays", href: "/hotel-awards.html" },
    { label: "Deals", href: "/dealradar.html" },
    { label: "Trips", href: "/trips.html" },
  ]
  const RADAR_MENU = [
    { label: "Observer", href: "/observer.html" },
    { label: "Fare Radar", href: "/fares.html" },
    { label: "Market", href: "/trips.html", title: "Market verdicts render inside Trip Composer" },
  ]

  function active(href) {
    const path = window.location.pathname
    if (href === "/") return path === "/" || path === "/dashboard.html"
    return path === href
  }

  const esc = s => String(s).replace(/[&<>"]/g, ch => ({ "&": "&amp;", "<": "&lt;", ">": "&gt;", '"': "&quot;" }[ch]))

  const nav = document.createElement("nav")
  nav.className = "radar-nav"
  nav.innerHTML =
    `<a class="brand" href="/">EXTREME TRAVEL RADAR<span class="dot">.</span></a>` +
    LINKS.map(l => `<a class="nav-link${active(l.href) ? " active" : ""}" href="${esc(l.href)}">${esc(l.label)}</a>`).join("") +
    `<span class="spacer"></span>` +
    `<details class="radar-menu"><summary>Radar ▾</summary><div class="menu">` +
    RADAR_MENU.map(l => `<a href="${esc(l.href)}"${l.title ? ` title="${esc(l.title)}"` : ""}>${esc(l.label)}</a>`).join("") +
    `</div></details>`

  document.body.insertBefore(nav, document.body.firstChild)

  // Close the Radar menu on any outside click.
  document.addEventListener("click", e => {
    const menu = nav.querySelector("details.radar-menu")
    if (menu && menu.open && !menu.contains(e.target)) menu.open = false
  })
})()
