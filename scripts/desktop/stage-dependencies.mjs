import { copyFileSync, existsSync, mkdirSync, readFileSync, readdirSync, realpathSync, statSync } from "node:fs";
import { dirname, join, relative, resolve, sep } from "node:path";

export function stageDependencies(output, destination) {
  const traces = [];
  const dependencies = {};
  const copied = new Set();

  function collectTraces(directory) {
    for (const entry of readdirSync(directory, { withFileTypes: true })) {
      const source = join(directory, entry.name);
      if (entry.isDirectory() && !["standalone", "node_modules", "cache"].includes(entry.name)) {
        collectTraces(source);
      } else if (entry.isFile() && entry.name.endsWith(".nft.json")) {
        traces.push(source);
      }
    }
  }

  function copyDependency(source) {
    if (!existsSync(source)) {
      throw new Error(`Traced runtime dependency is missing: ${source}`);
    }
    const actual = realpathSync(source);
    const marker = `${sep}node_modules${sep}`;
    const packageOffset = actual.lastIndexOf(marker);
    if (packageOffset === -1) return;
    const segments = actual.slice(packageOffset + marker.length).split(sep);
    if (segments[0].startsWith(".")) return;
    const packageSegments = segments[0].startsWith("@") ? segments.slice(0, 2) : segments.slice(0, 1);
    const packageRoot = join(actual.slice(0, packageOffset + marker.length), ...packageSegments);
    const manifestPath = join(packageRoot, "package.json");
    if (!existsSync(manifestPath)) {
      throw new Error(`Traced package has no manifest: ${packageRoot}`);
    }
    const manifest = JSON.parse(readFileSync(manifestPath, "utf8"));
    if (manifest.name !== packageSegments.join("/")) {
      throw new Error(`Unexpected traced package name: ${packageRoot}`);
    }
    if (dependencies[manifest.name] && dependencies[manifest.name] !== manifest.version) {
      throw new Error(`Multiple runtime versions of ${manifest.name} cannot be flattened safely.`);
    }
    const firstPackage = !dependencies[manifest.name];
    dependencies[manifest.name] = manifest.version;
    const targetRoot = join(destination, "node_modules", ...packageSegments);
    if (firstPackage) {
      mkdirSync(targetRoot, { recursive: true });
      copyFileSync(manifestPath, join(targetRoot, "package.json"));
      for (const entry of readdirSync(packageRoot)) {
        if (/^(licen[sc]e|notice|copying)([.-]|$)/i.test(entry) && statSync(join(packageRoot, entry)).isFile()) {
          copyFileSync(join(packageRoot, entry), join(targetRoot, entry));
        }
      }
    }
    if (statSync(actual).isDirectory()) return;
    const target = join(destination, "node_modules", ...packageSegments, relative(packageRoot, actual));
    if (copied.has(target)) return;
    copied.add(target);
    mkdirSync(dirname(target), { recursive: true });
    copyFileSync(actual, target);
  }

  collectTraces(output);
  if (!traces.length) throw new Error("Next.js produced no runtime dependency traces.");
  for (const trace of traces) {
    const manifest = JSON.parse(readFileSync(trace, "utf8"));
    for (const source of manifest.files) {
      const absolute = resolve(dirname(trace), source);
      if (absolute.includes(`${sep}node_modules${sep}`)) copyDependency(absolute);
    }
  }
  console.log(`[desktop] ${Object.keys(dependencies).length} runtime packages, ${copied.size} traced files`);
  return dependencies;
}
