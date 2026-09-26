#!/usr/bin/env node
/**
 * repo-to-skill CLI
 * Unified Two-Stage Microservices Engine: codebase-constitution + repo-to-skill
 * Copyright (c) 2026 Mamdouh Aboammar. All rights reserved.
 * MIT License — https://github.com/imMamdouhaboammar/repo-to-skill
 */

'use strict';

const { spawnSync } = require('child_process');
const path = require('path');
const fs = require('fs');
const os = require('os');

const SKILL_SRC = fs.existsSync(path.join(__dirname, '..', 'skills', 'repo-to-skill'))
  ? path.join(__dirname, '..', 'skills', 'repo-to-skill')
  : path.join(__dirname, '..');
const SCRIPTS_DIR = path.join(SKILL_SRC, 'scripts');
const VERSION = require('../package.json').version;

const HOSTS = {
  antigravity: path.join(os.homedir(), '.gemini', 'config', 'skills', 'repo-to-skill'),
  agents:      path.join(os.homedir(), '.agents', 'skills', 'repo-to-skill'),
  claude:      path.join(os.homedir(), '.claude', 'skills', 'repo-to-skill'),
  codex:       path.join(os.homedir(), '.codex', 'skills', 'repo-to-skill'),
  cursor:      path.join(os.homedir(), '.cursor', 'skills', 'repo-to-skill'),
  universal:   path.join(process.cwd(), '.skills', 'repo-to-skill'),
};

function banner() {
  console.log(`
  ┌─────────────────────────────────────────────────────────┐
  │                                                         │
  │   ◈  REPO TO SKILL & CONSTITUTION ENGINE   v${VERSION}     │
  │   ╌╌╌╌╌╌╌╌╌╌╌╌╌╌╌╌╌╌╌╌╌╌╌╌╌╌╌╌╌╌╌╌╌╌╌╌╌╌╌╌╌╌╌╌╌╌╌╌╌╌╌╌╌   │
  │   Two-Stage Microservices Engine (Auto End-to-End):     │
  │   [Step 1: Constitution] ➜ [Step 2: Skill Synthesizer]  │
  │                                                         │
  │   © 2026 Mamdouh Aboammar · MIT License                │
  └─────────────────────────────────────────────────────────┘
`);
}

function copyDir(src, dest) {
  if (!fs.existsSync(dest)) {
    fs.mkdirSync(dest, { recursive: true });
  }
  const ignore = new Set(['.git', 'node_modules', '.skills', 'dist', '.venv']);
  for (const entry of fs.readdirSync(src, { withFileTypes: true })) {
    if (ignore.has(entry.name)) continue;
    const srcPath = path.join(src, entry.name);
    const destPath = path.join(dest, entry.name);
    if (entry.isDirectory()) {
      copyDir(srcPath, destPath);
    } else {
      fs.copyFileSync(srcPath, destPath);
    }
  }
}

function installSkill(targetHost) {
  const targets = targetHost ? [targetHost] : Object.keys(HOSTS);
  let installed = 0;

  for (const host of targets) {
    if (!HOSTS[host]) {
      console.error(`  ✗ Unknown host: ${host}. Available: ${Object.keys(HOSTS).join(', ')}`);
      continue;
    }
    try {
      copyDir(SKILL_SRC, HOSTS[host]);
      console.log(`  ✓ Installed → ${HOSTS[host]} [${host}]`);
      installed++;
    } catch (err) {
      console.error(`  ✗ Failed to install for ${host}: ${err.message}`);
    }
  }

  return installed;
}

function runPipeline(target, outDir) {
  const orchestrateScript = path.join(SCRIPTS_DIR, 'orchestrate.py');
  const args = [orchestrateScript, target];
  if (outDir) {
    args.push('--out', outDir);
  }
  
  const result = spawnSync('python3', args, {
    stdio: 'inherit',
    encoding: 'utf8',
  });
  
  if (result.status !== 0) {
    console.error('\n  ✗ Pipeline failed. Ensure Python 3 and PyYAML are installed.');
    process.exit(result.status || 1);
  }
}

function runHarvest(repoPath) {
  const harvestScript = path.join(SCRIPTS_DIR, 'harvest.py');
  const outFile = path.join(repoPath, 'topology.yaml');
  
  const result = spawnSync('python3', [harvestScript, '--root', repoPath, '--out', outFile], {
    stdio: 'inherit',
    encoding: 'utf8',
  });
  
  if (result.status !== 0) {
    console.error('  ✗ Harvest failed.');
    process.exit(1);
  }
  console.log(`  ✓ Topology written to ${outFile}`);
}

function runValidate(constitutionDir) {
  const validateScript = path.join(SCRIPTS_DIR, 'validate_constitution.py');
  const result = spawnSync('python3', [validateScript, constitutionDir], {
    stdio: 'inherit',
    encoding: 'utf8',
  });
  process.exit(result.status || 0);
}

function printHelp() {
  console.log(`
Usage: repo-to-skill <command> [options]

Commands:
  run <repo-url-or-path> [--out <dir>]
                            Run the full 2-stage automated pipeline:
                            Step 1: Constitution extraction (ADRs, invariants, rules)
                            Step 2: Operational skill synthesis (SKILL.md, evals, adapters)
                            Default output: ./dist

  install [--host <name>]   Install the unified skill across agent environments
                            Hosts: antigravity, agents, claude, codex, cursor, universal
                            Default: all hosts

  harvest [--root <dir>]    Standalone topology and dependency audit
  validate [<dir>]          Verify constitution quality gate (sections, evidence >= 80%)
  version                   Show installed version
  help                      Show this help message

Quick Run:
  npx repo-to-skill-agent run https://github.com/vllm-project/vllm
  npx repo-to-skill-agent run ./my-local-project --out ./generated-skill
  npx repo-to-skill-agent install

© 2026 Mamdouh Aboammar · MIT License
https://github.com/imMamdouhaboammar/repo-to-skill
`);
}

// ─── Entrypoint ──────────────────────────────────────────────────────────────

banner();

const [,, command, ...args] = process.argv;

if (!command) {
  printHelp();
  process.exit(0);
}

switch (command) {
  case 'run': {
    const target = args[0];
    if (!target) {
      console.error('Error: "run" requires a repository URL or local directory path.\n');
      console.error('Example: npx repo-to-skill-agent run ./my-project\n');
      process.exit(1);
    }
    const outIdx = args.indexOf('--out');
    const outDir = outIdx !== -1 ? args[outIdx + 1] : 'dist';
    runPipeline(target, outDir);
    break;
  }

  case 'install': {
    const hostIdx = args.indexOf('--host');
    const host = hostIdx !== -1 ? args[hostIdx + 1] : null;
    console.log(`Installing unified repo-to-skill...\n`);
    const count = installSkill(host);
    console.log(`\n${count} host(s) configured. Activate in your agent with:\n`);
    console.log(`  "turn this repo into an agent skill with invariants"\n`);
    break;
  }

  case 'harvest': {
    const rootIdx = args.indexOf('--root');
    const root = rootIdx !== -1 ? args[rootIdx + 1] : process.cwd();
    console.log(`Running topology harvest on: ${root}\n`);
    runHarvest(root);
    break;
  }

  case 'validate': {
    const dir = args[0] || process.cwd();
    console.log(`Validating constitution in: ${dir}\n`);
    runValidate(dir);
    break;
  }

  case 'version': {
    console.log(VERSION);
    break;
  }

  case 'help':
  case '--help':
  case '-h': {
    printHelp();
    break;
  }

  default: {
    if (command.startsWith('http://') || command.startsWith('https://') || command.startsWith('.') || command.startsWith('/')) {
      const outIdx = args.indexOf('--out');
      const outDir = outIdx !== -1 ? args[outIdx + 1] : 'dist';
      runPipeline(command, outDir);
    } else {
      printHelp();
    }
    break;
  }
}
