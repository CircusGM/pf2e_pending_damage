import { readFileSync, readdirSync, existsSync } from "node:fs";
import { execFileSync } from "node:child_process";
import assert from "node:assert/strict";
import path from "node:path";

const manifest = JSON.parse(readFileSync("module.json", "utf8"));
assert.equal(manifest.id, "pf2e-pending-damage");
assert.equal(manifest.compatibility.minimum, "14.361");
assert.equal(manifest.compatibility.verified, "14");
assert.equal(manifest.compatibility.maximum, "15");
assert.equal(manifest.socket, true);
assert.ok(manifest.authors.some(author => author.name === "CircusGM"));
assert.equal(manifest.relationships.requires.find(d => d.id === "pf2e-toolbelt").compatibility.minimum, "3.56.3");
assert.ok(manifest.relationships.requires.some(d => d.id === "lib-wrapper"));
for (const [field, token] of Object.entries({ version: "VERSION", url: "URL", manifest: "MANIFEST", download: "DOWNLOAD" })) {
    assert.equal(manifest[field], `#{${token}}#`);
}
for (const file of [...manifest.esmodules, ...manifest.styles, ...manifest.languages.map(lang => lang.path),
    manifest.license, manifest.readme, "LICENSE-PF2E", "NOTICE"]) assert.ok(existsSync(file), file);
const translations = JSON.parse(readFileSync("lang/en.json", "utf8"))[manifest.id];
for (const folder of ["scripts", "tests", "tests/helpers", "tools"]) {
    for (const name of readdirSync(folder).filter(name => /\.(m?js)$/.test(name))) {
        const file = path.join(folder, name);
        execFileSync(process.execPath, ["--check", file], { stdio: "inherit" });
        if (folder !== "scripts") continue;
        const source = readFileSync(file, "utf8");
        for (const [, specifier] of source.matchAll(/from\s+"([^"]+)"/g)) {
            assert.ok(specifier.startsWith("./"), `Runtime imports must resolve within the module: ${file}`);
            assert.ok(existsSync(path.join(folder, specifier)), `Missing runtime import: ${specifier}`);
        }
        for (const [, key] of source.matchAll(/localize\("([^"]+)"/g)) {
            assert.equal(typeof key.split(".").reduce((obj, part) => obj?.[part], translations), "string", `Missing translation: ${key}`);
        }
    }
}
console.log("Manifest, runtime imports, localization and JavaScript syntax checks passed.");
