import { afterAll, beforeAll, describe, expect, it } from "bun:test";
import { mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { groundCandidatePatterns } from "../../src/stages/03-miner/grounder";
import { GroundingFailureError, minePatterns } from "../../src/stages/03-miner/extract";
import { BudgetLedger } from "../../src/core/budget";
import type { CandidatePattern } from "../../src/schemas/pattern";
import type { SignalBundle } from "../../src/schemas/signal-bundle";

let fixtureDir: string;

beforeAll(() => {
  fixtureDir = mkdtempSync(join(tmpdir(), "distill-grounder-"));
  writeFileSync(
    join(fixtureDir, "ring.ts"),
    [
      "export class RingBuffer<T> {",
      "  private buf: Array<T | undefined>;",
      "  private head = 0;",
      "  private tail = 0;",
      "  constructor(private readonly cap: number) {",
      "    this.buf = new Array(cap);",
      "  }",
      "  push(item: T): boolean {",
      "    const next = (this.tail + 1) % this.cap;",
      "    if (next === this.head) return false;",
      "    this.buf[this.tail] = item;",
      "    this.tail = next;",
      "    return true;",
      "  }",
      "}",
    ].join("\n"),
  );
});

afterAll(() => {
  rmSync(fixtureDir, { recursive: true, force: true });
});

function makePattern(overrides: Partial<CandidatePattern>): CandidatePattern {
  return {
    id: "bounded-ring-buffer",
    title: "Fixed-Capacity Ring Buffer",
    category: "memory_performance",
    maturityTag: "production_proven",
    evidenceStatus: "inferred_from_code",
    problemStatement: "Unbounded queues cause OOM under slow consumers during traffic spikes.",
    naiveApproach: "Use Array.push and Array.shift which shifts elements in O(n) and grows unboundedly.",
    repoApproach: "Pre-allocates a fixed array with modular head/tail indices and returns false when full.",
    tradeOffs: ["Drops or rejects items when full", "Requires power-of-two or modulo wrap"],
    whenToApply: ["High-throughput producer/consumer queues with bounded memory"],
    antiTriggers: ["When every message must be persisted without backpressure", "Low-volume CRUD lists"],
    citations: [
      {
        filePath: "ring.ts",
        startLine: 8,
        endLine: 14,
        verbatimSnippet: [
          "  push(item: T): boolean {",
          "    const next = (this.tail + 1) % this.cap;",
          "    if (next === this.head) return false;",
          "    this.buf[this.tail] = item;",
          "    this.tail = next;",
          "    return true;",
          "  }",
        ].join("\n"),
      },
    ],
    transferableRule: "Use a fixed-capacity ring buffer with explicit backpressure return instead of unbounded Array.shift.",
    ...overrides,
  };
}

describe("groundCandidatePatterns", () => {
  it("passes exact verbatim citations", () => {
    const res = groundCandidatePatterns([makePattern({})], fixtureDir);
    expect(res.groundedPatterns).toHaveLength(1);
    expect(res.groundingFailures).toBe(0);
    expect(res.groundedPatterns[0]?.citations[0]?.startLine).toBe(8);
  });

  it("auto-corrects off-by-N line drift via sliding window", () => {
    const drifted = makePattern({
      citations: [
        {
          filePath: "ring.ts",
          startLine: 1,
          endLine: 7,
          verbatimSnippet: [
            "  push(item: T): boolean {",
            "    const next = (this.tail + 1) % this.cap;",
            "    if (next === this.head) return false;",
            "    this.buf[this.tail] = item;",
            "    this.tail = next;",
            "    return true;",
            "  }",
          ].join("\n"),
        },
      ],
    });
    const res = groundCandidatePatterns([drifted], fixtureDir);
    expect(res.groundedPatterns).toHaveLength(1);
    expect(res.groundedPatterns[0]?.citations[0]?.startLine).toBe(8);
    expect(res.groundedPatterns[0]?.citations[0]?.endLine).toBe(14);
  });

  it("drops patterns with fabricated snippets or path traversal", () => {
    const fake = makePattern({
      id: "fake-pattern",
      citations: [
        {
          filePath: "../../etc/passwd",
          startLine: 1,
          endLine: 3,
          verbatimSnippet: "root:x:0:0:root:/root:/bin/bash",
        },
      ],
    });
    const res = groundCandidatePatterns([fake], fixtureDir);
    expect(res.groundedPatterns).toHaveLength(0);
    expect(res.groundingFailures).toBe(1);
    expect(res.dropped[0]?.stage).toBe("grounder");
  });
});

function makeMockBundle(): SignalBundle {
  return {
    profile: {
      source: fixtureDir,
      repoName: "ring-repo",
      skillSlug: "ring-repo",
      commitSha: null,
      subpath: ".",
      analyzedAt: new Date().toISOString(),
      primaryLanguage: "typescript",
      languages: [{ language: "typescript", fileCount: 1, loc: 15, sharePercent: 100 }],
      totalFilesScanned: 1,
      skippedOversizedFiles: [],
      maturity: {
        classification: "production",
        hasCiWorkflows: false,
        hasBenchmarks: false,
        hasStrictTyping: true,
        testToSourceRatio: 0,
        experimentalMarkersPerKloc: 0,
      },
    },
    totalTokens: 100,
    files: [],
    commits: [],
  };
}

describe("minePatterns retry & GroundingFailureError", () => {
  it("retries once when >50% fail grounding and succeeds if retry passes", async () => {
    let calls = 0;
    let sawFeedback = false;

    const result = await minePatterns({
      bundle: makeMockBundle(),
      analysisRoot: fixtureDir,
      modelId: "anthropic:claude-sonnet-4-5",
      budget: new BudgetLedger(2.0),
      llmCall: (async (params) => {
        calls += 1;
        if (calls === 2 && params.prompt.includes("PREVIOUS EXTRACTION HAD GROUNDING ERRORS")) {
          sawFeedback = true;
        }
        const pattern =
          calls === 1
            ? makePattern({
                id: "bad-cite",
                citations: [
                  {
                    filePath: "missing.ts",
                    startLine: 1,
                    endLine: 5,
                    verbatimSnippet: "nonexistent code snippet in missing file",
                  },
                ],
              })
            : makePattern({});
        return {
          object: {
            repoDomainSummary: "Fixed-capacity ring buffer queue implementation.",
            operatingConstraints: ["Bounded heap allocation"],
            patterns: [pattern],
          },
          cost: {
            stage: "miner",
            model: "anthropic:claude-sonnet-4-5",
            inputTokens: 100,
            outputTokens: 100,
            costUsd: 0.001,
            durationMs: 10,
          },
        };
      }) as typeof import("../../src/core/llm").callStructuredLlm,
    });

    expect(calls).toBe(2);
    expect(sawFeedback).toBe(true);
    expect(result.groundedPatterns).toHaveLength(1);
  });

  it("throws GroundingFailureError when retry also fails >50%", async () => {
    await expect(
      minePatterns({
        bundle: makeMockBundle(),
        analysisRoot: fixtureDir,
        modelId: "anthropic:claude-sonnet-4-5",
        budget: new BudgetLedger(2.0),
        llmCall: (async () => ({
          object: {
            repoDomainSummary: "Fixed-capacity ring buffer queue implementation.",
            operatingConstraints: ["Bounded heap allocation"],
            patterns: [
              makePattern({
                id: "bad-cite",
                citations: [
                  {
                    filePath: "missing.ts",
                    startLine: 1,
                    endLine: 5,
                    verbatimSnippet: "nonexistent code snippet in missing file",
                  },
                ],
              }),
            ],
          },
          cost: {
            stage: "miner",
            model: "anthropic:claude-sonnet-4-5",
            inputTokens: 100,
            outputTokens: 100,
            costUsd: 0.001,
            durationMs: 10,
          },
        })) as typeof import("../../src/core/llm").callStructuredLlm,
      }),
    ).rejects.toThrow(GroundingFailureError);
  });
});
