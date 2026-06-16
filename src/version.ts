import { readFileSync } from "node:fs";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";

type PackageMetadata = {
  version?: unknown;
};

const packageJsonPath = join(dirname(fileURLToPath(import.meta.url)), "..", "package.json");
const packageMetadata = JSON.parse(readFileSync(packageJsonPath, "utf8")) as PackageMetadata;

if (typeof packageMetadata.version !== "string") {
  throw new Error(`Missing package version in ${packageJsonPath}`);
}

export const version = packageMetadata.version;
