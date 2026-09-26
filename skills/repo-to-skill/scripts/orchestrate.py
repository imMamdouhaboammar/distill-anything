#!/usr/bin/env python3
"""
orchestrate.py — Unified End-to-End Orchestrator.
Executes Step 1 (codebase-constitution) then Step 2 (repo-to-skill) automatically with zero manual intervention.

Copyright (c) 2026 Mamdouh Aboammar. All rights reserved.
MIT License — https://github.com/imMamdouhaboammar/codebase-constitution
"""

import os
import sys
import subprocess
import argparse
from pathlib import Path


def run_cmd(cmd, desc):
    print(f"\n◈ [PIPELINE] {desc}...")
    res = subprocess.run(cmd, shell=True, text=True)
    if res.returncode != 0:
        print(f"✗ Failed at stage: {desc}")
        sys.exit(res.returncode)


def main():
    parser = argparse.ArgumentParser(description="Run 2-stage constitution and skill synthesis pipeline end-to-end")
    parser.add_argument("target", help="Local directory or git repository URL")
    parser.add_argument("--out", default="dist", help="Output directory for generated artifacts")
    args = parser.parse_args()

    target = args.target
    out_dir = Path(args.out).resolve()
    out_dir.mkdir(parents=True, exist_ok=True)

    scripts_dir = Path(__file__).parent.resolve()
    
    # 1. Resolve local path vs remote git URL
    if target.startswith("http://") or target.startswith("https://") or target.startswith("git@"):
        repo_name = target.rstrip("/").split("/")[-1].replace(".git", "")
        clone_path = Path("/tmp/constitution-pipeline") / repo_name
        clone_path.parent.mkdir(parents=True, exist_ok=True)
        if not clone_path.exists():
            run_cmd(f"git clone --depth 1 {target} {clone_path}", f"Cloning remote repository {target}")
        else:
            run_cmd(f"cd {clone_path} && git pull --depth 1 2>/dev/null || true", "Updating existing clone")
        target_path = clone_path
    else:
        target_path = Path(target).resolve()

    if not target_path.exists():
        print(f"Error: Target path does not exist: {target_path}")
        sys.exit(1)

    print("=" * 60)
    print("  CODEBASE CONSTITUTION & SKILL SYNTHESIS PIPELINE")
    print("  Two-Stage Microservices Engine — Auto End-to-End")
    print(f"  Target: {target_path}")
    print(f"  Output: {out_dir}")
    print("=" * 60)

    # ── STEP 1: CONSTITUTION ENGINE ──────────────────────────────────────────
    print("\n>>> STAGE 1: CONSTITUTION ENGINE (codebase-constitution)")
    
    docs_dir = out_dir / "docs"
    docs_dir.mkdir(parents=True, exist_ok=True)
    topology_yaml = docs_dir / "topology.yaml"
    adr_dir = docs_dir / "adr"
    adr_dir.mkdir(parents=True, exist_ok=True)

    # 1.1 Harvest topology
    harvest_py = scripts_dir / "harvest.py"
    run_cmd(f"python3 {harvest_py} --root {target_path} --out {topology_yaml}", "Harvesting repository topology & dependencies")

    # 1.2 Decision archaeology (extract ADRs)
    extract_adrs_py = scripts_dir / "extract_adrs.py"
    run_cmd(f"python3 {extract_adrs_py} --root {target_path} --out-dir {adr_dir} --max-adrs 15", "Extracting implicit ADRs from codebase")

    # 1.3 Synthesize agent rules
    rules_py = scripts_dir / "generate_rules.py"
    rules_yaml = docs_dir / "agent-rules.yaml"
    run_cmd(f"python3 {rules_py} --root {target_path} --out {rules_yaml}", "Synthesizing agent rules & invariants")

    # 1.4 Generate CONSTITUTION.md
    constitution_md = docs_dir / "CONSTITUTION.md"
    template_file = scripts_dir.parent / "references" / "constitution-template.md"
    if template_file.exists():
        content = template_file.read_text(encoding="utf-8")
        content = content.replace("{Project Name}", target_path.name)
        content = content.replace("{Date}", "2026-09-26")
        constitution_md.write_text(content, encoding="utf-8")
        print(f"  ✓ Assembled: {constitution_md}")

    # ── STEP 2: SKILL SYNTHESIZER ───────────────────────────────────────────
    print("\n>>> STAGE 2: SKILL SYNTHESIZER ENGINE (repo-to-skill)")
    
    skills_dir = out_dir / "skills"
    skills_dir.mkdir(parents=True, exist_ok=True)

    synthesize_py = scripts_dir / "synthesize_skill.py"
    run_cmd(
        f"python3 {synthesize_py} --root {target_path} --topology {topology_yaml} --constitution {constitution_md} --out-dir {skills_dir}",
        "Synthesizing operational skill package with evals & adapters"
    )

    print("\n" + "=" * 60)
    print("  PIPELINE COMPLETE (100% AUTOMATED)")
    print(f"  1. Constitution artifacts: {docs_dir}/")
    print(f"  2. Operational agent skill: {skills_dir}/{target_path.name}/")
    print("=" * 60 + "\n")


if __name__ == "__main__":
    main()
