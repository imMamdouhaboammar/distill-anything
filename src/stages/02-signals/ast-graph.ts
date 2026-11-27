import { existsSync, readdirSync, readFileSync } from "node:fs";
import { dirname, join, normalize, resolve } from "node:path";
import Parser, { type SyntaxNode } from "web-tree-sitter";
import type { DiscoveredFile } from "../01-ingest";
import type { SignalFile } from "../../schemas/signal-bundle";
import { countTokens, formatNumberedLines, truncateToTokens } from "../../core/tokens";

function resolveGrammarPath(wasmFile: string): string | null {
  const candidates = [
    resolve(import.meta.dir, "../../../grammars", wasmFile),
    resolve(dirname(process.execPath), "grammars", wasmFile),
    resolve(process.cwd(), "grammars", wasmFile),
    resolve(process.cwd(), "node_modules/tree-sitter-wasms/out", wasmFile),
  ];
  for (const candidate of candidates) {
    if (existsSync(candidate)) return candidate;
  }
  return null;
}

const LANG_TO_WASM: Record<string, string> = {
  typescript: "tree-sitter-typescript.wasm",
  tsx: "tree-sitter-tsx.wasm",
  javascript: "tree-sitter-javascript.wasm",
  python: "tree-sitter-python.wasm",
  rust: "tree-sitter-rust.wasm",
  go: "tree-sitter-go.wasm",
  cpp: "tree-sitter-cpp.wasm",
};

let parserInitialized = false;
const languageCache = new Map<string, Parser.Language>();

async function ensureParserInit(): Promise<void> {
  if (!parserInitialized) {
    await Parser.init();
    parserInitialized = true;
  }
}

async function getLanguage(lang: string): Promise<Parser.Language | null> {
  const wasmFile = LANG_TO_WASM[lang];
  if (!wasmFile) return null;
  const cached = languageCache.get(lang);
  if (cached) return cached;

  const wasmPath = resolveGrammarPath(wasmFile);
  if (!wasmPath) return null;

  await ensureParserInit();
  const loaded = await Parser.Language.load(wasmPath);
  languageCache.set(lang, loaded);
  return loaded;
}

const CRAFT_KEYWORDS: Record<string, RegExp> = {
  rust: /\b(unsafe|macro_rules!|Pin|Unpin|Send|Sync|Atomic[A-Z]\w*|Mutex|RwLock|Arc|NonNull|ManuallyDrop)\b/g,
  typescript: /\b(Proxy|Worker|SharedArrayBuffer|AbortController|WeakMap|WeakRef|FinalizationRegistry|extends Error)\b/g,
  tsx: /\b(Proxy|Worker|SharedArrayBuffer|AbortController|WeakMap|WeakRef|extends Error)\b/g,
  javascript: /\b(Proxy|Worker|SharedArrayBuffer|AbortController|WeakMap|WeakRef|Atomics)\b/g,
  python: /\b(__slots__|metaclass|asyncio|ctypes|cffi|triton|autograd\.Function|__enter__|__exit__|contextmanager)\b/g,
  go: /\b(sync\.Pool|atomic\.|chan\b|select\s*\{|unsafe\.Pointer|sync\.Mutex|sync\.RWMutex)\b/g,
  cpp: /\b(template\s*<|std::atomic|mmap|__m128|__m256|alignas|std::unique_lock|allocator)\b/g,
};

const CRAFT_NODE_TYPES = new Set([
  "unsafe_block",
  "macro_definition",
  "trait_item",
  "impl_item",
  "type_parameter",
  "type_parameters",
  "generic_type",
  "template_declaration",
  "select_statement",
  "go_statement",
  "with_statement",
]);

const EXPORT_TYPE_NODES = new Set([
  "interface_declaration",
  "type_alias_declaration",
  "class_declaration",
  "struct_item",
  "enum_item",
  "trait_item",
  "type_declaration",
  "class_definition",
  "class_specifier",
  "struct_specifier",
]);

function extractImportsFromText(content: string, language: string): string[] {
  const specs: string[] = [];
  if (["typescript", "tsx", "javascript"].includes(language)) {
    const re = /(?:from|import|require\()\s*['"]([^'"]+)['"]/g;
    for (const m of content.matchAll(re)) {
      if (m[1]) specs.push(m[1]);
    }
  } else if (language === "python") {
    const fromRe = /^\s*from\s+(\.+[\w.]*|[a-zA-Z_][\w.]*)\s+import\b/gm;
    for (const m of content.matchAll(fromRe)) {
      if (m[1]) specs.push(m[1]);
    }
    const impRe = /^\s*import\s+([a-zA-Z_][\w.]*(?:\s*,\s*[a-zA-Z_][\w.]*)*)/gm;
    for (const m of content.matchAll(impRe)) {
      if (m[1]) {
        for (const part of m[1].split(",")) {
          const mod = part.trim().split(/\s+as\s+/)[0]?.trim();
          if (mod) specs.push(mod);
        }
      }
    }
  } else if (language === "cpp") {
    const re = /^\s*#include\s+"([^"]+)"/gm;
    for (const m of content.matchAll(re)) {
      if (m[1]) specs.push(m[1]);
    }
  } else if (language === "rust") {
    const modRe = /^\s*(?:pub\s+)?mod\s+(\w+)\s*;/gm;
    for (const m of content.matchAll(modRe)) {
      if (m[1]) specs.push(`./${m[1]}`);
    }
    const useRe = /^\s*(?:pub\s+)?use\s+((?:crate|super|self)::[\w:]+)/gm;
    for (const m of content.matchAll(useRe)) {
      if (m[1]) specs.push(m[1]);
    }
  } else if (language === "go") {
    const singleRe = /^\s*import\s+"([^"]+)"/gm;
    for (const m of content.matchAll(singleRe)) {
      if (m[1]) specs.push(m[1]);
    }
    const blockRe = /import\s*\(([\s\S]*?)\)/g;
    for (const m of content.matchAll(blockRe)) {
      const inner = m[1] ?? "";
      for (const line of inner.split("\n")) {
        const str = line.match(/"([^"]+)"/)?.[1];
        if (str) specs.push(str);
      }
    }
  }
  return specs;
}

interface WorkspaceResolverContext {
  knownPaths: Set<string>;
  pythonModuleMap: Map<string, string>;
  tsPathAliases: Array<{ prefix: string; targetPrefix: string }>;
  tsWorkspacePackages: Map<string, string>;
  goModuleName: string | null;
  goDirToFile: Map<string, string>;
}

function buildWorkspaceContext(knownPaths: Set<string>, analysisRoot?: string): WorkspaceResolverContext {
  const pythonModuleMap = new Map<string, string>();
  const goDirToFile = new Map<string, string>();

  for (const p of knownPaths) {
    if (p.endsWith(".py")) {
      // Index both full path and path stripped of any ".../src/" or "src/" prefix
      const strippedSrc = p.replace(/^(?:.+?\/)?src\//, "");
      for (const rel of [p, strippedSrc]) {
        const mod = rel
          .replace(/\/__init__\.py$/, "")
          .replace(/\.py$/, "")
          .replace(/\//g, ".");
        if (mod && !pythonModuleMap.has(mod)) {
          pythonModuleMap.set(mod, p);
        }
      }
    } else if (p.endsWith(".go") && !p.endsWith("_test.go")) {
      const dir = dirname(p);
      if (!goDirToFile.has(dir)) goDirToFile.set(dir, p);
    }
  }

  const tsPathAliases: Array<{ prefix: string; targetPrefix: string }> = [];
  const tsWorkspacePackages = new Map<string, string>();
  let goModuleName: string | null = null;

  if (analysisRoot) {
    const tsconfigPath = join(analysisRoot, "tsconfig.json");
    if (existsSync(tsconfigPath)) {
      try {
        const raw = readFileSync(tsconfigPath, "utf8").replace(/\/\*[\s\S]*?\*\//g, "").replace(/^\s*\/\/.*$/gm, "");
        const parsed = JSON.parse(raw) as { compilerOptions?: { paths?: Record<string, string[]> } };
        const paths = parsed.compilerOptions?.paths ?? {};
        for (const [alias, targets] of Object.entries(paths)) {
          const target = targets[0];
          if (!target) continue;
          tsPathAliases.push({
            prefix: alias.replace(/\*$/, ""),
            targetPrefix: target.replace(/^\.\//, "").replace(/\*$/, ""),
          });
        }
      } catch {
        // Ignore malformed tsconfig
      }
    }

    for (const group of ["packages", "libs", "apps"]) {
      const groupDir = join(analysisRoot, group);
      if (!existsSync(groupDir)) continue;
      try {
        for (const entry of readdirSync(groupDir, { withFileTypes: true })) {
          if (!entry.isDirectory()) continue;
          const pkgJson = join(groupDir, entry.name, "package.json");
          if (!existsSync(pkgJson)) continue;
          try {
            const pkg = JSON.parse(readFileSync(pkgJson, "utf8")) as { name?: string };
            if (pkg.name) {
              tsWorkspacePackages.set(pkg.name, `${group}/${entry.name}`);
            }
          } catch {
            // Ignore malformed package.json
          }
        }
      } catch {
        // Ignore unreadable dirs
      }
    }

    const goModPath = join(analysisRoot, "go.mod");
    if (existsSync(goModPath)) {
      try {
        const modMatch = readFileSync(goModPath, "utf8").match(/^\s*module\s+(\S+)/m);
        if (modMatch?.[1]) goModuleName = modMatch[1];
      } catch {
        // Ignore
      }
    }
  }

  return { knownPaths, pythonModuleMap, tsPathAliases, tsWorkspacePackages, goModuleName, goDirToFile };
}

function probeTsCandidates(base: string, knownPaths: Set<string>): string | null {
  const clean = normalize(base).replace(/\\/g, "/");
  for (const c of [
    clean,
    `${clean}.ts`,
    `${clean}.tsx`,
    `${clean}.js`,
    `${clean}.jsx`,
    `${clean}/index.ts`,
    `${clean}/index.tsx`,
    `${clean}/index.js`,
  ]) {
    if (knownPaths.has(c)) return c;
  }
  return null;
}

function resolveInternalImport(
  fromRelPath: string,
  spec: string,
  language: string,
  ctx: WorkspaceResolverContext,
): string | null {
  const { knownPaths } = ctx;

  if (language === "python") {
    if (spec.startsWith(".")) {
      const dots = spec.match(/^(\.+)/)?.[1]?.length ?? 1;
      const rest = spec.slice(dots).replace(/\./g, "/");
      let baseDir = dirname(fromRelPath);
      for (let i = 1; i < dots; i++) {
        baseDir = dirname(baseDir);
      }
      const targetBase = rest ? (baseDir === "." ? rest : `${baseDir}/${rest}`) : baseDir;
      for (const c of [`${targetBase}.py`, `${targetBase}/__init__.py`]) {
        const norm = normalize(c).replace(/\\/g, "/");
        if (knownPaths.has(norm)) return norm;
      }
      return null;
    }
    return ctx.pythonModuleMap.get(spec) ?? null;
  }

  if (language === "rust") {
    if (spec.startsWith("crate::") || spec.startsWith("super::") || spec.startsWith("self::")) {
      const parts = spec.split("::");
      const kind = parts[0];
      const modParts = parts.slice(1);
      let baseDir = dirname(fromRelPath);
      if (kind === "crate") {
        const srcIdx = fromRelPath.indexOf("src/");
        baseDir = srcIdx >= 0 ? fromRelPath.slice(0, srcIdx + 3) : "src";
      } else if (kind === "super") {
        baseDir = dirname(baseDir);
      }
      // Try full path or parent module (in case last segment is an item name)
      for (const sliceLen of [modParts.length, Math.max(0, modParts.length - 1)]) {
        if (sliceLen === 0) continue;
        const sub = modParts.slice(0, sliceLen).join("/");
        for (const c of [`${baseDir}/${sub}.rs`, `${baseDir}/${sub}/mod.rs`]) {
          const norm = normalize(c).replace(/\\/g, "/");
          if (knownPaths.has(norm)) return norm;
        }
      }
      return null;
    }
  }

  if (language === "go" && ctx.goModuleName && spec.startsWith(ctx.goModuleName)) {
    const sub = spec.slice(ctx.goModuleName.length).replace(/^\//, "") || ".";
    return ctx.goDirToFile.get(sub) ?? null;
  }

  if (["typescript", "tsx", "javascript"].includes(language)) {
    if (spec.startsWith(".")) {
      return probeTsCandidates(join(dirname(fromRelPath), spec), knownPaths);
    }
    for (const alias of ctx.tsPathAliases) {
      if (spec.startsWith(alias.prefix)) {
        const mapped = `${alias.targetPrefix}${spec.slice(alias.prefix.length)}`;
        const hit = probeTsCandidates(mapped, knownPaths);
        if (hit) return hit;
      }
    }
    for (const [pkgName, pkgDir] of ctx.tsWorkspacePackages) {
      if (spec === pkgName) {
        return probeTsCandidates(`${pkgDir}/src/index`, knownPaths) ?? probeTsCandidates(`${pkgDir}/index`, knownPaths);
      }
      if (spec.startsWith(`${pkgName}/`)) {
        const sub = spec.slice(pkgName.length + 1);
        return probeTsCandidates(`${pkgDir}/src/${sub}`, knownPaths) ?? probeTsCandidates(`${pkgDir}/${sub}`, knownPaths);
      }
    }
    return null;
  }

  const baseDir = dirname(fromRelPath);
  const rawJoined = normalize(join(baseDir, spec)).replace(/\\/g, "/");
  for (const c of [rawJoined, `${rawJoined}.hpp`, `${rawJoined}.h`, `${rawJoined}.rs`, `${rawJoined}/mod.rs`]) {
    if (knownPaths.has(c)) return c;
  }
  return null;
}

function inspectAst(root: SyntaxNode): { craftNodes: number; exportedTypes: number } {
  let craftNodes = 0;
  let exportedTypes = 0;
  const stack: SyntaxNode[] = [root];
  while (stack.length > 0) {
    const node = stack.pop()!;
    if (CRAFT_NODE_TYPES.has(node.type)) craftNodes += 1;
    if (EXPORT_TYPE_NODES.has(node.type)) exportedTypes += 1;
    for (let i = 0; i < node.namedChildCount; i++) {
      const child = node.namedChild(i);
      if (child) stack.push(child);
    }
  }
  return { craftNodes, exportedTypes };
}

function smartTruncateFile(content: string, maxTokens: number): { numbered: string; truncated: boolean } {
  const fullNumbered = formatNumberedLines(content);
  if (countTokens(fullNumbered) <= maxTokens) {
    return { numbered: fullNumbered, truncated: false };
  }

  const lines = content.replace(/\r\n/g, "\n").split("\n");
  const width = Math.max(4, String(lines.length).length);
  const keepIndices = new Set<number>();

  // Keep file header (first 40 lines)
  for (let i = 0; i < Math.min(40, lines.length); i++) keepIndices.add(i);

  // Keep type/interface/struct/class/trait signatures and 5 lines of context
  for (let i = 0; i < lines.length; i++) {
    const line = lines[i] ?? "";
    if (/^\s*(export\s+)?(interface|type|class|struct|trait|enum|impl|def|fn|func|template)\b/.test(line)) {
      for (let j = i; j < Math.min(lines.length, i + 6); j++) {
        keepIndices.add(j);
      }
    }
  }

  const out: string[] = [];
  let elidingFrom: number | null = null;

  for (let i = 0; i < lines.length; i++) {
    if (keepIndices.has(i)) {
      if (elidingFrom !== null) {
        out.push(`/* [elided lines ${elidingFrom}-${i}] */`);
        elidingFrom = null;
      }
      out.push(`${String(i + 1).padStart(width, "0")} | ${lines[i]}`);
    } else if (elidingFrom === null) {
      elidingFrom = i + 1;
    }
  }
  if (elidingFrom !== null) {
    out.push(`/* [elided lines ${elidingFrom}-${lines.length}] */`);
  }

  const joined = out.join("\n");
  const finalTrunc = truncateToTokens(joined, maxTokens);
  return { numbered: finalTrunc.text, truncated: true };
}

/** Builds AST & dependency fan-in graph and selects top core architecture files. */
export async function extractCoreArchitectureFiles(params: {
  files: DiscoveredFile[];
  maxFiles: number;
  tokenBudget: number;
  analysisRoot?: string;
}): Promise<{ selected: SignalFile[]; coreFilePaths: Set<string> }> {
  const sourceFiles = params.files.filter((f) => !f.isTest && f.language !== "markdown");
  if (sourceFiles.length === 0 || params.maxFiles <= 0 || params.tokenBudget <= 0) {
    return { selected: [], coreFilePaths: new Set() };
  }

  const knownPaths = new Set(sourceFiles.map((f) => f.relPath));
  const resolverCtx = buildWorkspaceContext(knownPaths, params.analysisRoot);
  const fanInCount = new Map<string, number>();

  for (const f of sourceFiles) {
    const specs = extractImportsFromText(f.content, f.language);
    const seenTargets = new Set<string>();
    for (const spec of specs) {
      const target = resolveInternalImport(f.relPath, spec, f.language, resolverCtx);
      if (target && target !== f.relPath && !seenTargets.has(target)) {
        seenTargets.add(target);
        fanInCount.set(target, (fanInCount.get(target) ?? 0) + 1);
      }
    }
  }

  await ensureParserInit();
  const parser = new Parser();
  const scored: Array<{ file: DiscoveredFile; score: number; fanIn: number }> = [];

  for (const f of sourceFiles) {
    let craftNodes = 0;
    let exportedTypes = 0;

    const lang = await getLanguage(f.language);
    if (lang) {
      parser.setLanguage(lang);
      const tree = parser.parse(f.content);
      if (tree) {
        const stats = inspectAst(tree.rootNode);
        craftNodes += stats.craftNodes;
        exportedTypes += stats.exportedTypes;
        tree.delete();
      }
    }

    const regex = CRAFT_KEYWORDS[f.language];
    if (regex) {
      craftNodes += f.content.match(regex)?.length ?? 0;
    }

    const fanIn = fanInCount.get(f.relPath) ?? 0;
    const craftDensity = f.loc > 0 ? (craftNodes / f.loc) * 100 : 0;

    let boilerplatePenalty = 0;
    const nonEmptyLines = f.content.split("\n").filter((l) => l.trim().length > 0);
    const reExportLines = nonEmptyLines.filter((l) => /^\s*export\s+(\*|\{[^}]+\})\s+from\b/.test(l)).length;
    if (nonEmptyLines.length > 0 && reExportLines / nonEmptyLines.length > 0.6) {
      boilerplatePenalty = 4.0;
    }

    const isI18nPath =
      /(^|\/)(i18n|locales?|translations?)\//i.test(f.relPath) ||
      /(messages|strings|translations|i18n)\.(ts|tsx|js|jsx|py)$/i.test(f.relPath);
    const stringDictLines = nonEmptyLines.filter((l) => /^\s*['"\w.-]+\s*:\s*['"`]/.test(l)).length;
    const isStringDictHeavy = nonEmptyLines.length >= 15 && stringDictLines / nonEmptyLines.length > 0.65;
    if (isI18nPath || isStringDictHeavy) {
      boilerplatePenalty = Math.max(boilerplatePenalty, 30.0);
    }

    const score =
      3.0 * Math.log(1 + fanIn) +
      2.0 * Math.min(craftDensity, 10) +
      1.5 * Math.log(1 + exportedTypes) -
      0.5 * boilerplatePenalty;

    scored.push({ file: f, score, fanIn });
  }

  scored.sort((a, b) => b.score - a.score);

  const selected: SignalFile[] = [];
  const coreFilePaths = new Set<string>();
  let usedTokens = 0;

  for (const item of scored) {
    if (selected.length >= params.maxFiles) break;
    const remaining = params.tokenBudget - usedTokens;
    if (remaining < 300) break;

    const perFileCap = Math.min(remaining, 4000);
    const { numbered, truncated } = smartTruncateFile(item.file.content, perFileCap);
    const tokenCount = countTokens(numbered);
    if (tokenCount <= 0) continue;

    selected.push({
      path: item.file.relPath,
      bucket: "core_architecture",
      language: item.file.language,
      score: item.score,
      fanIn: item.fanIn,
      tokenCount,
      truncated,
      numberedContent: numbered,
    });
    coreFilePaths.add(item.file.relPath);
    usedTokens += tokenCount;
  }

  return { selected, coreFilePaths };
}
