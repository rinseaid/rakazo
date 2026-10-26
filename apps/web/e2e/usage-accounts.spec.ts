import { expect, test } from "@playwright/test";
import { captureScreenshot, completeOnboarding, openUserSettings, rpc, signup } from "./helpers";

test("gateway usage links persist owned upstreams and show shared accounts once", async ({
  page,
}, testInfo) => {
  await signup(page, `usage-links-${Date.now()}@rakazo.test`, "password12", "Usage fixture");
  await completeOnboarding(page);
  const errors: string[] = [];
  page.on("pageerror", () => errors.push("pageerror"));
  page.on("console", (message) => {
    if (message.type() === "error") errors.push("consoleerror");
  });
  // Native upstream credentials and loopback gateways need no public-endpoint exception.
  const connect = (label: string, baseUrl?: string) =>
    rpc<{ id: string }>(page, "models/connect", {
      provider: baseUrl ? "openai-compatible" : "opencode-go",
      credentialId: null,
      label,
      baseUrl,
      modelId: baseUrl ? "fixture-model" : "glm-5.3-flash",
      apiKey: "fake-fixture-key",
      makeDefault: false,
    });
  const shared = await connect("Shared upstream");
  const personal = await connect("Personal upstream");
  const gateway = await connect("LiteLLM", "http://127.0.0.1:8091/v1");
  const other = await connect("Other gateway", "http://127.0.0.1:8092/v1");
  await rpc(page, "models/setUsageAccounts", {
    credentialId: other.id,
    usageAccountIds: [shared.id],
  });
  const quotaReads: string[] = [];
  await page.route("**/rpc/models/quota", async (route) => {
    const credentialId = route.request().postDataJSON().json.credentialId as string;
    quotaReads.push(credentialId);
    await route.fulfill({
      json: {
        json: {
          credentialId,
          status: "fresh",
          identityVerified: false,
          observedAt: "2030-01-01T12:00:00.000Z",
          checkedAt: "2030-01-01T12:00:00.000Z",
          windows: [
            {
              id: "seven_day",
              usedPercent: 35,
              resetsAt: "2030-01-07T12:00:00.000Z",
              modelIds: null,
            },
          ],
        },
      },
    });
  });
  await openUserSettings(page, "models");
  await page.getByTestId(`model-provider-${gateway.id}`).getByRole("button").first().click();
  const selector = page.getByTestId("usage-accounts");
  await selector.locator("summary").click();
  const checkboxes = selector.getByRole("checkbox");
  await expect(checkboxes).toHaveCount(2);
  await checkboxes.nth(0).check();
  await checkboxes.nth(1).check();
  await selector.getByRole("button", { name: "Save", exact: true }).click();
  await expect(selector.getByRole("status")).toHaveText("Saved");
  const stored = await rpc<Array<{ id: string; usageAccountIds?: string[] }>>(
    page,
    "models/credentials",
    {},
  );
  expect(stored.find((entry) => entry.id === gateway.id)?.usageAccountIds?.sort()).toEqual(
    [shared.id, personal.id].sort(),
  );
  await captureScreenshot(page, testInfo, "gateway-usage-accounts");
  await page.setViewportSize({ width: 390, height: 844 });
  await selector.scrollIntoViewIfNeeded();
  await expect(checkboxes.nth(0)).toBeInViewport();
  expect(
    await page
      .getByTestId("settings-scroll")
      .evaluate((node) => node.scrollWidth > node.clientWidth + 1),
  ).toBe(false);
  await captureScreenshot(page, testInfo, "gateway-usage-accounts-narrow");
  await page.setViewportSize({ width: 1280, height: 900 });
  await page.getByTestId("settings-nav-usage").click();
  const usage = page.getByTestId("usage-settings");
  await expect(usage.getByTestId("connection-quota")).toHaveCount(2);
  await expect(usage.getByTestId(`provider-quota-${shared.id}`)).toContainText("LiteLLM");
  await expect(usage.getByTestId(`provider-quota-${shared.id}`)).toContainText("Other gateway");
  await expect(usage.getByTestId(`provider-quota-${personal.id}`)).toContainText("LiteLLM");
  await expect(usage.getByRole("meter")).toHaveCount(2);
  expect(quotaReads.every((id) => id === shared.id || id === personal.id)).toBe(true);
  await captureScreenshot(page, testInfo, "gateway-upstream-usage");
  await page.reload();
  await openUserSettings(page, "models");
  await page.getByTestId(`model-provider-${gateway.id}`).getByRole("button").first().click();
  await page.getByTestId("usage-accounts").locator("summary").click();
  await expect(page.getByTestId("usage-accounts").getByRole("checkbox").nth(0)).toBeChecked();
  await expect(page.getByTestId("usage-accounts").getByRole("checkbox").nth(1)).toBeChecked();
  await rpc(page, "models/disconnect", { provider: "opencode-go", credentialId: shared.id });
  const after = await rpc<Array<{ id: string; usageAccountIds?: string[] }>>(
    page,
    "models/credentials",
    {},
  );
  expect(after.some((entry) => entry.id === shared.id)).toBe(false);
  expect(after.find((entry) => entry.id === gateway.id)?.usageAccountIds).toEqual([personal.id]);
  expect(after.find((entry) => entry.id === other.id)?.usageAccountIds).toEqual([]);
  expect(errors).toEqual([]);
});
