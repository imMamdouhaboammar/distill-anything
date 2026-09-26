#!/usr/bin/env python3
"""
extract_adrs.py — Extract implicit ADRs from code comments, config, and git history.

Usage:
    python3 scripts/extract_adrs.py \
        --root <repo_dir> \
        --out-dir <docs/adr/> \
        [--git-history] \
        [--max-adrs <N>]

Produces individual ADR-NNN.md files in the output directory.
"""

import os
import re
import sys
import json
import subprocess
import argparse
from pathlib import Path
from dataclasses import dataclass, field
from typing import Optional


IGNORE_DIRS = {
    '.git', 'node_modules', '.venv', 'venv', '__pycache__',
    'target', 'dist', 'build', '.next', 'tmp'
}

# Patterns that signal an architectural decision in code
DECISION_PATTERNS = [
    (r'(?:DECISION|WHY|BECAUSE|RATIONALE):\s*(.+)', 'decision_comment'),
    (r'HACK:\s*(.+)', 'hack_comment'),
    (r'TODO:\s*(?:replace|migrate|switch|use|move)\s+(.+)', 'migration_todo'),
    (r'NOTE:\s*(?:we|using|chose|selected|decided)\s+(.+)', 'design_note'),
    (r'//\s*We\s+use\s+(\w+)\s+instead\s+of\s+(\w+)\s+because\s+(.+)', 'explicit_choice'),
    (r'#\s*We\s+use\s+(\w+)\s+instead\s+of\s+(\w+)\s+because\s+(.+)', 'explicit_choice'),
    (r'DEPRECATED:\s*(.+)', 'deprecated_marker'),
    (r'WORKAROUND:\s*(.+)', 'workaround_comment'),
]

SOURCE_EXTENSIONS = {
    '.ts', '.tsx', '.js', '.jsx', '.py', '.go', '.rs', '.rb',
    '.java', '.kt', '.swift', '.cs', '.php', '.ex', '.exs'
}


@dataclass
class ADRCandidate:
    title: str
    context: str
    decision: str
    consequences: str
    evidence: list[str] = field(default_factory=list)
    status: str = 'implicit'
    source_type: str = ''


def scan_source_files(root: Path) -> list[ADRCandidate]:
    """Scan source files for decision comment patterns."""
    candidates = []
    
    for filepath in root.rglob('*'):
        if not filepath.is_file():
            continue
        if filepath.suffix not in SOURCE_EXTENSIONS:
            continue
        if any(p in filepath.parts for p in IGNORE_DIRS):
            continue
        
        try:
            content = filepath.read_text(errors='ignore')
        except Exception:
            continue
        
        rel_path = str(filepath.relative_to(root))
        
        for line_num, line in enumerate(content.splitlines(), 1):
            for pattern, ptype in DECISION_PATTERNS:
                m = re.search(pattern, line, re.IGNORECASE)
                if m:
                    evidence = f"{rel_path}#{line_num}: {line.strip()}"
                    
                    if ptype == 'hack_comment':
                        candidates.append(ADRCandidate(
                            title=f"Technical shortcut: {m.group(1)[:60]}",
                            context=f"A HACK comment indicates an acknowledged technical shortcut",
                            decision=f"Shortcut taken: {m.group(1)}",
                            consequences="Technical debt accumulated; should be tracked for resolution",
                            evidence=[evidence],
                            status='implicit',
                            source_type=ptype
                        ))
                    elif ptype == 'decision_comment':
                        candidates.append(ADRCandidate(
                            title=f"Explicit decision: {m.group(1)[:60]}",
                            context="A DECISION/WHY/RATIONALE comment documents an explicit design choice",
                            decision=m.group(1),
                            consequences="See context for tradeoffs",
                            evidence=[evidence],
                            status='accepted',
                            source_type=ptype
                        ))
                    elif ptype == 'migration_todo':
                        candidates.append(ADRCandidate(
                            title=f"Planned migration: {m.group(1)[:60]}",
                            context="A TODO comment indicates a planned technology migration",
                            decision=f"Migration planned: {m.group(1)}",
                            consequences="Current implementation is considered temporary",
                            evidence=[evidence],
                            status='implicit',
                            source_type=ptype
                        ))
                    elif ptype == 'deprecated_marker':
                        candidates.append(ADRCandidate(
                            title=f"Deprecated: {m.group(1)[:60]}",
                            context="Code marked DEPRECATED indicates a superseded approach",
                            decision=f"Approach deprecated: {m.group(1)}",
                            consequences="New code should avoid this pattern",
                            evidence=[evidence],
                            status='deprecated',
                            source_type=ptype
                        ))
    
    return candidates


def scan_package_json(root: Path) -> list[ADRCandidate]:
    """Extract technology decisions from package.json."""
    candidates = []
    pkg = root / 'package.json'
    if not pkg.exists():
        return []
    
    try:
        data = json.loads(pkg.read_text())
    except Exception:
        return []
    
    deps = {**data.get('dependencies', {}), **data.get('devDependencies', {})}
    
    # Detect framework choices
    framework_signals = {
        'express': 'Express.js as web framework',
        'fastify': 'Fastify as web framework (performance-oriented)',
        'next': 'Next.js as full-stack React framework',
        'prisma': 'Prisma as ORM (type-safe database access)',
        'drizzle-orm': 'Drizzle as ORM (lightweight, SQL-first)',
        'zod': 'Zod for runtime type validation',
        'vitest': 'Vitest as test runner',
        'jest': 'Jest as test runner',
        'bun': 'Bun as JavaScript runtime',
    }
    
    for pkg_name, description in framework_signals.items():
        if pkg_name in deps:
            candidates.append(ADRCandidate(
                title=f"Technology choice: {description}",
                context=f"The package.json includes {pkg_name} as a dependency",
                decision=f"Using {description} (version: {deps[pkg_name]})",
                consequences=f"Team and AI agents must understand {pkg_name} patterns",
                evidence=[f"package.json:dependencies.{pkg_name}"],
                status='accepted',
                source_type='package_json'
            ))
    
    return candidates


def get_migration_adrs(root: Path) -> list[ADRCandidate]:
    """Extract decisions from database migration files."""
    candidates = []
    migration_dirs = ['migrations', 'migrate', 'db/migrations', 'database/migrations']
    
    for mdir in migration_dirs:
        mpath = root / mdir
        if not mpath.is_dir():
            continue
        
        migrations = sorted(mpath.rglob('*.sql')) + sorted(mpath.rglob('*.py'))
        if len(migrations) > 0:
            candidates.append(ADRCandidate(
                title=f"Database schema evolution via migrations ({len(migrations)} migrations found)",
                context=f"The project uses {mdir}/ for schema management",
                decision=f"Schema managed through versioned migration files in {mdir}/",
                consequences="All schema changes must go through migrations; no direct schema edits",
                evidence=[f"{mdir}/ ({len(migrations)} files)"],
                status='accepted',
                source_type='migrations'
            ))
    
    return candidates


def get_git_history_adrs(root: Path, max_commits: int = 50) -> list[ADRCandidate]:
    """Extract decisions from git log messages (large refactors, renames)."""
    candidates = []
    
    try:
        result = subprocess.run(
            ['git', 'log', f'--max-count={max_commits}', '--oneline', '--no-merges'],
            cwd=root, capture_output=True, text=True, timeout=10
        )
        if result.returncode != 0:
            return []
    except Exception:
        return []
    
    migration_keywords = [
        r'migrate\s+(?:from\s+)?(\w+)\s+to\s+(\w+)',
        r'replace\s+(\w+)\s+with\s+(\w+)',
        r'switch\s+(?:from\s+)?(\w+)\s+to\s+(\w+)',
        r'refactor:\s+(.+)',
        r'chore:\s+(?:migrate|replace|remove|upgrade)\s+(.+)',
    ]
    
    for line in result.stdout.splitlines():
        sha = line.split()[0] if line else ''
        msg = ' '.join(line.split()[1:]) if len(line.split()) > 1 else ''
        
        for pat in migration_keywords:
            m = re.search(pat, msg, re.IGNORECASE)
            if m:
                candidates.append(ADRCandidate(
                    title=f"Migration: {msg[:70]}",
                    context="Git history shows a technology migration or significant refactor",
                    decision=msg,
                    consequences="Previous approach was replaced; understand what changed",
                    evidence=[f"git commit {sha}: {msg}"],
                    status='accepted',
                    source_type='git_history'
                ))
                break
    
    return candidates


def write_adr(candidate: ADRCandidate, adr_num: int, out_dir: Path) -> Path:
    """Write an ADR-NNN.md file from a candidate."""
    adr_id = f"ADR-{adr_num:03d}"
    title = candidate.title
    
    content = f"""# {adr_id}: {title}

**Status:** {candidate.status}  
**Source type:** {candidate.source_type}

## Context

{candidate.context}

## Decision

{candidate.decision}

## Consequences

{candidate.consequences}

## Evidence

"""
    for e in candidate.evidence:
        content += f"- `{e}`\n"
    
    out_file = out_dir / f"{adr_id}.md"
    out_file.write_text(content)
    return out_file


def write_adr_index(adrs: list[tuple[int, ADRCandidate]], out_dir: Path):
    """Write ADR-000.md index file."""
    lines = ["# ADR-000: Architecture Decision Record Index\n\n"]
    lines.append("| ADR | Title | Status | Source |\n")
    lines.append("|---|---|---|---|\n")
    
    for num, candidate in adrs:
        adr_id = f"ADR-{num:03d}"
        lines.append(f"| [{adr_id}](./{adr_id}.md) | {candidate.title[:60]} | {candidate.status} | {candidate.source_type} |\n")
    
    (out_dir / "ADR-000.md").write_text("".join(lines))


def main():
    parser = argparse.ArgumentParser(description='Extract implicit ADRs from codebase')
    parser.add_argument('--root', default='.', help='Repository root')
    parser.add_argument('--out-dir', default='docs/adr', help='Output directory for ADR files')
    parser.add_argument('--git-history', action='store_true', help='Include git history analysis')
    parser.add_argument('--max-adrs', type=int, default=30, help='Maximum ADRs to generate')
    args = parser.parse_args()

    root = Path(args.root).resolve()
    out_dir = Path(args.out_dir)
    out_dir.mkdir(parents=True, exist_ok=True)

    print(f'[extract_adrs] Scanning: {root}')
    
    candidates = []
    candidates.extend(scan_source_files(root))
    candidates.extend(scan_package_json(root))
    candidates.extend(get_migration_adrs(root))
    
    if args.git_history:
        candidates.extend(get_git_history_adrs(root))
    
    # Deduplicate by title similarity (simple prefix match)
    seen_titles = set()
    unique = []
    for c in candidates:
        key = c.title[:40].lower()
        if key not in seen_titles:
            seen_titles.add(key)
            unique.append(c)
    
    # Prioritize: accepted > implicit > hypothesis
    priority = {'accepted': 0, 'implicit': 1, 'deprecated': 2, 'hypothesis': 3}
    unique.sort(key=lambda c: priority.get(c.status, 99))
    
    # Cap
    unique = unique[:args.max_adrs]
    
    numbered = list(enumerate(unique, start=1))
    
    for num, candidate in numbered:
        out_file = write_adr(candidate, num, out_dir)
        print(f'  [{num:03d}] {candidate.status}: {candidate.title[:60]}')
    
    write_adr_index(numbered, out_dir)
    
    print(f'\n[extract_adrs] Generated {len(numbered)} ADRs in {out_dir}/')
    print(f'[extract_adrs] Index: {out_dir}/ADR-000.md')


if __name__ == '__main__':
    main()
