import { readFileSync, writeFileSync } from "node:fs";
import ts from "typescript";

const source = readFileSync("lib/modelConfig.ts", "utf8");
const compiled = ts.transpileModule(source, { compilerOptions: { module: ts.ModuleKind.CommonJS, target: ts.ScriptTarget.ES2022 } }).outputText;
const exported = {};
new Function("exports", compiled)(exported);
const presets = {};
const presetSource = ts.transpileModule(readFileSync("lib/modelParameterPresets.ts", "utf8"), { compilerOptions: { module: ts.ModuleKind.CommonJS, target: ts.ScriptTarget.ES2022 } }).outputText;
new Function("exports", "require", presetSource)(presets, (specifier) => {
  if (specifier === "./modelConfig") return exported;
  throw new Error(`Unexpected model preset dependency: ${specifier}`);
});
const contents = `package server\n\nconst legacyImageModelsJSON = \`${JSON.stringify(exported.IMAGE_MODELS)}\`\n\nconst modelParameterPresetsJSON = \`${JSON.stringify(presets.MODEL_PARAMETER_PRESETS)}\`\n`;
const filename = "internal/server/legacy_models.go";
let previous = "";
try { previous = readFileSync(filename, "utf8"); } catch {}
if (previous !== contents) {
  if (process.argv.includes("--check")) throw new Error("Go model defaults are out of date; run node scripts/desktop/sync-go-models.mjs.");
  writeFileSync(filename, contents);
}
