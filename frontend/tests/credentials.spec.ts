import { expect, test } from "@playwright/test";

const json = (body: unknown) => ({ contentType: "application/json", body: JSON.stringify(body) });
const signedIn = { signed_in: true, name: "Test", assets: [], selected: [] };
test.beforeEach(({ page }) => page.route("**/api/stream", route => route.fulfill({ status: 404, ...json({ message: "Not found." }) })));

test("Settings explains optional key creation, charges and revocation before saving", async ({ page }) => {
  await page.route("**/api/me", route => route.fulfill(json(signedIn)));
  let writes = 0;
  await page.route("**/api/settings/ai", route => {
    if (route.request().method() !== "GET") writes++;
    return route.fulfill(json({ has_key: false, workspace_ai: true, model: "test-model" }));
  });
  await page.goto("/#settings");
  await page.getByRole("tab", { name: "AI model" }).click();
  await page.getByText("Use your own Baseten key", { exact: true }).click();
  await page.getByText("How to get, pay for and revoke a key", { exact: true }).click();
  await expect(page.getByText(/including the small call that checks a key/)).toBeVisible();
  await expect(page.getByText(/Call Model APIs → Create API key/)).toBeVisible();
  await expect(page.getByText(/select the trash icon beside this key/)).toBeVisible();
  await expect(page.getByRole("link", { name: "API keys" })).toHaveAttribute("href", "https://app.baseten.co/settings/api_keys");
  await expect(page.getByRole("link", { name: "Check current prices" })).toHaveAttribute("href", "https://docs.baseten.co/inference/model-apis/pricing-and-limits");
  await expect(page.getByRole("button", { name: "Save key" })).toBeDisabled();
  expect(writes).toBe(0);

});
