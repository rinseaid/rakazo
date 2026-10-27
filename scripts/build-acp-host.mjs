import { cp, mkdir, rm, writeFile } from "node:fs/promises";
import { createRequire } from "node:module";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { build } from "esbuild";

// Explicit optional image artifact; this does not install or execute the vendor runtime.
const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..");
const destination = path.resolve(
  process.argv[2] ?? path.join(root, "infra/sandboxes/computer/generated"),
);
await mkdir(destination, { recursive: true });
await build({
  absWorkingDir: root,
  entryPoints: ["packages/adapters/src/cli/acp-host.ts"],
  outfile: path.join(destination, "rakazo-acp-host.mjs"),
  bundle: true,
  platform: "node",
  format: "esm",
  target: "node22",
  banner: {
    js: "#!/usr/bin/env node\nimport { createRequire as __createRequire } from 'node:module'; const require = __createRequire(import.meta.url);",
  },
  sourcemap: false,
  legalComments: "eof",
});

// The bundled helper still loads sharp's platform-specific native modules at runtime.
// Copy the lockfile-selected Linux packages beside the bundle for the x64 ACP image.
const requireFromAdapters = createRequire(path.join(root, "packages/adapters/package.json"));
const requireFromSharp = createRequire(requireFromAdapters.resolve("sharp"));
for (const name of ["sharp-linux-x64", "sharp-libvips-linux-x64"]) {
  const source = path.dirname(requireFromSharp.resolve(`@img/${name}/package`));
  const target = path.join(destination, "node_modules/@img", name);
  await rm(target, { recursive: true, force: true });
  await mkdir(path.dirname(target), { recursive: true });
  await cp(source, target, { recursive: true, dereference: true });
}

// Materialize the fixed hook from its single source; no runtime/account execution.
const gateBundle = await build({
  absWorkingDir: root,
  entryPoints: ["packages/adapters/src/google-acp-tool-gate.ts"],
  bundle: true,
  platform: "node",
  format: "esm",
  target: "node22",
  write: false,
});
const gateModule = await import(
  `data:text/javascript;base64,${Buffer.from(gateBundle.outputFiles[0].text).toString("base64")}`
);
await writeFile(
  path.join(destination, "rakazo-acp-tool-gate.mjs"),
  gateModule.GOOGLE_ACP_GATE_SCRIPT,
);
