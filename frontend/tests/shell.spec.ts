import { expect, test } from "@playwright/test";

const json = (body: unknown) => ({ contentType: "application/json", body: JSON.stringify(body) });
// The preview server proxies /api to a local backend; keep the live stream out of tests that don't mock it.
test.beforeEach(({ page }) => page.route("**/api/stream", route => route.fulfill({ status: 404, ...json({ message: "Not found." }) })));

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
  await expect(page.getByText("Secnd only reads what you allow.")).toBeVisible();
  for (const [name, href] of [["Privacy", "/privacy.html"], ["Terms", "/terms.html"], ["Data deletion", "/deletion.html"]])
    await expect(page.getByRole("link", { name })).toHaveAttribute("href", href);
});

test("a signed-in person moves between destinations", async ({ page }) => {
  await page.route("**/api/me", route => route.fulfill(json({ signed_in: true, name: "Test", assets: [], selected: [] })));
  await page.goto("/");
  await expect(page.getByRole("heading", { name: "Set up Secnd" })).toBeVisible();
  await page.getByRole("link", { name: "Inbox" }).click();
  await expect(page.getByRole("heading", { name: "Inbox" })).toBeVisible();
  await expect(page.getByRole("link", { name: "Inbox" })).toHaveAttribute("aria-current", "page");
});

const signedIn = { signed_in: true, name: "Test", selected: ["ads:act_1"], assets: [
  { key: "ads:act_1", kind: "ads", id: "act_1", name: "Test ad account" },
  { key: "instagram:1", kind: "instagram", id: "1", name: "Test Instagram" },
] };

test("returning from Meta opens Setup and saves account switches", async ({ page }) => {
  await page.route("**/api/me", route => route.fulfill(json(signedIn)));
  let saved: unknown;
  await page.route("**/api/connections", route => {
    saved = route.request().postDataJSON();
    route.fulfill(json({ assets: signedIn.assets, selected: (saved as { selected: string[] }).selected }));
  });
  await page.goto("/?connected=1");
  await expect(page).toHaveURL(/\/#setup$/);
  await expect(page.getByRole("link", { name: "Connect WhatsApp" })).toHaveAttribute("href", "/api/v1/meta/oauth/start");
  const instagram = page.getByRole("switch", { name: "Test Instagram" });
  await expect(instagram).not.toBeChecked();
  await instagram.click();
  await expect(instagram).toBeChecked();
  expect(saved).toEqual({ selected: ["ads:act_1", "instagram:1"] });
});

test("a refused Meta sign-in shows Meta's reason and offers to try again", async ({ page }) => {
  await page.route("**/api/me", route => route.fulfill(json({ signed_in: false })));
  await page.goto("/?error=You+cancelled+the+Facebook+dialog.");
  await expect(page.getByText("Facebook didn't connect")).toBeVisible();
  await expect(page.getByText("You cancelled the Facebook dialog.")).toBeVisible();
  await expect(page.getByRole("link", { name: "Try again" })).toHaveAttribute("href", "/api/v1/meta/oauth/start");
  await expect(page).toHaveURL(/\/$/);
  await expect(page.getByRole("link", { name: "Continue with Instagram" })).toHaveCount(0);

  await page.goto("/?meta_error=1");
  await expect(page.getByText("Nothing was shared with Secnd.")).toBeVisible();
});

test("continuing with Facebook shows a full-screen loader on the way out and back", async ({ page }) => {
  let answer = () => {};
  await page.route("**/api/me", async route => { await new Promise<void>(done => (answer = done)); await route.fulfill(json({ signed_in: false, instagram_oauth_start: "/api/v1/instagram/oauth/start" })); });
  await page.goto("/?connected=1");
  await expect(page.getByText("Connecting to Meta…")).toBeVisible();
  answer();
  await expect(page.getByRole("link", { name: "Continue with Instagram" })).toHaveAttribute("href", "/api/v1/instagram/oauth/start");
  await page.route("**/api/v1/meta/oauth/start", route => route.fulfill({ status: 204 })); // 204 keeps the page where it is
  await page.getByRole("link", { name: "Continue with Facebook" }).click({ noWaitAfter: true });
  // Locators wait on the pending navigation, so read the page directly.
  await expect.poll(() => page.evaluate(() => document.body.innerText)).toContain("Connecting to Meta…");
});

test("Today asks to connect missing apps and reads the ones that are on", async ({ page }) => {
  await page.route("**/api/me", route => route.fulfill(json(signedIn)));
  await page.route("**/api/ads", route => route.fulfill(json({ accounts: [{ id: "act_1", name: "Test", currency: "USD", status: 1, campaigns: [
    { campaign_id: "1", campaign_name: "Cheap clicks", spend: "10", impressions: "1", reach: "1", clicks: "20", ctr: "1", cpc: "0.5", date_start: "", date_stop: "" },
    { campaign_id: "2", campaign_name: "No clicks", spend: "5", impressions: "1", reach: "1", clicks: "0", ctr: "0", cpc: "0", date_start: "", date_stop: "" },
  ] }] })));
  await page.goto("/#today");
  await expect(page.getByText("$15.00")).toBeVisible();
  await expect(page.getByText(/Doing best:\s*Cheap clicks/)).toBeVisible();
  await expect(page.getByText(/Costing most:\s*No clicks, \$5\.00 spent, no clicks yet/)).toBeVisible();
  await expect(page.getByRole("link", { name: "Connect Instagram" })).toBeVisible();
});

const inbox = { items: [
  { id: "w1", kind: "whatsapp", asset_id: "1", sender: "15550001", sender_name: "Ana", text: "Are you open?", created: 1, replied: false },
  { id: "c1", kind: "instagram_comment", asset_id: "1", sender: "ben", sender_name: null, text: "Nice post", created: 1, replied: true },
  { id: "d1", kind: "instagram", asset_id: "1", sender: "Cy", sender_name: null, text: "Old question", created: 1, replied: false },
  { id: "w2", kind: "whatsapp", asset_id: "1", sender: "918081388336", sender_name: "", text: "Price?", created: 1, replied: false },
] };

test("Today lists the three newest messages with who, where, when and whether they were answered", async ({ page }) => {
  await page.route("**/api/me", route => route.fulfill(json({ ...signedIn, selected: ["instagram:1"] })));
  await page.route("**/api/instagram", route => route.fulfill(json({ accounts: [] })));
  const now = Math.floor(Date.now() / 1000);
  await page.route("**/api/inbox", route => route.fulfill(json({ items: [
    { ...inbox.items[3], created: now - 120 }, inbox.items[0], inbox.items[1], inbox.items[2],
  ] })));
  await page.goto("/#today");
  await expect(page.getByText("+91 80813 88336")).toBeVisible();
  await expect(page.getByText("2 minutes ago")).toBeVisible();
  await expect(page.getByRole("img", { name: "WhatsApp" })).toHaveCount(2);
  await expect(page.getByRole("img", { name: "Instagram" })).toHaveCount(2);
  await expect(page.getByRole("img", { name: "Messages" })).toBeVisible();
  await expect(page.getByText("Replied")).toBeVisible();
  await expect(page.getByText("Old question")).toBeHidden();
});

test("Inbox filters by app, sends a reply and shows the server's refusal", async ({ page }) => {
  await page.route("**/api/me", route => route.fulfill(json(signedIn)));
  await page.route("**/api/inbox", route => route.fulfill(json(inbox)));
  let sent: unknown;
  await page.route("**/api/inbox/w1/reply", route => { sent = route.request().postDataJSON(); route.fulfill(json({ sent: true })); });
  await page.route("**/api/inbox/d1/reply", route => route.fulfill({ status: 409, ...json({ message: "Meta only allows replies within 24 hours of the last message." }) }));
  await page.goto("/#inbox");

  await page.getByRole("radio", { name: "WhatsApp" }).click();
  await expect(page.getByText("Nice post")).toBeHidden();
  await page.getByRole("radio", { name: "All" }).click();
  await expect(page.getByText("Replied")).toBeVisible();
  await expect(page.getByText("Ana", { exact: true })).toBeVisible();
  await expect(page.getByText("15550001")).toBeHidden();
  await expect(page.getByText("ben", { exact: true })).toBeVisible();
  await expect(page.getByText("+91 80813 88336")).toBeVisible();

  await page.getByText("Are you open?").click();
  await page.getByLabel("Reply to Ana").fill("Yes, until 7.");
  await page.getByRole("button", { name: "Send" }).click();
  await expect(page.getByLabel("Reply to Ana")).toBeHidden();
  await expect(page.getByText("Sent", { exact: true })).toBeVisible();
  expect(sent).toEqual({ text: "Yes, until 7." });

  await page.getByText("Old question").click();
  await page.getByLabel("Reply to Cy").fill("Sorry for the wait");
  await page.getByRole("button", { name: "Send" }).click();
  await expect(page.getByText("Meta only allows replies within 24 hours of the last message.").first()).toBeVisible();
});

test("Agents run, poll to a result and hand a reply draft to the Inbox", async ({ page }) => {
  await page.route("**/api/me", route => route.fulfill(json({ ...signedIn, selected: ["ads:act_1", "instagram:1"] })));
  await page.route("**/api/inbox", route => route.fulfill(json(inbox)));
  let polls = 0;
  await page.route("**/api/agents", route => route.fulfill(json({ ai_ready: true, own_key: false, model: "test-model", runs: polls++ < 1 ? [] : [
    { agent: "replies", status: polls < 3 ? "running" : "done", result: polls < 3 ? null : { replies: [{ event_id: "w1", to: "Ana", draft: "We're open until 7." }] }, error: null, cost_usd: 0.002, created: 1, finished: polls < 3 ? null : 2 },
  ] })));
  await page.route("**/api/agents/replies/run", route => route.fulfill(json({ agent: "replies", status: "running" })));
  await page.route("**/api/agents/ideas/run", route => route.fulfill({ status: 402, ...json({ message: "This month's AI budget is used up." }) }));
  await page.goto("/#agents");

  await page.getByRole("button", { name: "Run" }).nth(1).click();
  await expect(page.getByText("This month's AI budget is used up.")).toBeVisible();

  await page.getByRole("button", { name: "Run" }).nth(2).click();
  await expect(page.getByText("Working on it.")).toBeVisible();
  await expect(page.getByText("We're open until 7.")).toBeVisible({ timeout: 10000 });
  await expect(page.getByText("cost $0.002")).toBeVisible();

  await page.getByRole("link", { name: "Use this reply" }).click();
  await expect(page.getByLabel("Reply to Ana")).toHaveValue("We're open until 7.");
});

test("Agents point to Settings when there is no AI access", async ({ page }) => {
  await page.route("**/api/me", route => route.fulfill(json(signedIn)));
  await page.route("**/api/agents", route => route.fulfill(json({ ai_ready: false, own_key: false, model: "", runs: [] })));
  await page.goto("/#agents");
  await expect(page.getByText("Agents need AI access")).toBeVisible();
  await expect(page.getByRole("link", { name: "Open Settings" })).toHaveAttribute("href", "#settings");
});

test("Settings saves an AI key, confirms before deleting and signs out", async ({ page }) => {
  await page.route("**/api/me", route => route.fulfill(json(signedIn)));
  await page.route("**/api/settings/ai", route => route.request().method() === "GET"
    ? route.fulfill(json({ has_key: false, model: "test-model", workspace_ai: true }))
    : route.request().postDataJSON().api_key === "bad"
      ? route.fulfill({ status: 400, ...json({ message: "Meta refused that key." }) })
      : route.fulfill(json({ has_key: true, model: "test-model" })));
  let deleted = false;
  await page.route("**/api/connections", route => { deleted = route.request().method() === "DELETE"; route.fulfill(json({})); });
  await page.goto("/#settings");
  await expect(page.getByRole("link", { name: "Open setup" })).toHaveAttribute("href", "#setup");

  const key = page.getByLabel("Your Muse API key");
  await key.fill("bad");
  await page.getByRole("button", { name: "Save key" }).click();
  await expect(page.getByText("Meta refused that key.")).toBeVisible();
  await key.fill("good");
  await page.getByRole("button", { name: "Save key" }).click();
  await expect(page.getByText(/Key saved/)).toBeVisible();
  await expect(page.getByText("Agents run on test-model with your own key.")).toBeVisible();
  await expect(page.getByLabel("Replace your Muse API key")).toHaveValue("");

  await page.getByRole("button", { name: "Disconnect and delete my data" }).click();
  await page.getByRole("button", { name: "Cancel" }).click();
  expect(deleted).toBe(false);
  await page.getByRole("button", { name: "Disconnect and delete my data" }).click();
  await page.getByRole("button", { name: "Yes, delete everything" }).click();
  await expect(page.getByRole("link", { name: "Continue with Facebook" })).toBeVisible();
  expect(deleted).toBe(true);
});

test("the keyboard reaches the skip link first and can open a reply", async ({ page }) => {
  await page.route("**/api/me", route => route.fulfill(json(signedIn)));
  await page.route("**/api/inbox", route => route.fulfill(json(inbox)));
  await page.goto("/#inbox");
  await expect(page).toHaveTitle("Inbox · Secnd");
  await page.keyboard.press("Tab");
  await expect(page.getByText("Skip to content")).toBeFocused();
  await page.getByText("Are you open?").waitFor();
  for (let i = 0; i < 30 && !(await page.evaluate(() => document.activeElement?.textContent?.includes("Are you open?"))); i++) await page.keyboard.press("Tab");
  await page.keyboard.press("Enter");
  await expect(page.getByLabel("Reply to Ana")).toBeFocused();
});

test("legal pages are plain HTML that works without JavaScript", async ({ request }) => {
  for (const [path, words] of [["/privacy.html", "Baseten"], ["/terms.html", "You stay in charge"], ["/deletion.html", "Disconnect and delete my data"]]) {
    const res = await request.get(path);
    expect(res.headers()["content-type"]).toContain("text/html");
    const html = await res.text();
    expect(html).toContain(words);
    expect(html).toContain("rishit@secndai.com");
    expect(html).not.toContain("<script");
  }
});
