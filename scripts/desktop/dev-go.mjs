import { spawn } from "node:child_process";
import { readFileSync, mkdirSync } from "node:fs";
import { join } from "node:path";

const root = process.cwd();
const version = JSON.parse(readFileSync(join(root, "package.json"), "utf8")).version;
const data = process.env.HELIOS_DATA_DIR ?? join(root, "data");
const media = process.env.HELIOS_MEDIA_DIR ?? join(root, "public", "generated");
mkdirSync(join(root, ".mygo"), { recursive: true });
const backend = join(root, ".mygo", process.platform === "win32" ? "dev-server.exe" : "dev-server");
const children = new Set();
let stopping = false;
function shutdown() {
  if (stopping) return;
  stopping = true;
  for (const child of children) child.kill("SIGTERM");
}
function launch(command, args, options = {}) {
  const child = spawn(command, args, { cwd: root, stdio: "inherit", env: process.env, ...options });
  children.add(child);
  child.on("error", (error) => { console.error(error); process.exitCode = 1; shutdown(); });
  child.on("exit", (code) => { children.delete(child); if (code) process.exitCode = code; shutdown(); });
  return child;
}
process.on("SIGINT", shutdown);
process.on("SIGTERM", shutdown);
const compiler = spawn("go", ["build", "-o", backend, "./cmd/helios-server"], { cwd: root, stdio: "inherit" });
compiler.on("error", (error) => { console.error(error); process.exitCode = 1; });
compiler.on("exit", (code) => {
  if (code || stopping) { process.exitCode = code ?? 1; return; }
  launch(backend, ["-data", data, "-media", media, "-version", version]);
  launch(process.execPath, [join(root, "node_modules", "vite", "bin", "vite.js"), "--host", "127.0.0.1"]);
});
