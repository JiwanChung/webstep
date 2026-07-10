// ══════════════════════════════════════════════════════════════
//  WebStep - Interactive Trajectory Viewer
//  Three-row layout matching the paper figure:
//    Row 1: Agent sees  (screenshots)
//    Row 2: Agent does  (raw GUI actions)
//    Row 3: MDP records (semantic transitions, spanning columns)
// ══════════════════════════════════════════════════════════════

const SAMPLES = [
  { id: "airbnb_0001",    site: "Accommodation" },
  { id: "github_0001",    site: "Code Repo" },
  { id: "gmail_0001",     site: "Mail" },
];

const AGENTS = [
  { id: "openai_cua", label: "OpenAI CUA" },
  { id: "qwen_vl",    label: "Qwen3.5" },
  { id: "uitars",     label: "UI-TARS" },
  { id: "fara",       label: "Fara" },
  { id: "guiowl",     label: "GUI-Owl" },
];

const FAMILY_META = {
  configuration: { label: "Search/Config", color: "#818cf8", bg: "#eef2ff" },
  refinement:    { label: "Filter",        color: "#f59e0b", bg: "#fffbeb" },
  navigation:    { label: "Navigate",      color: "#06b6d4", bg: "#ecfeff" },
  inspection:    { label: "Inspect",       color: "#8b5cf6", bg: "#f5f3ff" },
  commit:        { label: "Commit",        color: "#10b981", bg: "#ecfdf5" },
  waste:         { label: "Other",         color: "#9ca3af", bg: "#f3f4f6" },
};

// ── State ──
let data = null;
let currentSample = 0;
let currentAgent = 0;
let activeCol = null;
let pendingCol = null; // one-shot column from the ?col= deep link
let mdpSteps = [];
let turnGroups = [];
let turnToMdp = [];
let triggerByTurn = {}; // turn index -> mdp index it dispatched

// ══════════════════════════════════════════════════════════════
//  INIT
// ══════════════════════════════════════════════════════════════

document.addEventListener("DOMContentLoaded", () => {
  // Deep link: ?task=airbnb_0001&agent=uitars&col=45
  const params = new URLSearchParams(location.search);
  const taskIdx = SAMPLES.findIndex(s => s.id === params.get("task"));
  const agentIdx = AGENTS.findIndex(a => a.id === params.get("agent"));
  if (taskIdx >= 0) currentSample = taskIdx;
  if (agentIdx >= 0) currentAgent = agentIdx;
  const colParam = parseInt(params.get("col"));
  if (!Number.isNaN(colParam)) pendingCol = colParam;
  document.querySelectorAll(".traj-tab").forEach((t, i) =>
    t.classList.toggle("active", i === currentSample));

  // Task tabs
  document.querySelectorAll(".traj-tab").forEach((tab, i) => {
    tab.addEventListener("click", () => {
      currentSample = i;
      document.querySelectorAll(".traj-tab").forEach(t => t.classList.remove("active"));
      tab.classList.add("active");
      currentAgent = 0;
      loadCurrent();
    });
  });

  // Agent tabs (rendered dynamically)
  document.addEventListener("keydown", e => {
    if (!data) return;
    const maxCol = data.turns.length - 1;
    if (e.key === "ArrowRight") { e.preventDefault(); activeCol = activeCol === null ? 0 : Math.min(maxCol, activeCol + 1); render(); }
    if (e.key === "ArrowLeft")  { e.preventDefault(); activeCol = activeCol === null ? maxCol : Math.max(0, activeCol - 1); render(); }
    if (e.key === "Escape")     { activeCol = null; render(); }
  });

  renderAgentTabs();
  loadCurrent();
});

function loadCurrent() {
  const taskId = SAMPLES[currentSample].id;
  const agent = AGENTS[currentAgent].id;
  loadSample(taskId, agent);
}

async function loadSample(taskId, agent) {
  activeCol = null;
  hoverCol = null;
  hideTag();
  renderAgentTabs();
  try {
    const resp = await fetch(`data/${taskId}/${agent}/bundle.json`);
    if (!resp.ok) throw new Error(`No data for ${agent} on ${taskId}`);
    data = await resp.json();
    processData();
    activeCol = pendingCol !== null
      ? Math.min(Math.max(pendingCol, 0), data.turns.length - 1) : 0;
    pendingCol = null;
    render();
  } catch (e) {
    console.error("Failed to load", taskId, agent, e);
    data = null;
    document.getElementById("three-row-timeline").innerHTML =
      `<div style="padding:20px;color:var(--text-muted);text-align:center;font-style:italic;">No trajectory for ${AGENTS[currentAgent].label} on this task</div>`;
    document.getElementById("detail-panel").innerHTML = "";
    document.getElementById("metrics-grid").innerHTML = "";
  }
}

function renderAgentTabs() {
  const container = document.getElementById("agent-tabs");
  if (!container) return;
  container.innerHTML = AGENTS.map((a, i) =>
    `<button class="agent-tab ${i === currentAgent ? 'active' : ''}" data-agent="${i}">${a.label}</button>`
  ).join("");
  container.querySelectorAll(".agent-tab").forEach(btn => {
    btn.addEventListener("click", () => {
      currentAgent = parseInt(btn.dataset.agent);
      loadCurrent();
    });
  });
}

// ══════════════════════════════════════════════════════════════
//  DATA PROCESSING
// ══════════════════════════════════════════════════════════════

function processData() {
  const { mdp_trajectory, skill_labels, turns } = data;

  const skillByStep = {};
  for (const sl of skill_labels) skillByStep[sl.step] = sl;

  mdpSteps = mdp_trajectory.map((action, i) => {
    const sl = skillByStep[i + 1];
    const skill = sl?.skills?.[0] || {};
    return {
      action: action.action,
      payload: action.payload,
      timestamp: action.timestamp,
      family: skill.family || "configuration",
      skill: skill.skill || "",
      skillDetail: skill.detail || "",
      skillScore: skill.score ?? 0,
    };
  });

  // Map GUI turns → MDP actions. Prefer the precomputed mapping from
  // fix_bundles.py (anchor-based alignment that also handles transitions
  // invisible in the slimmed state, e.g. Star); fall back to state-change
  // detection for bundles that don't carry it.
  turnGroups = [];
  turnToMdp = new Array(turns.length).fill(-1);

  if (Array.isArray(data.turn_to_mdp) && data.turn_to_mdp.length === turns.length) {
    turnToMdp = data.turn_to_mdp.slice();
    for (let t = 0; t < turnToMdp.length; t++) {
      const mi = turnToMdp[t];
      if (mi >= 0 && mi < mdpSteps.length) {
        if (!turnGroups[mi]) turnGroups[mi] = [];
        turnGroups[mi].push(t);
      }
    }
  } else {
    let mdpIdx = 0;
    let groupStart = 0;

    for (let i = 1; i < turns.length; i++) {
      if (mdpIdx < mdp_trajectory.length && stateChanged(turns[i - 1].state, turns[i].state)) {
        const group = [];
        for (let j = groupStart; j < i; j++) { group.push(j); turnToMdp[j] = mdpIdx; }
        turnGroups[mdpIdx] = group;
        groupStart = i;
        mdpIdx++;
      }
    }
    // Remaining turns → last MDP action or overflow
    if (groupStart < turns.length) {
      const idx = Math.min(mdpIdx, mdpSteps.length - 1);
      if (!turnGroups[idx]) turnGroups[idx] = [];
      for (let j = groupStart; j < turns.length; j++) {
        turnGroups[idx].push(j);
        turnToMdp[j] = idx;
      }
    }
  }

  // Which turn actually dispatched each MDP action: precomputed by
  // fix_bundles.py when available, else the last turn of each span.
  triggerByTurn = {};
  const trig = data.mdp_trigger_turns;
  if (Array.isArray(trig) && trig.length === mdpSteps.length) {
    trig.forEach((t, mi) => { if (t !== null && t >= 0) triggerByTurn[t] = mi; });
  } else {
    turnGroups.forEach((g, mi) => {
      if (g && g.length) triggerByTurn[g[g.length - 1]] = mi;
    });
  }
}

function stateChanged(a, b) {
  if (!a || !b) return false;
  const keys = new Set([...Object.keys(a), ...Object.keys(b)]);
  for (const k of keys) {
    if (JSON.stringify(a[k]) !== JSON.stringify(b[k])) return true;
  }
  return false;
}

// ══════════════════════════════════════════════════════════════
//  RENDER
// ══════════════════════════════════════════════════════════════

function render() {
  if (!data) return;
  renderInstruction();
  renderThreeRowTimeline();
  renderDetailPanel();
  renderMetrics();
  scrollActiveColIntoView();
}

// Keep the active column visible when stepping through turns
// (arrow keys or MDP-span clicks can move the selection off-viewport).
function scrollActiveColIntoView() {
  if (activeCol === null) return;
  const wrapper = document.querySelector(".three-row-wrapper");
  const cell = document.querySelector(`#three-row-timeline [data-col="${activeCol}"]`);
  if (!wrapper || !cell) return;
  const w = wrapper.getBoundingClientRect();
  const c = cell.getBoundingClientRect();
  const margin = 12;
  let delta = 0;
  if (c.left < w.left + margin) delta = c.left - (w.left + margin);
  else if (c.right > w.right - margin) delta = c.right - (w.right - margin);
  if (delta) wrapper.scrollBy({ left: delta, behavior: "auto" });
}

function renderInstruction() {
  document.getElementById("instruction-text").textContent = data.instruction;
  const outcomeTag = data.outcome === "success"
    ? '<span style="color:var(--success);font-weight:600;">PASS</span>'
    : '<span style="color:var(--failure);font-weight:600;">FAIL</span>';
  document.getElementById("instruction-meta").innerHTML =
    `${AGENTS[currentAgent].label} | ${outcomeTag} | ${data.task_id}`;
}

// ── Three-row timeline (the core visualization) ──
function renderThreeRowTimeline() {
  const container = document.getElementById("three-row-timeline");
  const turns = data.turns;

  // Filter to actionable turns (skip no-op screenshots where action is null
  // and it's not the first or last turn)
  const cols = turns.map((t, i) => i); // all turn indices as columns

  // Build MDP span info: for each MDP action, which columns does it span?
  const mdpSpans = []; // { mdpIdx, startCol, endCol }
  for (let mi = 0; mi < mdpSteps.length; mi++) {
    const group = turnGroups[mi] || [];
    if (group.length > 0) {
      mdpSpans.push({
        mdpIdx: mi,
        startCol: group[0],
        endCol: group[group.length - 1],
      });
    }
  }

  // ── Build HTML ──
  const COL_W = 130;   // px per column
  const LABEL_W = 60;  // .tr-row-label width; rows are label + columns wide
  const totalW = cols.length * COL_W + LABEL_W;

  let html = `<div class="tr-scroll" style="min-width:${totalW}px;">`;

  // ── Row 1: Agent sees (screenshots) ──
  html += `<div class="tr-row tr-row-sees">`;
  html += `<div class="tr-row-label">Agent<br>sees</div>`;
  html += `<div class="tr-row-content">`;
  for (const ci of cols) {
    const turn = turns[ci];
    const ssPath = `screenshots/${data.task_id}/${data.agent}/turn_${String(turn.step).padStart(3, "0")}.png`;
    const isActive = activeCol === ci;
    html += `<div class="tr-cell tr-cell-ss ${isActive ? "active" : ""}" data-col="${ci}" style="width:${COL_W}px;">
      <img src="${ssPath}" alt="Turn ${turn.step}" onerror="this.style.display='none';">
    </div>`;
  }
  html += `</div></div>`;

  // ── Row 2: Agent does (raw GUI actions) ──
  html += `<div class="tr-row tr-row-does">`;
  html += `<div class="tr-row-label">Agent<br>does</div>`;
  html += `<div class="tr-row-content">`;
  for (const ci of cols) {
    const turn = turns[ci];
    const action = turn.action;
    const isActive = activeCol === ci;
    let label, iconCls;
    if (!action?.action) {
      label = turn.final_response ? "done" : "-";
      iconCls = turn.final_response ? "fa-flag-checkered" : "fa-camera";
    } else {
      const a = action.action;
      iconCls = (a === "left_click" || a === "left_double") ? "fa-mouse-pointer"
        : a === "type" ? "fa-keyboard"
        : (a === "key" || a === "hotkey") ? "fa-arrow-turn-down"
        : a === "scroll" ? "fa-arrows-up-down" : "fa-hand-pointer";
      const coord = action.coordinate;
      const text = action.text;
      const keys = action.keys;
      label = a;
      if (coord) label += `(${coord[0]},${coord[1]})`;
      else if (text) label += `("${text.length > 10 ? text.slice(0, 10) + "…" : text}")`;
      else if (keys) label += `(${keys.join("+")})`;
    }
    const trigMi = triggerByTurn[ci];
    let trigDot = "";
    if (trigMi !== undefined) {
      const step = mdpSteps[trigMi];
      const fm = FAMILY_META[step.family] || FAMILY_META.configuration;
      trigDot = `<span class="tr-trigger-dot" style="background:${fm.color};"
        title="this action dispatched ${esc(step.action)}"></span>`;
    }
    html += `<div class="tr-cell tr-cell-action ${isActive ? "active" : ""}" data-col="${ci}" style="width:${COL_W}px;">
      <i class="fas ${iconCls}"></i>
      <span class="tr-action-label">${esc(label)}</span>
      ${trigDot}
    </div>`;
  }
  html += `</div></div>`;

  // ── Row 3: MDP records (semantic actions, spanning columns) ──
  html += `<div class="tr-row tr-row-mdp">`;
  html += `<div class="tr-row-label">MDP<br>records</div>`;
  html += `<div class="tr-row-content" style="position:relative;height:52px;">`;

  if (mdpSpans.length === 0) {
    html += `<div class="tr-mdp-empty">No semantic transitions recorded</div>`;
  }

  // Trailing turns that never produced another transition (agent flailing
  // after its last semantic action) get a distinct region, not a span.
  // The final "done" turn is the episode ending, not flailing — skip it.
  const lastAssigned = turnToMdp.reduce((acc, mi, t) => (mi >= 0 ? t : acc), -1);
  let tailEnd = turns.length - 1;
  const lastTurn = turns[tailEnd];
  if (lastTurn && !lastTurn.action?.action && lastTurn.final_response) tailEnd--;
  const nTail = tailEnd - lastAssigned;
  if (mdpSpans.length > 0 && lastAssigned >= 0 && nTail > 0) {
    const left = (lastAssigned + 1) * COL_W;
    const label = `no further semantic transitions (${nTail} turn${nTail > 1 ? "s" : ""})`;
    html += `<div class="tr-mdp-tail" style="left:${left}px;width:${nTail * COL_W}px;" title="${label}">
      ${nTail >= 3 ? `<span class="tr-mdp-tail-label">${label}</span>` : ""}
    </div>`;
  }

  for (const span of mdpSpans) {
    const step = mdpSteps[span.mdpIdx];
    const left = span.startCol * COL_W;
    const width = (span.endCol - span.startCol + 1) * COL_W;
    const fm = FAMILY_META[step.family] || FAMILY_META.configuration;
    const isActive = activeCol !== null && activeCol >= span.startCol && activeCol <= span.endCol;
    const detail = payloadSummary(step);

    html += `<div class="tr-mdp-span ${isActive ? "active" : ""}" data-mdp="${span.mdpIdx}"
      style="left:${left}px;width:${width}px;border-color:${fm.color};background:${fm.bg};">
      <span class="tr-mdp-action">${esc(step.action)}</span>
      ${detail ? `<span class="tr-mdp-detail">${esc(detail)}</span>` : ""}
    </div>`;
  }

  html += `</div></div>`;

  // ── S_start / S_end labels ──
  html += `<div class="tr-row tr-row-labels">`;
  html += `<div class="tr-row-label"></div>`;
  html += `<div class="tr-row-content" style="display:flex;justify-content:space-between;">
    <span class="tr-endpoint">S<sub>start</sub></span>
    <span class="tr-endpoint">S<sub>end</sub></span>
  </div></div>`;

  // ── Summary line ──
  const totalGui = turns.filter(t => t.action?.action).length;
  const idleTurns = turns.length - totalGui;
  html += `<div class="tr-summary">
    Semantic trace &tau; = (s<sub>0</sub>, a<sub>0</sub>, &hellip; s<sub>${mdpSteps.length}</sub>)
    | ${totalGui} GUI actions${idleTurns > 0 ? ` (+${idleTurns} idle)` : ""} -> ${mdpSteps.length} semantic transitions
  </div>`;

  html += `</div>`; // end tr-scroll

  container.innerHTML = html;

  // ── Click handlers ──
  container.querySelectorAll("[data-col]").forEach(el => {
    el.addEventListener("click", () => {
      activeCol = parseInt(el.dataset.col);
      render();
    });
  });
  container.querySelectorAll("[data-mdp]").forEach(el => {
    el.addEventListener("click", () => {
      const mi = parseInt(el.dataset.mdp);
      const group = turnGroups[mi];
      activeCol = group ? group[0] : null;
      render();
    });
  });

  attachHoverInteractions(container);
}

// ══════════════════════════════════════════════════════════════
//  SEMANTIC HOVER (tag + live preview + step emphasis)
// ══════════════════════════════════════════════════════════════

let tagEl = null;
let caretEl = null;
let hoverCol = null; // turn being previewed in the detail panel

function getTag() {
  if (!tagEl) {
    tagEl = document.createElement("div");
    tagEl.className = "semantic-tag";
    document.body.appendChild(tagEl);
    // Any scroll invalidates the fixed-position anchor: hide immediately.
    window.addEventListener("scroll", hideTag, { passive: true, capture: true });
  }
  return tagEl;
}

function hideTag() {
  if (tagEl) tagEl.classList.remove("visible");
  if (caretEl) caretEl.classList.remove("visible");
}

// Semantic reading of a turn: its transition's family color + label text.
function semanticReading(ci) {
  const mi = turnToMdp[ci];
  if (mi >= 0 && mdpSteps[mi]) {
    const step = mdpSteps[mi];
    const fm = FAMILY_META[step.family] || FAMILY_META.configuration;
    const isTrigger = triggerByTurn[ci] !== undefined;
    return {
      color: fm.color,
      bg: isTrigger ? fm.color : fm.bg,
      fg: isTrigger ? "#fff" : fm.color,
      text: isTrigger ? `dispatched ${step.action}` : `→ ${step.action}`,
    };
  }
  return { color: "#d1d5db", bg: "#f3f4f6", fg: "#6b7280", text: "no semantic effect" };
}

// Caret at the top of the detail panel pointing at the previewed column:
// makes the panel visibly "belong to" the hovered step.
function showCaret(cellEl, color) {
  if (!caretEl) {
    caretEl = document.createElement("div");
    caretEl.className = "preview-caret";
    document.body.appendChild(caretEl);
  }
  const panel = document.querySelector(".detail-panel-area");
  if (!panel) return;
  const p = panel.getBoundingClientRect();
  const r = cellEl.getBoundingClientRect();
  const x = Math.min(Math.max(r.left + r.width / 2, p.left + 18), p.right - 18);
  caretEl.style.left = `${x}px`;
  caretEl.style.top = `${p.top + 1}px`;
  caretEl.style.borderBottomColor = color;
  caretEl.classList.add("visible");
}

// One-line semantic reading of the hovered turn, floated above its column.
function showTag(ci, cellEl) {
  const tag = getTag();
  const reading = semanticReading(ci);
  tag.textContent = reading.text;
  tag.style.background = reading.bg;
  tag.style.color = reading.fg;
  tag.style.borderColor = reading.color;
  const r = cellEl.getBoundingClientRect();
  const wasHidden = !tag.classList.contains("visible");
  if (wasHidden) tag.classList.add("no-glide"); // appear in place, glide afterwards
  else tag.classList.remove("no-glide");
  tag.style.left = `${r.left + r.width / 2}px`;
  if (r.top < 46) {
    tag.style.top = `${r.bottom + 6}px`;
    tag.classList.add("below");
  } else {
    tag.style.top = `${r.top - 6}px`;
    tag.classList.remove("below");
  }
  tag.classList.add("visible");
}

function setHovered(container, cols, mi, onTail) {
  for (const ci of cols) {
    container.querySelectorAll(`[data-col="${ci}"]`).forEach(el => el.classList.add("hovered"));
  }
  if (mi >= 0) {
    container.querySelectorAll(`[data-mdp="${mi}"]`).forEach(el => el.classList.add("hovered"));
  }
  if (onTail) {
    container.querySelectorAll(".tr-mdp-tail").forEach(el => el.classList.add("hovered"));
  }
}

function clearHovered(container) {
  container.querySelectorAll(".hovered").forEach(el => el.classList.remove("hovered"));
}

function setPanelHighlight(color) {
  const panel = document.querySelector(".detail-panel-area");
  if (panel) panel.style.borderColor = color || "";
}

function endHover(container) {
  clearHovered(container);
  hideTag();
  setPanelHighlight(null);
  if (hoverCol !== null) {
    hoverCol = null;
    renderDetailPanel(); // restore the pinned (clicked) turn
  }
}

function attachHoverInteractions(container) {
  // Delegated listeners live on the container (its children are replaced on
  // every render, the container itself is not) — bind once.
  if (container.dataset.hoverBound) return;
  container.dataset.hoverBound = "1";

  container.addEventListener("mouseover", e => {
    const cell = e.target.closest("[data-col]");
    const span = e.target.closest("[data-mdp]");
    if (cell) {
      const ci = parseInt(cell.dataset.col);
      const mi = turnToMdp[ci];
      const reading = semanticReading(ci);
      container.style.setProperty("--hl", reading.color);
      clearHovered(container);
      setHovered(container, [ci], mi, mi < 0);
      showTag(ci, cell);
      showCaret(cell, reading.color);
      setPanelHighlight(reading.color);
      if (hoverCol !== ci) {
        hoverCol = ci;
        renderDetailPanel(); // live preview without moving the pinned turn
      }
    } else if (span) {
      const mi = parseInt(span.dataset.mdp);
      clearHovered(container);
      setHovered(container, turnGroups[mi] || [], mi, false);
      hideTag();
    }
  });
  container.addEventListener("mouseout", e => {
    if (!container.contains(e.relatedTarget)) {
      endHover(container);
    } else if (!e.relatedTarget.closest("[data-col],[data-mdp]")) {
      endHover(container);
    }
  });
  // Horizontal scrolling inside the wrapper moves the cells too.
  const wrapper = container.closest(".three-row-wrapper");
  if (wrapper && !wrapper.dataset.tagScroll) {
    wrapper.dataset.tagScroll = "1";
    wrapper.addEventListener("scroll", hideTag, { passive: true });
  }
}

// ── Detail panel (state + screenshot zoom) ──
function renderDetailPanel() {
  const panel = document.getElementById("detail-panel");

  // Hovered turn previews live; the clicked turn stays pinned underneath.
  const col = hoverCol !== null ? hoverCol : activeCol;

  if (col === null) {
    panel.innerHTML = `<div class="state-placeholder">Click any column to inspect state and screenshot</div>`;
    return;
  }

  const turn = data.turns[col];
  const mi = turnToMdp[col];
  const step = mi >= 0 ? mdpSteps[mi] : null;
  const ssPath = `screenshots/${data.task_id}/${data.agent}/turn_${String(turn.step).padStart(3, "0")}.png`;

  // Previous state for diff
  const prevState = col > 0 ? data.turns[col - 1].state : null;
  const curState = turn.state;

  let html = '<div class="detail-columns">';

  // Left: zoomed screenshot
  html += `<div class="detail-screenshot">
    <img src="${ssPath}" alt="Turn ${turn.step}" onerror="this.style.display='none';">
    ${turn.action?.coordinate ? `<div class="action-dot" style="left:${(turn.action.coordinate[0]/1440*100).toFixed(1)}%;top:${(turn.action.coordinate[1]/900*100).toFixed(1)}%;"></div>` : ""}
  </div>`;

  // Right: state + skill info
  html += `<div class="detail-info">`;

  // Skill badge (if this turn maps to an MDP action)
  if (step) {
    const fm = FAMILY_META[step.family] || FAMILY_META.configuration;
    html += `<div class="skill-badge-row">
      <span class="skill-badge" style="background:${fm.bg};color:${fm.color};border:1px solid ${fm.color};">
        ${esc(step.skill || step.family)}
      </span>
      <span class="skill-detail-text">${esc(step.skillDetail)}</span>
    </div>`;
  }

  // State fields with diff
  const previewing = hoverCol !== null && hoverCol !== activeCol;
  html += `<div class="detail-state-header">
    <span class="state-surface">${esc(curState?.surface || "")}</span>
    <span class="detail-turn-label">${previewing ? '<span class="preview-chip">preview</span> ' : ""}Turn ${turn.step}</span>
  </div>`;
  html += `<div class="state-tree">`;
  if (curState) {
    for (const [key, val] of Object.entries(curState)) {
      const displayVal = formatVal(val);
      const prevVal = prevState ? prevState[key] : undefined;
      const changed = prevState && JSON.stringify(val) !== JSON.stringify(prevVal);
      const isNew = prevState && !(key in prevState);
      const cls = isNew ? "added" : changed ? "changed" : "";
      html += `<div class="state-field">
        <span class="state-key">${esc(key)}</span>
        <span class="state-val ${cls}">${esc(displayVal)}</span>
      </div>`;
    }
  }
  html += `</div></div></div>`;

  panel.innerHTML = html;
}

// ── Metrics panel ──
function renderMetrics() {
  const grid = document.getElementById("metrics-grid");
  const m = data.process_metrics;

  // Exploration
  const explHtml = `<div class="metric-card-wide">
    <h4>Exploration</h4>
    <div class="metric-detail">${m.info_sufficient ? "Target found" : "Target not found"}: <strong class="${m.info_sufficient ? "good" : "bad"}">${m.info_sufficient ? "PASS" : "FAIL"}</strong></div>
  </div>`;

  // Skill accuracy - list each skill label with its score
  let skillRows = "";
  for (const sl of data.skill_labels) {
    if (sl.action === "done") continue;
    const s = sl.skills?.[0];
    if (!s) continue;
    const fm = FAMILY_META[s.family] || FAMILY_META.configuration;
    skillRows += `<div class="metric-skill-row">
      <span class="metric-skill-name" style="color:${fm.color};">${esc(sl.action)}</span>
      <span class="metric-skill-detail">${esc(s.detail)}</span>
    </div>`;
  }
  if (!skillRows) {
    skillRows = `<div class="metric-detail">No semantic transitions recorded</div>`;
  }
  const skillHtml = `<div class="metric-card-wide">
    <h4>Skill Invocation</h4>
    <div class="metric-skill-list">${skillRows}</div>
  </div>`;

  // Efficiency
  const totalGui = data.turns.filter(t => t.action?.action).length;
  const idleTurns = data.turns.length - totalGui;
  const totalMdp = mdpSteps.length;
  const optimal = data.oracle_trajectory.length;
  const effHtml = `<div class="metric-card-wide">
    <h4>Efficiency</h4>
    <div class="metric-detail">GUI steps: <strong>${totalGui}</strong>${idleTurns > 0 ? ` <span class="metric-idle">(+${idleTurns} idle)</span>` : ""}</div>
    <div class="metric-detail">MDP actions: <strong>${totalMdp}</strong></div>
    <div class="metric-detail">Optimal: <strong>${optimal}</strong></div>
    <div class="metric-detail">Coverage: <strong class="${m.coverage_at_commit >= 1 ? "good" : "bad"}">${(m.coverage_at_commit * 100).toFixed(0)}%</strong></div>
    <div class="metric-detail">Outcome: <strong class="${m.outcome_correct ? "good" : "bad"}">${m.outcome_correct ? "PASS" : "FAIL"}</strong></div>
  </div>`;

  grid.innerHTML = explHtml + skillHtml + effHtml;
}

// ══════════════════════════════════════════════════════════════
//  HELPERS
// ══════════════════════════════════════════════════════════════

function payloadSummary(step) {
  const p = step.payload;
  if (!p) return "";
  if (p.query) return p.query;
  if (p.filter_field) return `${p.filter_field}: ${Array.isArray(p.filter_value) ? p.filter_value.join(", ") : p.filter_value}`;
  if (p.listing_id) return p.listing_id;
  if (p.repo_id) return p.repo_id;
  if (p.event_id) return p.event_id;
  if (p.thread_id) return p.thread_id;
  if (p.message_id) return p.message_id;
  if (p.folder) return p.folder;
  if (p.field) return `${p.field}: ${p.value}`;
  if (p.check_in) return p.check_in;
  if (p.sort_field) return p.sort_field;
  return "";
}

function formatVal(v) {
  if (v === undefined) return "";
  if (v === null) return "null";
  if (typeof v === "object") return JSON.stringify(v);
  return String(v);
}

function esc(s) {
  if (s == null) return "";
  const d = document.createElement("div");
  d.textContent = String(s);
  return d.innerHTML;
}
