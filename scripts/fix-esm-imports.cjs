const fs = require("node:fs");
const path = require("node:path");

const root = path.join(process.cwd(), "lib");
const staleNestedLib = path.join(root, "lib");

if (fs.existsSync(staleNestedLib)) {
  fs.rmSync(staleNestedLib, { recursive: true, force: true });
}

function addJsExtension(specifier) {
  if (!/^\.\.?\//.test(specifier)) return specifier;
  if (path.extname(specifier)) return specifier;
  return `${specifier}.js`;
}

function rewriteFile(filePath) {
  const original = fs.readFileSync(filePath, "utf-8");
  const rewritten = original
    .replace(
      /(from\s*["'])(\.\.?[^\s"']+)(["'])/g,
      (_match, prefix, specifier, suffix) =>
        `${prefix}${addJsExtension(specifier)}${suffix}`,
    )
    .replace(
      /(import\(\s*["'])(\.\.?[^\s"']+)(["']\s*\))/g,
      (_match, prefix, specifier, suffix) =>
        `${prefix}${addJsExtension(specifier)}${suffix}`,
    );

  if (rewritten !== original) {
    fs.writeFileSync(filePath, rewritten, "utf-8");
  }
}

function walk(dir) {
  for (const entry of fs.readdirSync(dir, { withFileTypes: true })) {
    const filePath = path.join(dir, entry.name);
    if (entry.isDirectory()) {
      if (entry.name !== "lib") walk(filePath);
    } else if (entry.isFile() && entry.name.endsWith(".js")) {
      rewriteFile(filePath);
    }
  }
}

walk(root);
