import { readFile } from "node:fs/promises";
import { describe, expect, it } from "vitest";
import { version } from "../src/index.js";

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
      publishConfig?: { access: string; registry?: string };
    };
    const license = await readFile("LICENSE", "utf8");

    expect(packageJson.name).toBe("@richardyu114/moryn");
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

  it("reports the package version from the public API", async () => {
    const packageJson = JSON.parse(await readFile("package.json", "utf8")) as {
      version: string;
    };

    expect(version).toBe(packageJson.version);
  });
});
