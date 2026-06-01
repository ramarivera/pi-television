import { readFile } from "node:fs/promises";
import { homedir } from "node:os";
import { basename, relative, resolve } from "node:path";
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
  fuzzyFilter,
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
};

export type TelevisionResolvedConfig = {
  mode: TelevisionMode;
  maxResults: number;
  refreshMs: number;
  includeFolders: boolean;
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
};

export type TelevisionSearcher = (
  options: TelevisionSearchOptions,
) => Promise<TelevisionSearchResult[]>;

export type TelevisionConfigLoader = (
  cwd: string,
) => Promise<TelevisionResolvedConfig>;

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

export const extensionInfo: ExtensionInfo = {
  name: "television",
  description:
    "Pi extension that powers native @file picking with background television-style search",
};

const DEFAULT_INCLUDE_FOLDERS = true;

const defaultResolvedConfig: TelevisionResolvedConfig = {
  mode: "native-live",
  maxResults: DEFAULT_MAX_RESULTS,
  refreshMs: DEFAULT_REFRESH_MS,
  includeFolders: DEFAULT_INCLUDE_FOLDERS,
};

type FileIndexCache = {
  loadedAt: number;
  entries?: string[];
  pending?: Promise<string[]>;
};

function uniq(values: string[]): string[] {
  const seen = new Set<string>();
  const deduped: string[] = [];

  for (const value of values) {
    if (seen.has(value)) continue;
    seen.add(value);
    deduped.push(value);
  }

  return deduped;
}

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

function toAutocompleteItem(result: TelevisionSearchResult): AutocompleteItem {
  return {
    value: `@${result.path}`,
    label: result.label ?? result.path,
    description: result.description ?? result.path,
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

export function rankTelevisionResults(
  paths: string[],
  query: string | undefined,
  maxResults: number,
): TelevisionSearchResult[] {
  const trimmedQuery = query?.trim() ?? "";
  const limitedMaxResults = Math.max(1, maxResults);

  if (!trimmedQuery) {
    return paths.slice(0, limitedMaxResults).map((path) => ({ path }));
  }

  const exactPrefixMatches = paths.filter((path) =>
    path.startsWith(trimmedQuery),
  );
  const basenamePrefixMatches = paths.filter(
    (path) =>
      basename(path).startsWith(trimmedQuery) &&
      !exactPrefixMatches.includes(path),
  );
  const fuzzyMatches = fuzzyFilter(paths, trimmedQuery, (path) => {
    const name = basename(path);
    return name === path ? path : `${name} ${path}`;
  });

  return uniq([
    ...exactPrefixMatches,
    ...basenamePrefixMatches,
    ...fuzzyMatches,
  ])
    .slice(0, limitedMaxResults)
    .map((path) => ({ path }));
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
  }) => {
    const now = Date.now();
    const cached = cache.get(cwd);

    if (cached?.entries && now - cached.loadedAt < refreshMs) {
      return rankTelevisionResults(cached.entries, query, maxResults);
    }

    if (cached?.pending) {
      const entries = await cached.pending;
      return rankTelevisionResults(entries, query, maxResults);
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
      cache.set(cwd, { loadedAt: Date.now(), entries });
      return entries;
    })();

    cache.set(cwd, { loadedAt: now, pending });

    try {
      const entries = await pending;
      return rankTelevisionResults(entries, query, maxResults);
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
