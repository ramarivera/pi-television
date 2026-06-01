import assert from "node:assert/strict";
import test from "node:test";
import type {
  ExtensionAPI,
  ExtensionCommandContext,
  ExtensionContext,
  TerminalInputHandler,
} from "@earendil-works/pi-coding-agent";
import {
  createExtension,
  extensionInfo,
  type TelevisionPickResult,
  type TelevisionRunner,
  toEditorAttachmentPath,
} from "../src/index.ts";

type RegisteredCommand = {
  description: string;
  handler: (args: string, ctx: ExtensionCommandContext) => Promise<void>;
};

type FakePi = {
  pi: ExtensionAPI;
  commands: Map<string, RegisteredCommand>;
  sessionStart?: (ctx: ExtensionContext) => void;
};

type FakeContext = ExtensionContext & {
  pasted: string[];
  notifications: Array<{
    message: string;
    type?: "info" | "warning" | "error";
  }>;
  statuses: Array<string | undefined>;
  workingMessages: Array<string | undefined>;
  invokeTerminal(data: string): ReturnType<TerminalInputHandler>;
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
      handler: (_event: unknown, ctx: ExtensionContext) => void,
    ) {
      if (event === "session_start") {
        fake.sessionStart = (ctx: ExtensionContext) => handler({}, ctx);
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
  const context = {
    cwd,
    hasUI: true,
    signal: undefined,
    pasted,
    notifications,
    statuses,
    workingMessages,
    ui: {
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
      getEditorText() {
        return "";
      },
      setEditorText() {},
    },
    isIdle() {
      return true;
    },
    abort() {},
    hasPendingMessages() {
      return false;
    },
    shutdown() {},
    invokeTerminal(data: string) {
      return terminalHandler?.(data);
    },
  };
  return context as unknown as FakeContext;
}

test("factory registers the command and exposes extension identity", () => {
  const fake = fakePi();
  createExtension().register(fake.pi);

  assert.equal(extensionInfo.name, "television");
  assert.equal(createExtension().name, "television");
  assert.ok(fake.commands.get("television"));
  assert.ok(fake.sessionStart);
});

test("command pastes the selected file as a Pi @file attachment", async () => {
  const runner: TelevisionRunner = async ({ cwd, query }) => {
    assert.equal(cwd, "/tmp/project");
    assert.equal(query, "src");
    return { status: "selected", path: "src/index.ts" };
  };
  const fake = fakePi();
  const ctx = fakeContext("/tmp/project");
  createExtension({ runner }).register(fake.pi);

  await fake.commands
    .get("television")
    ?.handler("src", ctx as unknown as ExtensionCommandContext);

  assert.deepEqual(ctx.pasted, ["@src/index.ts "]);
  assert.deepEqual(ctx.statuses, ["television: picking file", undefined]);
  assert.deepEqual(ctx.workingMessages, [
    "television is picking a file",
    undefined,
  ]);
});

test("cancelled picks do not paste or notify errors", async () => {
  const runner: TelevisionRunner = async (): Promise<TelevisionPickResult> => ({
    status: "cancelled",
  });
  const fake = fakePi();
  const ctx = fakeContext();
  createExtension({ runner }).register(fake.pi);

  await fake.commands
    .get("television")
    ?.handler("", ctx as unknown as ExtensionCommandContext);

  assert.deepEqual(ctx.pasted, []);
  assert.deepEqual(ctx.notifications, []);
  assert.equal(ctx.statuses.at(-1), undefined);
});

test("failed picks notify without throwing or leaving stale async UI state", async () => {
  const runner: TelevisionRunner = async () => ({
    status: "failed",
    message: "tv missing",
  });
  const fake = fakePi();
  const ctx = fakeContext();
  createExtension({ runner }).register(fake.pi);

  await fake.commands
    .get("television")
    ?.handler("", ctx as unknown as ExtensionCommandContext);

  assert.deepEqual(ctx.pasted, []);
  assert.deepEqual(ctx.notifications, [
    { message: "television failed: tv missing", type: "error" },
  ]);
  assert.equal(ctx.statuses.at(-1), undefined);
  assert.equal(ctx.workingMessages.at(-1), undefined);
});

test("@ shortcut consumes one trigger, opens only one picker, and pastes after async selection", async () => {
  let resolvePick: ((result: TelevisionPickResult) => void) | undefined;
  let calls = 0;
  const runner: TelevisionRunner = () =>
    new Promise((resolve) => {
      calls += 1;
      resolvePick = resolve;
    });
  const fake = fakePi();
  const ctx = fakeContext("/tmp/project");
  createExtension({ runner }).register(fake.pi);
  fake.sessionStart?.(ctx);

  assert.deepEqual(ctx.invokeTerminal("@"), { consume: true });
  assert.equal(ctx.invokeTerminal("@"), undefined);
  assert.equal(calls, 1);

  resolvePick?.({ status: "selected", path: "README.md" });
  await new Promise((resolve) => setTimeout(resolve, 0));

  assert.deepEqual(ctx.pasted, ["@README.md "]);
  assert.deepEqual(ctx.invokeTerminal("@"), { consume: true });
  assert.equal(calls, 2);
});

test("shortcut ignores @ in the middle of a token", () => {
  const fake = fakePi();
  const ctx = fakeContext();
  createExtension({
    runner: async () => ({ status: "selected", path: "README.md" }),
  }).register(fake.pi);
  fake.sessionStart?.(ctx);

  assert.equal(ctx.invokeTerminal("a"), undefined);
  assert.equal(ctx.invokeTerminal("@"), undefined);
  assert.deepEqual(ctx.pasted, []);
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
