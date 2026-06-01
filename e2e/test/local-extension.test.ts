import assert from "node:assert/strict";
import { mkdir, mkdtemp, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import path from "node:path";
import test from "node:test";
import {
  createAgentSession,
  DefaultResourceLoader,
  type ExtensionCommandContext,
  type ExtensionContext,
  SessionManager,
} from "@earendil-works/pi-coding-agent";
import {
  createExtension,
  type TelevisionPickResult,
  type TelevisionRunner,
} from "../../src/index.ts";

const repoRoot = process.cwd();

async function makeAgentDir(): Promise<string> {
  const agentDir = await mkdtemp(path.join(tmpdir(), "pi-television-e2e-"));
  await mkdir(path.join(agentDir, ".pi", "agent"), { recursive: true });
  await writeFile(
    path.join(agentDir, ".pi", "agent", "settings.json"),
    JSON.stringify({
      extensions: [
        path.join(repoRoot, ".pi", "extensions", "television", "index.ts"),
      ],
    }),
  );
  return agentDir;
}

test("Pi SDK discovers the project-local .pi television extension without loader errors", async () => {
  const agentDir = await makeAgentDir();
  try {
    const loader = new DefaultResourceLoader({
      cwd: repoRoot,
      agentDir,
      noSkills: true,
      noPromptTemplates: true,
      noThemes: true,
      noContextFiles: true,
    });
    await loader.reload();

    const extensions = loader.getExtensions();
    assert.deepEqual(extensions.errors, []);
    assert.ok(
      extensions.extensions.some((extension) =>
        extension.resolvedPath.endsWith(".pi/extensions/television/index.ts"),
      ),
      "expected DefaultResourceLoader to discover .pi/extensions/television/index.ts",
    );
  } finally {
    await rm(agentDir, { recursive: true, force: true });
  }
});

test("live Pi session binds the local .pi extension and exposes /television", async () => {
  const agentDir = await makeAgentDir();
  try {
    const loader = new DefaultResourceLoader({
      cwd: repoRoot,
      agentDir,
      noSkills: true,
      noPromptTemplates: true,
      noThemes: true,
      noContextFiles: true,
    });
    await loader.reload();

    const { session } = await createAgentSession({
      cwd: repoRoot,
      agentDir,
      resourceLoader: loader,
      sessionManager: SessionManager.inMemory(repoRoot),
      noTools: "all",
    });

    try {
      await session.bindExtensions({});
      assert.ok(session.extensionRunner.getCommand("television"));
    } finally {
      session.dispose();
    }
  } finally {
    await rm(agentDir, { recursive: true, force: true });
  }
});

test("live Pi session command path runs through async UI state and survives selecting a file", async () => {
  const selected: TelevisionPickResult = {
    status: "selected",
    path: "src/index.ts",
  };
  const runner: TelevisionRunner = async ({ cwd, query }) => {
    assert.equal(cwd, repoRoot);
    assert.equal(query, "src");
    await new Promise((resolve) => setTimeout(resolve, 5));
    return selected;
  };
  const extension = createExtension({ runner });
  const agentDir = await mkdtemp(path.join(tmpdir(), "pi-television-live-"));
  const loader = new DefaultResourceLoader({
    cwd: repoRoot,
    agentDir,
    noExtensions: true,
    noSkills: true,
    noPromptTemplates: true,
    noThemes: true,
    noContextFiles: true,
    extensionFactories: [async (pi) => extension.register(pi)],
  });

  try {
    await loader.reload();
    const { session } = await createAgentSession({
      cwd: repoRoot,
      agentDir,
      resourceLoader: loader,
      sessionManager: SessionManager.inMemory(repoRoot),
      noTools: "all",
    });

    const pasted: string[] = [];
    const statuses: Array<string | undefined> = [];
    const workingMessages: Array<string | undefined> = [];

    try {
      await session.bindExtensions({
        uiContext: {
          notify() {},
          pasteToEditor(text: string) {
            pasted.push(text);
          },
          setStatus(_key: string, text: string | undefined) {
            statuses.push(text);
          },
          setWorkingMessage(message?: string) {
            workingMessages.push(message);
          },
          setWorkingIndicator() {},
          onTerminalInput() {
            return () => {};
          },
          getEditorText() {
            return "";
          },
          setEditorText() {},
        } as Partial<ExtensionContext["ui"]> as ExtensionContext["ui"],
      });

      const command = session.extensionRunner.getCommand("television");
      assert.ok(command, "expected /television command to be registered");
      await command.handler(
        "src",
        session.createReplacedSessionContext() as ExtensionCommandContext,
      );

      assert.deepEqual(pasted, ["@src/index.ts "]);
      assert.deepEqual(statuses, ["television: picking file", undefined]);
      assert.deepEqual(workingMessages, [
        "television is picking a file",
        undefined,
      ]);
    } finally {
      session.dispose();
    }
  } finally {
    await rm(agentDir, { recursive: true, force: true });
  }
});
