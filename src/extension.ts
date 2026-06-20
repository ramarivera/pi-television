import { readFile } from "node:fs/promises";
import { homedir } from "node:os";
import { basename, dirname, relative, resolve } from "node:path";
import type {
  ExtensionAPI,
  ExtensionContext,
  TerminalInputHandler,
} from "@earendil-works/pi-coding-agent";
import type {
  AutocompleteItem,
  AutocompleteProvider,
} from "@earendil-works/pi-tui";
import {
  decodeKittyPrintable,
  fuzzyMatch,
  Key,
  matchesKey,
} from "@earendil-works/pi-tui";

export type ExtensionInfo = {
  name: string;
  description: string;
};

export type TelevisionPickResult =
  | { status: "selected"; path: string }
  | { status: "cancelled" }
  | { status: "failed"; message: string };

export type TelevisionMode = "native-live" | "select-dialog";

export type TelevisionConfig = {
  mode?: TelevisionMode;
  maxResults?: number;
  refreshMs?: number;
  includeFolders?: boolean;
  gitTracked?: boolean;
  gitRecencyDays?: number;
};

export type TelevisionResolvedConfig = {
  mode: TelevisionMode;
  maxResults: number;
  refreshMs: number;
  includeFolders: boolean;
  gitTracked: boolean;
  gitRecencyDays: number;
};

export type TelevisionSearchResult = {
  path: string;
  label?: string;
  description?: string;
};

export type TelevisionSearchOptions = {
  cwd: string;
  query?: string;
  signal?: AbortSignal;
  maxResults?: number;
  refreshMs?: number;
  includeFolders?: boolean;
  gitTracked?: boolean;
  gitRecencyDays?: number;
};

export type TelevisionSearcher = (
  options: TelevisionSearchOptions,
) => Promise<TelevisionSearchResult[]>;

export type TelevisionConfigLoader = (
  cwd: string,
) => Promise<TelevisionResolvedConfig>;

// Git-backed ranking signals, best-effort. Both sets are keyed by cwd-relative
// paths (same coordinate space as the `fd` candidate list).
//   - tracked:        `git ls-files --cached --exclude-standard` (cwd-relative)
//   - recentlyEdited: `git log --since=N --name-only` (repo-relative, stripped
//                      by `--show-prefix` to become cwd-relative)
export type TelevisionRankSignals = {
  tracked?: Set<string>;
  recentlyEdited?: Set<string>;
};

export type TelevisionRankOptions = {
  signals?: TelevisionRankSignals;
};

export type TelevisionExtensionOptions = {
  commandName?: string;
  shortcut?: string;
  searcher?: TelevisionSearcher;
  configLoader?: TelevisionConfigLoader;
};

const STATUS_KEY = "pi-television";
const DEFAULT_COMMAND_NAME = "television";
const DEFAULT_SHORTCUT = "@";
const DEFAULT_MAX_RESULTS = 20;
const DEFAULT_REFRESH_MS = 10_000;
const DEFAULT_INCLUDE_FOLDERS = true;
const DEFAULT_GIT_TRACKED = true;
const DEFAULT_GIT_RECENCY_DAYS = 14;

export const extensionInfo: ExtensionInfo = {
  name: "television",
  description:
    "Pi extension that powers native @file picking with background television-style search",
};

const defaultResolvedConfig: TelevisionResolvedConfig = {
  mode: "native-live",
  maxResults: DEFAULT_MAX_RESULTS,
  refreshMs: DEFAULT_REFRESH_MS,
  includeFolders: DEFAULT_INCLUDE_FOLDERS,
  gitTracked: DEFAULT_GIT_TRACKED,
  gitRecencyDays: DEFAULT_GIT_RECENCY_DAYS,
};

type FileIndexCache = {
  loadedAt: number;
  entries?: string[];
  tracked?: Set<string>;
  recentlyEdited?: Set<string>;
  pending?: Promise<{
    paths: string[];
    tracked?: Set<string>;
    recentlyEdited?: Set<string>;
  }>;
};

function cleanPaths(stdout: string): string[] {
  return stdout
    .split(/\r?\n/)
    .map((line) => line.trim())
    .filter((line) => line.length > 0);
}

function extractFileToken(textBeforeCursor: string): string | undefined {
  const match = textBeforeCursor.match(/(?:^|[ \t])@([^\s@]*)$/);
  return match?.[1];
}

// Basename as label, dirname as description. This keeps the first (primary)
// column of Pi's native picker under the 32-cell cap so filenames stop getting
// truncated to fragments like "compLe", while the location still shows in the
// description column. Callers may override via result.label/description.
function toAutocompleteItem(result: TelevisionSearchResult): AutocompleteItem {
  const name = basename(result.path);
  const dir = dirname(result.path);
  const hasDir = dir !== "" && dir !== ".";
  const label = result.label ?? (hasDir ? name : result.path);
  const description = result.description ?? (hasDir ? dir : result.path);
  return {
    value: `@${result.path}`,
    label,
    description,
  };
}

function normalizeTelevisionConfig(
  config: TelevisionConfig | undefined,
): TelevisionResolvedConfig {
  return {
    mode: config?.mode ?? defaultResolvedConfig.mode,
    maxResults: config?.maxResults ?? defaultResolvedConfig.maxResults,
    refreshMs: config?.refreshMs ?? defaultResolvedConfig.refreshMs,
    includeFolders:
      config?.includeFolders ?? defaultResolvedConfig.includeFolders,
    gitTracked: config?.gitTracked ?? defaultResolvedConfig.gitTracked,
    gitRecencyDays:
      config?.gitRecencyDays ?? defaultResolvedConfig.gitRecencyDays,
  };
}

async function loadConfigFile(
  path: string,
): Promise<TelevisionConfig | undefined> {
  try {
    const content = await readFile(path, "utf8");
    const parsed = JSON.parse(content) as TelevisionConfig;
    return parsed;
  } catch (error) {
    const nodeError = error as NodeJS.ErrnoException;
    if (nodeError.code === "ENOENT") {
      return undefined;
    }
    throw new Error(`television: failed to read ${path}: ${nodeError.message}`);
  }
}

export async function loadTelevisionConfig(
  cwd: string,
): Promise<TelevisionResolvedConfig> {
  const globalConfig = await loadConfigFile(
    resolve(homedir(), ".pi", "agent", "television.json"),
  );
  const projectConfig = await loadConfigFile(
    resolve(cwd, ".pi", "television.json"),
  );

  return normalizeTelevisionConfig({
    ...globalConfig,
    ...projectConfig,
  });
}

// Per-path ranking tier derived from git signals. Higher = surfaces earlier.
//   3 = tracked AND recently edited
//   2 = tracked
//   1 = untracked (fd-only) or signals unavailable
function tierOf(path: string, signals?: TelevisionRankSignals): number {
  if (!signals?.tracked?.has(path)) return 1;
  return signals.recentlyEdited?.has(path) ? 3 : 2;
}

function depthOf(path: string): number {
  return path.split("/").length;
}

// Stable secondary ordering after the primary signal (fuzzy score or prefix
// bucket): tracked/recent edits first, then shallower paths, then shorter
// paths, then lexicographic — so the canonical file wins over vendored/test
// copies on ties.
function compareRank(
  a: string,
  b: string,
  signals?: TelevisionRankSignals,
): number {
  const ta = tierOf(a, signals);
  const tb = tierOf(b, signals);
  if (ta !== tb) return tb - ta;
  const da = depthOf(a);
  const db = depthOf(b);
  if (da !== db) return da - db;
  if (a.length !== b.length) return a.length - b.length;
  return a < b ? -1 : a > b ? 1 : 0;
}

// Fuzzy score over whitespace/slash tokens, mirroring pi-tui's fuzzyFilter
// semantics (all tokens must match, scores summed) but returning the score so
// the caller can tie-break. Number.POSITIVE_INFINITY = no match.
function fuzzyTokenScore(query: string, text: string): number {
  const tokens = query.split(/[\s/]+/).filter((token) => token.length > 0);
  if (tokens.length === 0) return 0;
  let total = 0;
  for (const token of tokens) {
    const match = fuzzyMatch(token, text);
    if (!match.matches) return Number.POSITIVE_INFINITY;
    total += match.score;
  }
  return total;
}

// Case-insensitive dedupe. Collapses case-variant paths (e.g. Foo.ts / foo.ts)
// to the first-seen — which, because this runs after ranking, is the
// best-ranked one. NOTE: on a case-sensitive filesystem where both spellings
// are genuinely distinct files, this drops the lower-ranked variant from the
// top-N. That is the intended noise reduction for a picker; flip to exact-key
// dedupe if a project needs both spellings to surface.
function dedupeByCanonical(paths: string[]): string[] {
  const seen = new Set<string>();
  const deduped: string[] = [];
  for (const path of paths) {
    const key = path.toLowerCase();
    if (seen.has(key)) continue;
    seen.add(key);
    deduped.push(path);
  }
  return deduped;
}

export function rankTelevisionResults(
  paths: string[],
  query: string | undefined,
  maxResults: number,
  options?: TelevisionRankOptions,
): TelevisionSearchResult[] {
  const trimmedQuery = query?.trim() ?? "";
  const limitedMaxResults = Math.max(1, maxResults);
  const signals = options?.signals;

  if (!trimmedQuery) {
    const ordered = [...paths].sort((a, b) => compareRank(a, b, signals));
    return dedupeByCanonical(ordered)
      .slice(0, limitedMaxResults)
      .map((path) => ({ path }));
  }

  const exactPrefixMatches = paths.filter((path) =>
    path.startsWith(trimmedQuery),
  );
  const exactSet = new Set(exactPrefixMatches);
  const basenamePrefixMatches = paths.filter(
    (path) => !exactSet.has(path) && basename(path).startsWith(trimmedQuery),
  );

  const fuzzySeen = new Set([...exactPrefixMatches, ...basenamePrefixMatches]);
  const fuzzyScored: Array<{ path: string; score: number }> = [];
  for (const path of paths) {
    if (fuzzySeen.has(path)) continue;
    const name = basename(path);
    const text = name === path ? path : `${name} ${path}`;
    const score = fuzzyTokenScore(trimmedQuery, text);
    if (Number.isFinite(score)) {
      fuzzyScored.push({ path, score });
    }
  }

  exactPrefixMatches.sort((a, b) => compareRank(a, b, signals));
  basenamePrefixMatches.sort((a, b) => compareRank(a, b, signals));
  fuzzyScored.sort(
    (a, b) => a.score - b.score || compareRank(a.path, b.path, signals),
  );

  const ordered = [
    ...exactPrefixMatches,
    ...basenamePrefixMatches,
    ...fuzzyScored.map((entry) => entry.path),
  ];

  return dedupeByCanonical(ordered)
    .slice(0, limitedMaxResults)
    .map((path) => ({ path }));
}

// Best-effort git signals. Returns undefined when cwd is not inside a git work
// tree (or git is unavailable), so the caller falls back to fd-only ranking.
async function readGitSignals(
  pi: ExtensionAPI,
  cwd: string,
  signal: AbortSignal | undefined,
  recencyDays: number,
): Promise<TelevisionRankSignals | undefined> {
  const trackedResult = await pi.exec(
    "git",
    ["ls-files", "--cached", "--exclude-standard"],
    { cwd, signal, timeout: 10_000 },
  );
  if (trackedResult.code !== 0) {
    return undefined;
  }
  const tracked = new Set(cleanPaths(trackedResult.stdout));

  let prefix = "";
  try {
    const prefixResult = await pi.exec("git", ["rev-parse", "--show-prefix"], {
      cwd,
      signal,
      timeout: 5_000,
    });
    if (prefixResult.code === 0) {
      prefix = prefixResult.stdout.trim();
    }
  } catch {
    // keep prefix = ""
  }

  const recentlyEdited = new Set<string>();
  try {
    const days = Math.max(1, Math.floor(recencyDays));
    const logResult = await pi.exec(
      "git",
      [
        "log",
        `--since=${days} days ago`,
        "--name-only",
        "--format=",
        "--no-renames",
        "-z",
      ],
      { cwd, signal, timeout: 10_000 },
    );
    if (logResult.code === 0) {
      for (const raw of logResult.stdout.split("\0")) {
        const repoRelative = raw.trim();
        if (!repoRelative) continue;
        const cwdRelative =
          prefix && repoRelative.startsWith(prefix)
            ? repoRelative.slice(prefix.length)
            : repoRelative;
        recentlyEdited.add(cwdRelative);
      }
    }
  } catch {
    // keep recentlyEdited empty
  }

  return { tracked, recentlyEdited };
}

export function createDefaultSearcher(pi: ExtensionAPI): TelevisionSearcher {
  const cache = new Map<string, FileIndexCache>();

  return async ({
    cwd,
    query,
    signal,
    maxResults = DEFAULT_MAX_RESULTS,
    refreshMs = DEFAULT_REFRESH_MS,
    includeFolders = DEFAULT_INCLUDE_FOLDERS,
    gitTracked = DEFAULT_GIT_TRACKED,
    gitRecencyDays = DEFAULT_GIT_RECENCY_DAYS,
  }) => {
    const now = Date.now();
    const cached = cache.get(cwd);

    const rank = (
      entries: string[],
      tracked?: Set<string>,
      recentlyEdited?: Set<string>,
    ) =>
      rankTelevisionResults(entries, query, maxResults, {
        signals: { tracked, recentlyEdited },
      });

    if (cached?.entries && now - cached.loadedAt < refreshMs) {
      return rank(cached.entries, cached.tracked, cached.recentlyEdited);
    }

    if (cached?.pending) {
      const { paths, tracked, recentlyEdited } = await cached.pending;
      return rank(paths, tracked, recentlyEdited);
    }

    const fdArgs = includeFolders
      ? ["--hidden", "--follow", "--exclude", ".git", "--strip-cwd-prefix"]
      : [
          "--type",
          "f",
          "--hidden",
          "--follow",
          "--exclude",
          ".git",
          "--strip-cwd-prefix",
        ];

    const pending = (async () => {
      const result = await pi.exec("fd", fdArgs, {
        cwd,
        signal,
        timeout: 10_000,
      });

      if (result.code !== 0) {
        const details = result.stderr.trim() || `exit code ${result.code}`;
        throw new Error(`television: fd failed: ${details}`);
      }

      const entries = cleanPaths(result.stdout);

      let tracked: Set<string> | undefined;
      let recentlyEdited: Set<string> | undefined;
      if (gitTracked) {
        try {
          const signals = await readGitSignals(pi, cwd, signal, gitRecencyDays);
          tracked = signals?.tracked;
          recentlyEdited = signals?.recentlyEdited;
        } catch {
          // git unavailable or errored: keep fd-only ranking
        }
      }

      cache.set(cwd, {
        loadedAt: Date.now(),
        entries,
        tracked,
        recentlyEdited,
      });
      return { paths: entries, tracked, recentlyEdited };
    })();

    cache.set(cwd, { loadedAt: now, pending });

    try {
      const { paths, tracked, recentlyEdited } = await pending;
      return rank(paths, tracked, recentlyEdited);
    } catch (error) {
      cache.delete(cwd);
      throw error;
    }
  };
}

export function createTelevisionAutocompleteProvider(
  current: AutocompleteProvider,
  searcher: TelevisionSearcher,
  cwd: string,
  config: TelevisionResolvedConfig,
): AutocompleteProvider {
  return {
    async getSuggestions(lines, cursorLine, cursorCol, options) {
      const line = lines[cursorLine] ?? "";
      const textBeforeCursor = line.slice(0, cursorCol);
      const token = extractFileToken(textBeforeCursor);

      if (token === undefined) {
        return current.getSuggestions(lines, cursorLine, cursorCol, options);
      }

      const results = await searcher({
        cwd,
        query: token,
        signal: options.signal,
        maxResults: config.maxResults,
        refreshMs: config.refreshMs,
        includeFolders: config.includeFolders,
        gitTracked: config.gitTracked,
        gitRecencyDays: config.gitRecencyDays,
      });

      if (options.signal.aborted || results.length === 0) {
        return current.getSuggestions(lines, cursorLine, cursorCol, options);
      }

      return {
        prefix: `@${token}`,
        items: results.slice(0, config.maxResults).map(toAutocompleteItem),
      };
    },

    applyCompletion(lines, cursorLine, cursorCol, item, prefix) {
      return current.applyCompletion(
        lines,
        cursorLine,
        cursorCol,
        item,
        prefix,
      );
    },

    shouldTriggerFileCompletion(lines, cursorLine, cursorCol) {
      return (
        current.shouldTriggerFileCompletion?.(lines, cursorLine, cursorCol) ??
        true
      );
    },
  };
}

export function toEditorAttachmentPath(
  selectedPath: string,
  cwd: string,
): string {
  const absolute = resolve(cwd, selectedPath);
  const relativePath = relative(cwd, absolute) || ".";
  const displayPath = relativePath.startsWith("..") ? absolute : relativePath;
  const normalized = displayPath.split("\\").join("/");
  if (/[\s"'$`\\]/.test(normalized)) {
    return `@"${normalized.replace(/(["\\$`])/g, "\\$1")}" `;
  }
  return `@${normalized} `;
}

function shortcutQuery(data: string, shortcut: string): string | null {
  if (data.startsWith(shortcut)) return data.slice(shortcut.length);
  return decodeKittyPrintable(data) === shortcut ? "" : null;
}

function isBoundaryKey(data: string): boolean {
  return (
    matchesKey(data, Key.space) ||
    matchesKey(data, Key.enter) ||
    matchesKey(data, Key.tab)
  );
}

async function findFiles(
  ctx: ExtensionContext,
  searcher: TelevisionSearcher,
  query: string | undefined,
  config: TelevisionResolvedConfig,
): Promise<TelevisionSearchResult[]> {
  ctx.ui.setStatus(STATUS_KEY, "television: finding files");
  ctx.ui.setWorkingMessage("television is finding files");
  ctx.ui.setWorkingIndicator({ frames: ["tv"], intervalMs: 1000 });

  try {
    return await searcher({
      cwd: ctx.cwd,
      query,
      signal: ctx.signal,
      maxResults: config.maxResults,
      refreshMs: config.refreshMs,
      includeFolders: config.includeFolders,
      gitTracked: config.gitTracked,
      gitRecencyDays: config.gitRecencyDays,
    });
  } finally {
    ctx.ui.setStatus(STATUS_KEY, undefined);
    ctx.ui.setWorkingMessage();
    ctx.ui.setWorkingIndicator();
  }
}

async function pickFileWithSelectDialog(
  ctx: ExtensionContext,
  searcher: TelevisionSearcher,
  query: string | undefined,
  config: TelevisionResolvedConfig,
): Promise<TelevisionPickResult> {
  try {
    const results = await findFiles(ctx, searcher, query, config);

    if (results.length === 0) {
      ctx.ui.notify("television: no matching files found", "warning");
      return { status: "cancelled" };
    }

    const choice = await ctx.ui.select(
      "television",
      results.slice(0, config.maxResults).map((result) => result.path),
    );

    if (!choice) {
      return { status: "cancelled" };
    }

    ctx.ui.pasteToEditor(toEditorAttachmentPath(choice, ctx.cwd));
    return { status: "selected", path: choice };
  } catch (error) {
    const message = error instanceof Error ? error.message : String(error);
    ctx.ui.notify(message, "error");
    return { status: "failed", message };
  }
}

function installShortcut(
  ctx: ExtensionContext,
  searcher: TelevisionSearcher,
  shortcut: string,
  config: TelevisionResolvedConfig,
): void {
  let pickerOpen = false;
  let lastKeyWasBoundary = true;

  const handler: TerminalInputHandler = (data) => {
    if (pickerOpen) return undefined;

    const query = shortcutQuery(data, shortcut);
    if (query === null) {
      lastKeyWasBoundary = isBoundaryKey(data);
      return undefined;
    }

    if (!lastKeyWasBoundary) {
      lastKeyWasBoundary = isBoundaryKey(data);
      return undefined;
    }

    pickerOpen = true;
    void pickFileWithSelectDialog(
      ctx,
      searcher,
      query || undefined,
      config,
    ).finally(() => {
      pickerOpen = false;
      lastKeyWasBoundary = true;
    });

    return { consume: true };
  };

  ctx.ui.onTerminalInput?.(handler);
}

export function createExtension(options: TelevisionExtensionOptions = {}) {
  const commandName = options.commandName ?? DEFAULT_COMMAND_NAME;
  const shortcut = options.shortcut ?? DEFAULT_SHORTCUT;

  return {
    name: extensionInfo.name,
    register(pi: ExtensionAPI): void {
      const searcher = options.searcher ?? createDefaultSearcher(pi);
      const configLoader = options.configLoader ?? loadTelevisionConfig;
      let config = defaultResolvedConfig;

      pi.on("session_start", async (_event, ctx) => {
        try {
          config = await configLoader(ctx.cwd);
        } catch (error) {
          const message =
            error instanceof Error ? error.message : String(error);
          config = defaultResolvedConfig;
          ctx.ui.notify(message, "error");
        }

        if (config.mode === "native-live") {
          ctx.ui.addAutocompleteProvider((current) =>
            createTelevisionAutocompleteProvider(
              current,
              searcher,
              ctx.cwd,
              config,
            ),
          );
          return;
        }

        installShortcut(ctx, searcher, shortcut, config);
      });

      pi.registerCommand(commandName, {
        description:
          "Find a file in the background and insert it as an @file attachment",
        handler: async (args, ctx) => {
          await pickFileWithSelectDialog(
            ctx,
            searcher,
            args.trim() || undefined,
            config,
          );
        },
      });
    },
  };
}
