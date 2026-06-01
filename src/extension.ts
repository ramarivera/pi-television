import { spawn } from "node:child_process";
import { relative, resolve } from "node:path";
import type {
  ExtensionAPI,
  ExtensionContext,
  TerminalInputHandler,
} from "@earendil-works/pi-coding-agent";
import { decodeKittyPrintable, Key, matchesKey } from "@earendil-works/pi-tui";

export type ExtensionInfo = {
  name: string;
  description: string;
};

export type TelevisionPickResult =
  | { status: "selected"; path: string }
  | { status: "cancelled" }
  | { status: "failed"; message: string };

export type TelevisionRunnerOptions = {
  cwd: string;
  query?: string;
  signal?: AbortSignal;
};

export type TelevisionRunner = (
  options: TelevisionRunnerOptions,
) => Promise<TelevisionPickResult>;

export type TelevisionExtensionOptions = {
  commandName?: string;
  shortcut?: string;
  runner?: TelevisionRunner;
};

const STATUS_KEY = "pi-television";
const DEFAULT_COMMAND_NAME = "television";
const DEFAULT_SHORTCUT = "@";

export const extensionInfo: ExtensionInfo = {
  name: "television",
  description:
    "Pi extension that replaces the fuzzy file finder with television (tv) for faster, non-blocking file search",
};

function cleanSelectedPath(stdout: string): string | null {
  const selected = stdout
    .split(/\r?\n/)
    .map((line) => line.trim())
    .find((line) => line.length > 0);
  return selected ?? null;
}

function buildTvArgs(query: string | undefined): string[] {
  const sourceCommand =
    "fd --type f --type d --hidden --follow --exclude .git --strip-cwd-prefix";
  const args = [
    "--source-command",
    sourceCommand,
    "--source-display",
    "{}",
    "--source-output",
    "{}",
    "--preview-command",
    "test -d {} && ls -la {} || sed -n '1,160p' {}",
    "--preview-header",
    "{}",
  ];

  if (query?.trim()) {
    args.push("--input", query.trim());
  }

  return args;
}

export function runTelevision(
  options: TelevisionRunnerOptions,
): Promise<TelevisionPickResult> {
  return new Promise((resolvePick) => {
    if (options.signal?.aborted) {
      resolvePick({ status: "cancelled" });
      return;
    }

    const child = spawn("tv", buildTvArgs(options.query), {
      cwd: options.cwd,
      stdio: ["inherit", "pipe", "inherit"],
    });

    let stdout = "";
    let settled = false;

    const settle = (result: TelevisionPickResult) => {
      if (settled) return;
      settled = true;
      options.signal?.removeEventListener("abort", onAbort);
      resolvePick(result);
    };

    const onAbort = () => {
      child.kill("SIGTERM");
      settle({ status: "cancelled" });
    };

    options.signal?.addEventListener("abort", onAbort, { once: true });
    child.stdout?.setEncoding("utf8");
    child.stdout?.on("data", (chunk: string) => {
      stdout += chunk;
    });
    child.on("error", (error) => {
      settle({ status: "failed", message: error.message });
    });
    child.on("close", (code, signal) => {
      if (settled) return;
      if (signal) {
        settle({ status: "cancelled" });
        return;
      }
      if (code === 0) {
        const path = cleanSelectedPath(stdout);
        settle(path ? { status: "selected", path } : { status: "cancelled" });
        return;
      }
      if (code === 130 || code === 1) {
        settle({ status: "cancelled" });
        return;
      }
      settle({
        status: "failed",
        message: `television exited with code ${code ?? "unknown"}`,
      });
    });
  });
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

async function pickFile(
  ctx: ExtensionContext,
  runner: TelevisionRunner,
  query: string | undefined,
): Promise<TelevisionPickResult> {
  ctx.ui.setStatus(STATUS_KEY, "television: picking file");
  ctx.ui.setWorkingMessage("television is picking a file");
  ctx.ui.setWorkingIndicator({ frames: ["tv"], intervalMs: 1000 });

  try {
    return await runner({ cwd: ctx.cwd, query, signal: ctx.signal });
  } finally {
    ctx.ui.setStatus(STATUS_KEY, undefined);
    ctx.ui.setWorkingMessage();
    ctx.ui.setWorkingIndicator();
  }
}

async function pastePickedFile(
  ctx: ExtensionContext,
  runner: TelevisionRunner,
  query: string | undefined,
): Promise<TelevisionPickResult> {
  const result = await pickFile(ctx, runner, query);

  if (result.status === "selected") {
    ctx.ui.pasteToEditor(toEditorAttachmentPath(result.path, ctx.cwd));
  } else if (result.status === "failed") {
    ctx.ui.notify(`television failed: ${result.message}`, "error");
  }

  return result;
}

function installShortcut(
  ctx: ExtensionContext,
  runner: TelevisionRunner,
  shortcut: string,
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
    void pastePickedFile(ctx, runner, query).finally(() => {
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
  const runner = options.runner ?? runTelevision;

  return {
    name: extensionInfo.name,
    register(pi: ExtensionAPI): void {
      pi.on("session_start", (_event, ctx) => {
        installShortcut(ctx, runner, shortcut);
      });

      pi.registerCommand(commandName, {
        description:
          "Pick a file with television (tv) and insert it as an @file attachment",
        handler: async (args, ctx) => {
          await pastePickedFile(ctx, runner, args.trim());
        },
      });
    },
  };
}
