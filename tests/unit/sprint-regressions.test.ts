import { describe, expect, test } from "bun:test";
import { mkdtempSync, mkdirSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { BudgetLedger } from "../../src/core/budget";
import type { DiscoveredFile } from "../../src/stages/01-ingest";
import { extractCoreArchitectureFiles } from "../../src/stages/02-signals/ast-graph";
import { generateBlindBaseline, StubBaselineError } from "../../src/stages/04-novelty/baseline";
import { renderPatternFile } from "../../src/stages/05-compiler/render-pattern";
import type { VerifiedPattern } from "../../src/schemas/novelty";

describe("Sprint Regression Tests", () => {
  test("1. Python package-absolute and relative import fanIn resolution in monorepo", async () => {
    const files: DiscoveredFile[] = [
      {
        relPath: "packages/core/src/coa_core/models.py",
        absPath: "/tmp/packages/core/src/coa_core/models.py",
        language: "python",
        isTest: false,
        loc: 10,
        content: "class DomainModel:\n    pass\n",
      },
      {
        relPath: "packages/core/src/coa_core/sub/helper.py",
        absPath: "/tmp/packages/core/src/coa_core/sub/helper.py",
        language: "python",
        isTest: false,
        loc: 5,
        content: "from ..models import DomainModel\ndef run(): pass\n",
      },
      {
        relPath: "packages/service/src/coa_svc/router.py",
        absPath: "/tmp/packages/service/src/coa_svc/router.py",
        language: "python",
        isTest: false,
        loc: 5,
        content: "from coa_core.models import DomainModel\ndef handle(): pass\n",
      },
    ];

    const res = await extractCoreArchitectureFiles({ files, maxFiles: 10, tokenBudget: 20_000 });
    const models = res.selected.find((f) => f.path.endsWith("models.py"));
    expect(models).toBeDefined();
    expect(models!.fanIn).toBe(2);
  });

  test("2. TypeScript workspace alias resolution and i18n dictionary penalty", async () => {
    const dir = mkdtempSync(join(tmpdir(), "distill-ts-reg-"));
    try {
      mkdirSync(join(dir, "packages/core/src"), { recursive: true });
      mkdirSync(join(dir, "apps/web/src/i18n"), { recursive: true });
      writeFileSync(
        join(dir, "tsconfig.json"),
        JSON.stringify({ compilerOptions: { paths: { "@web/*": ["apps/web/src/*"] } } }),
      );
      writeFileSync(join(dir, "packages/core/package.json"), JSON.stringify({ name: "@acme/core" }));

      const dictLines = Array.from({ length: 20 }, (_, i) => `  key_${i}: "Static UI label ${i}",`).join("\n");
      const files: DiscoveredFile[] = [
        {
          relPath: "packages/core/src/index.ts",
          absPath: join(dir, "packages/core/src/index.ts"),
          language: "typescript",
          isTest: false,
          loc: 10,
          content: "export class CoreEngine { run() {} }\n",
        },
        {
          relPath: "apps/web/src/i18n/appMessages.ts",
          absPath: join(dir, "apps/web/src/i18n/appMessages.ts"),
          language: "typescript",
          isTest: false,
          loc: 22,
          content: `export const appMessages = {\n${dictLines}\n};\n`,
        },
        {
          relPath: "apps/web/src/app.ts",
          absPath: join(dir, "apps/web/src/app.ts"),
          language: "typescript",
          isTest: false,
          loc: 8,
          content: `import { CoreEngine } from "@acme/core";\nimport { appMessages } from "@web/i18n/appMessages";\nexport { CoreEngine, appMessages };\n`,
        },
      ];

      const res = await extractCoreArchitectureFiles({
        files,
        maxFiles: 10,
        tokenBudget: 20_000,
        analysisRoot: dir,
      });

      const core = res.selected.find((f) => f.path === "packages/core/src/index.ts");
      const i18n = res.selected.find((f) => f.path === "apps/web/src/i18n/appMessages.ts");
      expect(core).toBeDefined();
      expect(core!.fanIn).toBe(1);
      expect(i18n).toBeDefined();
      expect(i18n!.fanIn).toBe(1);
      expect(core!.score).toBeGreaterThan(i18n!.score);
    } finally {
      rmSync(dir, { recursive: true, force: true });
    }
  });

  test("3. baseline.ts retries stub (<60 tokens) and throws StubBaselineError if still stub", async () => {
    const budget = new BudgetLedger(1.0);
    const seenCaps: number[] = [];

    const stubThenGood = async (p: { maxOutputTokens: number }) => {
      seenCaps.push(p.maxOutputTokens);
      const text =
        p.maxOutputTokens === 1200
          ? "Too short."
          : "Here is a complete engineering baseline solution that handles input validation, state isolation, concurrency locking, error recovery, exponential backoff with jitter, dead-letter queuing, idempotency keys, and bounded retries across distributed workers in production systems with clear architectural invariants, explicit failure boundaries, and observability hooks so that callers remain safe under heavy concurrent load and partial network partitions.";
      return {
        text,
        cost: { stage: "novelty_baseline" as const, model: "test", inputTokens: 10, outputTokens: 80, costUsd: 0.001, durationMs: 1 },
      };
    };

    const ok = await generateBlindBaseline({
      primaryLanguage: "python",
      problemStatement: "Design a bounded retry queue",
      judgeModelId: "gcloud:gemini-2.5-flash",
      budget,
      llmCall: stubThenGood as never,
    });
    expect(seenCaps).toEqual([1200, 1600]);
    expect(ok.length).toBeGreaterThan(100);

    const alwaysStub = async () => ({
      text: "Short stub.",
      cost: { stage: "novelty_baseline" as const, model: "test", inputTokens: 10, outputTokens: 3, costUsd: 0.001, durationMs: 1 },
    });

    await expect(
      generateBlindBaseline({
        primaryLanguage: "python",
        problemStatement: "Design a bounded retry queue",
        judgeModelId: "gcloud:gemini-2.5-flash",
        budget,
        llmCall: alwaysStub as never,
      }),
    ).rejects.toThrow(StubBaselineError);
  });

  test("4. render-pattern.ts infers code fence language from citation filePath", () => {
    const vp: VerifiedPattern = {
      pattern: {
        id: "serialize-writes",
        title: "Serialize writes",
        category: "concurrency",
        maturityTag: "production_proven",
        evidenceStatus: "seen_explicit",
        problemStatement: "Parallel writes clobber shared revision.",
        naiveApproach: "Use Promise.all.",
        repoApproach: "Await sequentially.",
        tradeOffs: ["Higher latency"],
        whenToApply: ["Shared parent revision"],
        antiTriggers: ["Independent records", "Server-side CAS exists"],
        transferableRule: "Await sequential writes on shared revision.",
        citations: [
          {
            filePath: "packages/web-app/src/utils/run-sequential.ts",
            startLine: 1,
            endLine: 3,
            verbatimSnippet: "export async function runSequential() {\n  return [];\n}",
          },
        ],
      },
      groundingVerified: true,
      blindBaselineSummary: "Baseline summary",
      audit: {
        noveltyScore: 4,
        transferabilityScore: 4,
        antiTriggerQuality: "strict",
        verdict: "keep",
        reasoning: "Valid concurrency pattern.",
      },
    };

    const rendered = renderPatternFile(vp, "python");
    expect(rendered.markdown).toContain("```ts\nexport async function runSequential()");
    expect(rendered.markdown).not.toContain("```python");
  });
});
