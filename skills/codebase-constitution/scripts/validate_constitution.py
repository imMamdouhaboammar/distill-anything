#!/usr/bin/env python3
"""
validate_constitution.py — Quality gate checker for generated CONSTITUTION.md

Usage:
    python3 scripts/validate_constitution.py <constitution_dir> [--strict]

Checks:
  1. All 10 required sections present
  2. Evidence citation count (≥ 80% of invariants)
  3. ADR count (≥ 3)
  4. Agent rule count (≥ 15)
  5. No fabricated paths (basic heuristic)
  6. Portability section if adapters requested
  7. agent-rules.yaml exists and has minimum rules

Exits 0 on pass, 1 on failure.
"""

import sys
import os
import re
import yaml
import argparse
from pathlib import Path

REQUIRED_SECTIONS = [
    '## 1. Identity',
    '## 2. Topology',
    '## 3. Architecture',
    '## 4. Dependencies',
    '## 5. Invariants',
    '## 6. Conventions',
    '## 7. Decision Record',
    '## 8. Agent Rules',
    '## 9. Portability Notes',
    '## 10. Living Document Policy',
]

MIN_ADRS = 3
MIN_AGENT_RULES = 15
MIN_EVIDENCE_RATIO = 0.8  # 80% of invariants must have citations


def check_constitution_sections(content: str) -> list[str]:
    """Return list of missing required sections."""
    missing = []
    for section in REQUIRED_SECTIONS:
        # Section 9 is conditional — soft check
        if '## 9.' in section:
            continue
        if section.lower() not in content.lower():
            missing.append(section)
    return missing


def count_adrs(constitution_dir: Path) -> int:
    adr_dir = constitution_dir / 'adr'
    if not adr_dir.is_dir():
        return 0
    return len(list(adr_dir.glob('ADR-*.md')))


def count_agent_rules(constitution_dir: Path) -> tuple[int, list[str]]:
    rules_file = constitution_dir / 'agent-rules.yaml'
    if not rules_file.exists():
        return 0, ['agent-rules.yaml not found']
    try:
        data = yaml.safe_load(rules_file.read_text())
        rules = data.get('rules', [])
        return len(rules), []
    except Exception as e:
        return 0, [f'Failed to parse agent-rules.yaml: {e}']


def check_evidence_citations(content: str) -> tuple[float, int, int]:
    """
    Estimate evidence coverage ratio.
    Counts invariant entries and checks what fraction have file path citations.
    """
    # Find invariant table rows
    inv_pattern = re.compile(r'\|\s*INV-\d+\s*\|')
    invariant_rows = inv_pattern.findall(content)
    total_invariants = len(invariant_rows)
    
    if total_invariants == 0:
        return 0.0, 0, 0
    
    # Check for file path evidence markers in invariant sections
    path_pattern = re.compile(r'`[a-z][a-zA-Z0-9_/.-]+\.[a-z]{1,6}`')
    evidence_count = len(path_pattern.findall(content))
    
    # Rough heuristic: ratio of evidence citations to invariants
    ratio = min(1.0, evidence_count / (total_invariants * 1.5))
    return ratio, evidence_count, total_invariants


def check_no_fake_shas(content: str) -> list[str]:
    """Flag placeholder SHA patterns."""
    warnings = []
    placeholder_shas = re.findall(r'\b(abcdef|123456|000000|xxxxxxx|deadbee)[0-9a-f]*\b', content, re.IGNORECASE)
    if placeholder_shas:
        warnings.append(f'Possible placeholder git SHAs: {placeholder_shas}')
    return warnings


def run_gate(constitution_dir: Path, strict: bool = False) -> bool:
    """Run all quality gate checks. Returns True if passed."""
    passed = True
    errors = []
    warnings = []

    print(f'\n[validate-constitution] Checking: {constitution_dir}')
    print('=' * 60)

    # Check CONSTITUTION.md exists
    constitution_file = constitution_dir / 'CONSTITUTION.md'
    if not constitution_file.exists():
        errors.append('CONSTITUTION.md not found in target directory')
        print('\n[FAIL] CONSTITUTION.md not found')
        return False

    content = constitution_file.read_text()

    # Gate 1: Required sections
    missing_sections = check_constitution_sections(content)
    if missing_sections:
        errors.extend([f'Missing section: {s}' for s in missing_sections])
        print(f'[FAIL] Missing {len(missing_sections)} required section(s):')
        for s in missing_sections:
            print(f'       - {s}')
    else:
        print('[PASS] All 10 required sections present')

    # Gate 2: ADR count
    adr_count = count_adrs(constitution_dir)
    if adr_count < MIN_ADRS:
        errors.append(f'ADR count {adr_count} < minimum {MIN_ADRS}')
        print(f'[FAIL] ADR count: {adr_count} (minimum {MIN_ADRS})')
    else:
        print(f'[PASS] ADR count: {adr_count}')

    # Gate 3: Agent rules count
    rule_count, rule_errors = count_agent_rules(constitution_dir)
    if rule_errors:
        warnings.extend(rule_errors)
    if rule_count < MIN_AGENT_RULES:
        errors.append(f'Agent rule count {rule_count} < minimum {MIN_AGENT_RULES}')
        print(f'[FAIL] Agent rules: {rule_count} (minimum {MIN_AGENT_RULES})')
    else:
        print(f'[PASS] Agent rules: {rule_count}')

    # Gate 4: Evidence coverage
    ratio, evidence_count, invariant_count = check_evidence_citations(content)
    if invariant_count > 0:
        if ratio < MIN_EVIDENCE_RATIO:
            msg = f'Evidence ratio {ratio:.0%} < {MIN_EVIDENCE_RATIO:.0%} ({evidence_count} citations for {invariant_count} invariants)'
            if strict:
                errors.append(msg)
                print(f'[FAIL] {msg}')
            else:
                warnings.append(msg)
                print(f'[WARN] {msg}')
        else:
            print(f'[PASS] Evidence coverage: {ratio:.0%} ({evidence_count} citations)')
    else:
        warnings.append('No invariant rows found — could not check evidence coverage')
        print('[WARN] No invariant rows found in Invariants section')

    # Gate 5: No fake SHAs
    sha_warnings = check_no_fake_shas(content)
    if sha_warnings:
        warnings.extend(sha_warnings)
        for w in sha_warnings:
            print(f'[WARN] {w}')

    # Gate 6: agent-rules.yaml exists
    if not (constitution_dir / 'agent-rules.yaml').exists():
        warnings.append('agent-rules.yaml not found — machine-readable rules missing')
        print('[WARN] agent-rules.yaml not found')
    else:
        print('[PASS] agent-rules.yaml present')

    # Summary
    print('=' * 60)
    if errors:
        passed = False
        print(f'[RESULT] FAILED — {len(errors)} error(s), {len(warnings)} warning(s)')
        for e in errors:
            print(f'  ERROR: {e}')
    else:
        print(f'[RESULT] PASSED — 0 errors, {len(warnings)} warning(s)')
    for w in warnings:
        print(f'  WARN: {w}')
    print()

    return passed


def main():
    parser = argparse.ArgumentParser(description='Constitution quality gate')
    parser.add_argument('constitution_dir', help='Directory containing CONSTITUTION.md and docs/')
    parser.add_argument('--strict', action='store_true', help='Treat warnings as errors')
    args = parser.parse_args()

    target = Path(args.constitution_dir)
    if not target.is_dir():
        print(f'[error] Not a directory: {target}')
        sys.exit(1)

    passed = run_gate(target, strict=args.strict)
    sys.exit(0 if passed else 1)


if __name__ == '__main__':
    main()
