import assert from "node:assert/strict";
import test from "node:test";
import type {
  ExtensionAPI,
  ExtensionCommandContext,
  ExtensionContext,
  TerminalInputHandler,
} from "@earendil-works/pi-coding-agent";
import type {
  AutocompleteProvider,
  AutocompleteSuggestions,
} from "@earendil-works/pi-tui";
import {
  createExtension,
  extensionInfo,
  type TelevisionSearcher,
  type TelevisionSearchResult,
  toEditorAttachmentPath,
} from "../src/index.ts";

type RegisteredCommand = {
  description: string;
  handler: (args: string, ctx: ExtensionCommandContext) => Promise<void>;
};

type FakePi = {
  pi: ExtensionAPI;
  commands: Map<string, RegisteredCommand>;
  sessionStart?: (ctx: ExtensionContext) => Promise<void>;
};

type FakeContext = ExtensionContext & {
  pasted: string[];
  notifications: Array<{
    message: string;
    type?: "info" | "warning" | "error";
  }>;
  statuses: Array<string | undefined>;
  workingMessages: Array<string | undefined>;
  selectCalls: Array<{ title: string; options: string[] }>;
  nextSelectResult?: string;
  autocompleteFactory?: (current: AutocompleteProvider) => AutocompleteProvider;
  invokeTerminal(data: string): ReturnType<TerminalInputHandler>;
  buildAutocomplete(
    current: AutocompleteProvider,
  ): AutocompleteProvider | undefined;
};

function fakePi(): FakePi {
  const commands = new Map<string, RegisteredCommand>();
  const fake: Partial<FakePi> = {};
  const pi = {
    registerCommand(name: string, command: RegisteredCommand) {
      commands.set(name, command);
    },
    on(
      event: string,
      handler: (_event: unknown, ctx: ExtensionContext) => void | Promise<void>,
    ) {
      if (event === "session_start") {
        fake.sessionStart = async (ctx: ExtensionContext) => {
          await handler({}, ctx);
        };
      }
    },
  } as ExtensionAPI;

  return Object.assign(fake, { pi, commands }) as FakePi;
}

function fakeContext(cwd = process.cwd()): FakeContext {
  let terminalHandler: TerminalInputHandler | undefined;
  const pasted: string[] = [];
  const notifications: FakeContext["notifications"] = [];
  const statuses: Array<string | undefined> = [];
  const workingMessages: Array<string | undefined> = [];
  const selectCalls: Array<{ title: string; options: string[] }> = [];
  const context = {
    cwd,
    hasUI: true,
    signal: undefined,
    pasted,
    notifications,
    statuses,
    workingMessages,
    selectCalls,
    nextSelectResult: undefined as string | undefined,
    autocompleteFactory: undefined as
      | ((current: AutocompleteProvider) => AutocompleteProvider)
      | undefined,
    ui: {
      async select(title: string, options: string[]) {
        selectCalls.push({ title, options });
        return context.nextSelectResult;
      },
      async confirm() {
        return false;
      },
      async input() {
        return undefined;
      },
      notify(message: string, type?: "info" | "warning" | "error") {
        notifications.push(type ? { message, type } : { message });
      },
      pasteToEditor(text: string) {
        pasted.push(text);
      },
      onTerminalInput(handler: TerminalInputHandler) {
        terminalHandler = handler;
        return () => {
          terminalHandler = undefined;
        };
      },
      setStatus(_key: string, text: string | undefined) {
        statuses.push(text);
      },
      setWorkingMessage(message?: string) {
        workingMessages.push(message);
      },
      setWorkingIndicator() {},
      setWorkingVisible() {},
      setHiddenThinkingLabel() {},
      setWidget() {},
      setFooter() {},
      setHeader() {},
      setTitle() {},
      async custom() {
        throw new Error("custom UI not implemented in fake context");
      },
      setEditorText() {},
      getEditorText() {
        return "";
      },
      async editor() {
        return undefined;
      },
      addAutocompleteProvider(
        factory: (current: AutocompleteProvider) => AutocompleteProvider,
      ) {
        context.autocompleteFactory = factory;
      },
      setEditorComponent() {},
      getEditorComponent() {
        return undefined;
      },
      theme: {
        fg(_color: string, text: string) {
          return text;
        },
        bg(_color: string, text: string) {
          return text;
        },
        bold(text: string) {
          return text;
        },
        italic(text: string) {
          return text;
        },
        strikethrough(text: string) {
          return text;
        },
      },
      getAllThemes() {
        return [];
      },
      getTheme() {
        return undefined;
      },
      setTheme() {
        return { success: true };
      },
      getToolsExpanded() {
        return false;
      },
      setToolsExpanded() {},
    },
    isIdle() {
      return true;
    },
    abort() {},
    hasPendingMessages() {
      return false;
    },
    shutdown() {},
    getContextUsage() {
      return undefined;
    },
    compact() {},
    getSystemPrompt() {
      return "";
    },
    invokeTerminal(data: string) {
      return terminalHandler?.(data);
    },
    buildAutocomplete(current: AutocompleteProvider) {
      return context.autocompleteFactory?.(current);
    },
  };
  return context as unknown as FakeContext;
}

function createFallbackProvider(
  result: AutocompleteSuggestions | null,
): AutocompleteProvider {
  return {
    async getSuggestions() {
      return result;
    },
    applyCompletion(lines, cursorLine, cursorCol) {
      return { lines, cursorLine, cursorCol };
    },
    shouldTriggerFileCompletion() {
      return true;
    },
  };
}

function matches(...paths: string[]): TelevisionSearchResult[] {
  return paths.map((path) => ({ path }));
}

test("factory registers the command and exposes extension identity", () => {
  const fake = fakePi();
  createExtension().register(fake.pi);

  assert.equal(extensionInfo.name, "television");
  assert.equal(createExtension().name, "television");
  assert.ok(fake.commands.get("television"));
  assert.ok(fake.sessionStart);
});

test("native-live mode registers an autocomplete provider that returns @file suggestions", async () => {
  const searcher: TelevisionSearcher = async ({ cwd, query, maxResults }) => {
    assert.equal(cwd, "/tmp/project");
    assert.equal(query, "src");
    assert.equal(maxResults, 20);
    return matches("src/index.ts", "src/extension.ts");
  };
  const fake = fakePi();
  const ctx = fakeContext("/tmp/project");
  createExtension({
    searcher,
    configLoader: async () => ({
      mode: "native-live",
      maxResults: 20,
      refreshMs: 5000,
    }),
  }).register(fake.pi);

  await fake.sessionStart?.(ctx);

  const provider = ctx.buildAutocomplete(createFallbackProvider(null));
  assert.ok(provider, "expected autocomplete provider to be registered");

  const suggestions = await provider?.getSuggestions(["@src"], 0, 4, {
    signal: new AbortController().signal,
  });

  assert.deepEqual(suggestions, {
    prefix: "@src",
    items: [
      {
        value: "@src/index.ts",
        label: "src/index.ts",
        description: "src/index.ts",
      },
      {
        value: "@src/extension.ts",
        label: "src/extension.ts",
        description: "src/extension.ts",
      },
    ],
  });
});

test("autocomplete provider falls back to the current provider outside @file tokens", async () => {
  const fake = fakePi();
  const ctx = fakeContext();
  createExtension({
    searcher: async () => {
      throw new Error("searcher should not be called");
    },
    configLoader: async () => ({
      mode: "native-live",
      maxResults: 20,
      refreshMs: 5000,
    }),
  }).register(fake.pi);

  await fake.sessionStart?.(ctx);

  const fallback = {
    prefix: "#12",
    items: [{ value: "#123", label: "#123" }],
  } satisfies AutocompleteSuggestions;
  const provider = ctx.buildAutocomplete(createFallbackProvider(fallback));
  const suggestions = await provider?.getSuggestions(["hello world"], 0, 11, {
    signal: new AbortController().signal,
  });

  assert.deepEqual(suggestions, fallback);
});

test("/television uses the native select dialog and pastes the selected file", async () => {
  const searcher: TelevisionSearcher = async ({ cwd, query, maxResults }) => {
    assert.equal(cwd, "/tmp/project");
    assert.equal(query, "src");
    assert.equal(maxResults, 20);
    return matches("src/index.ts", "src/extension.ts");
  };
  const fake = fakePi();
  const ctx = fakeContext("/tmp/project");
  ctx.nextSelectResult = "src/extension.ts";
  createExtension({
    searcher,
    configLoader: async () => ({
      mode: "native-live",
      maxResults: 20,
      refreshMs: 5000,
    }),
  }).register(fake.pi);

  await fake.commands
    .get("television")
    ?.handler("src", ctx as unknown as ExtensionCommandContext);

  assert.deepEqual(ctx.selectCalls, [
    {
      title: "television",
      options: ["src/index.ts", "src/extension.ts"],
    },
  ]);
  assert.deepEqual(ctx.pasted, ["@src/extension.ts "]);
  assert.deepEqual(ctx.statuses, ["television: finding files", undefined]);
  assert.deepEqual(ctx.workingMessages, [
    "television is finding files",
    undefined,
  ]);
});

test("select-dialog mode binds @ to the native select dialog instead of launching full-screen tv", async () => {
  const searcher: TelevisionSearcher = async ({ query }) => {
    assert.equal(query, undefined);
    return matches("README.md", "src/index.ts");
  };
  const fake = fakePi();
  const ctx = fakeContext("/tmp/project");
  ctx.nextSelectResult = "README.md";
  createExtension({
    searcher,
    configLoader: async () => ({
      mode: "select-dialog",
      maxResults: 20,
      refreshMs: 5000,
    }),
  }).register(fake.pi);

  await fake.sessionStart?.(ctx);

  assert.deepEqual(ctx.invokeTerminal("@"), { consume: true });
  await new Promise((resolve) => setTimeout(resolve, 0));

  assert.deepEqual(ctx.selectCalls, [
    {
      title: "television",
      options: ["README.md", "src/index.ts"],
    },
  ]);
  assert.deepEqual(ctx.pasted, ["@README.md "]);
  assert.deepEqual(ctx.statuses, ["television: finding files", undefined]);
  assert.deepEqual(ctx.workingMessages, [
    "television is finding files",
    undefined,
  ]);
});

test("attachment paths are relative, quoted when needed, and safe for paths outside cwd", () => {
  assert.equal(
    toEditorAttachmentPath("/tmp/project/src/index.ts", "/tmp/project"),
    "@src/index.ts ",
  );
  assert.equal(
    toEditorAttachmentPath("docs/read me.md", "/tmp/project"),
    '@"docs/read me.md" ',
  );
  assert.equal(
    toEditorAttachmentPath("/tmp/other/file.md", "/tmp/project"),
    "@/tmp/other/file.md ",
  );
});
