// Stages a self-contained Next.js server + a Node runtime for the MyGo bundle.
//
//   node scripts/desktop/build-server.mjs          # full production build + stage
// Invoked by MyGo through mygo.json buildCommand.

import { execFileSync } from "node:child_process";
import {
  cpSync,
  existsSync,
  mkdirSync,
  rmSync,
  chmodSync,
  copyFileSync,
  readFileSync,
  writeFileSync,
  readdirSync,
} from "node:fs";
import { join, dirname, sep } from "node:path";
import { fileURLToPath } from "node:url";

const ROOT = join(dirname(fileURLToPath(import.meta.url)), "..", "..");
const DESKTOP = join(ROOT, "desktop");
const STAGE = join(DESKTOP, "resources", "server");
const NEXT_OUTPUT = join(ROOT, "next-desktop");

const EXE = process.platform === "win32" ? ".exe" : "";

// Baked into the client bundle so the in-app update check
// (`app/api/update-check`) knows what version is running.
const APP_VERSION = JSON.parse(
  readFileSync(join(ROOT, "package.json"), "utf8"),
).version;

const nodeMajor = Number(process.version.slice(1).split(".")[0]);
if (nodeMajor < 22) {
  throw new Error(
    `desktop build needs Node >= 22 (running ${process.version}) — the bundled server uses node:sqlite. Try \`nvm use 22\`.`,
  );
}

function run(cmd, args, env = {}, cwd = ROOT) {
  execFileSync(cmd, args, {
    cwd,
    stdio: "inherit",
    env: { ...process.env, ...env },
    shell: process.platform === "win32",
  });
}

// Clear last run's staging *before* the build — otherwise the file tracer sweeps
// the previous server tree into next-desktop/standalone/desktop/resources and each build
// compounds. (next.config.ts also excludes desktop/resources from tracing.)
rmSync(STAGE, { recursive: true, force: true });
rmSync(NEXT_OUTPUT, { recursive: true, force: true });

console.log("[desktop] next build (standalone)…");
run("node", [join(ROOT, "node_modules", "next", "dist", "bin", "next"), "build"], {
  DESKTOP_BUILD: "1",
  // Baked into the client bundle — NEXT_PUBLIC_* vars can't be set at runtime
  // by the MyGo shell.
  NEXT_PUBLIC_APP_VERSION: APP_VERSION,
});

const STANDALONE = join(NEXT_OUTPUT, "standalone");
if (!existsSync(join(STANDALONE, "server.js"))) {
  throw new Error("next-desktop/standalone/server.js missing — is `output: \"standalone\"` active?");
}

console.log("[desktop] staging server →", STAGE);
cpSync(STANDALONE, STAGE, { recursive: true });
rmSync(join(STAGE, "desktop"), { recursive: true, force: true });
rmSync(join(STAGE, "build"), { recursive: true, force: true });
rmSync(join(STAGE, ".next"), { recursive: true, force: true });
cpSync(join(NEXT_OUTPUT, "server"), join(STAGE, "next-desktop", "server"), { recursive: true });
cpSync(join(NEXT_OUTPUT, "static"), join(STAGE, "next-desktop", "static"), { recursive: true });
copyFileSync(join(ROOT, "scripts", "desktop", "sidecar-guard.js"), join(STAGE, "sidecar-guard.js"));
if (existsSync(join(ROOT, "public"))) {
  cpSync(join(ROOT, "public"), join(STAGE, "public"), {
    recursive: true,
    filter: (src) => !src.includes(`${sep}public${sep}generated`), // runtime data, not an asset
  });
}

// The Next.js file tracer (nft) is unreliable with pnpm's symlinked store — it
// leaves many packages as a bare package.json. Rather than chase truncations,
// throw away the traced node_modules and do a clean production install from the
// app's own manifest, giving a flat, symlink-free, self-contained tree.
// nft is unreliable with pnpm (leaves packages truncated), so install the prod
// tree cleanly with npm instead. The repo is pnpm-managed with a stale
// package-lock.json, and `next build` output is tied to the EXACT `next` version
// that produced it — so pin every prod dep to the version actually installed in
// the repo before installing, rather than letting npm re-resolve `^` ranges.
console.log("[desktop] clean production install into stage…");
rmSync(join(STAGE, "node_modules"), { recursive: true, force: true });

const rootPkg = JSON.parse(readFileSync(join(ROOT, "package.json"), "utf8"));
const pinned = {};
for (const name of Object.keys(rootPkg.dependencies ?? {})) {
  try {
    const v = JSON.parse(
      readFileSync(join(ROOT, "node_modules", ...name.split("/"), "package.json"), "utf8"),
    ).version;
    pinned[name] = v;
  } catch {
    pinned[name] = rootPkg.dependencies[name]; // fall back to the range
  }
}
writeFileSync(
  join(STAGE, "package.json"),
  JSON.stringify({ ...rootPkg, dependencies: pinned, devDependencies: {} }, null, 2),
);
run("npm", ["install", "--omit=dev", "--no-audit", "--no-fund", "--no-package-lock"], {}, STAGE);

// Sanity check: the standalone server's own entry deps must be intact.
for (const probe of ["next/package.json", "@next/env/package.json", "react/package.json"]) {
  if (!existsSync(join(STAGE, "node_modules", ...probe.split("/")))) {
    throw new Error(`staged install is missing ${probe}`);
  }
}
const aliasesDir = join(NEXT_OUTPUT, "node_modules");
if (existsSync(aliasesDir)) {
  const aliases = readdirSync(aliasesDir).filter((name) => !name.startsWith(".")).flatMap((name) =>
    name.startsWith("@") ? readdirSync(join(aliasesDir, name)).map((child) => `${name}/${child}`) : [name],
  );
  for (const alias of aliases) {
    const original = JSON.parse(readFileSync(join(aliasesDir, alias, "package.json"), "utf8"));
    if (alias === original.name) continue;
    const installed = join(STAGE, "node_modules", ...original.name.split("/"));
    const installedPackage = JSON.parse(readFileSync(join(installed, "package.json"), "utf8"));
    if (installedPackage.version !== original.version) throw new Error(`External package version mismatch for ${alias}.`);
    cpSync(installed, join(STAGE, "next-desktop", "node_modules", ...alias.split("/")), { recursive: true });
  }
}
run("node", ["-e", "require('./next-desktop/server/app/api/health/route.js'); require('./next-desktop/server/app/api/settings/provider/models/route.js')"], {}, STAGE);

// Prune what a prebuilt standalone server never loads at runtime:
//  - @next/swc-* : the SWC compiler, build-time only (~95 MB)
//  - sharp/@img native packages for other platforms (~15 MB)
const platformTriple = `${process.platform}-${process.arch}`; // e.g. darwin-arm64
const nmScoped = (scope) => join(STAGE, "node_modules", scope);
for (const [dir, keepIf] of [
  [nmScoped("@next"), (n) => !n.startsWith("swc-")],
  [nmScoped("@img"), (n) => n.includes(platformTriple) || !/-(darwin|linux|linuxmusl|win32|wasm32)/.test(n)],
]) {
  if (!existsSync(dir)) continue;
  for (const name of readdirSync(dir)) {
    if (!keepIf(name)) rmSync(join(dir, name), { recursive: true, force: true });
  }
}


const nodeDest = join(STAGE, "node-bin", `node${EXE}`);
mkdirSync(dirname(nodeDest), { recursive: true });
console.log(`[desktop] bundling node runtime → ${nodeDest}`);
copyFileSync(portableNodeBinary(), nodeDest);
if (process.platform !== "win32") chmodSync(nodeDest, 0o755);


/**
 * `process.execPath` is only safe to bundle if it's a self-contained binary.
 * Homebrew's node splits off `libnode.*.dylib`, which would break outside this
 * machine — detect that and fall back to a cached official nodejs.org build.
 */
function portableNodeBinary() {
  const exe = process.execPath;
  if (process.platform === "darwin") {
    try {
      const libs = execFileSync("otool", ["-L", exe], { encoding: "utf8" });
      if (!/libnode\.\S+\.dylib/.test(libs)) return exe; // static — good
    } catch {
      return exe;
    }
    console.log("[desktop] running under a non-portable node — fetching official build");
  } else {
    return exe;
  }

  const ver = process.version; // e.g. v22.23.2
  const arch = process.arch === "x64" ? "x64" : process.arch; // arm64 stays arm64
  const name = `node-${ver}-darwin-${arch}`;
  const cacheDir = join(DESKTOP, ".node-cache");
  const cached = join(cacheDir, name, "bin", "node");
  if (!existsSync(cached)) {
    mkdirSync(cacheDir, { recursive: true });
    const tgz = join(cacheDir, `${name}.tar.gz`);
    run("curl", ["-fsSL", "-o", tgz, `https://nodejs.org/dist/${ver}/${name}.tar.gz`]);
    run("tar", ["-xzf", tgz, "-C", cacheDir, `${name}/bin/node`]);
  }
  return cached;
}

if (process.platform === "darwin" && process.env.APPLE_SIGNING_IDENTITY) {
  const identity = process.env.APPLE_SIGNING_IDENTITY;
  const ents = join(DESKTOP, "entitlements.plist");
  const macho = execFileSync(
    "sh",
    ["-c", `find '${STAGE}/node_modules' -type f \\( -name '*.node' -o -name '*.dylib' -o -name '*.so' \\)`],
    { encoding: "utf8" },
  )
    .split("\n")
    .filter(Boolean);
  macho.push(nodeDest); // the bundled Node runtime
  console.log(`[desktop] codesigning ${macho.length} Mach-O files…`);
  for (const f of macho) {
    run("codesign", [
      "--force", "--timestamp", "--options", "runtime",
      "--entitlements", ents, "-s", identity, f,
    ]);
  }
}

console.log("[desktop] done.");
