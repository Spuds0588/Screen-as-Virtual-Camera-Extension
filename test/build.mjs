// Builds dist/dev: the shipped extension plus localhost content-script coverage so the harness page
// behaves like a meeting platform. Nothing here is shipped; dist/ is git-ignored.
import { cp, mkdir, readFile, rm, writeFile } from "node:fs/promises";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";

const here = dirname(fileURLToPath(import.meta.url));
const root = join(here, "..");
const source = join(root, "extension");
const outDir = join(root, "dist", "dev");

const LOCAL_MATCHES = ["http://localhost/*", "http://127.0.0.1/*"];

const manifest = JSON.parse(await readFile(join(source, "manifest.json"), "utf8"));

for (const entry of manifest.content_scripts) {
  entry.matches = [...LOCAL_MATCHES, ...entry.matches];
}
// The test driver starts captures from the service worker, which has no activeTab grant.
manifest.host_permissions = LOCAL_MATCHES;
manifest.name = `${manifest.name} (dev)`;

await rm(outDir, { recursive: true, force: true });
await mkdir(outDir, { recursive: true });
await cp(source, outDir, { recursive: true });
await writeFile(join(outDir, "manifest.json"), `${JSON.stringify(manifest, null, 2)}\n`);

console.log(`[test:build] wrote ${outDir}`);
