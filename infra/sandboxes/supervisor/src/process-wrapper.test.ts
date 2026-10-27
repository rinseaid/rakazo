import { execFileSync } from "node:child_process";
import { fileURLToPath } from "node:url";
import { expect, it } from "vitest";

it.skipIf(process.platform !== "linux")("checks duplex process lifecycle offline", () => {
  const tests = fileURLToPath(new URL("../../computer/test_process.py", import.meta.url));
  expect(() => execFileSync("python3", [tests], { timeout: 20_000, stdio: "pipe" })).not.toThrow();
});
