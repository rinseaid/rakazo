import { createServer } from "node:http";
import type { AddressInfo } from "node:net";
import { expect, test } from "@playwright/test";
import { captureScreenshot, completeOnboarding, openUserSettings, rpc, signup } from "./helpers";

test("a custom usage endpoint saves and displays its own windows", async ({ page }, testInfo) => {
  const errors: string[] = [];
  page.on("pageerror", () => errors.push("pageerror"));
  page.on("console", (message) => {
    if (message.type() === "error") errors.push("consoleerror");
  });
  const server = createServer((_request, response) => {
    response.writeHead(200, { "content-type": "application/json" });
    response.end(
      JSON.stringify({
        windows: [{ id: "daily", usedPercent: 35, resetsAt: "2030-01-07T12:00:00.000Z" }],
      }),
    );
  });
  await new Promise<void>((resolve) => server.listen(0, "127.0.0.1", resolve));
  try {
    await signup(page, `custom-usage-${Date.now()}@rakazo.test`, "password12", "Usage fixture");
    await completeOnboarding(page);
    const credential = await rpc<{ id: string }>(page, "models/connect", {
      provider: "opencode-go",
      credentialId: null,
      label: "My provider",
      modelId: "glm-5.3-flash",
      apiKey: "fixture-key",
      makeDefault: false,
    });
    await openUserSettings(page, "models");
    await page.getByTestId(`model-provider-${credential.id}`).getByRole("button").first().click();
    const selector = page.getByTestId("custom-usage");
    await selector.locator("summary").click();
    const endpoint = `http://127.0.0.1:${(server.address() as AddressInfo).port}/usage`;
    await selector.getByLabel("Usage endpoint URL").fill(endpoint);
    await selector.getByRole("button", { name: "Save", exact: true }).click();
    await expect(selector.getByRole("status")).toHaveText("Saved");
    await captureScreenshot(page, testInfo, "custom-usage-settings");
    await page.setViewportSize({ width: 390, height: 844 });
    await selector.scrollIntoViewIfNeeded();
    expect(
      await page
        .getByTestId("settings-scroll")
        .evaluate((node) => node.scrollWidth > node.clientWidth + 1),
    ).toBe(false);
    await captureScreenshot(page, testInfo, "custom-usage-narrow");
    await page.setViewportSize({ width: 1280, height: 900 });
    await page.getByTestId("settings-nav-usage").click();
    const card = page.getByTestId(`provider-quota-${credential.id}`);
    await expect(card).toContainText("daily");
    await expect(card).toContainText("65% remaining");
    await page.reload();
    const stored = await rpc<{ endpoint: string; hasToken: boolean }>(page, "models/customUsage", {
      credentialId: credential.id,
    });
    expect(stored).toEqual({ endpoint, hasToken: false });
    await openUserSettings(page, "models");
    await page.getByTestId(`model-provider-${credential.id}`).getByRole("button").first().click();
    await page.getByTestId("custom-usage").locator("summary").click();
    await expect(page.getByLabel("Usage endpoint URL")).toHaveValue(endpoint);
    await expect(page.getByText("Usage accounts", { exact: true })).toHaveCount(0);
    expect(errors).toEqual([]);
  } finally {
    await new Promise<void>((resolve, reject) =>
      server.close((error) => (error ? reject(error) : resolve())),
    );
  }
});
