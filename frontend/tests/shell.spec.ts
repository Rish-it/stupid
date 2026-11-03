import { expect, test } from "@playwright/test";

const json = (body: unknown) => ({ contentType: "application/json", body: JSON.stringify(body) });

test("shows a clear offline state when the server is down", async ({ page }) => {
  await page.route("**/api/**", route => route.abort());
  await page.goto("/");
  await expect(page.getByRole("heading", { name: "Secnd is offline" })).toBeVisible();
  await expect(page.getByText("Not an official Meta product.")).toBeVisible();
});

test("asks a signed-out visitor to continue with Facebook", async ({ page }) => {
  await page.route("**/api/me", route => route.fulfill(json({ signed_in: false })));
  await page.goto("/");
  await expect(page.getByRole("link", { name: "Continue with Facebook" })).toHaveAttribute("href", "/api/v1/meta/oauth/start");
});

test("a signed-in person moves between destinations", async ({ page }) => {
  await page.route("**/api/me", route => route.fulfill(json({ signed_in: true, name: "Test", assets: [], selected: [] })));
  await page.goto("/");
  await expect(page.getByRole("heading", { name: "Today" })).toBeVisible();
  await page.getByRole("link", { name: "Inbox" }).click();
  await expect(page.getByRole("heading", { name: "Inbox" })).toBeVisible();
  await expect(page.getByRole("link", { name: "Inbox" })).toHaveAttribute("aria-current", "page");
});
