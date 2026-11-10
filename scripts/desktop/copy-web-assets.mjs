import { cpSync, copyFileSync, existsSync, readdirSync, mkdirSync } from "node:fs";
import { join } from "node:path";

const destination = "desktop/resources/frontend";
cpSync("agent-skills", join(destination, "agent-skills"), { recursive: true });
for (const entry of readdirSync("public")) {
  if (entry === "generated") continue;
  cpSync(join("public", entry), join(destination, entry), { recursive: true });
}
if (existsSync("app/favicon.ico")) copyFileSync("app/favicon.ico", join(destination, "favicon.ico"));
const licenses = join(destination, "licenses");
mkdirSync(licenses, { recursive: true });
for (const [name, dependency] of [
  ["geist", "@fontsource-variable/geist"],
  ["geist-mono", "@fontsource-variable/geist-mono"],
  ["doto", "@fontsource/doto"],
]) copyFileSync(join("node_modules", dependency, "LICENSE"), join(licenses, `${name}.txt`));
