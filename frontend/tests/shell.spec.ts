import { expect, test } from "@playwright/test";
import type { Page, Route } from "@playwright/test";

const json = (body: unknown) => ({ contentType: "application/json", body: JSON.stringify(body) });
// The preview server proxies /api to a local backend; keep the live stream out of tests that don't mock it.
test.beforeEach(({ page }) => page.route("**/api/stream", route => route.fulfill({ status: 404, ...json({ message: "Not found." }) })));

/** Opens an app's window from its cover on the Agents page. */
const openApp = async (page: Page, name: string) => {
  await page.getByRole("button", { name, exact: true }).click();
  await expect(page.getByRole("dialog", { name })).toBeVisible();
};

test("shows a clear offline state when the server is down", async ({ page }) => {
  await page.route("**/api/**", route => route.abort());
  await page.goto("/");
  await expect(page.getByRole("heading", { name: "Stupid is offline" })).toBeVisible();
  await expect(page.getByText("Not an official Meta product.")).toBeVisible();
});

test("the welcome page offers two doors, each with its own sign-in", async ({ page }) => {
  await page.route("**/api/me", route => route.fulfill(json({ signed_in: false })));
  await page.goto("/");
  await expect(page.getByText("Stupid only reads what you allow.")).toBeVisible();
  await expect(page.getByText("Not an official Meta product.")).toBeVisible();
  for (const [name, href] of [["Privacy", "/privacy.html"], ["Terms", "/terms.html"], ["Data deletion", "/deletion.html"]])
    await expect(page.getByRole("link", { name, exact: true })).toHaveAttribute("href", href);
  await expect(page.getByRole("link", { name: "Continue with Facebook" })).toHaveCount(0);

  const business = page.getByRole("button", { name: "I run a business" }).first();
  await business.click();
  const dialog = page.getByRole("dialog", { name: "Connect your business" });
  await expect(dialog.getByText("Your WhatsApp Business number.")).toBeVisible();
  await expect(dialog.getByRole("link", { name: "Continue with Facebook" })).toHaveAttribute("href", "/api/v1/meta/oauth/start");
  await expect(dialog.getByRole("link", { name: "Privacy policy" })).toHaveAttribute("href", "/privacy.html");
  expect(await page.evaluate(() => sessionStorage.getItem("stupid.persona"))).toBeNull();
  await page.keyboard.press("Escape");
  await expect(business).toBeFocused();

  await page.getByRole("button", { name: "I create content" }).first().click();
  await expect(page.getByRole("dialog", { name: "Connect as a creator" }).getByText(/Your Instagram account/)).toBeVisible();
  // The door is kept only once the person continues; a plain sign-in clears it.
  await page.route("**/api/v1/meta/oauth/start", route => route.fulfill({ status: 204 }));
  await page.getByRole("link", { name: "Continue with Facebook" }).click({ noWaitAfter: true });
  await expect.poll(() => page.evaluate(() => sessionStorage.getItem("stupid.persona"))).toBe("creator");
  await page.goto("/");
  await page.getByRole("button", { name: "Sign in", exact: true }).click();
  await page.getByRole("link", { name: "Continue with Facebook" }).click({ noWaitAfter: true });
  await expect.poll(() => page.evaluate(() => sessionStorage.getItem("stupid.persona"))).toBeNull();
});

test("the welcome headline cycles, and holds still for reduced motion", async ({ page }) => {
  await page.route("**/api/me", route => route.fulfill(json({ signed_in: false })));
  await page.goto("/");
  await expect(page.getByRole("heading", { level: 1, name: "Stupid, AI that does your Meta busywork", exact: true })).toBeVisible();
  const shown = page.locator(".rebus-phrase:not([hidden])");
  await expect(shown).toHaveText("does your Meta busywork");
  await expect(shown.last()).toHaveText("answers your customers", { timeout: 5000 });
  await page.emulateMedia({ reducedMotion: "reduce" });
  await page.reload();
  await page.waitForTimeout(4000);
  await expect(shown).toHaveText("does your Meta busywork");
});

test("the footer mascot loads on its own and gets busy over the doors", async ({ page }) => {
  await page.route("**/api/me", route => route.fulfill(json({ signed_in: false })));
  await page.goto("/");
  const footer = page.locator("footer.outro");
  await footer.scrollIntoViewIfNeeded();
  await expect(footer.locator(".mascot-stage canvas")).toBeVisible();
  await footer.getByRole("button", { name: "I run a business" }).hover();
  await expect(footer.locator(".mascot-stage canvas")).toHaveAttribute("aria-label", /working/i);
});

test("a signed-in person moves between destinations", async ({ page }) => {
  await page.route("**/api/me", route => route.fulfill(json({ signed_in: true, name: "Test", assets: [], selected: [] })));
  await page.goto("/");
  await expect(page.getByRole("heading", { level: 1, name: /^Home, / })).toBeVisible();
  await page.getByRole("link", { name: "Inbox" }).click();
  await expect(page.getByRole("heading", { name: "Inbox" })).toBeVisible();
  await expect(page.getByRole("link", { name: "Inbox" })).toHaveAttribute("aria-current", "page");
  await expect(page.getByRole("link", { name: "Settings", exact: true })).toBeVisible();
});

const signedIn = { signed_in: true, name: "Test", selected: ["ads:act_1"], assets: [
  { key: "ads:act_1", kind: "ads", id: "act_1", name: "Test ad account" },
  { key: "instagram:1", kind: "instagram", id: "1", name: "Test Instagram" },
] };

test("returning from Meta lands on Home, and Setup saves account switches", async ({ page }) => {
  await page.route("**/api/me", route => route.fulfill(json(signedIn)));
  let saved: unknown;
  await page.route("**/api/connections", route => {
    saved = route.request().postDataJSON();
    route.fulfill(json({ assets: signedIn.assets, selected: (saved as { selected: string[] }).selected }));
  });
  await page.goto("/?connected=1");
  await expect(page).toHaveURL(/\/#home$/);
  await page.goto("/#setup");
  await page.getByRole("button", { name: "Connect WhatsApp" }).click();
  await expect(page.getByRole("link", { name: "Continue with Facebook" })).toHaveAttribute("href", "/api/v1/meta/oauth/start");
  await page.getByRole("button", { name: "Cancel" }).click();
  await page.getByRole("button", { name: "Manage Instagram" }).click();
  const instagram = page.getByRole("switch", { name: "Test Instagram" });
  await expect(instagram).not.toBeChecked();
  await instagram.click();
  await expect(instagram).toBeChecked();
  expect(saved).toEqual({ selected: ["ads:act_1", "instagram:1"] });
});

test("a refused Meta sign-in says so in fixed words and offers to try again", async ({ page }) => {
  await page.route("**/api/me", route => route.fulfill(json({ signed_in: false })));
  await page.goto("/?meta_error=1");
  await expect(page.getByText("Facebook didn't connect")).toBeVisible();
  await expect(page.getByText("Nothing was shared with Stupid.")).toBeVisible();
  await expect(page.getByRole("link", { name: "Try again" })).toHaveAttribute("href", "/api/v1/meta/oauth/start");
  await expect(page).toHaveURL(/\/$/);
  await expect(page.getByRole("link", { name: "Continue with Instagram" })).toHaveCount(0);

  // Text in the address is never shown: anyone can write a link.
  await page.goto("/?error=Your+account+is+locked.+Call+us.");
  await expect(page.getByText("Your account is locked.")).toBeHidden();
  await expect(page.getByText("Facebook didn't connect")).toBeHidden();
});

test("continuing with Facebook shows a full-screen loader on the way out and back", async ({ page }) => {
  let answer = () => {};
  await page.route("**/api/me", async route => { await new Promise<void>(done => (answer = done)); await route.fulfill(json({ signed_in: false, instagram_oauth_start: "/api/v1/instagram/oauth/start" })); });
  await page.goto("/?connected=1");
  await expect(page.getByText("Connecting to Meta…")).toBeVisible();
  answer();
  await page.getByRole("button", { name: "I create content" }).first().click();
  await expect(page.getByRole("link", { name: "Continue with Instagram" })).toHaveAttribute("href", "/api/v1/instagram/oauth/start");
  await page.route("**/api/v1/meta/oauth/start", route => route.fulfill({ status: 204 })); // 204 keeps the page where it is
  await page.getByRole("link", { name: "Continue with Facebook" }).click({ noWaitAfter: true });
  // Locators wait on the pending navigation, so read the page directly.
  await expect.poll(() => page.evaluate(() => document.body.innerText)).toContain("Connecting to Meta…");
});

test("Home numbers ask to connect missing apps and reads the ones that are on", async ({ page }) => {
  await page.route("**/api/me", route => route.fulfill(json(signedIn)));
  await page.route("**/api/ads", route => route.fulfill(json({ accounts: [{ id: "act_1", name: "Test", currency: "USD", status: 1, campaigns: [
    { campaign_id: "1", campaign_name: "Cheap clicks", spend: "10", impressions: "1", reach: "1", clicks: "20", ctr: "1", cpc: "0.5", date_start: "", date_stop: "" },
    { campaign_id: "2", campaign_name: "No clicks", spend: "5", impressions: "1", reach: "1", clicks: "0", ctr: "0", cpc: "0", date_start: "", date_stop: "" },
  ] }] })));
  await page.goto("/#home");
  await page.getByRole("button", { name: "Your numbers, last 7 days" }).click();
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

test("Home numbers list the three newest messages with who, where, when and whether they were answered", async ({ page }) => {
  await page.route("**/api/me", route => route.fulfill(json({ ...signedIn, selected: ["instagram:1"] })));
  await page.route("**/api/instagram", route => route.fulfill(json({ accounts: [] })));
  const now = Math.floor(Date.now() / 1000);
  await page.route("**/api/inbox", route => route.fulfill(json({ items: [
    { ...inbox.items[3], created: now - 120 }, inbox.items[0], inbox.items[1], inbox.items[2],
  ] })));
  await page.goto("/#home");
  await page.getByRole("button", { name: "Your numbers, last 7 days" }).click();
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
  await page.route("**/api/agents", route => route.fulfill(json({ ai_ready: true, own_key: false, model: "test-model", order: ["leads", "ideas", "replies", "reels", "ads"], runs: polls++ < 1 ? [] : [
    { agent: "replies", status: polls < 3 ? "running" : "done", result: polls < 3 ? null : { replies: [{ event_id: "w1", to: "Ana", draft: "We're open until 7." }] }, error: null, models: [], cost_usd: 0.002, created: 1, finished: polls < 3 ? null : 2 },
  ] })));
  await page.route("**/api/agents/replies/run", route => route.fulfill(json({ agent: "replies", status: "running" })));
  await page.route("**/api/agents/ideas/run", route => route.fulfill({ status: 402, ...json({ message: "This month's AI budget is used up." }) }));
  await page.goto("/#agents");

  // Each button names its agent; the model shows before the first run (QA 5-2, 5-3).
  await openApp(page, "Instagram");
  await expect(page.getByRole("button", { name: "Run Lead finder" })).toBeVisible();
  await expect(page.getByRole("article", { name: "Reel director" })).toContainText("Muse Wonder");
  await page.getByRole("article", { name: "Post ideas" }).getByRole("button", { name: "Run" }).click();
  await expect(page.getByText("This month's AI budget is used up.")).toBeVisible();
  await page.keyboard.press("Escape");
  await openApp(page, "Meta");
  await expect(page.getByRole("article", { name: "Ad watcher" })).toContainText("test-model");
  await page.keyboard.press("Escape");

  await openApp(page, "WhatsApp");
  await page.getByRole("article", { name: "Reply drafts" }).getByRole("button", { name: "Run" }).click();
  await expect(page.getByText("Working on it.")).toBeVisible();
  await expect(page.getByText("We're open until 7.")).toBeVisible({ timeout: 10000 });
  await expect(page.getByText("cost $0.002")).toBeVisible();

  await page.getByRole("link", { name: "Use this reply" }).click();
  await expect(page.getByLabel("Reply to Ana")).toHaveValue("We're open until 7.");
  await expect(page.getByText("Drafted by AI · check before sending")).toBeVisible();
  // Closing the thread lands on its card, not on the page (QA 3-5); the h1 names the page (QA 3-6).
  await page.keyboard.press("Escape");
  await expect(page.getByRole("button", { name: /Are you open\?/ })).toBeFocused();
  await page.goto("/#home");
  await expect(page.getByRole("heading", { level: 1, name: /^Home, / })).toBeAttached();
});

test("Inbox cards settle in with motion, and stay still for reduced motion", async ({ page }) => {
  await page.route("**/api/me", route => route.fulfill(json(signedIn)));
  await page.route("**/api/inbox", route => route.fulfill(json(inbox)));
  await page.goto("/#inbox");
  await expect(page.locator(".people > li").first()).toHaveCSS("animation-name", "arrive");
  await page.emulateMedia({ reducedMotion: "reduce" });
  await page.reload();
  await expect(page.locator(".people > li").first()).toHaveCSS("animation-name", "none");
});

test("Inbox offers app filters only when messages come from more than one app", async ({ page }) => {
  await page.route("**/api/me", route => route.fulfill(json(signedIn)));
  await page.route("**/api/inbox", route => route.fulfill(json({ items: [inbox.items[0]] })));
  await page.goto("/#inbox");
  await expect(page.getByText("Are you open?")).toBeVisible();
  await expect(page.getByRole("radiogroup", { name: "Show messages from" })).toHaveCount(0);
});

test("a switched-on Instagram gets its filter before anything arrives, and says how to let DMs in", async ({ page }) => {
  await page.route("**/api/me", route => route.fulfill(json({ ...signedIn, selected: ["instagram:1"] })));
  await page.route("**/api/inbox", route => route.fulfill(json({ items: [inbox.items[0]] })));
  await page.goto("/#inbox");
  await page.getByRole("radiogroup", { name: "Show messages from" }).getByRole("radio", { name: "Instagram" }).click();
  await expect(page.getByRole("heading", { name: "Nothing from Instagram yet" })).toBeVisible();
  await expect(page.getByText(/^Stupid reads @Test Instagram's DMs and comments every few seconds.*Connected tools\./)).toBeVisible();
});

test("Agents point to Settings when there is no AI access", async ({ page }) => {
  await page.route("**/api/me", route => route.fulfill(json(signedIn)));
  await page.route("**/api/agents", route => route.fulfill(json({ ai_ready: false, own_key: false, model: "", order: ["leads", "ideas", "replies", "reels", "ads"], runs: [] })));
  await page.goto("/#agents");
  await expect(page.getByText("Agents need AI access")).toBeVisible();
  await expect(page.getByRole("link", { name: "Open Settings" })).toHaveAttribute("href", "#settings");
  // An agent whose app isn't on names that app and opens its connect step (QA 5-1).
  await expect(page.locator(".cover", { hasText: "Instagram" })).toContainText("Not connected");
  await openApp(page, "Instagram");
  await expect(page.getByRole("article", { name: "Post ideas" }).getByRole("link", { name: "Connect Instagram" })).toHaveAttribute("href", "#setup");
});

test("Settings opens over the page, swaps sections in place and closes back to it", async ({ page }) => {
  await page.route("**/api/me", route => route.fulfill(json(signedIn)));
  await page.route("**/api/inbox", route => route.fulfill(json(inbox)));
  await page.goto("/#inbox");
  await page.getByRole("link", { name: "Settings" }).click();
  const settings = page.getByRole("dialog", { name: "Settings" });
  // It opens on the first section, your own WhatsApp.
  await expect(settings.getByRole("heading", { name: "On your WhatsApp", exact: true })).toBeVisible();
  await expect(page.getByText("Are you open?")).toBeAttached();
  await settings.getByRole("tab", { name: "On your WhatsApp" }).press("ArrowDown");
  await expect(settings.getByRole("tab", { name: "Your work" })).toBeFocused();
  await expect(settings.getByRole("tab", { name: "Your work" })).toHaveAttribute("aria-selected", "true");
  await settings.getByRole("tab", { name: "Your work" }).press("End");
  await expect(settings.getByRole("tab", { name: "Account" })).toBeFocused();
  await settings.getByRole("tab", { name: "Account" }).press("Home");
  await expect(settings.getByRole("tab", { name: "On your WhatsApp" })).toHaveAttribute("aria-selected", "true");
  // One window, no page scroll, at desktop and phone sizes.
  for (const size of [{ width: 1440, height: 900 }, { width: 390, height: 844 }]) {
    await page.setViewportSize(size);
    expect(await page.evaluate(() => document.documentElement.scrollHeight <= innerHeight)).toBe(true);
  }
  await page.keyboard.press("Escape");
  await expect(settings).toBeHidden();
  await expect(page).toHaveURL(/#inbox$/);
  await expect(page.getByRole("link", { name: "Settings" })).toBeFocused();
});

test("Settings > Connections lists the connected apps and accounts in place", async ({ page }) => {
  await page.goto("http://127.0.0.1:8032/?fixtures=1&persona=creator&stage=ready#settings");
  const settings = page.getByRole("dialog", { name: "Settings" });
  await settings.getByRole("tab", { name: "Connections" }).click();
  await expect(settings.getByRole("button", { name: "Manage Instagram" })).toBeVisible();
  await expect(settings.getByText("@sample.trails")).toBeVisible();
  await page.setViewportSize({ width: 390, height: 844 });
  expect(await page.evaluate(() => document.documentElement.scrollHeight <= innerHeight)).toBe(true);
});

test("Settings > Connections puts WhatsApp and the Page first for a business", async ({ page }) => {
  await page.goto("http://127.0.0.1:8032/?fixtures=1&persona=business&stage=ready#settings");
  const settings = page.getByRole("dialog", { name: "Settings" });
  await settings.getByRole("tab", { name: "Connections" }).click();
  const cards = settings.getByRole("button", { name: /^(Connect|Manage) / });
  await expect(cards.nth(0)).toHaveAccessibleName(/WhatsApp/);
  await expect(cards.nth(1)).toHaveAccessibleName(/Facebook Page/);
});

test("Settings changes the path between creator and business", async ({ page }) => {
  let account = { ...signedIn, persona: "creator" };
  const sent: unknown[] = [];
  await page.route("**/api/me", route => route.fulfill(json(account)));
  await page.route("**/api/me/persona", route => { sent.push(route.request().postDataJSON()); account = { ...account, persona: "business" }; return route.fulfill(json(account)); });
  await page.goto("/#settings");
  await page.getByRole("tab", { name: "Your work" }).click();
  await expect(page.getByRole("radio", { name: "Create content" })).toBeChecked();
  await page.getByRole("radio", { name: "Run a business" }).click();
  await expect(page.getByRole("radio", { name: "Run a business" })).toBeChecked();
  expect(sent).toEqual([{ persona: "business" }]);
});

test("Settings saves an AI key, confirms before deleting and signs out", async ({ page }) => {
  await page.route("**/api/me", route => route.fulfill(json(signedIn)));
  await page.route("**/api/settings/ai", route => route.request().method() === "GET"
    ? route.fulfill(json({ has_key: false, model: "test-model", workspace_ai: true }))
    : route.request().postDataJSON().api_key === "bad"
      ? route.fulfill({ status: 400, ...json({ message: "Meta refused that key." }) })
      : route.fulfill(json({ has_key: route.request().postDataJSON().consent === true, key_saved_at: 1793700000, model: "test-model" })));
  let deleted = false;
  await page.route("**/api/connections", route => { deleted = route.request().method() === "DELETE"; route.fulfill(json({})); });
  await page.goto("/#settings");
  await page.getByRole("tab", { name: "Connections" }).click();
  await expect(page.getByRole("button", { name: "Manage Instagram" })).toBeVisible();

  await page.getByRole("tab", { name: "AI model" }).click();
  await page.getByText("Use your own Baseten key").click();
  const key = page.getByLabel("Your own Baseten API key");
  await key.fill("bad");
  await expect(page.getByRole("button", { name: "Save key" })).toBeDisabled();
  await page.getByLabel("Send the messages agents read to my own AI account").check();
  await page.getByRole("button", { name: "Save key" }).click();
  await expect(page.getByText("Meta refused that key.")).toBeVisible();
  await key.fill("good");
  await page.getByRole("button", { name: "Save key" }).click();
  await expect(page.getByText(/Key saved/)).toBeVisible();
  await expect(page.getByText("Agents run on test-model with your own Baseten API key.")).toBeVisible();
  await expect(page.getByText(/^Saved /)).toBeVisible();
  await expect(page.getByLabel("Replace your own Baseten API key")).toHaveValue("");
  await expect(page.getByLabel("Send the messages agents read to my own AI account")).not.toBeChecked();

  await page.getByRole("tab", { name: "Account" }).click();
  await page.getByRole("button", { name: "Disconnect and delete my data" }).click();
  await page.getByRole("button", { name: "Cancel" }).click();
  expect(deleted).toBe(false);
  await page.getByRole("button", { name: "Disconnect and delete my data" }).click();
  await page.getByRole("button", { name: "Yes, delete everything" }).click();
  await expect(page.getByRole("button", { name: "I run a business" }).first()).toBeVisible();
  expect(deleted).toBe(true);
});

test("the keyboard reaches the skip link first and can open a reply", async ({ page }) => {
  await page.route("**/api/me", route => route.fulfill(json(signedIn)));
  await page.route("**/api/inbox", route => route.fulfill(json(inbox)));
  await page.goto("/#inbox");
  await expect(page).toHaveTitle("Inbox · Stupid");
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

const now = () => Math.floor(Date.now() / 1000);
const agentHome = () => ({
  proactive: true, rules: "", facts: [], watching: ["whatsapp", "messenger"], last_checked: now() - 120,
  needs: [
    { type: "question", id: 7, question: "What does delivery to Pune cost?", created: now() - 60, message: { kind: "whatsapp", sender: "15550002", sender_name: "Priya", text: "How much is delivery to Pune?" } },
    { type: "draft", id: 3, event_id: "w1", text: "Yes, we're open until 7 today.", source: "agent", created: now() - 120, message: { kind: "whatsapp", sender: "15550001", sender_name: "Ana", text: "Are you open?" } },
  ],
  tickets: [
    { id: 7, job: "replies", state: "open", created: now() - 70, message: { kind: "whatsapp", sender: "15550002", sender_name: "Priya" }, reports: [
      { kind: "progress", text: "Asks about delivery cost.", created: now() - 70 }, { kind: "question", text: "What does delivery to Pune cost?", created: now() - 60 }, { kind: "waiting", text: "Waiting for your answer.", created: now() - 60 }] },
    { id: 5, job: "leads", state: "ended", created: now() - 900, message: null, reports: [{ kind: "progress", text: "Working on it.", created: now() - 900 }, { kind: "ready", text: "Found 2 leads.", created: now() - 880 }] },
  ],
});

test("Home says what the agent watches and puts what needs you first", async ({ page }) => {
  await page.route("**/api/me", route => route.fulfill(json({ ...signedIn, selected: ["instagram:1"] })));
  await page.route("**/api/agent", route => route.fulfill(json(agentHome())));
  await page.route("**/api/inbox", route => route.fulfill(json(inbox)));
  await page.goto("/#home");
  await expect(page.getByText("Watching WhatsApp and Messenger · last checked 2 minutes ago")).toBeVisible();
  await expect(page.getByRole("heading", { name: "Needs you" })).toBeVisible();
  await page.getByRole("button", { name: "Edit" }).click();
  await expect(page.getByLabel("Reply to Ana")).toHaveValue("Yes, we're open until 7 today.");
  await expect(page.getByText("Drafted by AI · check before sending")).toBeVisible();
});

test("a draft on Home is sent only on the Send tap, and focus moves on", async ({ page }) => {
  let sent: unknown;
  await page.route("**/api/me", route => route.fulfill(json({ ...signedIn, selected: ["instagram:1"] })));
  await page.route("**/api/agent", route => route.fulfill(json(sent ? { ...agentHome(), needs: agentHome().needs.slice(0, 1) } : agentHome())));
  await page.route("**/api/inbox/w1/reply", route => { sent = route.request().postDataJSON(); return route.fulfill(json({ sent: true })); });
  await page.goto("/#home");
  await expect(page.getByText("Yes, we're open until 7 today.")).toBeVisible();
  expect(sent).toBeUndefined();
  await page.getByRole("button", { name: "Send" }).click();
  await expect(page.getByText("Yes, we're open until 7 today.")).toHaveCount(0);
  expect(sent).toEqual({ text: "Yes, we're open until 7 today." });
  await expect(page.locator(".row").first()).toBeFocused();
});

test("a question from the agent is answered right on Home", async ({ page }) => {
  let answered: unknown;
  await page.route("**/api/me", route => route.fulfill(json({ ...signedIn, selected: ["instagram:1"] })));
  await page.route("**/api/agent", route => route.fulfill(json(answered ? { ...agentHome(), needs: [] } : agentHome())));
  await page.route("**/api/agent/tickets/7/answer", route => { answered = route.request().postDataJSON(); return route.fulfill(json({ state: "open" })); });
  await page.goto("/#home");
  await expect(page.getByText("“How much is delivery to Pune?”")).toBeVisible();
  await expect(page.getByRole("button", { name: "Answer" })).toBeDisabled();
  await page.getByLabel("Your answer").fill("₹60, free over ₹999");
  await page.getByRole("button", { name: "Answer" }).click();
  await expect(page.getByLabel("Your answer")).toHaveCount(0);
  expect(answered).toEqual({ text: "₹60, free over ₹999", skip: false });
  await expect(page.getByRole("heading", { name: "Needs you" })).toBeFocused();
});

test("Ready for you shows the actual results in the path's order, each naming its model", async ({ page }) => {
  await page.route("**/api/me", route => route.fulfill(json({ ...signedIn, selected: ["instagram:1"], persona: "creator" })));
  await page.route("**/api/agent", route => route.fulfill(json({ ...agentHome(), needs: [] })));
  await page.route("**/api/agents", route => route.fulfill(json({ ai_ready: true, own_key: false, model: "m", order: ["reels", "ideas", "leads", "replies", "ads"], runs: [
    { agent: "leads", status: "done", error: null, models: [], cost_usd: 0, created: 1, finished: 2, models: ["Muse Spark Open"], result: { leads: [{ who: "Shoe Co", channel: "instagram", said: "What are your rates?", why: "", next_step: "" }] } },
    { agent: "ideas", status: "done", error: null, models: [], cost_usd: 0, created: 1, finished: 2, models: ["Muse Spark 1.3"], result: { ideas: [{ hook: "Closet tour", caption: "", format: "reel", why: "" }] } },
  ] })));
  await page.goto("/#home");
  const items = page.locator("section[aria-labelledby=ready-heading] .row");
  await expect(items.nth(0)).toContainText("Post ideas");
  await expect(items.nth(0)).toContainText("Muse Spark 1.3");
  await expect(items.nth(0)).toContainText("Closet tour");
  await expect(items.nth(1)).toContainText("“What are your rates?”");
  await expect(page.getByText("Reel director: Post a Reel and I'll direct the next one.")).toBeVisible();
});

test("with nothing waiting, Home says so plainly", async ({ page }) => {
  await page.route("**/api/me", route => route.fulfill(json({ ...signedIn, selected: ["instagram:1"] })));
  await page.route("**/api/agent", route => route.fulfill(json({ proactive: true, rules: "", facts: [], needs: [], tickets: [], watching: [], last_checked: null })));
  await page.goto("/#home");
  await expect(page.getByText("Not watching any messages yet")).toBeVisible();
  await expect(page.getByText(/Nothing waits for you/)).toBeVisible();
});

test("Agents lists recent work with every report", async ({ page }) => {
  await page.route("**/api/me", route => route.fulfill(json(signedIn)));
  await page.route("**/api/agents", route => route.fulfill(json({ ai_ready: true, own_key: false, model: "test-model", order: ["leads", "ideas", "replies", "reels", "ads"], runs: [] })));
  await page.route("**/api/agent", route => route.fulfill(json(agentHome())));
  await page.goto("/#agents");
  await page.getByRole("button", { name: "Recent work" }).click();
  await expect(page.getByRole("dialog", { name: "Recent work" })).toBeVisible();
  await expect(page.getByText("Reply to Priya")).toBeVisible();
  await expect(page.getByText("Asks about delivery cost.")).toBeVisible();
  await expect(page.getByText("Waiting for your answer.")).toBeVisible();
});

test("Settings turns drafting off and saves the agent's rules", async ({ page }) => {
  const saved: unknown[] = [];
  await page.route("**/api/me", route => route.fulfill(json(signedIn)));
  await page.route("**/api/settings/ai", route => route.fulfill(json({ has_key: false, model: "test-model", workspace_ai: true })));
  await page.route("**/api/agent", route => route.fulfill(json({ proactive: true, rules: "", facts: [], needs: [], tickets: [], watching: [], last_checked: null })));
  await page.route("**/api/agent/settings", route => { const body = route.request().postDataJSON(); saved.push(body); return route.fulfill(json(body)); });
  await page.goto("/#settings");
  await page.getByRole("tab", { name: "Your agent" }).click();
  await page.getByLabel("Draft replies when new messages arrive").click();
  await expect.poll(() => saved.length).toBe(1);
  await page.getByLabel("Rules for your agent").fill("Open 10 to 7, closed Sundays.");
  await page.getByRole("button", { name: "Save rules" }).click();
  await expect(page.getByText("Saved.")).toBeVisible();
  expect(saved).toEqual([{ proactive: false, rules: "" }, { proactive: false, rules: "Open 10 to 7, closed Sundays." }]);
});

test("Settings lists what the owner told the agent and forgets one on request", async ({ page }) => {
  const forgotten: string[] = [];
  const fact = { id: 4, question: "What does delivery to Pune cost?", answer: "₹80, free over ₹999.", created: now() - 3600 };
  await page.route("**/api/me", route => route.fulfill(json(signedIn)));
  await page.route("**/api/settings/ai", route => route.fulfill(json({ has_key: false, model: "test-model", workspace_ai: true })));
  await page.route("**/api/agent", route => route.fulfill(json({ proactive: true, rules: "", facts: [fact], needs: [], tickets: [], watching: [], last_checked: null })));
  await page.route("**/api/agent/facts/*", route => { forgotten.push(route.request().method() + " " + new URL(route.request().url()).pathname); return route.fulfill(json({ facts: [] })); });
  await page.goto("/#settings");
  await page.getByRole("tab", { name: "Your agent" }).click();
  await expect(page.getByText("What does delivery to Pune cost?")).toBeVisible();
  await expect(page.getByText("₹80, free over ₹999.")).toBeVisible();
  await page.getByRole("button", { name: "Forget: ₹80, free over ₹999." }).click();
  await expect(page.getByText("₹80, free over ₹999.")).toBeHidden();
  await expect(page.getByText(/Nothing yet. When you answer one of its questions/)).toBeVisible();
  expect(forgotten).toEqual(["DELETE /api/agent/facts/4"]);
});

test("Settings shows how the owner writes, or says honestly that there are no sent replies", async ({ page }) => {
  let style: object = { style: null, built: null, from: 0, sent: 0, message: "No sent replies yet. Once you send a few from Stupid, your agent learns how you write." };
  const deleted: string[] = [];
  await page.route("**/api/me", route => route.fulfill(json(signedIn)));
  await page.route("**/api/settings/ai", route => route.fulfill(json({ has_key: false, model: "test-model", workspace_ai: true })));
  await page.route("**/api/agent", route => route.fulfill(json({ proactive: true, rules: "", facts: [], needs: [], tickets: [], watching: [], last_checked: null })));
  await page.route("**/api/agent/style", route => {
    if (route.request().method() === "DELETE") { deleted.push("style"); style = { style: null, built: null, from: 0, sent: 4, message: "Your agent learns how you write once a day. Check back tomorrow." }; return route.fulfill(json({ style: null, message: "Forgotten." })); }
    return route.fulfill(json(style));
  });
  await page.goto("/#settings");
  await page.getByRole("tab", { name: "Your agent" }).click();
  await expect(page.getByText("No sent replies yet. Once you send a few from Stupid, your agent learns how you write.")).toBeVisible();

  style = { style: { note: "Short and warm, starts with Hii, one emoji.", length: "short", greeting: "Hii", emoji: "one", language: "Hinglish", sign_off: "none" }, built: now() - 600, from: 4, sent: 4, message: null };
  await page.evaluate(() => { location.hash = "today"; });
  await page.evaluate(() => { location.hash = "settings"; });
  await page.getByRole("tab", { name: "Your agent" }).click();
  await expect(page.getByText("Short and warm, starts with Hii, one emoji.")).toBeVisible();
  await expect(page.getByText(/From 4 sent replies/)).toBeVisible();
  await page.getByRole("button", { name: "Forget how you write" }).click();
  await expect(page.getByText("Your agent learns how you write once a day. Check back tomorrow.")).toBeVisible();
  expect(deleted).toEqual(["style"]);
});

test("voice notes and photos show what they say, marked while being read", async ({ page }) => {
  await page.route("**/api/me", route => route.fulfill(json(signedIn)));
  await page.route("**/api/inbox", route => route.fulfill(json({ items: [
    { id: "v1", kind: "whatsapp", asset_id: "1", sender: "15550003", sender_name: "Priya", text: "Hi, how much is the blue mug?", created: 1, replied: false, voice: true },
    { id: "v2", kind: "whatsapp", asset_id: "1", sender: "15550004", sender_name: "Dev", text: "", created: 1, replied: false, transcribing: "voice" },
    { id: "p1", kind: "messenger", asset_id: "1", sender: "15550005", sender_name: "Sam", text: "", created: 1, replied: false, transcribing: "photo" },
    { id: "p2", kind: "instagram", asset_id: "1", sender: "15550006", sender_name: "Ria", text: "Same in blue?\n(Photo: A red ceramic mug.)", created: 1, replied: false },
  ] })));
  await page.goto("/#inbox");
  await expect(page.getByText("Voice note · transcript")).toBeVisible();
  await expect(page.getByText("Transcribing the voice note…")).toBeVisible();
  await expect(page.getByText("Photo · looking")).toBeVisible();
  await expect(page.getByText("Looking at the photo…")).toBeVisible();
  await page.getByText("Hi, how much is the blue mug?").click();
  await expect(page.getByRole("dialog").getByText("Voice note · transcript")).toBeVisible();
});

test("Reel director shows what works, labelled guesses and scripts to copy", async ({ page }) => {
  await page.route("**/api/me", route => route.fulfill(json({ ...signedIn, selected: ["instagram:1"] })));
  await page.route("**/api/agent", route => route.fulfill(json({ proactive: true, rules: "", facts: [], needs: [], tickets: [], watching: [], last_checked: null })));
  await page.route("**/api/agents", route => route.fulfill(json({ ai_ready: true, own_key: false, model: "test-model", order: ["leads", "ideas", "replies", "reels", "ads"], runs: [{ agent: "reels", status: "done", error: null, models: [], cost_usd: 0.045, created: 1, finished: 2, result: {
    from_captions_only: false,
    watched: [{ video: 1, caption: "Morning bake", permalink: "https://www.instagram.com/p/x", works: [{ at: "0:00-0:02", what: "Hands pull the bread apart in the first second." }], drop_off_guesses: [{ at: "0:09", what: "Guess: the oven shot is slow." }] }],
    scripts: [{ title: "Three breads in 15 seconds", hook: "Which one would you tear first?", caption: "Fresh at 8.", shots: [{ shot: "Close-up of the crust", seconds: 2, on_screen: "Crackle test", sound: "Crust crackle" }] }],
  } }] })));
  await page.goto("/#agents");
  await openApp(page, "Instagram");
  await expect(page.getByText("Watched 1 Reel and wrote 1 script.")).toBeVisible();
  await page.getByRole("button", { name: "See results" }).click();
  const dialog = page.getByRole("dialog", { name: "Reel director" });
  await expect(dialog.getByRole("link", { name: "Morning bake" })).toBeVisible();
  await expect(dialog.getByText("Hands pull the bread apart in the first second.")).toBeVisible();
  await expect(dialog.getByText("Guess", { exact: true })).toBeVisible();
  await expect(dialog.getByText("the oven shot is slow.")).toBeVisible();
  await expect(dialog.getByRole("button", { name: "Copy script" })).toBeVisible();
  await expect(dialog.getByText("Nothing is posted.", { exact: false })).toBeVisible();
});

test("Ad watcher adds a creative pack cropped around what SAM found", async ({ page }) => {
  await page.route("**/api/me", route => route.fulfill(json(signedIn)));
  await page.route("**/api/agent", route => route.fulfill(json({ proactive: true, rules: "", facts: [], needs: [], tickets: [], watching: [], last_checked: null })));
  await page.route("**/api/instagram/media/**", route => route.fulfill({ status: 404, body: "" }));
  await page.route("**/api/agents", route => route.fulfill(json({ ai_ready: true, own_key: false, model: "test-model", order: ["leads", "ideas", "replies", "reels", "ads"], runs: [{ agent: "ads", status: "done", error: null, models: [], cost_usd: 0.01, created: 1, finished: 2, result: {
    summary: "One campaign works.", actions: [],
    creative_pack: [
      { id: "p1", permalink: "https://www.instagram.com/p/1", caption: "Blue mug", subject: "ceramic mug", box: { x1: 30, y1: 5, x2: 90, y2: 45, w: 100, h: 50 }, note: null },
      { id: "p2", subject: "product", box: null, note: "SAM 3.1 didn't find \"product\" in this picture, so the crops are centred." },
    ],
  } }] })));
  await page.goto("/#agents");
  await openApp(page, "Meta");
  await page.getByRole("button", { name: "See results" }).click();
  const dialog = page.getByRole("dialog", { name: "Ad watcher" });
  await expect(dialog.getByText("Ad creative pack")).toBeVisible();
  // The mug's centre is 60% across a 2:1 picture, so a square crop sits 70% of the way along.
  await expect(dialog.getByAltText("ceramic mug, 1:1 crop for Feed")).toHaveCSS("object-position", "70% 50%");
  await expect(dialog.getByRole("button", { name: "Save 9:16" })).toHaveCount(2);
  await expect(dialog.getByText(/so the crops are centred/)).toBeVisible();
  await expect(dialog.getByText(/Nothing is uploaded to Ads/)).toBeVisible();
});

test("Settings makes a key for Muse, shows it once, and revokes it", async ({ page }) => {
  let key: { has_key: boolean; created: number | null; last_used: number | null } = { has_key: false, created: null, last_used: null };
  await page.route("**/api/me", route => route.fulfill(json(signedIn)));
  await page.route("**/api/settings/ai", route => route.fulfill(json({ has_key: false, model: "test-model", workspace_ai: true })));
  await page.route("**/api/agent", route => route.fulfill(json({ proactive: true, rules: "", facts: [], needs: [], tickets: [], watching: [], last_checked: null })));
  await page.route("**/api/mcp/key", route => {
    const method = route.request().method();
    if (method === "POST") { key = { has_key: true, created: Math.floor(Date.now() / 1000), last_used: null }; return route.fulfill(json({ key: "stupid_test_key", created: key.created })); }
    if (method === "DELETE") { key = { has_key: false, created: null, last_used: null }; return route.fulfill(json({ has_key: false })); }
    return route.fulfill(json({ ...key, url: "https://app.example.com/mcp" }));
  });
  await page.goto("/#settings");
  await page.getByRole("tab", { name: "Muse" }).click();
  await expect(page.getByLabel("MCP server URL")).toHaveValue("https://app.example.com/mcp");
  await expect(page.getByLabel("Ask Muse to add Stupid")).toHaveValue(/MCP server URL: https:\/\/app\.example\.com\/mcp/);
  await page.getByText("Use it from Muse Code").click();
  await expect(page.getByLabel("Muse Code settings")).toHaveValue(/"url": "https:\/\/app\.example\.com\/mcp"/);
  await expect(page.getByLabel("Muse Code settings")).toHaveValue(/"Authorization": "\$\{STUPID_MCP_AUTH\}"/);
  await page.getByRole("button", { name: "Make a key" }).click();
  await expect(page.getByLabel("Access key")).toHaveValue("stupid_test_key");
  await expect(page.getByText("Not used yet.")).toBeVisible();
  await page.getByRole("button", { name: "Revoke the key" }).click();
  await expect(page.getByLabel("Access key")).toHaveCount(0);
  await expect(page.getByText(/No key yet/)).toBeVisible();
});

test("a draft queued from Muse opens prefilled and marked From Muse", async ({ page }) => {
  await page.route("**/api/me", route => route.fulfill(json(signedIn)));
  await page.route("**/api/inbox", route => route.fulfill(json({ items: [{ ...inbox.items[0], draft: { text: "Yes, open till 7!", source: "muse" } }] })));
  await page.goto("/#inbox");
  await page.getByText("Are you open?").click();
  await expect(page.getByLabel("Reply to Ana")).toHaveValue("Yes, open till 7!");
  await expect(page.getByText("From Muse · check before sending")).toBeVisible();
});

test("Post ideas say how many of the creator's pictures they looked at", async ({ page }) => {
  await page.route("**/api/me", route => route.fulfill(json({ ...signedIn, selected: ["instagram:1"] })));
  await page.route("**/api/agent", route => route.fulfill(json({ proactive: true, rules: "", facts: [], needs: [], tickets: [], watching: [], last_checked: null })));
  await page.route("**/api/agents", route => route.fulfill(json({ ai_ready: true, own_key: false, model: "test-model", order: ["leads", "ideas", "replies", "reels", "ads"], runs: [{ agent: "ideas", status: "done", error: null, models: [], cost_usd: 0.004, created: 1, finished: 2,
    result: { looked_at: 4, ideas: [{ hook: "Crab sticker unboxing", caption: "New drop", format: "reel", why: "Your second picture, the close-up, got the most comments." }] } }] })));
  await page.goto("/#agents");
  await openApp(page, "Instagram");
  await expect(page.getByText("Drafted 1 post idea after looking at 4 of your pictures.")).toBeVisible();
});

test("a sender without a name reads as someone on that app, never as an id", async ({ page }) => {
  await page.route("**/api/me", route => route.fulfill(json(signedIn)));
  await page.route("**/api/inbox", route => route.fulfill(json({ items: [
    { id: "i1", kind: "instagram_comment", asset_id: "1", sender: "17841400000000001", sender_name: null, text: "Love it", created: 1, replied: false },
    { id: "m1", kind: "messenger", asset_id: "1", sender: "24000000000000001", sender_name: "", text: "Open Sunday?", created: 1, replied: false },
  ] })));
  await page.goto("/#inbox");
  await expect(page.getByText("Someone on Instagram")).toBeVisible();
  await expect(page.getByText("Someone on Messenger")).toBeVisible();
  await expect(page.getByText("17841400000000001")).toHaveCount(0);
});

test("Inbox shows each person as a card with the app, the words, when, and what's waiting", async ({ page }) => {
  await page.route("**/api/me", route => route.fulfill(json(signedIn)));
  await page.route("**/api/inbox", route => route.fulfill(json({ items: [{ ...inbox.items[0], created: now() - 600, draft: { text: "Yes!", source: "agent" } }, inbox.items[1]] })));
  await page.goto("/#inbox");
  const ana = page.getByRole("button", { name: /Are you open\?/ });
  await expect(ana).toContainText("WhatsApp");
  await expect(ana).toContainText("Ana");
  await expect(ana).toContainText("10 minutes ago");
  await expect(ana).toContainText("Draft ready");
  await expect(page.getByRole("button", { name: /Nice post/ })).toContainText("Replied");
  // Unselected filters stay readable on the control's tint (QA 2-3).
  await expect(page.getByRole("radio", { name: "WhatsApp" })).toHaveCSS("color", "rgb(180, 180, 186)");
});

test("Agents show three apps in the path's order, each agent naming the models behind its last run", async ({ page }) => {
  await page.route("**/api/me", route => route.fulfill(json({ ...signedIn, selected: ["instagram:1"], persona: "business" })));
  await page.route("**/api/agent", route => route.fulfill(json({ proactive: true, rules: "", facts: [], needs: [], tickets: [], watching: [], last_checked: null })));
  await page.route("**/api/agents", route => route.fulfill(json({ ai_ready: true, own_key: false, model: "m", order: ["replies", "leads", "ads", "ideas", "reels"], runs: [
    { agent: "reels", status: "done", error: null, models: ["Muse Wonder"], cost_usd: 0, created: 1, finished: 2, result: { from_captions_only: false, watched: [], scripts: [] } },
  ] })));
  await page.goto("/#agents");
  await expect(page.locator(".cover")).toHaveCount(3);
  await expect(page.locator(".cover").first()).toHaveAccessibleName("WhatsApp");
  await expect(page.locator(".cover").last()).toHaveAccessibleName("Meta");
  await openApp(page, "Instagram");
  // Inside an app, its agents keep the path's order too.
  await expect(page.getByRole("dialog").getByRole("article").first()).toHaveAccessibleName("Lead finder");
  await expect(page.getByRole("article", { name: "Reel director" })).toContainText("Muse Wonder");
});

test("closing Settings with motion on hands focus back to the rail's Settings link", async ({ page }) => {
  await page.emulateMedia({ reducedMotion: "no-preference" });
  await page.goto("http://127.0.0.1:8032/?fixtures=1&persona=creator&stage=ready#inbox");
  await page.getByRole("link", { name: "Settings" }).focus();
  await page.keyboard.press("Enter");
  const settings = page.getByRole("dialog", { name: "Settings" });
  await expect(settings).toBeVisible();
  await page.keyboard.press("Escape");
  await expect(settings).toBeHidden();
  // Well inside the browser's 4 s limit for a transition's DOM update.
  await expect(page.getByRole("link", { name: "Settings" })).toBeFocused({ timeout: 2000 });
});

test("the production build opens a sample desk from the welcome page, sends nothing and never calls the server", async ({ page }) => {
  await page.route("**/api/me", route => route.fulfill({ contentType: "application/json", body: JSON.stringify({ signed_in: false }) }));
  await page.goto("/");
  const desk = page.getByRole("link", { name: "See a sample desk" });
  await expect(desk).toBeVisible();
  const calls: string[] = [];
  page.on("request", request => { if (new URL(request.url()).pathname.startsWith("/api/")) calls.push(`${request.url()} from ${request.frame().url()}`); });
  await desk.click();
  await expect(page).toHaveURL(/fixtures=1&persona=business&stage=busy#home$/);
  const banner = page.getByText("Sample data, nothing here is real");
  await expect(banner).toBeVisible();
  await expect(page.getByRole("heading", { level: 1 })).toBeVisible();
  await expect(page.getByRole("button", { name: "Sample: nothing is sent" }).first()).toBeDisabled();
  await page.getByRole("link", { name: "Inbox" }).click();
  await page.locator(".person").first().click();
  await expect(page.getByRole("button", { name: "Sample: nothing is sent" })).toBeDisabled();
  await page.keyboard.press("Escape");
  await page.locator("#astryx-app-shell-main").evaluate(el => el.scrollTo(0, el.scrollHeight));
  await expect(banner).toBeInViewport();
  await page.getByRole("link", { name: "See the creator desk" }).click();
  await expect(page).toHaveURL(/persona=creator&stage=busy#home$/);
  await expect(page.getByRole("link", { name: "See the business desk" })).toBeVisible();
  expect(calls).toEqual([]);
});

for (const [persona, off] of [["business", "Reel director"], ["creator", "Ad watcher"]] as const) {
  test(`each ${persona} agent tile sets how far it goes and takes one sentence`, async ({ page }) => {
    await page.setViewportSize({ width: 390, height: 844 });
    await page.goto(`http://127.0.0.1:8032/?fixtures=1&persona=${persona}&stage=ready#agents`);
    // The path's main app comes first.
    await expect(page.locator(".cover").first()).toHaveAccessibleName(persona === "business" ? "WhatsApp" : "Instagram");
    await openApp(page, persona === "business" ? "Instagram" : "Meta");
    // Off stays in its app, quiet.
    const resting = page.locator("article", { has: page.getByRole("heading", { name: off }) });
    await expect(resting).toHaveAttribute("data-mode", "off");
    await expect(resting.getByRole("radio", { name: "Off" })).toBeChecked();
    // An off agent doesn't run (the server answers 409).
    await expect(resting.getByRole("button", { name: `Run ${off}`, disabled: false })).toHaveCount(0);
    await expect(resting.getByText(/^Off\. It won't run until/)).toBeVisible();
    await expect(resting.getByRole("radio", { name: "Draft for me" })).toHaveCSS("color", "rgb(255, 255, 255)");
    if (persona === "creator") { await page.keyboard.press("Escape"); await openApp(page, "Instagram"); }
    const leads = page.locator("article", { has: page.getByRole("heading", { name: "Lead finder" }) });
    const modes = leads.getByRole("radiogroup", { name: "What Lead finder does on its own" });
    await modes.getByRole("radio", { name: "Ask me first" }).focus();
    await page.keyboard.press("ArrowRight");
    await expect(modes.getByRole("radio", { name: "Draft for me" })).toBeChecked();
    await expect(leads).toHaveAttribute("data-mode", "draft");
    await expect(leads.getByText("Saved")).toBeVisible();
    const note = leads.getByRole("textbox", { name: "Tell Lead finder" });
    await note.fill("x".repeat(281));
    await page.keyboard.press("Tab");
    await expect(leads.getByText("Keep it to 280 characters.")).toBeVisible();
    await note.fill("Only flag people who ask about price.");
    await expect(leads.getByText("37/280")).toBeVisible();
    await page.keyboard.press("Tab");
    await expect(leads.getByText("Saved")).toBeVisible();
    expect(await page.evaluate(() => document.documentElement.scrollWidth <= innerWidth)).toBe(true);
    // Both survive leaving the page and coming back.
    await page.keyboard.press("Escape");
    await page.getByRole("link", { name: "Home" }).click();
    await page.getByRole("link", { name: "Agents" }).click();
    await openApp(page, "Instagram");
    await expect(note).toHaveValue("Only flag people who ask about price.");
    await expect(modes.getByRole("radio", { name: "Draft for me" })).toBeChecked();
  });
}

test("Home asks before drafting for an Ask me first agent, and says what a draft drew on", async ({ page }) => {
  await page.goto("http://127.0.0.1:8032/?fixtures=1&persona=business&stage=busy#home");
  const ask = page.getByRole("listitem").filter({ hasText: "Tara" }).filter({ hasText: "Shall I draft a reply to this message?" });
  await expect(ask.getByRole("button", { name: "Skip" })).toBeVisible();
  await expect(ask.getByRole("textbox")).toHaveCount(0);
  await ask.getByRole("button", { name: "Draft it" }).click();
  await expect(ask).toHaveCount(0);
  const draft = page.getByRole("listitem").filter({ hasText: "Hi Rohan! That's our chocolate berry cake" });
  await expect(draft.getByText("Written in your style")).toBeVisible();
  const told = await page.evaluate(() => new Date(Date.now() - 3 * 86400e3).toLocaleDateString(undefined, { day: "numeric", month: "short" }));
  await expect(draft.getByText(`Used what you told me on ${told}: ₹650 for 1 kg; delivery in Pune is ₹60.`)).toBeVisible();
});

test("a draft says which of your posts the customer's photo shows, or that it is none", async ({ page }) => {
  await page.goto("http://127.0.0.1:8032/?fixtures=1&persona=business&stage=busy#home");
  const draft = page.getByRole("listitem").filter({ hasText: "Hi Rohan! That's our chocolate berry cake" });
  const posted = await page.evaluate(() => new Date("2026-10-20T18:30:00+00:00").toLocaleDateString(undefined, { day: "numeric", month: "short" }));
  const link = draft.getByRole("link", { name: new RegExp(`^Matched your post of ${posted}`) });
  await expect(link).toHaveAttribute("href", "https://www.instagram.com/");
  await expect(link).toHaveAttribute("target", "_blank");
  await expect(draft.locator("img.trace-thumb")).toBeVisible();
  await page.goto("http://127.0.0.1:8032/?fixtures=1&persona=creator&stage=busy#home");
  await expect(page.getByRole("listitem").filter({ hasText: "Thanks for looking out, Jay!" }).getByText("Not one of your posts")).toBeVisible();
});

test("Inbox shows the post a customer's photo matches", async ({ page }) => {
  await page.goto("http://127.0.0.1:8032/?fixtures=1&persona=business&stage=busy#inbox");
  await page.locator(".person").filter({ hasText: "Rohan" }).click();
  const dialog = page.getByRole("dialog");
  await expect(dialog.getByRole("link", { name: /^Matched your post of / })).toHaveAttribute("target", "_blank");
  await expect(dialog.getByRole("img", { name: "Sample post: chocolate berry cake, 1 kg" })).toBeVisible();
});

test("the sample desk shows a busy week, labelled photos and the owner's own WhatsApp", async ({ page }) => {
  for (const [persona, first, sent] of [["business", "Hi Rohan!", "Sent to Ananya ✓"], ["creator", "Hey Riya!", "Sent to Nikhil ✓"]] as const) {
    await page.goto(`http://127.0.0.1:8032/?fixtures=1&persona=${persona}&stage=busy#home`);
    const phone = page.getByRole("group", { name: /^Sample WhatsApp chat with your agent/ });
    // The urgent ping, the owner's 1, the confirmation, then the 9 PM summary.
    await expect(phone.getByRole("listitem")).toHaveText([/Reply 1 to send/, /^1You/, new RegExp(`^${sent}`), /9:00 PM$/]);
    await expect(phone.getByRole("listitem").nth(1)).toHaveCSS("animation-delay", "0.8s");
    // Each customer photo is a drawing, labelled so.
    const draft = page.getByRole("listitem").filter({ hasText: first }).first();
    await expect(draft.getByText("Sample photo")).toBeVisible();
    await page.goto(`http://127.0.0.1:8032/?fixtures=1&persona=${persona}&stage=busy#inbox`);
    await expect(page.locator(".person-card").nth(14)).toBeVisible();
  }
  await page.emulateMedia({ reducedMotion: "reduce" });
  await page.goto("http://127.0.0.1:8032/?fixtures=1&persona=business&stage=busy#home");
  await expect(page.locator(".phone-lines li").first()).toHaveCSS("animation-name", "none");
});

test("the sample desk never calls the server, so a real session is never used", async ({ page }) => {
  const calls: string[] = [];
  page.on("request", r => { const path = new URL(r.url()).pathname; if (path.startsWith("/api/") || path === "/mcp" || path.startsWith("/webhooks/")) calls.push(`${r.method()} ${path}`); });
  for (const persona of ["creator", "business"]) {
    for (const hash of ["home", "inbox", "agents", "settings"]) {
      await page.goto(`/?fixtures=1&persona=${persona}&stage=busy#${hash}`);
      await expect(page.getByText("Sample data")).toBeVisible();
    }
  }
  await page.goto("/?fixtures=1&persona=creator&stage=busy#agents");
  for (const app of ["Instagram", "WhatsApp", "Meta"]) {
    await openApp(page, app);
    const runs = await page.getByRole("dialog").getByRole("button", { name: /^Run/ }).all();
    for (const run of runs) if (await run.isEnabled()) await run.click();
    await page.keyboard.press("Escape");
    await expect(page.getByRole("dialog")).toHaveCount(0);
  }
  await page.goto("/?fixtures=1&persona=business&stage=busy#settings");
  for (const tab of ["Your work", "Connections", "Your agent", "AI model", "Muse", "Account"]) await page.getByRole("tab", { name: tab }).click();
  expect(calls).toEqual([]);
});


test("a chunk gone after a deploy reloads the page once instead of going blank", async ({ page }) => {
  let failed = false;
  await page.route("**/assets/Settings-*.js", route => { if (failed) return route.continue(); failed = true; return route.fulfill({ status: 404, body: "" }); });
  await page.goto("/?fixtures=1&persona=creator&stage=ready#settings");
  await expect(page.getByRole("dialog", { name: "Settings" })).toBeVisible();
  expect(failed).toBe(true);
});

test("the three app covers fit a laptop screen without scrolling, and stack on a phone", async ({ page }) => {
  for (const persona of ["business", "creator"]) {
    await page.setViewportSize({ width: 1440, height: 900 });
    await page.goto(`/?fixtures=1&persona=${persona}&stage=busy#agents`);
    await expect(page.locator(".cover")).toHaveCount(3);
    const main = page.locator("#astryx-app-shell-main");
    expect(await main.evaluate(el => el.scrollHeight <= el.clientHeight)).toBe(true);
    const [a, b] = await page.locator(".cover-art").evaluateAll(els => els.slice(0, 2).map(el => el.getBoundingClientRect().top));
    expect(a).toBe(b);
    await page.setViewportSize({ width: 390, height: 844 });
    expect(await page.evaluate(() => document.documentElement.scrollWidth <= innerWidth)).toBe(true);
  }
  // Each agent's choices read on one line, at laptop and phone widths alike.
  for (const width of [1440, 390]) {
    await page.setViewportSize({ width, height: width === 390 ? 844 : 900 });
    await openApp(page, "Instagram");
    // A label's text box is no taller than one line of it.
    expect(await page.getByRole("dialog").getByRole("radio").evaluateAll(els => els.every(el => {
      const text = [...el.querySelectorAll("*")].find(c => c.childElementCount === 0 && c.textContent) ?? el;
      return text.getBoundingClientRect().height < 1.5 * parseFloat(getComputedStyle(text).lineHeight);
    }))).toBe(true);
    expect(await page.getByRole("dialog").getByRole("radio").evaluateAll(els => els.every(el => el.scrollWidth <= el.clientWidth))).toBe(true);
    await page.keyboard.press("Escape");
  }
  // The cover opens from the keyboard, and closing hands focus back to it.
  await page.locator(".cover-open").first().focus();
  await page.keyboard.press("Enter");
  await expect(page.getByRole("dialog", { name: "Instagram" })).toBeVisible();
  await page.keyboard.press("Escape");
  await expect(page.getByRole("button", { name: "Instagram" })).toBeFocused();
});

test("Inbox shows one card per person, with their recent messages on hover, focus or the corner button", async ({ page }) => {
  await page.route("**/api/me", route => route.fulfill(json(signedIn)));
  await page.route("**/api/inbox", route => route.fulfill(json({ items: [
    { id: "a2", kind: "whatsapp", asset_id: "1", sender: "15550001", sender_name: "Ana", text: "Are you open?", created: now() - 60, replied: false },
    { id: "b1", kind: "whatsapp", asset_id: "1", sender: "15550002", sender_name: "Ben", text: "Do you deliver?", created: now() - 120, replied: false },
    { id: "a1", kind: "whatsapp", asset_id: "1", sender: "15550001", sender_name: "Ana", text: "Hi, it's Ana", created: now() - 3600, replied: true },
  ] })));
  await page.goto("/#inbox");
  await expect(page.locator(".person-card")).toHaveCount(2);
  await expect(page.locator(".person-card").first()).toContainText("2 messages");
  // Hover shows Ana's thread, oldest first; Escape closes it.
  await page.getByRole("button", { name: /Are you open\?/ }).hover();
  const ana = page.getByRole("region", { name: "Recent messages from Ana" });
  await expect(ana.getByRole("listitem")).toHaveText([/Hi, it's Ana.*you replied/, /Are you open\?/]);
  await page.keyboard.press("Escape");
  await expect(ana).toHaveCount(0);
  // Keyboard: focus shows it; the corner's button pins it, so its first Enter keeps it open (QA 10-5), the next closes it.
  await page.mouse.move(0, 0);
  await page.getByRole("button", { name: /Do you deliver\?/ }).focus();
  const ben = page.getByRole("region", { name: "Recent messages from Ben" });
  await expect(ben).toContainText("No earlier messages from Ben.");
  await page.keyboard.press("Tab");
  await expect(page.getByRole("button", { name: "Recent messages from Ben" })).toBeFocused();
  await page.keyboard.press("Enter");
  await expect(ben).toBeVisible();
  await page.keyboard.press("Enter");
  await expect(ben).toHaveCount(0);
  await page.keyboard.press("Enter");
  await expect(ben).toBeVisible();
  await page.keyboard.press("Tab");
  await page.keyboard.press("Enter");
  await expect(page.getByRole("dialog", { name: "Ben" })).toBeVisible();
});

test("a new message, draft or learned fact from the live stream shows a toast, and the new card arrives", async ({ page }) => {
  // On a phone, where the tab bar is (QA 10-2).
  await page.setViewportSize({ width: 390, height: 844 });
  let fresh = false;
  const ana = { id: "w1", kind: "whatsapp", asset_id: "1", sender: "15550001", sender_name: "Ana", text: "Are you open?", created: now() - 60, replied: false };
  const zoe = { id: "w9", kind: "whatsapp", asset_id: "1", sender: "15550009", sender_name: "Zoe", text: "Is the cake ready?", created: now(), replied: false };
  await page.route("**/api/me", route => route.fulfill(json(signedIn)));
  await page.route("**/api/inbox", route => route.fulfill(json({ items: fresh ? [zoe, ana] : [ana] })));
  // The owner answered the agent on WhatsApp: the fact it learned arrives with the next update.
  const fact = { id: 9, question: "What's your price for 40 mugs?", answer: "₹420 each, free delivery in Pune", created: now() };
  await page.route("**/api/agent", route => route.fulfill(json({ ...agentHome(), facts: fresh ? [fact] : [],
    needs: fresh ? [{ type: "draft", id: 1, event_id: "w9", text: "Yes, at 5.", source: "agent", created: now(), message: { kind: "whatsapp", sender: "15550009", sender_name: "Zoe", text: "Is the cake ready?" } }] : [] })));
  await page.route("**/api/stream", route => route.fulfill({ contentType: "text/event-stream",
    body: `retry: 300\nevent: update\ndata: {"inbox":"${fresh ? 2 : 1}","replies":"1","runs":"1","agent":"${fresh ? 2 : 1}","connections":"1"}\n\n` }));
  await page.goto("/#inbox");
  await expect(page.locator(".person-card")).toHaveCount(1);
  fresh = true;
  // The stream reconnects every 300 ms here; the next connection carries the new counts.
  const toasts = page.getByRole("region", { name: "Notifications" });
  await expect(toasts.getByText("New WhatsApp message from Zoe")).toHaveCount(1, { timeout: 15000 });
  await expect(toasts.getByText("Draft ready for Zoe")).toHaveCount(1);
  await expect(toasts.getByText("Learned: ₹420 each, free delivery in Pune")).toHaveCount(1);
  // The toast sits above the tab bar, not over it.
  const toast = await toasts.boundingBox(), bar = await page.getByRole("navigation", { name: "Main" }).boundingBox();
  expect(toast!.y + toast!.height).toBeLessThanOrEqual(bar!.y + 1);
  await expect(page.locator(".person-card")).toHaveCount(2);
  await expect(page.locator(".person-card").first()).toHaveCSS("animation-name", "arrive");
});

test("each draft says how it got here, step by step, from what the server sent", async ({ page }) => {
  await page.goto("http://127.0.0.1:8032/?fixtures=1&persona=business&stage=busy#home");
  const draft = page.getByRole("listitem").filter({ hasText: "Hi Rohan! That's our chocolate berry cake" });
  const steps = draft.getByRole("list", { name: "How it got here" }).getByRole("listitem");
  // Each step names the model that did it, by the app's names for the ids the server sends.
  await expect(steps).toHaveText(["Described the photoMuse Spark Open", /^Matched your post of /, /^Used what you told me on /, "Written in your style", "Drafted the replyMuse Spark Open", "Waiting for your tap"]);
  // One after another, 60 ms apart.
  await expect(steps.nth(2)).toHaveCSS("animation-delay", "0.12s");
  await page.emulateMedia({ reducedMotion: "reduce" });
  await expect(steps.nth(2)).toHaveCSS("animation-name", "none");
});

test("an Inbox draft for a voice note names the models behind it, and an older one skips what it doesn't have", async ({ page }) => {
  await page.route("**/api/me", route => route.fulfill(json(signedIn)));
  await page.route("**/api/inbox", route => route.fulfill(json({ items: [
    { id: "v1", kind: "whatsapp", asset_id: "1", sender: "15550001", sender_name: "Ana", text: "Do you deliver?", created: now() - 60, replied: false, voice: true,
      draft: { text: "Yes, today.", source: "agent", styled: true, used: null, models: { described_by: "muse-voice-transcribe-1.0", drafted_by: "meta-models/muse-spark-open-1026" } } },
    { id: "v0", kind: "whatsapp", asset_id: "1", sender: "15550003", sender_name: "Cy", text: "Still open?", created: now() - 80, replied: false, voice: true, draft: { text: "Yes.", source: "agent" } },
    { id: "v2", kind: "whatsapp", asset_id: "1", sender: "15550002", sender_name: "Ben", text: "Open now?", created: now() - 90, replied: false },
  ] })));
  await page.goto("/#inbox");
  await page.locator(".person", { hasText: "Do you deliver?" }).click();
  const steps = page.getByRole("dialog").getByRole("list", { name: "How it got here" }).getByRole("listitem");
  await expect(steps).toHaveText(["Transcribed the voice noteMuse Voice Transcribe", "Written in your style", "Drafted the replyMuse Spark Open", "Waiting for your tap"]);
  await page.keyboard.press("Escape");
  // An older message has no model ids: the steps stay, without names.
  await page.locator(".person", { hasText: "Still open?" }).click();
  await expect(page.getByRole("dialog", { name: "Cy" }).getByRole("list", { name: "How it got here" }).getByRole("listitem"))
    .toHaveText(["Transcribed the voice note", "Drafted the reply", "Waiting for your tap"]);
  await page.keyboard.press("Escape");
  // No draft, no chain.
  await page.locator(".person", { hasText: "Open now?" }).click();
  await expect(page.getByRole("dialog", { name: "Ben" })).toBeVisible();
  await expect(page.getByRole("list", { name: "How it got here" })).toHaveCount(0);
});

test("Home keeps its heading still while the panels load", async ({ page }) => {
  await page.addInitScript(() => {
    const w = window as unknown as { shift: number };
    w.shift = 0;
    new PerformanceObserver(list => { for (const e of list.getEntries() as unknown as { value: number; hadRecentInput: boolean }[]) if (!e.hadRecentInput) w.shift += e.value; }).observe({ type: "layout-shift", buffered: true });
  });
  const late = (ms: number, body: unknown) => async (route: Route) => { await new Promise(done => setTimeout(done, ms)); await route.fulfill(json(body)); };
  await page.route("**/api/me", route => route.fulfill(json({ ...signedIn, persona: "business" })));
  await page.route("**/api/agent", late(900, { ...agentHome(), watching: ["whatsapp"], last_checked: now() - 60 }));
  await page.route("**/api/agents", late(1000, { ai_ready: true, own_key: false, model: "m", order: ["replies"], runs: [] }));
  await page.route("**/api/setup/next", late(300, { persona: "business", done: true, step: null, progress: { done: 3, total: 3 } }));
  await page.goto("/#home");
  const heading = page.getByRole("heading", { level: 1 });
  await heading.waitFor();
  const before = (await heading.boundingBox())!.y;
  await expect(page.getByText("Watching WhatsApp")).toBeVisible();
  await page.waitForTimeout(1200);
  expect((await heading.boundingBox())!.y).toBe(before);
  // Under the 0.1 that counts as good (QA 10-1 measured 0.38).
  expect(await page.evaluate(() => (window as unknown as { shift: number }).shift)).toBeLessThan(0.1);
});

test("See results opens over its app's window and Escape steps back one level at a time", async ({ page }) => {
  await page.goto("/?fixtures=1&persona=creator&stage=busy#agents");
  await page.getByRole("button", { name: "Instagram", exact: true }).focus();
  await page.keyboard.press("Enter");
  const app = page.getByRole("dialog", { name: "Instagram" });
  await expect(app).toBeVisible();
  const see = app.getByRole("button", { name: "See results: Lead finder" });
  await see.focus();
  await page.keyboard.press("Enter");
  const results = page.getByRole("dialog", { name: "Lead finder" });
  await expect(results).toBeVisible();
  expect(await results.evaluate(el => el.contains(document.activeElement))).toBe(true);
  await page.keyboard.press("Escape");
  await expect(results).toHaveCount(0);
  await expect(app).toBeVisible();
  await expect(see).toBeFocused();
  await page.keyboard.press("Escape");
  await expect(app).toHaveCount(0);
  await expect(page.getByRole("button", { name: "Instagram", exact: true })).toBeFocused();
  // The sample names a real model (QA 9-3).
  await expect(page.getByText("Agents run on Muse Spark Open (sample).")).toBeVisible();
});

test("Settings opens on your own WhatsApp: linked with the window open, and every setting saves", async ({ page }) => {
  await page.setViewportSize({ width: 1440, height: 900 });
  await page.goto("http://127.0.0.1:8032/?fixtures=1&persona=business&stage=ready#settings");
  const panel = page.getByRole("dialog", { name: "Settings" }).getByRole("tabpanel");
  await expect(page.getByRole("tab").first()).toHaveText("On your WhatsApp");
  await expect(panel.getByText(/^Linked · I can message you until \d\d:\d\d$/)).toBeVisible();
  // Paired and open reads as "all good", in the success colour.
  await expect(panel.locator(".status-line .live-dot[data-ok]")).toHaveCount(1);
  // Only the last four digits show.
  await expect(panel.getByText("•••• 0001")).toBeVisible();
  await expect(panel.getByText("+919800000001")).toHaveCount(0);
  await expect(panel.getByRole("switch", { name: "Daily summary" })).toBeChecked();
  await expect(panel.getByLabel("Summary time")).toHaveValue("21:00");
  await expect(panel.getByLabel("From")).toHaveValue("23:00");
  await expect(panel.getByRole("checkbox", { name: "Big orders" })).toBeChecked();
  await panel.getByRole("checkbox", { name: "Brand deals" }).check();
  await expect(panel.getByText("Saved")).toBeVisible();
  await panel.getByRole("button", { name: "Send a test" }).click();
  await expect(panel.getByText("Sent. Check your WhatsApp.")).toBeVisible();
  // The whole section fits the Settings window on a laptop.
  for (let i = 0; i < 8; i++) { console.log("FIT", i, JSON.stringify(await panel.evaluate(el => [el.scrollHeight, el.clientHeight, el.innerText.length]))); await page.waitForTimeout(100); }
  expect(await panel.evaluate(el => el.scrollHeight <= el.clientHeight + 1)).toBe(true);
  // A bad number says why, on its own field.
  await panel.getByRole("button", { name: "Change number" }).click();
  const number = panel.getByRole("textbox", { name: /Your WhatsApp number/ });
  await number.fill("98000");
  await panel.getByRole("button", { name: "Save number" }).click();
  await expect(panel.getByText(/^That number doesn't look right/)).toBeVisible();
  // A new number has to be paired again: the code leads, and the button opens WhatsApp with it typed in.
  await number.fill("+91 98000 00002");
  await panel.getByRole("button", { name: "Save number" }).click();
  await expect(panel.getByText("Not linked")).toBeVisible();
  await expect(panel.getByRole("heading", { name: "Send this code to your agent: N3W5PH" })).toBeVisible();
  await expect(panel.getByRole("link", { name: "Open WhatsApp" })).toHaveAttribute("href", "https://wa.me/15550100000?text=hi%20N3W5PH");
  await expect(panel.getByText("or send hi N3W5PH to +15550100000 from your phone")).toBeVisible();
  await panel.getByRole("button", { name: "Send a test" }).click();
  await expect(panel.getByText(/^Pair your WhatsApp first/)).toBeVisible();
  // Daily summary off: its time stays in view, greyed out.
  await panel.getByRole("switch", { name: "Daily summary" }).click();
  await expect(panel.getByLabel("Summary time")).toBeDisabled();
});

test("a closed window says how to reopen it, and the test says exactly what's needed", async ({ page }) => {
  const owner = { phone: "+919800000001", link_code: "K7Q2XM", linked: true, business_number: "+15550100000", window_until: now() - 60,
    digest_time: null, tz: "Asia/Kolkata", quiet: null, urgent: [], last_ping: null };
  await page.route("**/api/me", route => route.fulfill(json(signedIn)));
  await page.route("**/api/owner-channel", route => route.fulfill(json(owner)));
  await page.route("**/api/owner-channel/test", route => route.fulfill({ status: 409, ...json({ needs: "window" }) }));
  await page.goto("/#settings");
  const panel = page.getByRole("dialog", { name: "Settings" }).getByRole("tabpanel");
  await expect(panel.getByText("Window closed: send any message to reopen")).toBeVisible();
  await panel.getByRole("button", { name: "Send a test" }).click();
  await expect(panel.getByText(/within 24 hours of your last message\. Send any message to the business number/)).toBeVisible();
});

test("Home says when it's pinging you on WhatsApp, and that the agent is one message away", async ({ page }) => {
  await page.goto("http://127.0.0.1:8032/?fixtures=1&persona=business&stage=busy#home");
  await expect(page.getByText(/· Pinging you on WhatsApp/)).toBeVisible();
  const strip = page.getByRole("region", { name: "Your agent on WhatsApp" });
  await expect(strip.getByText(/^Message your agent anytime: "what's pending\?" or "reply to \S+…"$/)).toBeVisible();
  await expect(strip.getByRole("link", { name: "Open the chat" })).toHaveAttribute("href", "https://wa.me/15550100000");
});

test("pairing needs only the code: the number is optional, and a failed test shows the server's own words", async ({ page }) => {
  await page.setViewportSize({ width: 1440, height: 900 });
  let owner = { phone: null, link_code: "9JJBDV", linked: false, business_number: "+15550100000", window_until: null, digest_time: null, tz: "Asia/Kolkata", quiet: null, urgent: [], last_ping: null };
  await page.route("**/api/me", route => route.fulfill(json(signedIn)));
  await page.route("**/api/agent", route => route.fulfill(json(agentHome())));
  await page.route("**/api/owner-channel", route => route.fulfill(json(owner = { ...owner, ...route.request().postDataJSON() })));
  await page.route("**/api/owner-channel/test", route => route.fulfill({ status: 502, ...json({ error: "WhatsApp refused it: the business number isn't registered yet.", code: 133010 }) }));
  await page.goto("/#settings");
  const panel = page.getByRole("dialog", { name: "Settings" }).getByRole("tabpanel");
  await expect(panel.getByRole("heading", { name: "Send this code to your agent: 9JJBDV" })).toBeVisible();
  await expect(panel.getByRole("link", { name: "Open WhatsApp" })).toHaveAttribute("href", "https://wa.me/15550100000?text=hi%209JJBDV");
  await expect(panel.getByRole("textbox", { name: /Your WhatsApp number/ })).toHaveCount(0);
  // Both timed messages off: the switches and their times still show, the times greyed out.
  await expect(panel.getByRole("switch", { name: "Daily summary" })).not.toBeChecked();
  await expect(panel.getByLabel("Summary time")).toBeDisabled();
  await expect(panel.getByLabel("Summary time")).toHaveValue("21:00");
  await expect(panel.getByLabel("From")).toBeDisabled();
  await panel.getByRole("switch", { name: "Quiet hours" }).click();
  await expect(panel.getByLabel("To", { exact: true })).toBeEnabled();
  await panel.getByRole("button", { name: "or type your number" }).click();
  await expect(panel.getByRole("textbox", { name: /Your WhatsApp number/ })).toBeVisible();
  await panel.getByRole("button", { name: "Send a test" }).click();
  // Still one window on a laptop, with the code, the number and the error all showing.
  // Measured once the answer is in; while the test is sending the layout is still changing.
  await expect(panel.getByText("WhatsApp refused it: the business number isn't registered yet.")).toBeVisible();
  expect(await panel.evaluate(el => el.scrollHeight <= el.clientHeight + 1)).toBe(true);
  // Not paired: Home has no chat strip yet.
  await page.keyboard.press("Escape");
  await expect(page.getByRole("region", { name: "Your agent on WhatsApp" })).toHaveCount(0);
});

test("not linked yet: Home offers one tap to set it up, and onboarding offers it as an optional last step", async ({ page }) => {
  const owner = { phone: null, link_code: "R4N8TB", linked: false, business_number: "+15550100000", window_until: null, digest_time: null, tz: "Asia/Kolkata", quiet: null, urgent: [], last_ping: null };
  await page.route("**/api/me", route => route.fulfill(json({ ...signedIn, persona: "business" })));
  await page.route("**/api/agent", route => route.fulfill(json(agentHome())));
  await page.route("**/api/owner-channel", route => route.fulfill(json(owner)));
  await page.route("**/api/setup/next", route => route.fulfill(json({ persona: "business", done: true, step: null, progress: { done: 3, total: 3 } })));
  await page.goto("/#home");
  // Onboarding offers it once the server's steps are done, and it can wait.
  const card = page.getByRole("dialog", { name: "Get pinged on your own WhatsApp" });
  await expect(card.getByRole("link", { name: "Set it up" })).toHaveAttribute("href", "#settings");
  await card.getByRole("button", { name: "Skip for now" }).click();
  await expect(card).toHaveCount(0);
  await expect(page.getByRole("link", { name: "Get pinged on your WhatsApp" })).toHaveAttribute("href", "#settings");
});
