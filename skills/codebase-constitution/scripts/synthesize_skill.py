#!/usr/bin/env python3
"""
synthesize_skill.py — Step 2 Microservice Engine.
Synthesizes an operational agent skill from codebase analysis and constitutional rules.

Copyright (c) 2026 Mamdouh Aboammar. All rights reserved.
MIT License — https://github.com/imMamdouhaboammar/codebase-constitution

Usage:
    python3 scripts/synthesize_skill.py \
        --root <target_repo_path> \
        --topology <topology.yaml> \
        --out-dir <skills_output_dir> \
        [--constitution <CONSTITUTION.md>]
"""

import os
import re
import sys
import json
import yaml
import argparse
from pathlib import Path
from typing import Dict, Any, List, Optional


def load_yaml_safe(path: Path) -> Dict[str, Any]:
    if not path.exists():
        return {}
    try:
        with open(path, "r", encoding="utf-8") as f:
            return yaml.safe_load(f) or {}
    except Exception:
        return {}


def detect_tool_archetype(root: Path, topology: Dict[str, Any]) -> str:
    """Classifies the tool into CLI, Library, Framework, or Service."""
    pkg_json = root / "package.json"
    if pkg_json.exists():
        try:
            data = json.loads(pkg_json.read_text(encoding="utf-8", errors="ignore"))
            if data.get("bin"):
                return "CLI"
            deps = {**data.get("dependencies", {}), **data.get("devDependencies", {})}
            if any(k in deps for k in ["express", "fastify", "next", "hono", "koa"]):
                return "Service"
            if any(k in deps for k in ["react", "vue", "svelte", "@angular/core"]):
                return "Framework"
        except Exception:
            pass

    pyproject = root / "pyproject.toml"
    setup_py = root / "setup.py"
    if pyproject.exists() or setup_py.exists():
        content = ""
        if pyproject.exists():
            content += pyproject.read_text(encoding="utf-8", errors="ignore")
        if setup_py.exists():
            content += setup_py.read_text(encoding="utf-8", errors="ignore")
        if "console_scripts" in content or "[project.scripts]" in content:
            return "CLI"
        if "fastapi" in content or "flask" in content or "django" in content:
            return "Service"
        return "Library"

    cargo = root / "Cargo.toml"
    if cargo.exists():
        content = cargo.read_text(encoding="utf-8", errors="ignore")
        if "[[bin]]" in content or "[bin]" in content or (root / "src" / "main.rs").exists():
            return "CLI"
        return "Library"

    return "Library"


def extract_readme_sections(root: Path) -> Dict[str, str]:
    """Extracts high-value usage instructions from README."""
    readme_path = None
    for name in ["README.md", "readme.md", "README.rst"]:
        p = root / name
        if p.exists():
            readme_path = p
            break
    
    if not readme_path:
        return {"quickstart": "", "install": "", "summary": ""}

    text = readme_path.read_text(encoding="utf-8", errors="ignore")
    lines = text.splitlines()
    
    summary = ""
    for line in lines[:20]:
        clean = line.strip()
        if clean and not clean.startswith("#") and not clean.startswith("[!") and not clean.startswith("```"):
            summary = clean
            break

    # Look for code blocks under Quickstart, Usage, or Install
    code_blocks = re.findall(r"```(?:bash|sh|javascript|typescript|python)?\n(.*?)\n```", text, re.DOTALL)
    quickstart = code_blocks[0].strip() if code_blocks else ""

    return {"summary": summary, "quickstart": quickstart}


def synthesize_skill_md(
    name: str,
    archetype: str,
    summary: str,
    quickstart: str,
    invariants: List[str],
    conventions: List[str],
    entry_points: List[str]
) -> str:
    """Generates the compact, imperative SKILL.md under 500 lines."""
    clean_name = re.sub(r"[^a-zA-Z0-9_-]", "-", name).lower()
    
    inv_section = ""
    if invariants:
        inv_section = "\n## Architectural Invariants\n\n"
        for inv in invariants[:5]:
            inv_section += f"- {inv}\n"

    conv_section = ""
    if conventions:
        conv_section = "\n## Conventions & Rules\n\n"
        for conv in conventions[:5]:
            conv_section += f"- {conv}\n"

    qs_block = quickstart if quickstart else f"# Run {clean_name}\n{clean_name} --help"

    return f"""---
name: {clean_name}
description: >
  Operational agent skill for {name}. Use when building, testing, running, or configuring
  {name} ({archetype}). Covers CLI commands, API calls, setup, and architectural invariants.
version: "1.0.0"
author: "Mamdouh Aboammar"
copyright: "Copyright (c) 2026 Mamdouh Aboammar. All rights reserved."
license: MIT
---

# {name} Agent Skill

> {summary if summary else f"Operational execution guide for {name}."}

- **Archetype**: {archetype}
- **Generated via**: codebase-constitution & skill-synthesizer pipeline
- **Copyright**: (c) 2026 Mamdouh Aboammar

---

## When to activate

Activate on prompts such as:
- "run {clean_name} commands"
- "how to use {name}"
- "configure {name} in this project"
- "write code using {name}"
- "test {name} integration"

---

## Quick Start

```bash
{qs_block}
```

---

## Core Operations

1. **Inspection**: Verify installation and environment
   ```bash
   {clean_name} --version || which {clean_name}
   ```
2. **Execution**: Run primary operational workflow
   ```bash
   {clean_name} run
   ```
3. **Validation**: Test integration and assertion integrity
   ```bash
   {clean_name} test || {clean_name} validate
   ```
{inv_section}{conv_section}
---

## Troubleshooting

1. **Missing executable / command not found**:
   Ensure dependencies are installed with Bun or native package manager.
2. **Configuration syntax error**:
   Verify configuration flags against `references/configuration.md`.
3. **Invariant violation**:
   Review `docs/CONSTITUTION.md` for architectural boundaries.

---

## Progressive References

- See `references/api-reference.md` for complete command and flag options.
- See `references/examples.md` for real-world scenarios.
- See `references/configuration.md` for environment variables and manifests.
- See `evals/evals.json` for benchmark test suites.

*Copyright (c) 2026 Mamdouh Aboammar. All rights reserved. MIT License.*
"""


def synthesize_evals(name: str, archetype: str) -> Dict[str, Any]:
    """Generates benchmark evaluations for the synthesized skill."""
    clean_name = re.sub(r"[^a-zA-Z0-9_-]", "-", name).lower()
    return {
        "skill_name": clean_name,
        "evals": [
            {
                "id": 1,
                "prompt": f"How do I install and run {name}?",
                "expected_output": f"Clear instructions to install and execute {clean_name}",
                "expectations": [
                    f"Mentions {clean_name} invocation command",
                    "Includes prerequisites and runtime requirements",
                    "Does not invent non-existent flags"
                ]
            },
            {
                "id": 2,
                "prompt": f"What are the architectural invariants and rules for {name}?",
                "expected_output": "Lists enforced invariants extracted from code",
                "expectations": [
                    "Cites verified invariants or conventions",
                    "Distinguishes between MUST and SHOULD rules"
                ]
            },
            {
                "id": 3,
                "prompt": f"Write a working configuration or usage script for {name}",
                "expected_output": "Runnable code block without placeholder secrets",
                "expectations": [
                    "Provides syntactically valid code or command",
                    "No fake API keys or hardcoded local paths"
                ]
            }
        ]
    }


def main():
    parser = argparse.ArgumentParser(description="Synthesize an operational agent skill from codebase analysis")
    parser.add_argument("--root", default=".", help="Target repository root")
    parser.add_argument("--topology", default="", help="Path to topology.yaml")
    parser.add_argument("--constitution", default="", help="Path to CONSTITUTION.md")
    parser.add_argument("--out-dir", required=True, help="Destination directory for synthesized skill")
    args = parser.parse_args()

    root = Path(args.root).resolve()
    out_dir = Path(args.out_dir).resolve()
    name = root.name

    topology_path = Path(args.topology).resolve() if args.topology else root / "topology.yaml"
    topology = load_yaml_safe(topology_path).get("topology", {})

    archetype = detect_tool_archetype(root, topology)
    readme_info = extract_readme_sections(root)

    # Invariants and conventions from constitution if available
    invariants = []
    conventions = []
    const_file = Path(args.constitution).resolve() if args.constitution else root / "docs" / "CONSTITUTION.md"
    if const_file.exists():
        content = const_file.read_text(encoding="utf-8", errors="ignore")
        for match in re.finditer(r"- \*\*(MUST[A-Z_-]+)\*\*:\s*(.+)", content):
            invariants.append(f"{match.group(1)}: {match.group(2)}")
        for match in re.finditer(r"- \*\*([a-zA-Z0-9_\s]+)\*\*:\s*(.+)", content):
            if "Convention" in match.group(1) or "Rule" in match.group(1):
                conventions.append(f"{match.group(1)}: {match.group(2)}")

    entry_points = topology.get("entry_points", [])

    print(f"[synthesize_skill] Target: {root}")
    print(f"[synthesize_skill] Detected archetype: {archetype}")
    print(f"[synthesize_skill] Output directory: {out_dir}")

    # Create skill directory tree
    skill_dir = out_dir / name
    refs_dir = skill_dir / "references"
    evals_dir = skill_dir / "evals"
    adapters_dir = skill_dir / "adapters"

    refs_dir.mkdir(parents=True, exist_ok=True)
    evals_dir.mkdir(parents=True, exist_ok=True)
    adapters_dir.mkdir(parents=True, exist_ok=True)

    # 1. Write SKILL.md
    skill_content = synthesize_skill_md(
        name=name,
        archetype=archetype,
        summary=readme_info["summary"],
        quickstart=readme_info["quickstart"],
        invariants=invariants,
        conventions=conventions,
        entry_points=entry_points
    )
    (skill_dir / "SKILL.md").write_text(skill_content, encoding="utf-8")
    print(f"  ✓ Written: {skill_dir}/SKILL.md")

    # 2. Write references
    (refs_dir / "api-reference.md").write_text(
        f"# {name} — API & CLI Reference\n\nArchetype: {archetype}\n\nRefer to root manifests and CLI help for complete option matrices.\n",
        encoding="utf-8"
    )
    (refs_dir / "examples.md").write_text(
        f"# {name} — Usage Examples\n\n```bash\n{readme_info['quickstart']}\n```\n",
        encoding="utf-8"
    )
    (refs_dir / "configuration.md").write_text(
        f"# {name} — Configuration & Environment\n\nDocumented config keys and environment flags.\n",
        encoding="utf-8"
    )
    print(f"  ✓ Written: references/ in {skill_dir}")

    # 3. Write evals
    evals_data = synthesize_evals(name, archetype)
    (evals_dir / "evals.json").write_text(json.dumps(evals_data, indent=2), encoding="utf-8")
    print(f"  ✓ Written: evals/evals.json in {skill_dir}")

    # 4. Write adapters
    for host in ["antigravity", "claude", "codex", "cursor", "universal"]:
        adapter_text = f"# {host.title()} Host Adapter for {name}\n\nStatus: SUPPORTED_STRUCTURAL_ONLY\n\nTarget directory: ~/{host}/skills/{name}/\n"
        (adapters_dir / f"{host}.md").write_text(adapter_text, encoding="utf-8")
    print(f"  ✓ Written: adapters/ in {skill_dir}")

    print(f"[synthesize_skill] Successfully synthesized operational skill: {skill_dir}")


if __name__ == "__main__":
    main()
