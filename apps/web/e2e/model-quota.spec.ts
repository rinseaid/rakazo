import { expect, test } from "@playwright/test";
import { captureScreenshot, completeOnboarding, openUserSettings, signup } from "./helpers";

test("provider allowances stack in Usage and its account menu popover", async ({
  page,
}, testInfo) => {
  await signup(page, `quota-${Date.now()}@rakazo.test`, "password12", "Quota Preview");
  await completeOnboarding(page);
  const errors: string[] = [];
  page.on("pageerror", (error) => errors.push(error.message));
  page.on("console", (message) => {
    if (message.type() === "error") errors.push(message.text());
  });
  const credentialId = "quota-claude-fixture";
  const credentials = [
    { id: "quota-go-fixture", provider: "opencode-go", label: "OpenCode Go", authKind: "api_key" },
    { id: "quota-goat-fixture", provider: "openai-compatible", label: "GOAT", authKind: "api_key" },
    { id: "quota-codex-fixture", provider: "openai-codex", label: "Codex", authKind: "oauth" },
    { id: credentialId, provider: "anthropic", label: "Claude", authKind: "oauth" },
  ].map((entry) => ({ ...entry, hasKey: entry.authKind !== "oauth", isDefault: false }));
  await page.route("**/rpc/models/credentials", (route) =>
    route.fulfill({ json: { json: credentials } }),
  );
  let usedPercent = 91;
  let policy = { enabled: false };
  let quotaReads = 0;
  await page.route("**/rpc/models/quotaPolicy", (route) =>
    route.fulfill({ json: { json: policy } }),
  );
  await page.route("**/rpc/models/setQuotaPolicy", async (route) => {
    const body = route.request().postDataJSON() as {
      json: { credentialId: string; policy: typeof policy };
    };
    expect(body.json.credentialId).toBe(credentialId);
    policy = body.json.policy;
    await route.fulfill({ json: { json: policy } });
  });
  await page.route("**/rpc/models/quota", (route) => {
    quotaReads++;
    const id = route.request().postDataJSON().json.credentialId as string;
    const supported = id === credentialId || id === "quota-codex-fixture";
    return route.fulfill({
      json: {
        json: {
          credentialId: id,
          status: supported ? "fresh" : "unsupported",
          identityVerified: supported,
          observedAt: supported ? "2030-03-17T12:00:00.000Z" : null,
          checkedAt: "2030-03-17T12:00:00.000Z",
          windows:
            id === credentialId
              ? [
                  {
                    id: "five_hour",
                    usedPercent: 0,
                    resetsAt: "2030-03-17T17:00:00.000Z",
                    modelIds: null,
                  },
                  {
                    id: "seven_day",
                    usedPercent,
                    resetsAt: "2030-03-20T12:00:00.000Z",
                    modelIds: null,
                  },
                ]
              : id === "quota-codex-fixture"
                ? [
                    {
                      id: "primary_window",
                      usedPercent: 45,
                      resetsAt: "2030-03-20T12:00:00.000Z",
                      modelIds: null,
                    },
                  ]
                : [],
        },
      },
    });
  });
  await page.getByTestId("user-menu-trigger").click();
  expect(quotaReads).toBe(0);
  await page.getByTestId("usage-menu-trigger").click();
  const preview = page.getByTestId("usage-popover");
  await expect(preview).toBeVisible();
  await expect(preview.getByTestId("provider-quota-stack").locator(":scope > div")).toHaveCount(4);
  await expect(preview).toContainText("OpenCode Go");
  await expect(preview).toContainText("GOAT");
  await expect(preview).toContainText("Codex");
  await expect(preview).toContainText("Claude");
  await expect(preview).toContainText("55% remaining");
  await expect(preview).toContainText("9% remaining");
  await expect(preview.getByText("Quota unavailable", { exact: true })).toHaveCount(2);
  await expect(preview.getByRole("checkbox")).toHaveCount(0);
  await captureScreenshot(page, testInfo, "provider-usage-menu");
  await page.keyboard.press("Escape");
  await expect(preview).not.toBeVisible();
  await expect(page.getByTestId("usage-menu-trigger")).toBeVisible();
  await page.getByTestId("usage-menu-trigger").click();
  await preview.getByRole("button", { name: "View usage", exact: true }).click();
  const usage = page.getByTestId("usage-settings");
  await expect(usage).toBeVisible();
  await expect(preview).not.toBeVisible();
  const quota = usage.getByTestId(`provider-quota-${credentialId}`);
  await expect(quota).toContainText("9% remaining");
  await expect(quota).toContainText("100% remaining");
  await expect(quota.locator("time").first()).toHaveAttribute(
    "datetime",
    "2030-03-17T17:00:00.000Z",
  );
  await captureScreenshot(page, testInfo, "provider-usage-stack");
  usedPercent = 100;
  await quota.getByRole("button", { name: "Refresh", exact: true }).click();
  await expect(quota).toContainText("0% remaining");
  await page.setViewportSize({ width: 390, height: 844 });
  await expect(quota).toBeVisible();
  await captureScreenshot(page, testInfo, "provider-usage-narrow");
  await page.getByRole("button", { name: "Close user settings", exact: true }).click();
  await page.getByRole("button", { name: "Open navigation", exact: true }).click();
  await page.getByTestId("user-menu-trigger").click();
  await page.getByTestId("usage-menu-trigger").click();
  await expect(preview).toBeVisible();
  const box = await preview.boundingBox();
  expect(box!.x).toBeGreaterThanOrEqual(0);
  expect(box!.x + box!.width).toBeLessThanOrEqual(390);
  expect(box!.y).toBeGreaterThanOrEqual(0);
  expect(box!.y + box!.height).toBeLessThanOrEqual(844);
  await captureScreenshot(page, testInfo, "provider-usage-menu-narrow");
  await preview.getByRole("button", { name: "View usage", exact: true }).click();
  await openUserSettings(page, "models");
  await page.getByTestId(`model-provider-${credentialId}`).getByRole("button").click();
  await expect(page.getByTestId("connection-quota")).toHaveCount(0);
  const routing = page.getByRole("checkbox", { name: "Skip exhausted accounts", exact: true });
  await routing.check();
  await page
    .getByTestId("user-settings")
    .getByRole("button", { name: "Save", exact: true })
    .click();
  await expect(page.getByRole("status").filter({ hasText: "Saved" })).toBeVisible();
  expect(policy).toEqual({ enabled: true });
  expect(errors).toEqual([]);
});
