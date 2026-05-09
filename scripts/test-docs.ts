import { promises as fs } from "node:fs";
import path from "node:path";
import { $ } from "bun";

async function* walk(dir: string): AsyncGenerator<string> {
  const entries = await fs.readdir(dir, { withFileTypes: true });
  for (const entry of entries) {
    const fullPath = path.join(dir, entry.name);
    if (entry.isDirectory()) {
      yield* walk(fullPath);
    } else if (entry.name.endsWith(".md")) {
      yield fullPath;
    }
  }
}

async function extractCodeBlocks(markdownFile: string): Promise<string[]> {
  const content = await fs.readFile(markdownFile, "utf-8");
  const blocks: string[] = [];
  const lines = content.split(/\r?\n/);

  let inExampleSection = false;
  let inFence = false;
  let shouldCaptureFence = false;
  let currentFence: string[] = [];

  for (const line of lines) {
    if (!inFence) {
      if (/^#{1,6}\s+Examples?$/.test(line.trim())) {
        inExampleSection = true;
        continue;
      }

      if (/^#{1,6}\s+/.test(line.trim())) {
        inExampleSection = false;
      }

      const fenceStart = line.match(/^```([^\s]+)(?:\s+(.*))?$/);
      if (!fenceStart) {
        continue;
      }

      const language = fenceStart[1]?.toLowerCase() ?? "";
      const modifiers = (fenceStart[2] ?? "")
        .split(/\s+/)
        .map((token) => token.trim().toLowerCase())
        .filter(Boolean);

      inFence = true;
      currentFence = [];
      shouldCaptureFence =
        inExampleSection &&
        (language === "ts" || language === "typescript") &&
        !modifiers.includes("ignore");
      continue;
    }

    if (line.trim() === "```") {
      if (shouldCaptureFence && currentFence.join("\n").trim()) {
        blocks.push(currentFence.join("\n"));
      }
      inFence = false;
      shouldCaptureFence = false;
      currentFence = [];
      continue;
    }

    if (shouldCaptureFence) {
      currentFence.push(line);
    }
  }

  return blocks;
}

async function run() {
  const apiDocsPath = path.resolve(__dirname, "../docs/api");
  const tempDir = path.resolve(__dirname, "../.doctests");

  // Cleanup or create temp dir
  await fs.rm(tempDir, { recursive: true, force: true });
  await fs.mkdir(tempDir, { recursive: true });

  let blockCount = 0;
  let fileIdx = 0;

  for await (const file of walk(apiDocsPath)) {
    const blocks = await extractCodeBlocks(file);
    for (const block of blocks) {
      if (!block.trim()) continue;

      // Skip known external snippets that we cannot tag with 'ignore'
      if (block.includes("new ClientSideConnection(client, stream)")) continue;

      // Some examples use top level await or imports
      const code = `// Extracted from ${path.relative(apiDocsPath, file)}\n${block}\nexport {};`;
      const tempFile = path.join(tempDir, `doctest_${fileIdx}_${blockCount}.ts`);

      await fs.writeFile(tempFile, code);
      blockCount++;
    }
    fileIdx++;
  }

  if (blockCount === 0) {
    console.log(
      "No compile-ready TypeScript example blocks were found in docs/api. Skipping doctest typecheck.",
    );
    return;
  }

  console.log(`Found ${blockCount} typescript code blocks. Typechecking...`);

  // Run tsc over the generated files
  const tsconfigPath = path.resolve(__dirname, "../tsconfig.json");
  const tempTsConfigPath = path.join(tempDir, "tsconfig.json");
  await fs.writeFile(
    tempTsConfigPath,
    JSON.stringify(
      {
        extends: path.relative(tempDir, tsconfigPath),
        include: ["*.ts"],
        compilerOptions: { noEmit: true },
      },
      null,
      2,
    ),
  );

  let tscFailed = false;
  try {
    await $`bunx tsc --project ${tempTsConfigPath}`;
    console.log("✅ All doctests compile successfully!");
  } catch (_error) {
    console.error("❌ Doctest typechecking failed!");
    tscFailed = true;
  }

  if (tscFailed) {
    process.exit(1);
  }
}

run().catch((e) => {
  console.error(e);
  process.exit(1);
});
