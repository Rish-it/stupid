import { expect, test } from "@playwright/test";

const json = (body: unknown) => ({ contentType: "application/json", body: JSON.stringify(body) });
// The preview server proxies /api to a local backend; keep the live stream out of tests that don't mock it.
test.beforeEach(({ page }) => page.route("**/api/stream", route => route.fulfill({ status: 404, ...json({ message: "Not found." }) })));
const me = { signed_in: true, name: "Test", selected: ["whatsapp:1"], permissions: [], assets: [{ key: "whatsapp:1", kind: "whatsapp", id: "1", name: "Shop" }] };
const message = { id: "w1", kind: "whatsapp", asset_id: "1", sender: "15550001", sender_name: "Ana", text: "Are you open?", created: 1, replied: false, reply_error: null };
// One update per connection; `retry` makes the browser reconnect quickly once the body ends.
const update = (versions: Record<string, string>) => ({ contentType: "text/event-stream", body: `retry: 300\nevent: update\ndata: ${JSON.stringify(versions)}\n\n` });
const versions = (replies: string) => ({ inbox: "1", replies, runs: "1", connections: "1" });

test("a live update refetches the inbox and shows that a reply didn't arrive", async ({ page }) => {
  let sent = false;
  await page.route("**/api/me", route => route.fulfill(json(me)));
  await page.route("**/api/stream", route => route.fulfill(update(versions(sent ? "2" : "1"))));
  await page.route("**/api/inbox", route => route.fulfill(json({ items: [sent ? { ...message, reply_error: "WhatsApp didn't deliver this reply: the number has no WhatsApp." } : message] })));
  let release = () => {};
  await page.route("**/api/inbox/w1/reply", async route => { await new Promise<void>(done => (release = done)); sent = true; await route.fulfill(json({ sent: true })); });
  await page.goto("/#inbox");

  await page.getByText("Are you open?").click();
  await page.getByLabel("Reply to Ana").fill("Yes, until 7.");
  await page.getByRole("button", { name: "Send" }).click();
  await expect(page.getByText("Sending…")).toBeVisible();
  release();
  await expect(page.getByText("Sent", { exact: true })).toBeVisible();
  await expect(page.getByText("Not delivered")).toBeVisible({ timeout: 5000 });
  await page.getByText("Are you open?").click();
  await expect(page.getByText("Your reply didn't arrive")).toBeVisible();
  await expect(page.getByText(/the number has no WhatsApp\./)).toBeVisible();
  await expect(page.getByLabel("Reply to Ana")).toBeVisible();
});

test("a signed-out stream goes back to the landing page", async ({ page }) => {
  await page.route("**/api/me", route => route.fulfill(json(me)));
  await page.route("**/api/stream", route => route.fulfill({ status: 401, ...json({ message: "Your session ended. Sign in again." }) }));
  await page.goto("/#setup");
  await expect(page.getByRole("button", { name: "I run a business" }).first()).toBeVisible();
});

test("a stream that stays down says Reconnecting after 10 seconds", async ({ page }) => {
  await page.clock.install();
  await page.route("**/api/me", route => route.fulfill(json(me)));
  await page.route("**/api/stream", route => route.fulfill({ status: 503, ...json({ message: "Down." }) }));
  await page.goto("/#setup");
  await expect(page.getByRole("heading", { name: "You're set" })).toBeVisible();
  await expect(page.getByText("Reconnecting…")).toBeHidden();
  await page.clock.fastForward(11_000);
  await expect(page.getByText("Reconnecting…")).toBeVisible();
});

test("a server without a stream stays quiet", async ({ page }) => {
  await page.clock.install();
  await page.route("**/api/me", route => route.fulfill(json(me)));
  await page.route("**/api/stream", route => route.fulfill({ status: 404, ...json({ message: "Not found." }) }));
  await page.goto("/#setup");
  await expect(page.getByRole("heading", { name: "You're set" })).toBeVisible();
  await page.clock.fastForward(11_000);
  await expect(page.getByText("Reconnecting…")).toBeHidden();
});

for (const [reason, title, link] of [
  ["Business account has been locked. (131031)", "Meta has locked this WhatsApp account.", "https://business.facebook.com/business-support-home/"],
  ["Re-engagement message (131047)", "The 24-hour reply window has ended.", "https://developers.facebook.com/documentation/business-messaging/whatsapp/messages/send-messages#customer-service-windows"],
  ["Payment error (131042)", "Meta couldn't use this account's billing setup.", "https://business.facebook.com/latest/billing_hub/payment_methods/"],
]) {
  test(`Inbox explains delivery failure: ${title}`, async ({ page }) => {
    await page.route("**/api/me", route => route.fulfill(json(me)));
    await page.route("**/api/inbox", route => route.fulfill(json({ items: [{ ...message, reply_error: reason }] })));
    await page.goto("/#inbox");
    await page.getByText("Are you open?").click();
    const dialog = page.getByRole("dialog");
    await expect(dialog.getByText(title, { exact: false })).toBeVisible();
    await expect(dialog.getByRole("link", { name: "Open in Meta" })).toHaveAttribute("href", link);
    await expect(dialog.getByRole("link", { name: "Open in Meta" })).toHaveAttribute("target", "_blank");
  });
}

test("Home numbers explain empty reporting periods without inventing results", async ({ page }) => {
  await page.route("**/api/me", route => route.fulfill(json({ ...me, selected: ["ads:1", "instagram:1"], assets: [
    { key: "ads:1", kind: "ads", id: "1", name: "Sample ads" }, { key: "instagram:1", kind: "instagram", id: "1", name: "Sample IG" },
  ] })));
  await page.route("**/api/ads", route => route.fulfill(json({ accounts: [] })));
  await page.route("**/api/instagram", route => route.fulfill(json({ accounts: [] })));
  await page.route("**/api/inbox", route => route.fulfill(json({ items: [] })));
  await page.route("**/api/agent", route => route.fulfill(json({ proactive: false, rules: "", needs: [], tickets: [], watching: [], last_checked: null })));
  await page.goto("/#home");
  await page.getByRole("button", { name: "Your numbers, last 7 days" }).click();
  await expect(page.getByText("No ad results in the last 7 days.")).toBeVisible();
  await expect(page.getByText(/select the same ad account and Last 7 days/)).toBeVisible();
  await expect(page.getByText(/An absent account doesn't tell us/)).toBeVisible();
});
