#!/usr/bin/env python3
"""
harvest.py — Topology + Dependency harvest for Codebase Constitution skill.

Usage:
    python3 scripts/harvest.py [--root <dir>] [--depth <n>] [--out <output.yaml>]

Produces topology.yaml suitable for CONSTITUTION.md Section 2.
"""

import os
import sys
import json
import yaml
import subprocess
import argparse
from pathlib import Path
from collections import Counter, defaultdict

IGNORE_DIRS = {
    '.git', 'node_modules', '.venv', 'venv', '__pycache__',
    'target', 'dist', 'build', '.next', '.nuxt', 'out',
    'coverage', '.coverage', '.cache', '.parcel-cache',
    '.turbo', '.vercel', 'tmp', 'temp'
}

LANGUAGE_EXTENSIONS = {
    '.ts': 'TypeScript',
    '.tsx': 'TypeScript (React)',
    '.js': 'JavaScript',
    '.jsx': 'JavaScript (React)',
    '.mjs': 'JavaScript (ESM)',
    '.py': 'Python',
    '.go': 'Go',
    '.rs': 'Rust',
    '.rb': 'Ruby',
    '.java': 'Java',
    '.kt': 'Kotlin',
    '.swift': 'Swift',
    '.cpp': 'C++',
    '.c': 'C',
    '.cs': 'C#',
    '.php': 'PHP',
    '.ex': 'Elixir',
    '.exs': 'Elixir (script)',
    '.hs': 'Haskell',
    '.scala': 'Scala',
    '.clj': 'Clojure',
    '.sh': 'Shell',
    '.bash': 'Bash',
    '.sql': 'SQL',
    '.graphql': 'GraphQL',
    '.proto': 'Protocol Buffers',
}

TEST_PATTERNS = [
    '.test.', '.spec.', '_test.', 'test_',
    '/tests/', '/test/', '/__tests__/', '/spec/',
]

def is_ignored(path: Path) -> bool:
    for part in path.parts:
        if part in IGNORE_DIRS:
            return True
    return False


def walk_files(root: Path) -> list[Path]:
    files = []
    for f in root.rglob('*'):
        if f.is_file() and not is_ignored(f.relative_to(root)):
            files.append(f)
    return files


def classify_language(files: list[Path]) -> dict:
    ext_counts = Counter(f.suffix.lower() for f in files if f.suffix)
    lang_counts = {}
    for ext, count in ext_counts.most_common():
        lang = LANGUAGE_EXTENSIONS.get(ext)
        if lang:
            lang_counts[lang] = lang_counts.get(lang, 0) + count
    total = sum(lang_counts.values()) or 1
    return [
        {'name': lang, 'file_count': count, 'percentage': round(count / total * 100, 1)}
        for lang, count in sorted(lang_counts.items(), key=lambda x: -x[1])
    ]


def is_test_file(path: Path) -> bool:
    s = str(path)
    return any(pat in s for pat in TEST_PATTERNS)


def detect_entry_points(root: Path) -> list[str]:
    candidates = [
        'main.ts', 'main.js', 'main.py', 'main.go', 'main.rs',
        'index.ts', 'index.js', 'index.py',
        'app.ts', 'app.js', 'app.py', 'app.rb',
        'server.ts', 'server.js', 'server.py',
        '__main__.py', 'cmd/main.go',
    ]
    found = []
    for c in candidates:
        p = root / c
        if p.exists():
            found.append(str(p.relative_to(root)))
    # Check package.json for main/bin
    pkg = root / 'package.json'
    if pkg.exists():
        try:
            data = json.loads(pkg.read_text())
            if 'main' in data:
                found.append(f"package.json:main → {data['main']}")
            if 'bin' in data:
                for k, v in (data['bin'].items() if isinstance(data['bin'], dict) else {}).items():
                    found.append(f"bin:{k} → {v}")
        except Exception:
            pass
    return found


def detect_build_tools(root: Path) -> list[str]:
    tools = []
    checks = {
        'package.json': 'npm/bun',
        'bun.lockb': 'Bun',
        'Cargo.toml': 'Cargo (Rust)',
        'go.mod': 'Go modules',
        'pyproject.toml': 'Python (pyproject)',
        'requirements.txt': 'pip',
        'Gemfile': 'Bundler (Ruby)',
        'pom.xml': 'Maven',
        'build.gradle': 'Gradle',
        'Makefile': 'Make',
        'CMakeLists.txt': 'CMake',
        'mix.exs': 'Mix (Elixir)',
    }
    for filename, label in checks.items():
        if (root / filename).exists():
            tools.append(label)
    return tools


def detect_ci_files(root: Path) -> list[str]:
    ci_files = []
    patterns = [
        '.github/workflows',
        '.gitlab-ci.yml',
        '.circleci/config.yml',
        'Jenkinsfile',
        '.travis.yml',
        'azure-pipelines.yml',
        'bitbucket-pipelines.yml',
        '.buildkite',
    ]
    for p in patterns:
        path = root / p
        if path.exists():
            ci_files.append(str(path.relative_to(root)))
    return ci_files


def detect_infra_files(root: Path) -> list[str]:
    infra = []
    for pattern in ['**/*.tf', '**/Dockerfile', '**/docker-compose.yml',
                    '**/fly.toml', '**/vercel.json', '**/wrangler.toml',
                    '**/Chart.yaml', '**/pulumi.yaml']:
        for f in root.glob(pattern):
            if not is_ignored(f.relative_to(root)):
                infra.append(str(f.relative_to(root)))
    return infra[:20]  # cap at 20


def get_git_sha(root: Path) -> str:
    try:
        result = subprocess.run(
            ['git', 'rev-parse', '--short', 'HEAD'],
            cwd=root, capture_output=True, text=True, timeout=5
        )
        return result.stdout.strip() if result.returncode == 0 else 'unknown'
    except Exception:
        return 'unknown'


def count_loc(files: list[Path]) -> int:
    """Approximate lines of code (source files only)."""
    source_exts = set(LANGUAGE_EXTENSIONS.keys())
    total = 0
    for f in files:
        if f.suffix.lower() in source_exts:
            try:
                total += f.read_text(errors='ignore').count('\n')
            except Exception:
                pass
    return total


def harvest(root: Path, depth: int = 3) -> dict:
    all_files = walk_files(root)
    source_files = [f for f in all_files if f.suffix.lower() in LANGUAGE_EXTENSIONS]
    test_files = [f for f in source_files if is_test_file(f)]
    non_test_source = [f for f in source_files if not is_test_file(f)]
    test_ratio = round(len(test_files) / len(source_files) * 100, 1) if source_files else 0.0

    return {
        'topology': {
            'repo_name': root.name,
            'git_sha': get_git_sha(root),
            'languages': classify_language(source_files),
            'entry_points': detect_entry_points(root),
            'total_files': len(all_files),
            'source_file_count': len(non_test_source),
            'test_file_count': len(test_files),
            'test_ratio': test_ratio,
            'approximate_loc': count_loc(source_files),
            'build_tools': detect_build_tools(root),
            'ci_files': detect_ci_files(root),
            'infra_files': detect_infra_files(root),
            'monorepo': (root / 'packages').is_dir() or (root / 'apps').is_dir(),
        }
    }


def main():
    parser = argparse.ArgumentParser(description='Topology harvest for codebase-constitution skill')
    parser.add_argument('--root', default='.', help='Repository root directory')
    parser.add_argument('--depth', type=int, default=3, help='Max tree depth for display')
    parser.add_argument('--out', default='topology.yaml', help='Output YAML file')
    args = parser.parse_args()

    root = Path(args.root).resolve()
    print(f'[harvest] Scanning: {root}')

    data = harvest(root, args.depth)

    with open(args.out, 'w') as f:
        yaml.dump(data, f, default_flow_style=False, sort_keys=False, allow_unicode=True)

    print(f'[harvest] Written to: {args.out}')
    topo = data['topology']
    print(f'[harvest] Languages: {[l["name"] for l in topo["languages"][:5]]}')
    print(f'[harvest] Source files: {topo["source_file_count"]} | Test files: {topo["test_file_count"]} | Ratio: {topo["test_ratio"]}%')
    print(f'[harvest] Approx LOC: {topo["approximate_loc"]:,}')


if __name__ == '__main__':
    main()
