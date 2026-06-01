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
  type TelevisionSearcher,
  type TelevisionSearchResult,
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

function matches(...paths: string[]): TelevisionSearchResult[] {
  return paths.map((path) => ({ path }));
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
  const searcher: TelevisionSearcher = async ({ cwd, query, maxResults }) => {
    assert.equal(cwd, repoRoot);
    assert.equal(query, "src");
    assert.equal(maxResults, 20);
    await new Promise((resolve) => setTimeout(resolve, 5));
    return matches("src/index.ts", "src/extension.ts");
  };
  const extension = createExtension({
    searcher,
    configLoader: async () => ({
      mode: "native-live",
      maxResults: 20,
      refreshMs: 5000,
      includeFolders: true,
    }),
  });
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
    const selectCalls: Array<{ title: string; options: string[] }> = [];

    try {
      await session.bindExtensions({
        uiContext: {
          async select(title: string, options: string[]) {
            selectCalls.push({ title, options });
            return "src/extension.ts";
          },
          async confirm() {
            return false;
          },
          async input() {
            return undefined;
          },
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

      assert.deepEqual(selectCalls, [
        {
          title: "television",
          options: ["src/index.ts", "src/extension.ts"],
        },
      ]);
      assert.deepEqual(pasted, ["@src/extension.ts "]);
      assert.deepEqual(statuses, ["television: finding files", undefined]);
      assert.deepEqual(workingMessages, [
        "television is finding files",
        undefined,
      ]);
    } finally {
      session.dispose();
    }
  } finally {
    await rm(agentDir, { recursive: true, force: true });
  }
});
