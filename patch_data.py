"""
Monkey-patch data bundles to fix visible benchmark bugs in the website demo.

Fixes:
  1. Deduplicate consecutive identical MDP transitions (Airbnb SetFilter double-dispatch).
  2. Drop malformed SetFilter entries with missing filter_value.
  3. Re-label UI-TARS gmail SelectThread family from "commit" to "navigation".
  4. Drop the trailing "done" skill label (waste/no-op) so it doesn't clutter the viewer.

Run this AFTER prepare_data.py, then run fix_bundles.py to recompute derived
data (process_metrics remapping, turn_to_mdp alignment).
"""
import json
from pathlib import Path

DATA = Path(__file__).resolve().parent / "data"


def is_same_mdp_action(a, b):
    return a.get("action") == b.get("action") and a.get("payload") == b.get("payload")


def dedupe_consecutive(traj):
    """Collapse consecutive identical MDP actions into one."""
    out = []
    for step in traj:
        if out and is_same_mdp_action(out[-1], step):
            continue
        out.append(step)
    return out


def patch_bundle(bundle_path):
    bundle = json.loads(bundle_path.read_text())
    task_id = bundle["task_id"]
    agent = bundle["agent"]
    changed = False

    # ── 1. Drop malformed SetFilter entries (missing filter_value) ──
    new_traj = []
    new_skills = []
    skill_idx = 0
    skill_steps = bundle.get("skill_labels", [])

    for i, step in enumerate(bundle["mdp_trajectory"]):
        # Filter out malformed SetFilter
        if step.get("action") == "SetFilter":
            payload = step.get("payload", {})
            if "filter_value" not in payload or payload.get("filter_value") is None:
                changed = True
                # Skip this step and its corresponding skill label
                continue
        new_traj.append(step)

    bundle["mdp_trajectory"] = new_traj

    # ── 2. Deduplicate consecutive identical MDP actions ──
    deduped = dedupe_consecutive(new_traj)
    if len(deduped) != len(new_traj):
        changed = True
    bundle["mdp_trajectory"] = deduped

    # ── 3. Realign skill_labels to deduped trajectory ──
    # skill_labels are 1-indexed by step number, with a final "done" entry
    # We need to keep skill labels matching the new trajectory positions
    new_skill_labels = []
    new_step = 1
    deduped_actions = [(s["action"], json.dumps(s.get("payload", {}), sort_keys=True))
                       for s in deduped]
    seen = set()
    for sl in skill_steps:
        action = sl.get("action")
        payload_key = json.dumps(sl.get("payload", {}), sort_keys=True)
        # Keep "done" action at the end always
        if action == "done":
            sl_copy = dict(sl)
            sl_copy["step"] = new_step
            new_skill_labels.append(sl_copy)
            continue
        # Match against deduped trajectory in order
        match_idx = None
        for di, (da, dp) in enumerate(deduped_actions):
            if di in seen:
                continue
            if da == action and dp == payload_key:
                match_idx = di
                break
        if match_idx is not None:
            seen.add(match_idx)
            sl_copy = dict(sl)
            sl_copy["step"] = match_idx + 1
            new_skill_labels.append(sl_copy)

    if len(new_skill_labels) != len(skill_steps):
        changed = True
    # Sort by step number, with "done" last
    new_skill_labels.sort(key=lambda x: (x.get("action") == "done", x["step"]))
    bundle["skill_labels"] = new_skill_labels

    # ── 4. Drop trailing "done" skill label ──
    while bundle["skill_labels"] and bundle["skill_labels"][-1].get("action") == "done":
        bundle["skill_labels"].pop()
        changed = True

    # ── 5. Task-specific patches ──
    # NOTE: do NOT rewrite the fara airbnb_0001 booking year. The agent really
    # typed 2025-04-14/2025-04-17 (visible in screenshots and turn states) and
    # failed the task because of it; the MDP record must keep the faithful 2025.

    if task_id == "gmail_0001" and agent == "uitars":
        # Re-label SelectThread family from "commit" to "navigation"
        for sl in bundle["skill_labels"]:
            if sl.get("action") == "SelectThread":
                for s in sl.get("skills", []):
                    if s.get("family") == "commit":
                        s["family"] = "navigation"
                        s["skill"] = "thread_selection"
                        s["detail"] = "selected thread"
                        changed = True

    if changed:
        bundle_path.write_text(json.dumps(bundle, indent=2))
    return changed


def main():
    total = 0
    patched = 0
    for bundle_path in sorted(DATA.rglob("bundle.json")):
        total += 1
        if patch_bundle(bundle_path):
            patched += 1
            rel = bundle_path.relative_to(DATA)
            print(f"  patched: {rel}")
    print(f"\n{patched}/{total} bundles patched")


if __name__ == "__main__":
    main()
