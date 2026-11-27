import { describe, expect, test } from "bun:test";
import { mkdtempSync, mkdirSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { parseCliArgs } from "../../src/cli/args";
import { ingestRepository } from "../../src/stages/01-ingest";
import { extractCoreArchitectureFiles } from "../../src/stages/02-signals/ast-graph";
import { renderPatternFile } from "../../src/stages/05-compiler/render-pattern";
import {
  buildCloneArgs,
  buildCloneEnv,
  computeSignalDensityScore,
  filterOrgRepos,
} from "../../src/stages/org-scan/scanner";
import type { VerifiedPattern } from "../../src/schemas/novelty";
import type { GitHubRepoSummary } from "../../src/schemas/org-scan";
import type { SignalBundle } from "../../src/schemas/signal-bundle";

describe("Phase 1A: CUDA & Python ML/Systems AST scoring", () => {
  test("ingests .cu/.cuh files, scores CUDA craftsmanship, and renders cuda code fences", async () => {
    const dir = mkdtempSync(join(tmpdir(), "distill-cuda-test-"));
    try {
      mkdirSync(join(dir, "src"), { recursive: true });
      writeFileSync(
        join(dir, "src/kernel.cuh"),
        `#pragma once
template <int BLOCK_SIZE>
__device__ __forceinline__ float warp_reduce(float val) {
  for (int offset = 16; offset > 0; offset /= 2) {
    val += __shfl_sync(0xffffffff, val, offset);
  }
  return val;
}
`,
      );
      writeFileSync(
        join(dir, "src/fused_gemm.cu"),
        `#include "kernel.cuh"
__global__ void __launch_bounds__(256) fused_gemm_kernel(float* out, const float* in) {
  __shared__ float tile[256];
  int tid = threadIdx.x;
  tile[tid] = in[blockIdx.x * blockDim.x + tid];
  __syncthreads();
  float sum = warp_reduce<256>(tile[tid]);
  if (tid == 0) out[blockIdx.x] = sum;
}
void launch(float* out, const float* in, cudaStream_t stream) {
  cudaMemcpyAsync(out, in, 1024, cudaMemcpyDeviceToDevice, stream);
  fused_gemm_kernel<<<16, 256, 0, stream>>>(out, in);
}
`,
      );
      writeFileSync(
        join(dir, "src/plain.cpp"),
        `int add(int a, int b) {
  return a + b;
}
`,
      );

      const ingest = await ingestRepository({
        source: dir,
        subpath: ".",
        gitDepth: 50,
        noGit: true,
      });

      expect(ingest.profile.primaryLanguage).toBe("cuda");
      expect(ingest.profile.maturity.hasStrictTyping).toBe(true);

      const { selected } = await extractCoreArchitectureFiles({
        files: ingest.files,
        maxFiles: 5,
        tokenBudget: 10_000,
        analysisRoot: ingest.analysisRoot,
      });

      const cuFile = selected.find((f) => f.path === "src/fused_gemm.cu");
      const cuhFile = selected.find((f) => f.path === "src/kernel.cuh");
      const plainFile = selected.find((f) => f.path === "src/plain.cpp");

      expect(cuFile).toBeDefined();
      expect(cuhFile).toBeDefined();
      expect(cuhFile!.fanIn).toBe(1);
      expect(cuFile!.score).toBeGreaterThan(plainFile?.score ?? 0);

      const vp: VerifiedPattern = {
        pattern: {
          id: "cuda-warp-reduce",
          title: "Warp-Shuffle Reduction Kernel",
          category: "memory_performance",
          problemStatement: "Shared memory reductions stall on barrier sync.",
          naiveApproach: "Use __syncthreads() at every tree level.",
          repoApproach: "Use __shfl_sync() within warps before shared memory.",
          transferableRule: "Prefer warp-level __shfl_sync() before falling back to shared memory barriers.",
          tradeOffs: ["Requires CUDA compute capability >= 3.0"],
          whenToApply: ["Writing reduction kernels"],
          antiTriggers: ["Non-warp-uniform control flow"],
          evidenceStatus: "seen_explicit",
          maturityTag: "production_proven",
          citations: [
            {
              filePath: "src/fused_gemm.cu",
              startLine: 2,
              endLine: 4,
              verbatimSnippet: "__global__ void __launch_bounds__(256) fused_gemm_kernel(float* out, const float* in) {",
            },
          ],
        },
        groundingVerified: true,
        blindBaselineSummary: "Baseline",
        audit: {
          noveltyScore: 4,
          transferabilityScore: 4,
          antiTriggerQuality: "strict",
          verdict: "keep",
          reasoning: "Specific kernel optimization.",
        },
      };

      const { markdown } = renderPatternFile(vp, "cuda");
      expect(markdown).toContain("```cuda\n");
    } finally {
      rmSync(dir, { recursive: true, force: true });
    }
  });

  test("boosts Python craftDensity for Triton, PyTorch, JAX, and systems primitives", async () => {
    const dir = mkdtempSync(join(tmpdir(), "distill-py-ml-test-"));
    try {
      mkdirSync(join(dir, "pkg"), { recursive: true });
      writeFileSync(
        join(dir, "pkg/triton_kernel.py"),
        `import triton
import triton.language as tl
import torch
import jax
import mmap
import asyncio

@triton.autotune(configs=[], key=["N"])
@triton.jit
def fused_add_kernel(x_ptr, y_ptr, out_ptr, N):
    x = tl.load(x_ptr)
    y = tl.load(y_ptr)
    tl.store(out_ptr, x + y)

@torch.library.custom_op("myops::fused", mutates_args=())
def fused_op(x: torch.Tensor) -> torch.Tensor:
    return torch.compile(lambda t: t + 1)(x)

def jax_step(xs):
    return jax.jit(jax.vmap(lambda x: jax.lax.scan(lambda c, v: (c + v, c), 0, x)))(xs)

lock = asyncio.Lock()
`,
      );
      writeFileSync(
        join(dir, "pkg/plain_helper.py"),
        `def greet(name: str) -> str:
    return f"hello {name}"

def add(a: int, b: int) -> int:
    return a + b
`,
      );

      const ingest = await ingestRepository({
        source: dir,
        subpath: ".",
        gitDepth: 50,
        noGit: true,
      });

      const { selected } = await extractCoreArchitectureFiles({
        files: ingest.files,
        maxFiles: 5,
        tokenBudget: 10_000,
        analysisRoot: ingest.analysisRoot,
      });

      const mlFile = selected.find((f) => f.path === "pkg/triton_kernel.py");
      const plainFile = selected.find((f) => f.path === "pkg/plain_helper.py");
      expect(mlFile).toBeDefined();
      expect(plainFile).toBeDefined();
      expect(mlFile!.score).toBeGreaterThan(plainFile!.score + 10);
    } finally {
      rmSync(dir, { recursive: true, force: true });
    }
  });
});

describe("Phase 1B: scan-org CLI, filtering, cloning safety, and ranking", () => {
  test("parses scan-org subcommand options", () => {
    const parsed = parseCliArgs([
      "bun",
      "distill-anything",
      "scan-org",
      "NVIDIA",
      "--limit",
      "15",
      "--lang",
      "cuda",
      "--min-stars",
      "100",
      "--include-forks",
      "--concurrency",
      "4",
      "--out",
      "nvidia.json",
      "--json",
    ]);

    expect(parsed.mode).toBe("scan-org");
    if (parsed.mode === "scan-org") {
      expect(parsed.org).toBe("NVIDIA");
      expect(parsed.limit).toBe(15);
      expect(parsed.lang).toBe("cuda");
      expect(parsed.minStars).toBe(100);
      expect(parsed.includeForks).toBe(true);
      expect(parsed.includeArchived).toBe(false);
      expect(parsed.concurrency).toBe(4);
      expect(parsed.out).toBe("nvidia.json");
      expect(parsed.json).toBe(true);
    }
  });

  test("filterOrgRepos applies stars, fork, archived, lang, and limit before cloning", () => {
    const repos: GitHubRepoSummary[] = [
      {
        name: "forked-repo",
        full_name: "org/forked-repo",
        html_url: "https://github.com/org/forked-repo",
        clone_url: "https://github.com/org/forked-repo.git",
        language: "Python",
        stargazers_count: 500,
        fork: true,
        archived: false,
      },
      {
        name: "archived-repo",
        full_name: "org/archived-repo",
        html_url: "https://github.com/org/archived-repo",
        clone_url: "https://github.com/org/archived-repo.git",
        language: "Python",
        stargazers_count: 500,
        fork: false,
        archived: true,
      },
      {
        name: "low-stars",
        full_name: "org/low-stars",
        html_url: "https://github.com/org/low-stars",
        clone_url: "https://github.com/org/low-stars.git",
        language: "C++",
        stargazers_count: 10,
        fork: false,
        archived: false,
      },
      {
        name: "cpp-engine",
        full_name: "org/cpp-engine",
        html_url: "https://github.com/org/cpp-engine",
        clone_url: "https://github.com/org/cpp-engine.git",
        language: "C++",
        stargazers_count: 250,
        fork: false,
        archived: false,
      },
      {
        name: "py-lib",
        full_name: "org/py-lib",
        html_url: "https://github.com/org/py-lib",
        clone_url: "https://github.com/org/py-lib.git",
        language: "Python",
        stargazers_count: 300,
        fork: false,
        archived: false,
      },
    ];

    const filtered = filterOrgRepos(repos, {
      limit: 10,
      lang: "cpp",
      minStars: 50,
      includeForks: false,
      includeArchived: false,
    });
    expect(filtered.map((r) => r.name)).toEqual(["cpp-engine"]);

    const allNonFork = filterOrgRepos(repos, {
      limit: 1,
      minStars: 50,
      includeForks: false,
      includeArchived: true,
    });
    expect(allNonFork.map((r) => r.name)).toEqual(["archived-repo"]);

    const withSizeCap = filterOrgRepos(
      [
        ...repos,
        {
          name: "huge-weights",
          full_name: "org/huge-weights",
          html_url: "https://github.com/org/huge-weights",
          clone_url: "https://github.com/org/huge-weights.git",
          language: "Python",
          stargazers_count: 900,
          fork: false,
          archived: false,
          size: 200 * 1024,
        },
      ],
      {
        limit: 10,
        minStars: 50,
        maxSizeMb: 150,
        includeForks: false,
        includeArchived: false,
      },
    );
    expect(withSizeCap.map((r) => r.name)).not.toContain("huge-weights");
  });

  test("buildCloneArgs & buildCloneEnv enforce GIT_LFS_SKIP_SMUDGE=1 and shallow single-branch clone", () => {
    const args = buildCloneArgs("https://github.com/org/repo.git", "/tmp/dest");
    expect(args).toEqual(["clone", "--depth", "25", "--no-tags", "--single-branch", "https://github.com/org/repo.git", "/tmp/dest"]);
    const env = buildCloneEnv();
    expect(env.GIT_LFS_SKIP_SMUDGE).toBe("1");
    expect(env.GIT_TERMINAL_PROMPT).toBe("0");
  });

  test("computeSignalDensityScore ranks focused high-craft engine above massive boilerplate repo", () => {
    const focusedBundle: SignalBundle = {
      profile: {
        source: "https://github.com/org/focused",
        repoName: "focused",
        skillSlug: "focused",
        commitSha: "abc1234",
        subpath: ".",
        analyzedAt: new Date().toISOString(),
        primaryLanguage: "cuda",
        languages: [{ language: "cuda", fileCount: 12, loc: 2400, sharePercent: 100 }],
        totalFilesScanned: 24,
        skippedOversizedFiles: [],
        maturity: {
          classification: "production",
          hasCiWorkflows: true,
          hasBenchmarks: true,
          hasStrictTyping: true,
          testToSourceRatio: 0.5,
          experimentalMarkersPerKloc: 1.0,
        },
      },
      totalTokens: 12000,
      files: [
        {
          path: "src/kernel.cu",
          bucket: "core_architecture",
          language: "cuda",
          score: 24.5,
          fanIn: 6,
          tokenCount: 1500,
          truncated: false,
          numberedContent: "0001 | __global__ void k() {}",
        },
      ],
      commits: [
        {
          sha: "1111111",
          subject: "perf: warp shuffle reduction",
          body: "",
          date: "2026-01-01",
          score: 10,
          tokenCount: 500,
          diff: "+__shfl_sync",
        },
      ],
    };

    const massiveBoilerplateBundle: SignalBundle = {
      ...focusedBundle,
      profile: {
        ...focusedBundle.profile,
        repoName: "monorepo",
        totalFilesScanned: 2500,
        maturity: {
          ...focusedBundle.profile.maturity,
          hasBenchmarks: false,
          hasStrictTyping: false,
          testToSourceRatio: 0.05,
        },
      },
      files: [
        {
          path: "src/index.ts",
          bucket: "core_architecture",
          language: "typescript",
          score: 10.0,
          fanIn: 1,
          tokenCount: 800,
          truncated: false,
          numberedContent: "0001 | export const x = 1;",
        },
      ],
      commits: [],
    };

    const focusedScore = computeSignalDensityScore(focusedBundle);
    const monorepoScore = computeSignalDensityScore(massiveBoilerplateBundle);
    expect(focusedScore).toBeGreaterThan(monorepoScore);
  });
});
