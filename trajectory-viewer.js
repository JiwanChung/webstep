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
  { id: "claude_cua", label: "Claude CUA" },
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
    document.getElementById("episode-chips").innerHTML = "";
    document.getElementById("timeline-skills").innerHTML = "";
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
  renderScorecard();
  renderThreeRowTimeline();
  renderDetailPanel();
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
  const COL_W = 118;   // px per column
  const LABEL_W = 54;  // .tr-row-label width; rows are label + columns wide
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

  // No semantic transitions at all: hatch the whole row, like a tail region.
  if (mdpSpans.length === 0) {
    const label = `no semantic transitions recorded (${turns.length} turn${turns.length > 1 ? "s" : ""})`;
    html += `<div class="tr-mdp-tail" style="left:0;width:${turns.length * COL_W}px;" title="${label}">
      <span class="tr-mdp-tail-label">${label}</span>
    </div>`;
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

  // Terminal outcome capsule under the final "done" turn: the episode's
  // verdict closes the MDP record row.
  if (lastTurn && !lastTurn.action?.action && lastTurn.final_response) {
    const ok = data.outcome === "success";
    const fInfo = !ok && FAILURE_INFO[data.process_metrics.failure_mode];
    const failText = fInfo ? fInfo[0] : "failure";
    html += `<div class="tr-mdp-outcome ${ok ? "ok" : "fail"}"
      style="left:${(turns.length - 1) * COL_W}px;width:${COL_W}px;"
      title="${ok ? "terminal outcome: success" : esc(fInfo ? fInfo[1] : "terminal outcome: failure")}">
      <i class="fas ${ok ? "fa-check" : "fa-xmark"}"></i>&nbsp;${ok ? "success" : esc(failText)}
    </div>`;
  }

  const commitIdx = data.process_metrics.commit_step;
  const outcomeOk = data.outcome === "success";
  for (const span of mdpSpans) {
    const step = mdpSteps[span.mdpIdx];
    const left = span.startCol * COL_W;
    const width = (span.endCol - span.startCol + 1) * COL_W;
    const fm = FAMILY_META[step.family] || FAMILY_META.configuration;
    const isActive = activeCol !== null && activeCol >= span.startCol && activeCol <= span.endCol;
    const detail = payloadSummary(step);
    const isCommit = commitIdx != null && commitIdx === span.mdpIdx;

    html += `<div class="tr-mdp-span ${isActive ? "active" : ""}" data-mdp="${span.mdpIdx}"
      style="left:${left}px;width:${width}px;border-color:${fm.color};background:${fm.bg};">
      ${isCommit ? `<span class="tr-commit-flag ${outcomeOk ? "ok" : "fail"}" title="the agent committed at this transition${outcomeOk ? "" : ", where it went wrong"}">\u2691</span>` : ""}
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
  const turn = data.turns[ci];
  if (turn && !turn.action?.action && turn.final_response) {
    const ok = data.outcome === "success";
    return ok
      ? { color: "#10b981", bg: "#ecfdf5", fg: "#10b981", text: "episode end (success)" }
      : { color: "#ef4444", bg: "#fef2f2", fg: "#ef4444", text: "episode end (failure)" };
  }
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


// Human-readable abstraction of a semantic state, as icon chips.
function abstractState(st) {
  const chips = [];
  const sp = st.surface_params || {};
  const entity = sp.listing_id || sp.thread_id || sp.repo_id || sp.event_id || sp.product_id;
  chips.push({ icon: "", text: (st.surface || "?") + (entity ? " \u00b7 " + entity : "") });
  const q = st.search_query ?? st.repo_search_query;
  const results = st.total_results ?? st.repo_total_results;
  if (q) chips.push({ icon: "", text: `\u201c${q}\u201d` + (results != null ? ` \u00b7 ${results} results` : "") });
  else if (results != null) chips.push({ icon: "", text: `${results} results` });
  const f = st.filters;
  if (f && typeof f === "object" && Object.keys(f).length) {
    chips.push({ icon: "", text: Object.values(f).map(v => Array.isArray(v) ? v.join("/") : v).join(", ") });
  }
  if (st.sort_by && st.sort_by !== "relevance") chips.push({ icon: "", text: st.sort_by });
  if (st.booking_check_in || st.booking_check_out || st.booking_guests) {
    const dates = [st.booking_check_in, st.booking_check_out].filter(Boolean).join(" \u2192 ");
    chips.push({ icon: "", text: [dates, st.booking_guests ? `${st.booking_guests} guests` : ""].filter(Boolean).join(" \u00b7 ") });
  }
  if (Array.isArray(st.reservations) && st.reservations.length)
    chips.push({ icon: "", text: `${st.reservations.length} reservation${st.reservations.length > 1 ? "s" : ""}`, ok: true });
  if (st.active_folder && st.active_folder !== "INBOX") chips.push({ icon: "", text: st.active_folder });
  if (Array.isArray(st.starred_repos) && st.starred_repos.length)
    chips.push({ icon: "", text: st.starred_repos.join(", "), ok: true });
  if (st.error_message) chips.push({ icon: "", text: st.error_message, warn: true });
  return chips;
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

  // Left: zoomed screenshot with an action strip underneath
  const reading = semanticReading(col);
  const a = turn.action || {};
  let actionLabel;
  if (!a.action) actionLabel = turn.final_response ? "done" : "(no action)";
  else {
    actionLabel = a.action;
    if (a.coordinate) actionLabel += `(${Math.round(a.coordinate[0])}, ${Math.round(a.coordinate[1])})`;
    else if (a.text) actionLabel += `("${a.text.length > 18 ? a.text.slice(0, 18) + "…" : a.text}")`;
    else if (a.keys) actionLabel += `(${a.keys.join("+")})`;
  }
  html += `<div class="detail-screenshot">
    <div class="shot-frame">
      <img src="${ssPath}" alt="Turn ${turn.step}" onerror="this.style.display='none';">
      ${turn.action?.coordinate ? `<div class="action-dot" style="left:${(turn.action.coordinate[0]/1440*100).toFixed(1)}%;top:${(turn.action.coordinate[1]/900*100).toFixed(1)}%;"></div>` : ""}
    </div>
    <div class="shot-strip">
      <span class="shot-action">${esc(actionLabel)}</span>
      <span class="shot-reading" style="color:${reading.fg};background:${reading.bg};border-color:${reading.color};">${esc(reading.text)}</span>
    </div>
  </div>`;

  // Right: what changed this turn first, then the rest of the state
  html += `<div class="detail-info">`;

  const previewing = hoverCol !== null && hoverCol !== activeCol;
  html += `<div class="detail-state-header">
    <span class="state-surface">${esc(curState?.surface || "")}</span>
    ${step ? `<span class="skill-badge" style="background:${(FAMILY_META[step.family] || FAMILY_META.configuration).bg};color:${(FAMILY_META[step.family] || FAMILY_META.configuration).color};border:1px solid ${(FAMILY_META[step.family] || FAMILY_META.configuration).color};">${esc(step.skill || step.family)}</span>` : ""}
    <span class="detail-turn-label">${previewing ? '<span class="preview-chip">preview</span> ' : ""}Turn ${turn.step}</span>
  </div>`;

  if (curState) {
    const changed = [], rest = [], nulls = [];
    for (const [key, val] of Object.entries(curState)) {
      const prevVal = prevState ? prevState[key] : undefined;
      const isChanged = prevState && JSON.stringify(val) !== JSON.stringify(prevVal);
      if (isChanged) changed.push([key, val, prevVal]);
      else if (val === null) nulls.push(key);
      else rest.push([key, val]);
    }
    const row = (key, val) => `<div class="state-field">
        <span class="state-key">${esc(key)}</span>
        <span class="state-val">${esc(formatVal(val))}</span>
      </div>`;
    const short = v => {
      const s = formatVal(v);
      return s.length > 16 ? s.slice(0, 15) + "…" : s;
    };

    // 1. Instant summary of where the agent is
    html += `<div class="state-group-title">State at a glance</div>
      <div class="abs-chips">${abstractState(curState).map(c =>
        `<span class="abs-chip${c.warn ? " warn" : ""}${c.ok ? " ok" : ""}"><span class="tpl-fa">${c.icon}</span>${esc(c.text)}</span>`).join("")}</div>`;

    // 2. What this turn changed, as old -> new
    html += `<div class="state-group-title">${changed.length ? `Changed this turn (${changed.length})` : "No state change this turn"}</div>`;
    if (changed.length) html += `<div class="chg-list">${changed.map(([k, v, pv]) => `
      <div class="chg-row">
        <span class="state-key">${esc(k)}</span>
        <span class="chg-vals"><span class="chg-old" title="${esc(formatVal(pv))}">${esc(short(pv))}</span><span class="chg-arrow">\u2192</span><span class="chg-new">${esc(formatVal(v))}</span></span>
      </div>`).join("")}</div>`;

    // 3. Everything else
    html += `<div class="state-group-title">Full state</div>
      <div class="state-tree">${rest.map(([k, v]) => row(k, v)).join("")}</div>
      ${nulls.length ? `<div class="state-nulls"><span>null:</span> ${nulls.map(esc).join(" · ")}</div>` : ""}`;
  }
  html += `</div></div>`;

  panel.innerHTML = html;
}

const FAILURE_INFO = {
  decision_error:   ["decision error", "the agent gathered sufficient information, but the episode still failed"],
  explorer_failure: ["exploration failure", "the agent never located the task-relevant target"],
  premature_commit: ["premature commit", "the agent committed before gathering sufficient information"],
};

// ── Episode scorecard: outcome + exploration + efficiency + skill sequence ──
function renderScorecard() {
  const m = data.process_metrics;
  const totalGui = data.turns.filter(t => t.action?.action).length;
  const idle = data.turns.length - totalGui;
  const ok = data.outcome === "success";
  const fInfo = !ok && FAILURE_INFO[m.failure_mode];
  const neverCommitted = !ok && m.commit_step != null && m.commit_step >= mdpSteps.length;
  const chips = [
    `<span class="ep-chip ${ok ? "ok" : "fail"}">${ok ? "\u2713 PASS" : "\u2717 FAIL"}</span>`,
    ...(fInfo ? [`<span class="ep-chip fail" title="${esc(fInfo[1])}">${esc(fInfo[0])}</span>`] : []),
    ...(neverCommitted ? [`<span class="ep-chip fail" title="the episode ended without a commit action, e.g. the agent got stuck or timed out">never committed</span>`] : []),
    `<span class="ep-chip ${(m.outcome_correct || m.info_sufficient) ? "ok" : "fail"}" title="did the agent reach the task-relevant target? (terminal success implies exploration success, matching the paper)"><span class="ep-kw">exploration</span>target ${(m.outcome_correct || m.info_sufficient) ? "found" : "not found"}</span>`,
    `<span class="ep-chip" title="GUI effort vs semantic progress, against the oracle solution"><span class="ep-kw">efficiency</span>${totalGui} GUI${idle ? ` (+${idle} idle)` : ""} \u2192 ${mdpSteps.length} semantic \u00b7 oracle ${data.oracle_trajectory.length} \u00b7 coverage <span class="${m.coverage_at_commit >= 1 ? "cov-ok" : "cov-warn"}">${(m.coverage_at_commit * 100).toFixed(0)}%</span></span>`,
  ];
  document.getElementById("episode-chips").innerHTML = chips.join("");

  // Skill sequence, consecutive duplicates aggregated (hero-figure style)
  const groups = [];
  for (const sl of data.skill_labels) {
    if (sl.action === "done") continue;
    const s = sl.skills?.[0];
    if (!s) continue;
    const last = groups[groups.length - 1];
    if (last && last.action === sl.action && last.family === s.family) {
      last.n++; last.details.push(s.detail);
    } else {
      groups.push({ action: sl.action, family: s.family, n: 1, details: [s.detail] });
    }
  }
  document.getElementById("timeline-skills").innerHTML =
    `<span class="skill-chips-label" title="each semantic action the agent invoked, colored by skill family. Hover a chip to see its measured effect">skill invocation</span>` +
    (groups.length
      ? groups.map(g => {
          const fm = FAMILY_META[g.family] || FAMILY_META.configuration;
          return `<span class="ep-chip skill" style="color:${fm.color};background:${fm.bg};border-color:${fm.color};"
            title="${esc(g.details.filter(Boolean).join("\n"))}">${esc(g.action)}${g.n > 1 ? ` \u00d7${g.n}` : ""}</span>`;
        }).join("")
      : `<span class="ep-chip muted">no semantic transitions recorded</span>`);
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
