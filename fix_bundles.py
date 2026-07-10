"""
Recompute derived bundle data left stale by patch_data.py.

patch_data.py drops/dedupes mdp_trajectory entries but the bundles also carry
data derived from the ORIGINAL trajectory. This script rebuilds:

  1. process_metrics (total_steps, coverage_trajectory, commit_step,
     info_completion_time, commit_lag) — remapped through the old->new step
     index mapping, using the pre-patch bundle recovered from git.
  2. turn_to_mdp — an explicit per-turn mapping to mdp_trajectory indices,
     so the viewer no longer has to guess the alignment from state diffs
     (which fails for transitions invisible in the slimmed state, e.g. Star).

Run AFTER prepare_data.py + patch_data.py.
"""
import json
import subprocess
from bisect import bisect_right
from datetime import datetime
from pathlib import Path

ROOT = Path(__file__).resolve().parent
DATA = ROOT / "data"
PRE_PATCH_REF = "a0848dcc2f82d22876ba24d15d352ed70a332413~1"


# ══════════════════════════════════════════════════════════════
#  1. process_metrics remapping
# ══════════════════════════════════════════════════════════════

def is_same_mdp_action(a, b):
    return a.get("action") == b.get("action") and a.get("payload") == b.get("payload")


def kept_indices(old_traj):
    """Replay patch_data.py's drop+dedup on the pre-patch trajectory and
    return the original indices of the entries that survive, in order."""
    kept = []
    for i, step in enumerate(old_traj):
        if step.get("action") == "SetFilter":
            payload = step.get("payload", {})
            if "filter_value" not in payload or payload.get("filter_value") is None:
                continue
        if kept and is_same_mdp_action(old_traj[kept[-1]], step):
            continue
        kept.append(i)
    return kept


def load_prepatch(rel_path):
    txt = subprocess.check_output(
        ["git", "show", f"{PRE_PATCH_REF}:{rel_path}"], cwd=ROOT, text=True
    )
    return json.loads(txt)


def remap_metrics(bundle, old, kept):
    """Rebuild the trajectory-indexed process_metrics fields from the
    pre-patch bundle. Returns True if anything changed."""
    old_mdp = old["mdp_trajectory"]
    m = bundle["process_metrics"]
    old_m = old["process_metrics"]
    old_cov = old_m["coverage_trajectory"]
    assert old_m["total_steps"] == len(old_mdp) + 1 == len(old_cov), \
        "pre-patch metrics already inconsistent"

    # State s follows action s-1; a state after a dropped action collapses
    # onto the state after the last surviving action before it.
    def map_state(s):
        if s is None:
            return None
        return 0 if s <= 0 else bisect_right(kept, s - 1)

    new = {
        "total_steps": len(kept) + 1,
        "coverage_trajectory": [old_cov[0]] + [old_cov[i + 1] for i in kept],
        "commit_step": map_state(old_m["commit_step"]),
        "info_completion_time": map_state(old_m["info_completion_time"]),
    }
    if new["commit_step"] is None or new["info_completion_time"] is None:
        new["commit_lag"] = old_m["commit_lag"]
    else:
        new["commit_lag"] = new["commit_step"] - new["info_completion_time"]
    if new["commit_step"] is not None:
        new["coverage_at_commit"] = new["coverage_trajectory"][new["commit_step"]]

    changed = False
    for k, v in new.items():
        if m.get(k) != v:
            m[k] = v
            changed = True
    return changed


# ══════════════════════════════════════════════════════════════
#  2. turn -> mdp alignment
# ══════════════════════════════════════════════════════════════

# State keys an MDP action is expected to touch in the slimmed per-turn state.
# Derived empirically from the bundles whose state-change count matches the
# trajectory length, plus manual entries for the remaining actions.
SEARCH_KEYS = {"search_query", "total_results", "visible_ids", "page",
               "filters", "error_message", "active_folder", "surface_params"}
NAV_KEYS = {"surface", "back_stack", "surface_params"}
EXPECTED_KEYS = {
    "Search": SEARCH_KEYS,
    "SearchEmails": SEARCH_KEYS,
    "ClearSearch": SEARCH_KEYS,
    "SearchRepos": {"repo_search_query", "repo_total_results", "repo_visible_ids"},
    "SetFilter": {"filters", "total_results", "visible_ids", "page"},
    "SortBy": {"sort_by", "visible_ids"},
    "SwitchFolder": {"active_folder", "visible_ids", "total_results", "page",
                     "surface_params", "error_message"},
    "ViewListing": NAV_KEYS | {"viewed_listings"},
    "CloseListing": NAV_KEYS,
    "ViewRepo": NAV_KEYS | {"opened_repos"},
    "OpenThread": NAV_KEYS | {"opened_threads", "expanded_messages", "thread"},
    "CloseThread": NAV_KEYS | {"thread"},
    "ExpandMessage": {"expanded_messages", "thread"},
    "SelectThread": {"selected_thread_ids"},
    "SetBookingField": {"booking_check_in", "booking_check_out",
                        "booking_guests", "modal_state"},
    "BookListing": NAV_KEYS | {"booking_listing_id", "booking_guests",
                               "booking_check_in", "booking_check_out", "modal_state"},
    "ConfirmBooking": NAV_KEYS | {"reservations", "booking_check_in",
                                  "booking_check_out", "booking_listing_id",
                                  "booking_guests"},
    "Star": set(),  # starred flag lives in slimmed-away thread data
    "StarRepo": {"starred_repos"},
}
# Actions whose effect can legitimately be invisible in the slimmed state.
SILENT_OK = {"Star", "ExpandMessage", "SelectThread", "ClearSearch", "CloseThread"}


def diff_keys(a, b):
    keys = set(a) | set(b)
    return {k for k in keys
            if json.dumps(a.get(k), sort_keys=True) != json.dumps(b.get(k), sort_keys=True)}


def state_boundaries(turns):
    """[(turn_index, changed_keys, post_state)] where the state differs from
    the previous turn. A boundary at turn i closes the group of turns ending
    at i-1; post_state is the state the transition produced."""
    out = []
    for i in range(1, len(turns)):
        state = turns[i].get("state") or {}
        d = diff_keys(turns[i - 1].get("state") or {}, state)
        if d:
            out.append((i, d, state))
    return out


def postcondition(step, state):
    """Does `state` look like the state this MDP action produces? Returns
    True/False, or None when the bundle's slimmed state can't tell. Needed
    because e.g. ViewListing and CloseListing change the SAME keys
    (surface/back_stack) and only the resulting value tells them apart."""
    a, p = step["action"], step.get("payload") or {}
    surf = state.get("surface")
    if a == "ViewListing":
        return surf == "ListingDetail"
    if a == "CloseListing":
        return surf != "ListingDetail"
    if a == "OpenThread":
        return surf == "ThreadView"
    if a == "CloseThread":
        return surf != "ThreadView"
    if a == "ViewRepo":
        return surf == "RepoDetail"
    if a == "BookListing":
        return surf == "Checkout"
    if a in ("Search", "SearchEmails", "SearchRepos"):
        q = p.get("query")
        key = "repo_search_query" if a == "SearchRepos" else "search_query"
        return None if q is None else state.get(key) == q
    if a == "ClearSearch":
        return not state.get("search_query")
    if a == "SortBy":
        return state.get("sort_by") == p.get("sort_field") if p.get("sort_field") else None
    if a == "SwitchFolder":
        return state.get("active_folder") == p.get("folder") if p.get("folder") else None
    if a == "SetBookingField":
        f = p.get("field")
        return state.get(f"booking_{f}") == p.get("value") if f else None
    if a == "SetFilter":
        field, val = p.get("filter_field"), p.get("filter_value")
        filters = state.get("filters")
        if not field or val is None or not isinstance(filters, dict):
            return None
        cur = filters.get(field)
        if isinstance(cur, list) and isinstance(val, list):
            return set(map(str, val)) <= set(map(str, cur))
        return cur == val
    return None


# A dropped entry dispatched within this window of its predecessor came from
# the same GUI turn (double-dispatch bug); a larger gap means the agent
# re-dispatched it with a separate click and that turn must be attributed.
SAME_TURN_GAP_S = 1.0


def parse_ts(step):
    return datetime.fromisoformat(step["timestamp"].replace("Z", "+00:00"))


def classify_dropped(old_mdp, kept):
    """Split dropped indices into same-turn double-fires (consume no GUI turn)
    and separate-turn re-dispatches (consume one GUI turn)."""
    kept_set = set(kept)
    same_turn, separate = set(), set()
    for i in range(len(old_mdp)):
        if i in kept_set:
            continue
        gap = (parse_ts(old_mdp[i]) - parse_ts(old_mdp[i - 1])).total_seconds() if i else None
        (same_turn if gap is not None and gap <= SAME_TURN_GAP_S else separate).add(i)
    return same_turn, separate


def align_mdp_to_boundaries(mdp, boundaries, same_turn=frozenset(), separate=frozenset()):
    """Needleman-Wunsch style alignment between MDP entries and state-change
    boundaries. Returns matches[k] = boundary index or None (silent entry).
    Handles both extra boundaries (state changes with no MDP record) and
    silent MDP entries (no visible state change). Dropped double-fires
    (`same_turn`) re-dispatch a state the surviving entry already produced,
    so they never win a boundary; dropped separate re-dispatches (`separate`)
    prefer staying silent but may match if they visibly changed state."""
    m, n = len(mdp), len(boundaries)
    NEG = float("-inf")
    dp = [[NEG] * (n + 1) for _ in range(m + 1)]
    back = [[None] * (n + 1) for _ in range(m + 1)]
    dp[0][0] = 0.0

    def skip_penalty(k):
        if k in same_turn:
            return 0.0          # double-fire: always silent
        if k in separate:
            return -0.05        # re-dispatch: expected to be silent
        action = mdp[k]["action"]
        exp = EXPECTED_KEYS.get(action)
        if exp is not None and not exp:
            return 0.0          # no observable key at all
        if action in SILENT_OK:
            return -1.0         # sometimes invisible
        return -4.0             # should have produced a change

    for k in range(m + 1):
        for j in range(n + 1):
            cur = dp[k][j]
            if cur == NEG:
                continue
            if k < m:
                exp = EXPECTED_KEYS.get(mdp[k]["action"])
                if j < n:
                    keys, post_state = boundaries[j][1], boundaries[j][2]
                    sc = 1.0 if exp is None else (3.0 if keys & exp else -4.0)
                    post = postcondition(mdp[k], post_state)
                    if post is True:
                        sc += 2.0
                    elif post is False:
                        sc -= 6.0   # resulting state contradicts the action
                    if k in same_turn:
                        sc = -10.0  # its state change belongs to the original
                    elif k in separate:
                        sc -= 0.5   # prefer giving the boundary to a kept entry
                    if cur + sc > dp[k + 1][j + 1]:
                        dp[k + 1][j + 1] = cur + sc
                        back[k + 1][j + 1] = ("M", k, j)
                pen = skip_penalty(k)
                if cur + pen > dp[k + 1][j]:
                    dp[k + 1][j] = cur + pen
                    back[k + 1][j] = ("S", k, j)
            if j < n and cur - 1.0 > dp[k][j + 1]:
                dp[k][j + 1] = cur - 1.0
                back[k][j + 1] = ("B", k, j)

    matches = [None] * m
    k, j = m, n
    while k > 0 or j > 0:
        op, pk, pj = back[k][j]
        if op == "M":
            matches[pk] = pj
        k, j = pk, pj
    return matches


def compute_turn_to_mdp(bundle, old_mdp, kept):
    """Align the ORIGINAL (pre-patch) trajectory to the turn boundaries, then
    fold dropped entries onto their surviving neighbours. Aligning the patched
    trajectory directly would misattribute the turns of deduped double-fires:
    e.g. gmail/fara's search-button click re-dispatched an identical
    SearchEmails (deduped away) and must stay with the surviving SearchEmails,
    not leak into the following OpenThread span."""
    turns, new_mdp = bundle["turns"], bundle["mdp_trajectory"]
    turn_to_mdp = [-1] * len(turns)
    if not new_mdp or not turns:
        return turn_to_mdp

    boundaries = state_boundaries(turns)
    same_turn, separate = classify_dropped(old_mdp, kept)
    matches = align_mdp_to_boundaries(old_mdp, boundaries, same_turn, separate)

    old_map = [-1] * len(turns)
    pos = 0
    for k in range(len(old_mdp)):
        if matches[k] is not None:
            end = max(boundaries[matches[k]][0] - 1, pos)
            for t in range(pos, min(end + 1, len(turns))):
                old_map[t] = k
            pos = end + 1
        elif k in same_turn:
            # Double-fire from the same GUI turn as its original: no turn.
            continue
        elif pos < len(turns):
            # Silent transition with its own GUI turn: attribute one turn.
            old_map[pos] = k
            pos += 1
    for t in range(pos, len(turns)):
        old_map[t] = len(old_mdp) - 1

    # Fold original indices onto surviving entries. A dedup-dropped duplicate
    # folds onto the kept entry it repeated (the previous kept index); a
    # dropped leading entry folds forward onto the first kept one.
    for t, k in enumerate(old_map):
        if k >= 0:
            turn_to_mdp[t] = min(max(bisect_right(kept, k) - 1, 0), len(new_mdp) - 1)
    return turn_to_mdp


# ══════════════════════════════════════════════════════════════

def main():
    for bundle_path in sorted(DATA.rglob("bundle.json")):
        rel = bundle_path.relative_to(ROOT).as_posix()
        bundle = json.loads(bundle_path.read_text())

        old = load_prepatch(rel)
        old_mdp = old["mdp_trajectory"]
        kept = kept_indices(old_mdp)
        assert len(kept) == len(bundle["mdp_trajectory"]), \
            f"{rel}: kept {len(kept)} != current {len(bundle['mdp_trajectory'])}"
        for ki, step in zip(kept, bundle["mdp_trajectory"]):
            assert old_mdp[ki]["action"] == step["action"], f"{rel}: action mismatch at old idx {ki}"

        metrics_changed = remap_metrics(bundle, old, kept)

        t2m = compute_turn_to_mdp(bundle, old_mdp, kept)
        mapping_changed = bundle.get("turn_to_mdp") != t2m
        bundle["turn_to_mdp"] = t2m

        if metrics_changed or mapping_changed:
            bundle_path.write_text(json.dumps(bundle, indent=2))
        flags = [name for name, on in
                 [("metrics", metrics_changed), ("turn_to_mdp", mapping_changed)] if on]
        print(f"  {rel.removeprefix('data/'):30s} {'updated: ' + ', '.join(flags) if flags else 'unchanged'}")


if __name__ == "__main__":
    main()
