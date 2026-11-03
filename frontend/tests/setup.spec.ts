import { expect, test } from "@playwright/test";

const json = (body: unknown) => ({ contentType: "application/json", body: JSON.stringify(body) });
// The preview server proxies /api to a local backend; keep the live stream out of tests that don't mock it.
test.beforeEach(({ page }) => page.route("**/api/stream", route => route.fulfill({ status: 404, ...json({ message: "Not found." }) })));
const ads = { key: "ads:act_1", kind: "ads", id: "act_1", name: "Test ads" };
const instagram = { key: "instagram:1", kind: "instagram", id: "1", name: "Test IG" };
const whatsapp = { key: "whatsapp:1", kind: "whatsapp", id: "1", name: "Shop number" };
const unpaid = { blocking: true, text: "This number can't send messages yet.", fix: "Add a payment method in WhatsApp Manager.", link: "https://business.facebook.com/wa/manage/home/" };
const limited = { blocking: false, text: "Only the last 30 days of DMs are shared.", fix: "Nothing to do.", link: null };

test("Setup says which features Meta didn't allow and offers to connect again", async ({ page }) => {
  await page.route("**/api/me", route => route.fulfill(json({
    signed_in: true, name: "Test", selected: ["ads:act_1", "instagram:1"], permissions: ["ads_read", "instagram_basic", "instagram_manage_comments"], assets: [ads, instagram],
  })));
  await page.goto("/#setup");
  await expect(page.getByText("Ready")).toHaveCount(1);
  await expect(page.getByText("Needs one step")).toHaveCount(1);
  await expect(page.getByText("Not connected")).toHaveCount(2);
  await page.getByRole("button", { name: "Manage Instagram" }).click();
  await expect(page.getByText("Meta wasn't allowed to share reach and insights, DMs.")).toBeVisible();
  await expect(page.getByText("Connect again and allow them.")).toBeVisible();
  await expect(page.getByText(/your ad results/)).toBeHidden();
});

test("Setup walks through Meta's fixes, checks again and finishes", async ({ page }) => {
  let refreshed = 0;
  await page.route("**/api/me", route => route.fulfill(json({
    signed_in: true, name: "Test", selected: ["whatsapp:1"], permissions: [], problems: ["Messages from Shop Page: the Page wasn't shared."],
    assets: [{ ...whatsapp, issues: [unpaid, limited] }],
  })));
  await page.route("**/api/connections/refresh", route => {
    refreshed++;
    route.fulfill(json({ assets: [{ ...whatsapp, issues: [limited] }], selected: ["whatsapp:1"], permissions: [], problems: [] }));
  });
  await page.goto("/");
  await expect(page.getByRole("heading", { name: "Set up Stupid" })).toBeVisible();
  await expect(page.getByText("Messages from Shop Page: the Page wasn't shared.")).toBeVisible();
  await expect(page.getByRole("link", { name: "Connect again" })).toHaveAttribute("href", "/api/v1/meta/oauth/start");

  await page.getByRole("button", { name: "Connect Instagram" }).click();
  await expect(page.getByText(/Instagram must be a Professional account linked to your Facebook Page/)).toBeVisible();
  await expect(page.getByRole("link", { name: "How to switch" })).toHaveAttribute("href", "https://help.instagram.com/502981923235522");
  await expect(page.getByRole("link", { name: "Continue with Facebook" })).toHaveAttribute("href", "/api/v1/meta/oauth/start");
  await page.getByRole("button", { name: "Cancel" }).click();

  await page.getByRole("button", { name: "Manage WhatsApp" }).click();
  await expect(page.getByText("Add a payment method in WhatsApp Manager.")).toBeVisible();
  const open = page.getByRole("link", { name: "Open in Meta" });
  await expect(open).toHaveAttribute("href", unpaid.link);
  await expect(open).toHaveAttribute("target", "_blank");

  await page.getByRole("button", { name: "Check again" }).click();
  await expect(page.getByRole("heading", { name: "You're set" })).toBeVisible();
  await expect(page.getByText("Only the last 30 days of DMs are shared.")).toBeVisible();
  await expect(page.getByRole("link", { name: "Go to Inbox" })).toHaveAttribute("href", "#inbox");
  await expect(page.getByRole("link", { name: "Setup", exact: true })).toHaveCount(0);
  expect(refreshed).toBe(1);
});

test("Setup checks again when the tab comes back into view", async ({ page }) => {
  let refreshed = 0;
  await page.route("**/api/me", route => route.fulfill(json({ signed_in: true, name: "Test", selected: ["whatsapp:1"], permissions: [], assets: [{ ...whatsapp, issues: [unpaid] }] })));
  await page.route("**/api/connections/refresh", route => { refreshed++; route.fulfill(json({ assets: [{ ...whatsapp, issues: [unpaid] }], selected: ["whatsapp:1"], permissions: [], problems: [] })); });
  await page.goto("/#setup");
  await expect(page.getByText("Needs one step")).toBeVisible();
  await page.evaluate(() => document.dispatchEvent(new Event("visibilitychange")));
  await expect(page.getByText("Checked just now.")).toBeVisible();
  expect(refreshed).toBe(1);
});
