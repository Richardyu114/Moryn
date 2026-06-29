import { readFile } from "node:fs/promises";
import { execFile } from "node:child_process";
import { promisify } from "node:util";
import { describe, expect, it } from "vitest";
import { version } from "../src/index.js";

const exec = promisify(execFile);

describe("package metadata", () => {
  it("is ready for scoped npm publication", async () => {
    const packageJson = JSON.parse(await readFile("package.json", "utf8")) as {
      name: string;
      main?: string;
      types?: string;
      license: string;
      exports?: {
        "."?: {
          types?: string;
          import?: string;
        };
      };
      repository?: { type: string; url: string };
      bugs?: { url: string };
      homepage?: string;
      keywords?: string[];
      version: string;
      publishConfig?: { access: string; registry?: string };
    };
    const license = await readFile("LICENSE", "utf8");

    expect(packageJson.name).toBe("@richardyu114/moryn");
    expect(packageJson.version).toBe(version);
    expect(packageJson.main).toBe("./dist/index.js");
    expect(packageJson.types).toBe("./dist/index.d.ts");
    expect(packageJson.exports?.["."]).toEqual({
      types: "./dist/index.d.ts",
      import: "./dist/index.js"
    });
    expect(packageJson.license).toBe("MIT");
    expect(packageJson.repository).toEqual({
      type: "git",
      url: "git+https://github.com/Richardyu114/Moryn.git"
    });
    expect(packageJson.bugs?.url).toBe("https://github.com/Richardyu114/Moryn/issues");
    expect(packageJson.homepage).toBe("https://github.com/Richardyu114/Moryn#readme");
    expect(packageJson.keywords).toEqual(expect.arrayContaining(["agent", "memory", "mcp"]));
    expect(packageJson.publishConfig?.access).toBe("public");
    expect(packageJson.publishConfig?.registry).toBe("https://registry.npmjs.org");
    expect(license).toContain("MIT License");
    expect(license).toContain("Richard Yu");
  });

  it("keeps temporary development plans and local artifacts out of the packed package", async () => {
    const result = await exec("npm", ["pack", "--dry-run", "--json"], { cwd: process.cwd() });
    const packs = JSON.parse(result.stdout) as Array<{ files: Array<{ path: string }> }>;
    const files = packs[0]?.files.map((file) => file.path) ?? [];

    expect(files).toContain("README.md");
    expect(files).toContain("docs/implementation-roadmap.md");
    expect(files).not.toContain("docs/v0.2-phase-plan.md");
    expect(files.some((file) => file.startsWith("state/"))).toBe(false);
    expect(files.some((file) => file.includes(".moryn"))).toBe(false);
    expect(files.some((file) => file.endsWith(".tgz"))).toBe(false);
  }, 30000);
});
