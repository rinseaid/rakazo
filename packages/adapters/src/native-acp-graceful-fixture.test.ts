import { describe, expect, it } from "vitest";
import { createGracefulFixtureHost } from "./native-acp-graceful-fixture.js";

const handlers = {
  update: () => {},
  permission: async () => ({ outcome: { outcome: "cancelled" } }),
};
describe("test-only graceful EOF lifecycle", () => {
  it("lets completed normal EOF finish without any process signal", async () => {
    const driver = createGracefulFixtureHost({
      executable: process.execPath,
      args: [
        "-e",
        "process.stdin.resume();process.stdin.on('end',()=>setTimeout(()=>process.exit(0),30));",
      ],
      cwd: process.cwd(),
      home: process.cwd(),
      eofGraceMs: 2000,
    });
    const transport = await driver.host.connect(handlers, new AbortController().signal);
    try {
      await driver.finishNormally();
      expect(driver.evidence).toEqual({
        normalFinishes: 1,
        eofExits: 1,
        termSignals: 0,
        killSignals: 0,
        groupsGone: 1,
        exitCode: 0,
      });
    } finally {
      await transport.close();
    }
  });
  it("times out EOF, cleans up, and refuses to qualify it as normal completion", async () => {
    const driver = createGracefulFixtureHost({
      executable: process.execPath,
      args: ["-e", "process.stdin.resume();setInterval(()=>{},1000);"],
      cwd: process.cwd(),
      home: process.cwd(),
      eofGraceMs: 100,
    });
    const transport = await driver.host.connect(handlers, new AbortController().signal);
    try {
      await expect(driver.finishNormally()).rejects.toThrow("Orderly EOF");
      expect(driver.evidence).toMatchObject({ eofExits: 0, termSignals: 1, groupsGone: 1 });
    } finally {
      await transport.close().catch(() => {});
    }
  });
  it("keeps cancellation on the immediate signal cleanup path", async () => {
    const controller = new AbortController();
    const driver = createGracefulFixtureHost({
      executable: process.execPath,
      args: ["-e", "process.stdin.resume();setInterval(()=>{},1000);"],
      cwd: process.cwd(),
      home: process.cwd(),
    });
    const transport = await driver.host.connect(handlers, controller.signal);
    controller.abort();
    await transport.close();
    await expect(driver.finishNormally()).rejects.toThrow("Aborted");
    expect(driver.evidence).toMatchObject({ eofExits: 0, termSignals: 1, groupsGone: 1 });
  });
});
