#!/usr/bin/env python3
"""
generate_rules.py — Synthesize agent-rules.yaml from extracted invariants + conventions.

Usage:
    python3 scripts/generate_rules.py \
        --invariants <invariants.yaml> \
        --conventions <conventions.yaml> \
        --adrs <adrs.yaml> \
        --out <agent-rules.yaml>

Input: YAML files from Pass 5 (invariants) and Pass 6 (conventions).
Output: Structured agent-rules.yaml ready for agent consumption.
"""

import sys
import yaml
import argparse
import datetime
from pathlib import Path


CATEGORY_MAP = {
    'MUST_NEVER': {
        'sql': 'SEC',
        'inject': 'SEC',
        'secret': 'SEC',
        'auth': 'SEC',
        'import': 'ARCH',
        'module': 'ARCH',
        'layer': 'ARCH',
        'test': 'TEST',
        'default': 'SEC',
    },
    'MUST_ALWAYS': {
        'test': 'TEST',
        'validate': 'SEC',
        'log': 'CONV',
        'auth': 'SEC',
        'error': 'CONV',
        'inject': 'ARCH',
        'transaction': 'DATA',
        'default': 'CONV',
    },
    'MUST_WHEN': {
        'database': 'DATA',
        'transaction': 'DATA',
        'api': 'API',
        'external': 'API',
        'retry': 'API',
        'pii': 'SEC',
        'default': 'CONV',
    }
}


def classify_category(rule_class: str, rule_text: str) -> str:
    """Heuristic category classification from rule text."""
    text_lower = rule_text.lower()
    class_map = CATEGORY_MAP.get(rule_class, {})
    for keyword, category in class_map.items():
        if keyword in text_lower:
            return category
    return class_map.get('default', 'CONV')


def invariant_to_rule(inv: dict, rule_num: int) -> dict:
    """Convert an invariant YAML entry to an agent rule."""
    rule_class = inv.get('class', 'MUST_ALWAYS')
    rule_text = inv.get('rule', '')
    condition = inv.get('condition', '')

    category = classify_category(rule_class, rule_text)
    rule_id = f"CONST-{category}-{rule_num:03d}"

    # Build trigger from class and condition
    if rule_class == 'MUST_NEVER':
        trigger = 'Any code generation or modification'
        assertion = f'Never: {rule_text}'
    elif rule_class == 'MUST_ALWAYS':
        trigger = 'Any relevant code context'
        assertion = f'Always: {rule_text}'
    else:  # MUST_WHEN
        trigger = condition or 'When stated condition applies'
        assertion = rule_text

    return {
        'id': rule_id,
        'category': category,
        'severity': inv.get('severity', 'medium'),
        'trigger': trigger,
        'assertion': assertion,
        'enforcement': inv.get('enforcement', 'convention'),
        'source_invariant': inv.get('id', ''),
        'source_adr': inv.get('source_adr', ''),
        'rationale': inv.get('rationale', ''),
        'agent_instruction': f"{'Never' if rule_class == 'MUST_NEVER' else 'Always'} ensure: {rule_text}",
        'violation_example': {'lang': 'text', 'code': '# (Add specific violation example from codebase)'},
        'compliant_example': {'lang': 'text', 'code': '# (Add specific compliant example from codebase)'},
    }


def convention_to_rules(conventions: dict) -> list[dict]:
    """Convert convention register entries to agent rules."""
    rules = []
    counter = {'NAME': 1, 'CONV': 1, 'TEST': 1, 'API': 1, 'DATA': 1}

    naming = conventions.get('naming', {})
    if naming:
        file_style = naming.get('file_style', '')
        if file_style:
            cat = 'NAME'
            n = counter[cat]
            counter[cat] += 1
            rules.append({
                'id': f'CONST-{cat}-{n:03d}',
                'category': cat,
                'severity': 'low',
                'trigger': 'When creating a new source file',
                'assertion': f'Files must use {file_style} naming convention',
                'enforcement': 'convention',
                'source_invariant': '',
                'rationale': 'Consistent naming reduces cognitive load when navigating the codebase',
                'agent_instruction': f'When generating a new file, use {file_style} for the filename.',
                'violation_example': {'lang': 'text', 'code': '# Wrong: userService.ts or UserService.ts'},
                'compliant_example': {'lang': 'text', 'code': f'# Correct: user-service.ts ({file_style})'},
            })

    error_handling = conventions.get('error_handling', {})
    if error_handling:
        pattern = error_handling.get('primary_pattern', '')
        if pattern:
            cat = 'CONV'
            n = counter[cat]
            counter[cat] += 1
            rules.append({
                'id': f'CONST-{cat}-{n:03d}',
                'category': cat,
                'severity': 'high',
                'trigger': 'When writing error handling code',
                'assertion': f'Use {pattern} error handling pattern consistently',
                'enforcement': 'convention',
                'source_invariant': '',
                'rationale': 'Consistent error handling makes errors predictable and debuggable',
                'agent_instruction': f'Use the {pattern} pattern for error handling. Check existing service files for reference.',
                'violation_example': {'lang': 'text', 'code': '# Mixing patterns creates unpredictable error flows'},
                'compliant_example': {'lang': 'text', 'code': f'# Follow the {pattern} pattern from existing services'},
            })

    testing = conventions.get('testing', {})
    if testing:
        cat = 'TEST'
        n = counter[cat]
        counter[cat] += 1
        threshold = testing.get('coverage_threshold', 80)
        rules.append({
            'id': f'CONST-{cat}-{n:03d}',
            'category': cat,
            'severity': 'high',
            'trigger': 'When adding a new public API or service method',
            'assertion': f'New code must maintain ≥{threshold}% test coverage',
            'enforcement': 'ci',
            'source_invariant': '',
            'rationale': f'Coverage floor of {threshold}% is enforced in CI',
            'agent_instruction': f'When generating implementation code, always generate accompanying tests. Coverage target: {threshold}%.',
            'violation_example': {'lang': 'text', 'code': '# New service method with no test file'},
            'compliant_example': {'lang': 'text', 'code': '# service.ts + service.test.ts co-located'},
        })

    return rules


def build_rules_file(invariants: list[dict], conventions: dict, adrs: list[dict]) -> dict:
    """Build the full agent-rules.yaml structure."""
    rules = []
    
    # Convert invariants to rules
    for i, inv in enumerate(invariants, start=1):
        rules.append(invariant_to_rule(inv, i))
    
    # Convert conventions to rules
    conv_rules = convention_to_rules(conventions)
    # Assign IDs avoiding conflicts
    offset = len(rules) + 1
    for j, r in enumerate(conv_rules):
        # Keep category-specific ID assigned in convention_to_rules
        rules.append(r)

    # Build category summary
    by_category = {}
    for r in rules:
        cat = r['category']
        by_category[cat] = by_category.get(cat, 0) + 1

    return {
        'meta': {
            'generated_at': datetime.datetime.utcnow().isoformat() + 'Z',
            'generated_by': 'codebase-constitution skill v1.0.0',
            'total_rules': len(rules),
            'by_category': by_category,
        },
        'rules': rules,
    }


def load_yaml_optional(path: str):
    """Load YAML file or return empty structure if not found."""
    p = Path(path)
    if not p.exists():
        return {}
    try:
        return yaml.safe_load(p.read_text()) or {}
    except Exception:
        return {}


def main():
    parser = argparse.ArgumentParser(description='Generate agent-rules.yaml from invariants + conventions')
    parser.add_argument('--root', default='', help='Root directory to search for manifests')
    parser.add_argument('--invariants', default='invariants.yaml', help='Invariants YAML file')
    parser.add_argument('--conventions', default='conventions.yaml', help='Conventions YAML file')
    parser.add_argument('--adrs', default='adrs.yaml', help='ADRs YAML file')
    parser.add_argument('--out', default='agent-rules.yaml', help='Output file')
    args = parser.parse_args()

    root_path = Path(args.root).resolve() if args.root else None

    # Check root or local paths
    inv_file = args.invariants
    if root_path and not Path(inv_file).exists():
        if (root_path / 'invariants.yaml').exists():
            inv_file = str(root_path / 'invariants.yaml')
        elif (root_path / 'docs' / 'invariants.yaml').exists():
            inv_file = str(root_path / 'docs' / 'invariants.yaml')

    conv_file = args.conventions
    if root_path and not Path(conv_file).exists():
        if (root_path / 'conventions.yaml').exists():
            conv_file = str(root_path / 'conventions.yaml')
        elif (root_path / 'docs' / 'conventions.yaml').exists():
            conv_file = str(root_path / 'docs' / 'conventions.yaml')

    adr_file = args.adrs
    if root_path and not Path(adr_file).exists():
        if (root_path / 'adrs.yaml').exists():
            adr_file = str(root_path / 'adrs.yaml')
        elif (root_path / 'docs' / 'adrs.yaml').exists():
            adr_file = str(root_path / 'docs' / 'adrs.yaml')

    inv_data = load_yaml_optional(inv_file)
    invariants = inv_data if isinstance(inv_data, list) else inv_data.get('invariants', [])
    
    conv_data = load_yaml_optional(conv_file)
    conventions = conv_data.get('conventions', conv_data) if isinstance(conv_data, dict) else {}
    
    adr_data = load_yaml_optional(adr_file)
    adrs = adr_data if isinstance(adr_data, list) else adr_data.get('adrs', [])

    output = build_rules_file(invariants, conventions, adrs)

    out_path = Path(args.out)
    out_path.parent.mkdir(parents=True, exist_ok=True)
    with open(out_path, 'w') as f:
        yaml.dump(output, f, default_flow_style=False, sort_keys=False, allow_unicode=True)

    print(f'[generate_rules] Written {output["meta"]["total_rules"]} rules to {args.out}')
    print(f'[generate_rules] By category: {output["meta"]["by_category"]}')


if __name__ == '__main__':
    main()
