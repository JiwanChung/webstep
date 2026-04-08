"""
Extract trajectory data from real artifacts into the project page data/ directory.

Usage:
    python prepare_data.py                          # default samples, all agents
    python prepare_data.py airbnb_0005 gmail_0042   # custom task IDs, all agents
"""
import json, shutil, sys
from pathlib import Path

FRESH = Path(__file__).resolve().parent.parent.parent  # fresh/
ARTIFACTS_ROOT = FRESH / "submission_code" / "artifacts"
ARTIFACTS_FULL = FRESH / "artifacts"  # for episode_metrics + screenshots
SITES_DIR = FRESH / "sites"
OUT = Path(__file__).resolve().parent / "data"
SS_ROOT = Path(__file__).resolve().parent / "screenshots"

DEFAULT_SAMPLES = ["airbnb_0001", "github_0001", "gmail_0001"]
AGENTS = ["openai_cua", "fara", "guiowl", "uitars", "qwen_vl"]

# Large nested objects to drop from per-turn state
HEAVY_STATE_KEYS = {
    "repos", "issues", "prs", "events", "listings", "products",
    "messages", "threads", "contacts", "channels", "jobs",
    "new_issues", "issue_overlays", "repo_overlays",
    "next_issue_seq", "next_comment_seq",
}


def slim_state(state: dict) -> dict:
    out = {}
    for k, v in state.items():
        if k in HEAVY_STATE_KEYS:
            continue
        if isinstance(v, list) and len(v) > 10:
            out[k] = f"[{len(v)} items]"
        elif isinstance(v, dict) and len(json.dumps(v)) > 500:
            out[k] = f"{{{len(v)} keys}}"
        else:
            out[k] = v
    return out


def site_of(task_id: str) -> str:
    return task_id.rsplit("_", 1)[0]


def load_task(task_id: str) -> dict:
    site = site_of(task_id)
    tasks_file = SITES_DIR / site / "tasks" / "tasks.json"
    for t in json.loads(tasks_file.read_text()):
        if t["task_id"] == task_id:
            return t
    raise ValueError(f"Task {task_id} not found in {tasks_file}")


def prepare_agent(task_id: str, agent: str, task: dict):
    art_dir = ARTIFACTS_ROOT / agent / task_id
    art_full = ARTIFACTS_FULL / agent / task_id
    if not (art_dir / "artifact.json").exists():
        return None
    # episode_metrics may be in submission_code or full artifacts
    metrics_file = art_dir / "episode_metrics.json"
    if not metrics_file.exists():
        metrics_file = art_full / "episode_metrics.json"
    if not metrics_file.exists():
        return None

    artifact = json.loads((art_dir / "artifact.json").read_text())
    metrics = json.loads(metrics_file.read_text())

    ls = artifact.get("local_storage", {})
    if "mdp_trajectory" not in ls:
        return None

    bundle = {
        "task_id": task_id,
        "agent": agent,
        "site": site_of(task_id),
        "instruction": task["instruction"],
        "template": task.get("template", ""),
        "difficulty": task.get("metadata", {}).get("difficulty", {}).get("label", ""),
        "outcome": "success" if metrics["process_metrics"]["outcome_correct"] else "failure",
        "mdp_trajectory": ls["mdp_trajectory"],
        "mdp_state_final": ls.get("mdp_state", {}),
        "init_state": task["environment"]["init_state"],
        "oracle_trajectory": task["solution"]["optimal_trajectory"],
        "process_metrics": metrics["process_metrics"],
        "skill_labels": metrics["skill_labels"],
        "turns": [
            {
                "step": t["step"],
                "surface": t["observation"]["surface"],
                "state": slim_state(t["observation"]["state"]),
                "action": t["decision"]["action"],
                "message": t["decision"].get("message"),
                "final_response": t["decision"].get("final_response"),
            }
            for t in artifact["turns"]
        ],
        "judge": task["judge"],
    }

    # Write bundle
    out_dir = OUT / task_id / agent
    out_dir.mkdir(parents=True, exist_ok=True)
    (out_dir / "bundle.json").write_text(json.dumps(bundle, indent=2))

    # Copy screenshots (try submission_code first, fall back to full artifacts)
    ss_src = art_dir / "turn_screenshots"
    if not ss_src.exists():
        ss_src = art_full / "turn_screenshots"
    ss_dst = SS_ROOT / task_id / agent
    if ss_src.exists():
        ss_dst.mkdir(parents=True, exist_ok=True)
        for png in sorted(ss_src.glob("turn_*.png")):
            dst = ss_dst / png.name
            if not dst.exists():
                shutil.copy2(png, dst)

    return bundle


def prepare(task_id: str):
    task = load_task(task_id)
    print(f"  {task_id}:")
    for agent in AGENTS:
        bundle = prepare_agent(task_id, agent, task)
        if bundle:
            print(f"    {agent}: {len(bundle['mdp_trajectory'])} MDP, "
                  f"{len(bundle['turns'])} GUI, "
                  f"{'PASS' if bundle['outcome'] == 'success' else 'FAIL'}")
        else:
            print(f"    {agent}: (no artifact)")


if __name__ == "__main__":
    task_ids = sys.argv[1:] or DEFAULT_SAMPLES
    print(f"Preparing {len(task_ids)} tasks x {len(AGENTS)} agents...")
    for tid in task_ids:
        prepare(tid)
    print("Done.")
