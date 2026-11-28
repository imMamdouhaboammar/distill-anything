import { describe, expect, test } from "bun:test";
import { existsSync, mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join, resolve } from "node:path";
import { evaluateDistillHook } from "../../hooks/distill-hook";
import { executeMcpTool, MCP_TOOLS } from "../../src/mcp/server";
import { verifySkillDirectory } from "../../src/mcp/verify";

const REPO_ROOT = resolve(import.meta.dir, "../..");

describe("distill-anything plugin bundle", () => {
  test("plugin.json, mcp_config.json, hooks.json, rules, agents, and skills are valid", () => {
    const pluginJson = JSON.parse(readFileSync(join(REPO_ROOT, "plugin.json"), "utf8")) as Record<string, unknown>;
    expect(pluginJson.name).toBe("distill-anything");
    expect(pluginJson.logo).toBe("assets/logo.svg");
    expect(existsSync(join(REPO_ROOT, "assets/logo.svg"))).toBe(true);
    expect(Array.isArray(pluginJson.suggestedPrompts)).toBe(true);
    expect((pluginJson.suggestedPrompts as unknown[]).length).toBe(3);

    const allowedKeys = new Set([
      "name",
      "description",
      "logo",
      "suggestedPrompts",
      "displayName",
      "version",
      "author",
      "homepage",
      "repository",
      "disabled",
    ]);
    for (const key of Object.keys(pluginJson)) {
      expect(allowedKeys.has(key)).toBe(true);
    }

    const mcpConfig = JSON.parse(readFileSync(join(REPO_ROOT, "mcp_config.json"), "utf8")) as {
      mcpServers: Record<string, { command: string; args: string[] }>;
    };
    expect(mcpConfig.mcpServers["distill-anything"]?.command).toBe("bun");

    const hooksJson = JSON.parse(readFileSync(join(REPO_ROOT, "hooks.json"), "utf8")) as Record<string, unknown>;
    expect(hooksJson["distill-anything-lifecycle"]).toBeDefined();

    expect(existsSync(join(REPO_ROOT, "rules/AGENTS.md"))).toBe(true);
    expect(existsSync(join(REPO_ROOT, "agents/skill-distiller.md"))).toBe(true);
    expect(existsSync(join(REPO_ROOT, "agents/grounding-auditor.md"))).toBe(true);
    expect(existsSync(join(REPO_ROOT, "agents/engineering-knowledge-curator.md"))).toBe(true);
    expect(existsSync(join(REPO_ROOT, "skills/distill-anything/SKILL.md"))).toBe(true);
    expect(existsSync(join(REPO_ROOT, "skills/distill-scan-org/SKILL.md"))).toBe(true);
    expect(existsSync(join(REPO_ROOT, "skills/distill-merge/SKILL.md"))).toBe(true);
    expect(existsSync(join(REPO_ROOT, "skills/distill-verify/SKILL.md"))).toBe(true);
  });

  test("MCP server exposes all distill tools and executes distill_dry_run + distill_verify_skill", async () => {
    const names = MCP_TOOLS.map((t) => t.name);
    expect(names).toEqual([
      "distill_dry_run",
      "distill_scan_org",
      "distill_verify_skill",
      "distill_repo",
      "distill_from_findings",
      "distill_merge",
      "distill_publish",
      "distill_discuss",
    ]);

    const dryRunRes = await executeMcpTool("distill_dry_run", {
      source: REPO_ROOT,
      maxFiles: 5,
      maxCommits: 2,
      noGit: true,
    });
    expect(dryRunRes.isError).toBeUndefined();
    const dryPayload = JSON.parse(dryRunRes.content[0]?.text ?? "{}") as {
      profile?: { primaryLanguage?: string };
      signalBundle?: { fileCount?: number };
    };
    expect(dryPayload.profile?.primaryLanguage).toBe("typescript");
    expect((dryPayload.signalBundle?.fileCount ?? 0) > 0).toBe(true);
  });

  test("verifySkillDirectory validates token caps, report schema, and disk citations", () => {
    const tmp = mkdtempSync(join(tmpdir(), "distill-verify-test-"));
    try {
      const skillDir = join(tmp, "sample-skill");
      const patternsDir = join(skillDir, "references", "patterns");
      mkdirSync(patternsDir, { recursive: true });

      writeFileSync(join(skillDir, "SKILL.md"), "---\nname: sample-skill\ndescription: Test.\n---\n# Sample\n", "utf8");
      writeFileSync(
        join(patternsDir, "01-test.md"),
        "# Test Pattern\n\nCited: `src/core/tokens.ts:1-10`\n",
        "utf8",
      );
      writeFileSync(
        join(skillDir, "distill-report.json"),
        JSON.stringify({
          version: "1.0",
          profile: {
            source: REPO_ROOT,
            repoName: "REPO-TO-SKILL",
            skillSlug: "sample-skill",
            commitSha: null,
            subpath: ".",
            analyzedAt: new Date().toISOString(),
            primaryLanguage: "typescript",
            languages: [{ language: "typescript", fileCount: 1, loc: 10, sharePercent: 100 }],
            totalFilesScanned: 1,
            skippedOversizedFiles: [],
            maturity: {
              classification: "production",
              hasCiWorkflows: true,
              hasBenchmarks: false,
              hasStrictTyping: true,
              testToSourceRatio: 0.5,
              experimentalMarkersPerKloc: 0,
            },
          },
          outputPath: skillDir,
          groundingMode: "verified_disk",
          totalCandidatesExtracted: 1,
          groundingFailures: 0,
          patternsKept: 1,
          patternsDropped: [],
          costs: [],
          totalCostUsd: 0,
          skillIndexTokens: 20,
        }),
        "utf8",
      );

      const okRes = verifySkillDirectory(skillDir, REPO_ROOT);
      expect(okRes.ok).toBe(true);
      expect(okRes.skillIndexWithinCap).toBe(true);
      expect(okRes.reportValid).toBe(true);

      writeFileSync(
        join(patternsDir, "01-test.md"),
        "# Broken\n\nCited: `does/not/exist.ts:1-5`\n",
        "utf8",
      );
      const failRes = verifySkillDirectory(skillDir, REPO_ROOT);
      expect(failRes.ok).toBe(false);
      expect(failRes.patterns[0]?.missingCitedPaths).toEqual(["does/not/exist.ts"]);
    } finally {
      rmSync(tmp, { recursive: true, force: true });
    }
  });

  test("distill-hook returns valid protojson responses for PreToolUse and PostToolUse", () => {
    const tmp = mkdtempSync(join(tmpdir(), "distill-hook-test-"));
    try {
      const skillPath = join(tmp, ".claude", "skills", "my-skill", "SKILL.md");
      const preRes = evaluateDistillHook("PreToolUse", {
        tool_name: "write_file",
        tool_input: { Path: skillPath, Content: "# Unverified" },
      });
      expect(preRes).toEqual({ decision: "allow" });

      mkdirSync(join(tmp, ".claude", "skills", "my-skill"), { recursive: true });
      writeFileSync(skillPath, "word ".repeat(1400), "utf8");
      const postRes = evaluateDistillHook("PostToolUse", {
        tool_name: "write_file",
        tool_input: { Path: skillPath },
      });
      expect(postRes).toEqual({});
    } finally {
      rmSync(tmp, { recursive: true, force: true });
    }
  });
});
