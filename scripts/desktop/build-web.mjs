import { spawnSync } from "node:child_process";

const runner = process.platform === "win32" ? "pnpm.cmd" : "pnpm";
const defaults = spawnSync(process.execPath, ["scripts/desktop/sync-go-models.mjs", "--check"], { stdio: "inherit" });
if (defaults.status !== 0) process.exit(defaults.status ?? 1);
const result = spawnSync(runner, ["web:build"], { stdio: "inherit", shell: process.platform === "win32" });
if (result.status !== 0) process.exit(result.status ?? 1);
const verify = spawnSync("go", ["test", "./..."], { stdio: "inherit" });
if (verify.status !== 0) process.exit(verify.status ?? 1);
