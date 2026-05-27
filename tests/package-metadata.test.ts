import { readFile } from "node:fs/promises";
import { describe, expect, it } from "vitest";

describe("package metadata", () => {
  it("is ready for scoped npm publication", async () => {
    const packageJson = JSON.parse(await readFile("package.json", "utf8")) as {
      name: string;
      license: string;
      repository?: { type: string; url: string };
      bugs?: { url: string };
      homepage?: string;
      publishConfig?: { access: string };
    };
    const license = await readFile("LICENSE", "utf8");

    expect(packageJson.name).toBe("@richardyu114/memora");
    expect(packageJson.license).toBe("MIT");
    expect(packageJson.repository).toEqual({
      type: "git",
      url: "git+ssh://git@github.com/Richardyu114/Memora.git"
    });
    expect(packageJson.bugs?.url).toBe("https://github.com/Richardyu114/Memora/issues");
    expect(packageJson.homepage).toBe("https://github.com/Richardyu114/Memora#readme");
    expect(packageJson.publishConfig?.access).toBe("public");
    expect(license).toContain("MIT License");
    expect(license).toContain("Richard Yu");
  });
});
