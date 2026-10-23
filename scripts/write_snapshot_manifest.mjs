import { createHash } from "node:crypto";
import { createReadStream } from "node:fs";
import { readdir, readFile, writeFile } from "node:fs/promises";
import path from "node:path";
import { fileURLToPath } from "node:url";

const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..");
const outputName = "SNAPSHOT_MANIFEST.sha256";
const excludedDirectories = new Set([".git", "dist", "node_modules", "outputs", ".wrangler"]);

async function collect(directory, relative = "") {
  const entries = await readdir(directory, { withFileTypes: true });
  const files = [];
  for (const entry of entries) {
    if (entry.isDirectory() && excludedDirectories.has(entry.name)) continue;
    const childRelative = path.join(relative, entry.name);
    const childPath = path.join(directory, entry.name);
    if (entry.isDirectory()) files.push(...await collect(childPath, childRelative));
    else if (entry.isFile() && childRelative !== outputName) files.push(childRelative);
  }
  return files;
}

const files = (await collect(root)).sort((a, b) => a.localeCompare(b, "en"));
const lines = [];
for (const relative of files) {
  const filename = path.join(root, relative);
  const hash = createHash("sha256");
  let pointer = "";
  for await (const bytes of createReadStream(filename)) {
    if (relative.startsWith("source-model") && !pointer) pointer = bytes.subarray(0, 250).toString("utf8");
    hash.update(bytes);
  }
  const lfs = pointer.startsWith("version https://git-lfs.github.com/spec/v1\n") && pointer.match(/\noid sha256:([a-f0-9]{64})\nsize \d+/);
  const digest = lfs ? lfs[1] : hash.digest("hex");
  lines.push(`${digest}  ${relative.split(path.sep).join("/")}`);
}
await writeFile(path.join(root, outputName), `${lines.join("\n")}\n`, "utf8");
console.log(`Wrote ${outputName} for ${files.length} files.`);
