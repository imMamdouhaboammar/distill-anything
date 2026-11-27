# Security Policy

## Reporting a Vulnerability

If you discover a security vulnerability in `distill-anything`, please report it privately rather than opening a public issue:

- Email: `mamdouh@aboammar.dev`
- Include a description of the issue, steps to reproduce, and affected file paths or CLI flags.

You will receive an acknowledgment within 72 hours. Once a fix is verified, a release and advisory will be published.

## Threat Model and Guarantees

### Static Analysis Only

`distill-anything` performs static analysis on target repositories. It never executes build scripts, package post-install hooks, tests, or any untrusted code inside the repository being analyzed. Stage 1 clones with Git and reads files from disk; Stage 2 parses source files using sandboxed `web-tree-sitter` WASM grammars.

### Path Traversal Prevention

- `--subpath` and all LLM-generated citation paths are validated and normalized against the repository root. Paths that escape the repository root (such as `../../etc`) are rejected immediately (see `src/cli/args.ts` and `src/stages/03-miner/grounder.ts`).
- Output paths (`--out`, `--name`) are sanitized before writing compiled skills.

### Temporary Directory Cleanup

When cloning remote repositories for analysis, `distill-anything` creates an isolated temporary directory via `mkdtemp` and removes it in a `finally` block on completion, error, or budget abort.

### Secret Handling

- API keys and tokens are read from environment variables or local Codex CLI authentication and are never written to `distill-report.json`, `SKILL.md`, or pattern files.
- Never pass secrets on the command line or commit `.env` files.
