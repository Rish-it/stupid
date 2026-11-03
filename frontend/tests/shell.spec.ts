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

const signedIn = { signed_in: true, name: "Test", selected: ["ads:act_1"], assets: [
  { key: "ads:act_1", kind: "ads", id: "act_1", name: "Test ad account" },
  { key: "instagram:1", kind: "instagram", id: "1", name: "Test Instagram" },
] };

test("returning from Meta opens Connections and saves account switches", async ({ page }) => {
  await page.route("**/api/me", route => route.fulfill(json(signedIn)));
  let saved: unknown;
  await page.route("**/api/connections", route => {
    saved = route.request().postDataJSON();
    route.fulfill(json({ assets: signedIn.assets, selected: (saved as { selected: string[] }).selected }));
  });
  await page.goto("/?connected=1");
  await expect(page.getByText("You're connected")).toBeVisible();
  await expect(page).toHaveURL(/\/#connections$/);
  await expect(page.getByRole("link", { name: "Connect WhatsApp" })).toHaveAttribute("href", "/api/v1/meta/oauth/start");
  const instagram = page.getByRole("switch", { name: "Test Instagram" });
  await expect(instagram).not.toBeChecked();
  await instagram.click();
  await expect(instagram).toBeChecked();
  expect(saved).toEqual({ selected: ["ads:act_1", "instagram:1"] });
});

test("a refused Meta sign-in says nothing was shared", async ({ page }) => {
  await page.route("**/api/me", route => route.fulfill(json({ signed_in: false })));
  await page.goto("/?meta_error=1");
  await expect(page.getByText("Facebook didn't connect")).toBeVisible();
  await expect(page).toHaveURL(/\/$/);
});
