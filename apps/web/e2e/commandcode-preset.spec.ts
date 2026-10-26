import { expect, test } from "@playwright/test";
import {
  captureScreenshot,
  completeOnboarding,
  openModelConnection,
  openUserSettings,
  signup,
} from "./helpers";

for (const surface of ["settings", "onboarding"] as const) {
  test(`${surface} CommandCode preset uses the compatible connection form`, async ({
    page,
  }, testInfo) => {
    if (surface === "onboarding") {
      await page.route("**/rpc/me", async (route) => {
        const response = await route.fetch();
        const body = await response.json();
        await route.fulfill({ response, json: { json: { ...body.json, needsModel: true } } });
      });
    }
    await signup(
      page,
      `commandcode-${surface}-${Date.now()}@rakazo.test`,
      "password12",
      "Preset fixture",
    );
    if (surface === "settings") {
      await completeOnboarding(page);
      await openUserSettings(page, "models");
      await openModelConnection(page, "CommandCode");
    } else {
      await page.getByRole("combobox", { name: "Provider", exact: true }).click();
      await page.getByRole("option", { name: "CommandCode", exact: true }).click();
    }
    await expect(page.getByLabel("OpenAI-compatible server URL")).toHaveValue(
      "https://api.commandcode.ai/provider/v1",
    );
    const key = page.getByLabel("API key", { exact: true });
    await expect(key).toBeVisible();
    await expect(key).toHaveAttribute("required", "");
    await key.fill("fake-fixture-key");
    await page.route("**/rpc/models/probeOpenAiCompatible", async (route) => {
      expect(route.request().postDataJSON().json).toMatchObject({
        baseUrl: "https://api.commandcode.ai/provider/v1",
        apiKey: "fake-fixture-key",
      });
      await route.fulfill({ json: { json: { models: ["fixture-model"] } } });
    });
    await page.getByRole("button", { name: "Find models", exact: true }).click();
    await expect(page.getByRole("combobox", { name: "Models from server" })).toBeVisible();
    await captureScreenshot(page, testInfo, `${surface}-commandcode-preset`);
    await page.setViewportSize({ width: 390, height: 844 });
    await expect(key).toBeVisible();
    await captureScreenshot(page, testInfo, `${surface}-commandcode-preset-narrow`);
  });
}
