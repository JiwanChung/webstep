// ══════════════════════════════════════════════════════════════
//  WebStep - Interactive task-distribution sunburst
//  Overview: 10 domain arcs; hovering shows the site's screenshot in
//  a rounded card at the center. Click a domain to zoom into its
//  templates (icons included) while the center card stays; click a
//  template for an example instruction in the side panel; click the
//  center to go back. On any failure the static PNG stays.
// ══════════════════════════════════════════════════════════════

(function () {
  const SIZE = 640, CX = 320, CY = 320;
  const DOMAIN_COLORS = {
    "Mail":          "#eec9a2",
    "Calendar":      "#d9bd8e",
    "Shopping":      "#efe6a7",
    "Accommodation": "#b5dcb7",
    "Food Delivery": "#9ed3ca",
    "Housing":       "#a9cdEE",
    "Coding QA":     "#b3b3e4",
    "Code Repo":     "#c6b4e2",
    "Job Network":   "#e5a9c3",
    "Team Chat":     "#f2b8a8",
  };

  const DOMAIN_ICONS = {
    "Mail":          "",
    "Calendar":      "",
    "Shopping":      "",
    "Accommodation": "",
    "Food Delivery": "",
    "Housing":       "",
    "Coding QA":     "",
    "Code Repo":     "",
    "Job Network":   "",
    "Team Chat":     "",
  };

  // Font Awesome 6 Free (solid) codepoints, keyed by keyword. The keyword
  // appearing earliest in the template name wins.
  const ICON_RULES = [
    ["search", ""], ["find", ""], ["explore", ""], ["extract", ""],
    ["filter", ""], ["constraint", ""],
    ["cancel", ""], ["book", ""],
    ["star", ""], ["rated", ""], ["bookmark", ""],
    ["compare", ""], ["conflict", ""], ["allergen", ""],
    ["count", ""], ["compute", ""],
    ["price", ""], ["sqft", ""], ["cheapest", ""],
    ["salary", ""], ["investment", ""],
    ["cart", ""], ["purchase", ""], ["order", ""], ["product", ""],
    ["message", ""], ["reply", ""], ["dm", ""], ["chat", ""], ["comment", ""],
    ["react", ""], ["pin", ""],
    ["email", ""], ["compose", ""], ["thread", ""], ["attachment", ""],
    ["schedule", ""], ["meeting", ""], ["event", ""],
    ["edit", ""], ["modify", ""], ["organize", ""],
    ["create", ""], ["post", ""],
    ["issue", ""], ["triage", ""],
    ["upvote", ""], ["downvote", ""], ["accept", ""],
    ["tag", ""], ["sort", ""], ["paginate", ""],
    ["view", ""], ["detail", ""], ["open", ""], ["inspect", ""],
    ["profile", ""], ["people", ""], ["connect", ""],
    ["network", ""], ["contributor", ""], ["host", ""], ["agent", ""],
    ["job", ""], ["apply", ""],
    ["location", ""], ["neighborhood", ""], ["tour", ""], ["school", ""],
    ["fork", ""], ["code", ""], ["language", ""], ["navigation", ""],
    ["question", ""], ["answer", ""],
    ["save", ""], ["send", ""],
    ["sleeping", ""], ["amenity", ""],
    ["menu", ""], ["cuisine", ""], ["restaurant", ""],
    ["dietary", ""], ["calorie", ""], ["delivery", ""],
    ["property", ""], ["house", ""], ["listing", ""],
    ["history", ""], ["channel", ""],
  ];
  const DEFAULT_ICON = ""; // file-lines

  function iconFor(name) {
    const n = name.toLowerCase();
    let best = null, bestIdx = Infinity;
    for (const [kw, glyph] of ICON_RULES) {
      const i = n.indexOf(kw);
      if (i >= 0 && i < bestIdx) { bestIdx = i; best = glyph; }
    }
    return best || DEFAULT_ICON;
  }

  function siteSlug(domain) {
    return domain.toLowerCase().replace(/\s+/g, "-");
  }

  let data = null;
  let container = null;
  let zoomed = null;          // domain object or null
  let pinnedTplIdx = null;    // template pinned by click, if any
  let clearStatDetailFn = null; // set by bindStats; keeps right column single-detail
  const siteImageOk = {};     // domain -> bool (probed at init)

  function polar(r, angleDeg) {
    const a = (angleDeg - 90) * Math.PI / 180;
    return [CX + r * Math.cos(a), CY + r * Math.sin(a)];
  }

  function arcPath(r0, r1, a0, a1) {
    const large = a1 - a0 > 180 ? 1 : 0;
    const [x0, y0] = polar(r1, a0), [x1, y1] = polar(r1, a1);
    const [x2, y2] = polar(r0, a1), [x3, y3] = polar(r0, a0);
    return `M${x0},${y0} A${r1},${r1} 0 ${large} 1 ${x1},${y1}` +
           ` L${x2},${y2} A${r0},${r0} 0 ${large} 0 ${x3},${y3} Z`;
  }

  function esc(s) {
    return String(s).replace(/&/g, "&amp;").replace(/</g, "&lt;").replace(/>/g, "&gt;");
  }

  function shade(hex, f) {
    const n = parseInt(hex.slice(1), 16);
    const ch = i => {
      let c = (n >> (16 - 8 * i)) & 255;
      c = Math.round(f > 0 ? c + (255 - c) * f : c * (1 + f));
      return Math.min(255, Math.max(0, c));
    };
    return `rgb(${ch(0)}, ${ch(1)}, ${ch(2)})`;
  }

  function overviewCenterHtml() {
    const total = data.reduce((s, d) => s + d.total, 0);
    return `
      <text class="sb-center-title" x="${CX}" y="${CY - 8}" text-anchor="middle">${total.toLocaleString()} tasks</text>
      <text class="sb-center-sub" x="${CX}" y="${CY + 16}" text-anchor="middle">${data.length} domains</text>
      <text class="sb-center-hint" x="${CX}" y="${CY + 40}" text-anchor="middle"><tspan class="sb-hint-icon"></tspan><tspan dx="6">click a domain to explore</tspan></text>`;
  }

  // Rounded screenshot card + caption (icon · name · count) in the center.
  function domainCardHtml(d, sub, withHint) {
    const hasImg = siteImageOk[d.domain] === true;
    const icon = DOMAIN_ICONS[d.domain] || "";
    let s = "";
    let base;
    if (hasImg) {
      const BW = 176, BH = 99, bx = CX - BW / 2, by = CY - 78;
      s += `<clipPath id="sb-card-clip"><rect x="${bx}" y="${by}" width="${BW}" height="${BH}" rx="9"></rect></clipPath>
        <image href="static/sites/${siteSlug(d.domain)}.png" x="${bx}" y="${by}" width="${BW}" height="${BH}"
          preserveAspectRatio="xMidYMid slice" clip-path="url(#sb-card-clip)"></image>
        <rect class="sb-card-frame" x="${bx}" y="${by}" width="${BW}" height="${BH}" rx="9"></rect>`;
      base = CY + 45;
    } else {
      base = CY - 2;
    }
    s += `<text class="sb-cap-name" x="${CX}" y="${base}" text-anchor="middle"><tspan class="sb-cap-icon">${icon}</tspan><tspan dx="7">${esc(d.domain)}</tspan></text>
      <text class="sb-cap-count" x="${CX}" y="${base + 20}" text-anchor="middle">${esc(sub)}</text>
      ${withHint ? `<text class="sb-center-hint" x="${CX}" y="${base + 41}" text-anchor="middle">← back</text>` : ""}`;
    return s;
  }

  function renderOverview() {
    zoomed = null;
    clearTemplateDetail();
    const total = data.reduce((s, d) => s + d.total, 0);
    let a = 0, arcs = "", labels = "";
    for (const d of data) {
      const sweep = 360 * d.total / total;
      const mid = a + sweep / 2;
      const rad = (mid - 90) * Math.PI / 180;
      arcs += `<path class="sb-arc" d="${arcPath(150, 252, a, a + sweep)}"
        style="--px:${(7 * Math.cos(rad)).toFixed(2)}px;--py:${(7 * Math.sin(rad)).toFixed(2)}px;"
        fill="${DOMAIN_COLORS[d.domain] || "#cbd5e1"}" data-domain="${esc(d.domain)}">
        <title>${esc(d.domain)}: ${d.total} tasks</title></path>`;
      const [lx, ly] = polar(203, mid);
      labels += `<text class="sb-domain-label" x="${lx}" y="${ly - 3}" text-anchor="middle"><tspan class="sb-ring-icon">${DOMAIN_ICONS[d.domain] || ""}</tspan><tspan dx="6">${esc(d.domain)}</tspan></text>
        <text class="sb-domain-count" x="${lx}" y="${ly + 14}" text-anchor="middle">(${d.total})</text>`;
      a += sweep;
    }
    draw(`${arcs}${labels}
      <circle class="sb-center" cx="${CX}" cy="${CY}" r="140"></circle>
      <g class="sb-center-content">${overviewCenterHtml()}</g>`);
  }

  // ── Domain panel: card slides aside, templates cascade top-to-bottom ──
  function openDomain(d) {
    zoomed = d;
    clearTemplateDetail();
    const color = DOMAIN_COLORS[d.domain] || "#cbd5e1";
    const panel = document.getElementById("domain-panel");
    panel.style.setProperty("--dc", shade(color, -0.15));
    panel.style.setProperty("--dc-bg", shade(color, 0.62));
    panel.innerHTML = `
      <div class="dp-card">
        ${siteImageOk[d.domain] === true
          ? `<img src="static/sites/${siteSlug(d.domain)}.png" alt="${esc(d.domain)}">` : ""}
        <div class="dp-name"><span class="tpl-fa">${DOMAIN_ICONS[d.domain] || ""}</span>${esc(d.domain)}</div>
        <div class="dp-count">${d.total} tasks · ${d.templates.length} templates</div>
        <button class="dp-back" type="button">← all domains</button>
      </div>
      <div class="dp-list-wrap">
        <div class="dp-list-head">Task templates <span>· hover for an example, click to pin</span></div>
        <ul class="dp-list">
          ${d.templates.map((t, i) => `
            <li class="tpl-row" style="--i:${i};" data-idx="${i}" title="${esc(t.name)}: ${t.count} tasks">
              <span class="tpl-fa">${iconFor(t.name)}</span>
              <span class="tpl-row-name">${esc(t.name)}</span>
              <span class="tpl-row-count">${t.count} tasks</span>
            </li>`).join("")}
        </ul>
      </div>`;
    panel.hidden = false;
    requestAnimationFrame(() => container.parentElement.classList.add("zoomed"));
    const cardImg = panel.querySelector(".dp-card img");
    if (cardImg) cardImg.addEventListener("click", () =>
      openLightbox(cardImg.src, `${d.domain}, a self-hosted benchmark website`));
    panel.querySelector(".dp-back").addEventListener("click", closeDomain);
    pinnedTplIdx = null;
    panel.querySelectorAll(".tpl-row").forEach(row => {
      const idx = parseInt(row.dataset.idx);
      // Hovering a template previews its example; clicking pins it.
      row.addEventListener("mouseenter", () => {
        showTemplateDetail(d, d.templates[idx]);
      });
      row.addEventListener("click", () => {
        pinnedTplIdx = idx;
        panel.querySelectorAll(".tpl-row.selected").forEach(r => r.classList.remove("selected"));
        row.classList.add("selected");
        row.classList.remove("pulse");
        void row.offsetWidth; // restart the pulse animation
        row.classList.add("pulse");
        showTemplateDetail(d, d.templates[idx]);
      });
    });
    panel.querySelector(".dp-list").addEventListener("mouseleave", () => {
      if (pinnedTplIdx !== null) showTemplateDetail(d, d.templates[pinnedTplIdx]);
      else {
        const detail = document.getElementById("template-detail");
        if (detail) { detail.hidden = true; detail.innerHTML = ""; }
      }
    });
  }

  // ── Lightbox for site screenshots ──
  let lightboxEl = null;
  function openLightbox(src, label) {
    if (!lightboxEl) {
      lightboxEl = document.createElement("div");
      lightboxEl.className = "lightbox";
      lightboxEl.innerHTML = `<figure><img alt=""><figcaption></figcaption></figure>`;
      document.body.appendChild(lightboxEl);
      lightboxEl.addEventListener("click", () => lightboxEl.classList.remove("show"));
      document.addEventListener("keydown", e => {
        if (e.key === "Escape") lightboxEl.classList.remove("show");
      });
    }
    lightboxEl.querySelector("img").src = src;
    lightboxEl.querySelector("figcaption").textContent = label;
    requestAnimationFrame(() => lightboxEl.classList.add("show"));
  }

  function closeDomain() {
    zoomed = null;
    clearTemplateDetail();
    container.parentElement.classList.remove("zoomed");
    setTimeout(() => {
      if (!zoomed) document.getElementById("domain-panel").hidden = true;
    }, 280);
  }

  // ── Side panel: example instruction for a clicked template ──
  function clearTemplateDetail() {
    pinnedTplIdx = null;
    const panel = document.getElementById("template-detail");
    if (panel) { panel.hidden = true; panel.innerHTML = ""; }
    const dp = document.getElementById("domain-panel");
    if (dp) dp.querySelectorAll(".tpl-row.selected").forEach(r => r.classList.remove("selected"));
  }

  function showTemplateDetail(domain, t) {
    if (clearStatDetailFn) clearStatDetailFn();
    const panel = document.getElementById("template-detail");
    if (!panel) return;
    const color = DOMAIN_COLORS[domain.domain] || "#cbd5e1";
    panel.innerHTML = `
      <div class="tpl-head" style="border-color:${shade(color, -0.25)};">
        <span class="tpl-icon" style="color:${shade(color, -0.45)};">${iconFor(t.name)}</span>
        <span class="tpl-name">${esc(t.name)}</span>
        <span class="tpl-count">${t.count} tasks</span>
      </div>
      ${t.example
        ? `<div class="tpl-example"><span class="tpl-example-tag">example</span>${esc(t.example)}</div>`
        : `<div class="tpl-example tpl-example-empty">example instruction coming soon</div>`}`;
    panel.hidden = false;
  }

  function draw(inner) {
    const svg = container.querySelector("svg");
    svg.classList.add("sb-fading");
    setTimeout(() => {
      svg.innerHTML = inner;
      bind(svg);
      svg.classList.remove("sb-fading");
    }, 130);
  }

  function bind(svg) {
    const content = () => svg.querySelector(".sb-center-content");
    const total = data.reduce((s, d) => s + d.total, 0);
    svg.querySelectorAll(".sb-arc").forEach(arc => {
      arc.addEventListener("mouseenter", () => {
        const d = data.find(x => x.domain === arc.dataset.domain);
        content().innerHTML = domainCardHtml(d, `${d.total} tasks · ${(100 * d.total / total).toFixed(1)}%`, false);
      });
      arc.addEventListener("mouseleave", () => {
        content().innerHTML = overviewCenterHtml();
      });
      arc.addEventListener("click", () => {
        openDomain(data.find(x => x.domain === arc.dataset.domain));
      });
    });
  }


  // ── Stat cards: hover previews a detail card, click pins it ──
  const SKILL_FAMILIES = [
    ["Search / Config", "#818cf8", "#eef2ff"],
    ["Filter",          "#f59e0b", "#fffbeb"],
    ["Navigate",        "#06b6d4", "#ecfeff"],
    ["Inspect",         "#8b5cf6", "#f5f3ff"],
    ["Commit",          "#10b981", "#ecfdf5"],
  ];
  const AGENT_LIST = ["OpenAI CUA", "Qwen3.5-122B", "UI-TARS-1.5-7B", "GUI-Owl-1.5-8B", "Fara-7B"];

  function statDetailHtml(kind) {
    if (kind === "websites") {
      return `<div class="sd-head">10 self-hosted websites</div>
        <div class="sd-chips">${data.map(d =>
          `<span class="sd-chip"><span class="tpl-fa">${DOMAIN_ICONS[d.domain] || ""}</span>${esc(d.domain)}</span>`).join("")}</div>`;
    }
    if (kind === "tasks") {
      const nTpl = data.reduce((s, d) => s + d.templates.length, 0);
      return `<div class="sd-head">1,800 task instances</div>
        <ul class="sd-lines">
          <li><strong>180 tasks</strong> per website, with controlled difficulty</li>
          <li>drawn from <strong>${nTpl} task templates</strong></li>
          <li>each instance checked by an <strong>automatic judge</strong></li>
        </ul>`;
    }
    if (kind === "skills") {
      return `<div class="sd-head">5 skill categories</div>
        <div class="sd-chips">${SKILL_FAMILIES.map(([n, c, b]) =>
          `<span class="sd-chip" style="color:${c};background:${b};border-color:${c};">${esc(n)}</span>`).join("")}</div>
        <p class="sd-note">Every recorded semantic action is automatically labeled with one of these skill families.</p>`;
    }
    if (kind === "agents") {
      return `<div class="sd-head">5 agents evaluated</div>
        <ul class="sd-lines">${AGENT_LIST.map(a => `<li>${esc(a)}</li>`).join("")}</ul>`;
    }
    return "";
  }

  function bindStats() {
    const cards = document.querySelectorAll(".stat-card[data-stat]");
    const detail = document.getElementById("stat-detail");
    if (!cards.length || !detail) return;
    let pinnedStat = null;
    const show = kind => {
      clearTemplateDetail(); // keep the right column to a single detail card
      detail.innerHTML = statDetailHtml(kind);
      detail.hidden = false;
    };
    clearStatDetailFn = () => {
      pinnedStat = null;
      cards.forEach(c => c.classList.remove("active"));
      detail.hidden = true;
      detail.innerHTML = "";
    };
    const sync = () => {
      cards.forEach(c => c.classList.toggle("active", c.dataset.stat === pinnedStat));
      if (pinnedStat) show(pinnedStat);
      else { detail.hidden = true; detail.innerHTML = ""; }
    };
    cards.forEach(card => {
      card.addEventListener("mouseenter", () => show(card.dataset.stat));
      card.addEventListener("click", () => {
        pinnedStat = pinnedStat === card.dataset.stat ? null : card.dataset.stat;
        sync();
      });
    });
    document.querySelector(".stats-col").addEventListener("mouseleave", sync);
  }

  function init(dist) {
    dist.forEach(d => { d.total = d.templates.reduce((s, t) => s + t.count, 0); });
    const total = dist.reduce((s, d) => s + d.total, 0);
    if (dist.length !== 10 || total !== 1800) {
      console.warn("task_distribution.json failed checksum (domains:", dist.length, "total:", total, ") — keeping static figure");
      return;
    }
    data = dist;
    // Probe which domains have a site screenshot for the center card.
    data.forEach(d => {
      const probe = new Image();
      probe.onload = () => { siteImageOk[d.domain] = true; };
      probe.onerror = () => { siteImageOk[d.domain] = false; };
      probe.src = `static/sites/${siteSlug(d.domain)}.png`;
    });
    container = document.getElementById("task-sunburst");
    container.innerHTML = `<svg viewBox="0 0 ${SIZE} ${SIZE}" role="img"
      aria-label="Task distribution across domains"></svg>`;
    const img = document.querySelector(".benchmark-section .figure-img");
    if (img) img.style.display = "none";
    container.style.display = "";
    const legend = document.getElementById("sunburst-legend");
    if (legend) legend.hidden = false;
    bindStats();
    renderOverview();
  }

  document.addEventListener("DOMContentLoaded", () => {
    fetch("static/task_distribution.json")
      .then(r => { if (!r.ok) throw new Error(r.status); return r.json(); })
      .then(init)
      .catch(e => console.warn("sunburst data unavailable, keeping static figure:", e));
  });
})();
