import { expect, test } from "@playwright/test";

const json = (body: unknown) => ({ contentType: "application/json", body: JSON.stringify(body) });
test.beforeEach(({ page }) => page.route("**/api/stream", route => route.fulfill({ status: 404, ...json({ message: "Not found." }) })));

test("the door picked before sign-in is saved as the account's path after sign-in", async ({ page }) => {
  let me: Record<string, unknown> = { signed_in: true, name: "Test", assets: [], selected: [], permissions: [], persona: null };
  const sent: unknown[] = [];
  await page.route("**/api/me", route => route.fulfill(json(me)));
  await page.route("**/api/me/persona", route => { sent.push(route.request().postDataJSON()); me = { ...me, persona: "business" }; return route.fulfill(json(me)); });
  await page.addInitScript(() => sessionStorage.setItem("stupid.persona", "business"));
  await page.goto("/");
  await expect.poll(() => sent).toEqual([{ persona: "business" }]);
});

test("the sample setup steps ask for one thing at a time on each path", async ({ page }) => {
  await page.goto("http://127.0.0.1:8032/?fixtures=1&stage=out");
  const steps = await page.evaluate(async () => {
    const { localNext } = await import("/src/fixtures.ts");
    const ig = { key: "instagram:1", kind: "instagram" as const, id: "1", name: "ig" };
    const wa = { key: "whatsapp:1", kind: "whatsapp" as const, id: "1", name: "wa" };
    const page = { key: "messenger:1", kind: "messenger" as const, id: "1", name: "page" };
    const lock = { blocking: true, text: "Locked.", fix: "Open Business Support Home.", link: "https://business.facebook.com/business-support-home/" };
    const me = (assets: (typeof ig | typeof wa | typeof page)[]) => ({ assets, selected: assets.map(a => a.key), permissions: [] });
    const id = (n: ReturnType<typeof localNext>) => [n.step?.id ?? "", n.done, `${n.progress.done}/${n.progress.total}`].join(" ");
    return [
      id(localNext(me([]), "", null)),
      id(localNext(me([]), "", "creator")),
      id(localNext(me([{ ...ig, issues: [lock] }]), "", "creator")),
      id(localNext(me([ig]), "", "creator")),
      id(localNext(me([ig]), "Fashion; paid collabs only.", "creator")),
      id(localNext(me([]), "", "business")),
      id(localNext(me([wa]), "", "business")),
      id(localNext(me([{ ...wa, issues: [lock] }, page]), "", "business")),
      id(localNext(me([wa, page]), "Open 9 to 7.", "business")),
      // The button names what the title asks for.
      `${localNext(me([]), "", "business").step?.button} / ${localNext(me([page]), "", "business").step?.button}`,
    ];
  });
  expect(steps).toEqual([
    " false 0/0",
    "instagram_connect false 0/3",
    "instagram_issue false 1/3",
    "agent_facts true 2/3",
    " true 3/3",
    "whatsapp_connect false 0/4",
    "page_connect false 2/4",
    "whatsapp_payment false 2/4",
    " true 4/4",
    "Connect WhatsApp and Page / Connect WhatsApp",
  ]);
});

const me = (persona: string | null) => ({ signed_in: true, name: "Test", assets: [], selected: [], permissions: [], persona });
const step = (id: string, action: string, extra = {}) => ({ id, app: "whatsapp", title: `Title ${id}`, why: "Why.", action, button: "Go", optional: false, ...extra });

test("onboarding asks for the path in one card over Home when none was picked", async ({ page }) => {
  let account = me(null);
  const sent: unknown[] = [];
  await page.route("**/api/me", route => route.fulfill(json(account)));
  await page.route("**/api/me/persona", route => { sent.push(route.request().postDataJSON()); account = me("creator"); return route.fulfill(json(account)); });
  await page.route("**/api/setup/next", route => route.fulfill(json(account.persona
    ? { persona: "creator", done: false, progress: { done: 0, total: 3 }, step: step("instagram_connect", "connect", { app: "instagram", title: "Connect Instagram" }) }
    : { persona: null, done: false, progress: { done: 0, total: 0 } })));
  await page.goto("/");
  const card = page.getByRole("dialog", { name: "What do you do on Meta?" });
  await card.getByRole("button", { name: "I create content" }).click();
  expect(sent).toEqual([{ persona: "creator" }]);
  await expect(page.getByRole("dialog", { name: "Connect Instagram" })).toBeVisible();
  // The new step's heading takes focus, not the page.
  await expect(page.getByRole("heading", { name: "Connect Instagram" })).toBeFocused();
  await expect(page.getByRole("link", { name: "Go" })).toHaveAttribute("href", "/api/v1/meta/oauth/start");
  await expect(page.getByText("Step 1 of 3")).toBeVisible();
  // At 0 done the empty track still shows against the card.
  const contrast = await page.getByRole("progressbar").evaluate(bar => {
    const rgba = (e: Element) => (getComputedStyle(e).backgroundColor.match(/[\d.]+/g) ?? []).map(Number);
    const [r, g, b, a = 1] = rgba(bar); // the progressbar element is the track itself
    const card = rgba(bar.closest("dialog")!);
    const lum = (c: number[]) => c.slice(0, 3).map(v => { v /= 255; return v <= 0.03928 ? v / 12.92 : ((v + 0.055) / 1.055) ** 2.4; })
      .reduce((sum, v, k) => sum + v * [0.2126, 0.7152, 0.0722][k], 0);
    const [l1, l2] = [lum([r, g, b].map((v, k) => v * a + card[k] * (1 - a))), lum(card)];
    return (Math.max(l1, l2) + 0.05) / (Math.min(l1, l2) + 0.05);
  });
  expect(contrast).toBeGreaterThan(1.5);
});

test("a fix in Meta is checked on return, and the card closes when setup is done", async ({ page }) => {
  let refreshed = 0;
  await page.route("**/api/me", route => route.fulfill(json(me("business"))));
  await page.route("**/api/connections/refresh", route => { refreshed++; return route.fulfill(json({ assets: [], selected: [], permissions: [], problems: [] })); });
  await page.route("**/api/setup/next", route => route.fulfill(json(refreshed
    ? { persona: "business", done: true, progress: { done: 4, total: 4 } }
    : { persona: "business", done: false, progress: { done: 2, total: 4 }, step: step("whatsapp_payment", "fix_in_meta", { link: "https://business.facebook.com/", fix: "Add a payment method." }) })));
  await page.goto("/");
  const card = page.getByRole("dialog", { name: "Title whatsapp_payment" });
  await expect(card.getByText("Add a payment method.")).toBeVisible();
  await expect(card.getByRole("link", { name: "Go" })).toHaveAttribute("target", "_blank");
  await page.evaluate(() => document.dispatchEvent(new Event("visibilitychange")));
  await expect(card).toBeHidden();
  expect(refreshed).toBe(1);
});

test("telling the agent saves rules without flipping drafting, and the step can be skipped", async ({ page }) => {
  let saved: unknown;
  await page.route("**/api/me", route => route.fulfill(json(me("business"))));
  await page.route("**/api/agent", route => route.fulfill(json({ proactive: false, rules: "", facts: [], needs: [], tickets: [], watching: [], last_checked: null })));
  await page.route("**/api/agent/settings", route => { saved = route.request().postDataJSON(); return route.fulfill(json(saved)); });
  await page.route("**/api/setup/next", route => route.fulfill(json(saved
    ? { persona: "business", done: true, progress: { done: 4, total: 4 } }
    : { persona: "business", done: true, progress: { done: 3, total: 4 }, step: step("agent_facts", "tell_agent", { app: "agent", optional: true, button: "Save" }) })));
  await page.goto("/");
  const card = page.getByRole("dialog", { name: "Title agent_facts" });
  await card.getByRole("button", { name: "Skip for now" }).click();
  await expect(card).toBeHidden();
  await page.evaluate(() => sessionStorage.clear());
  await page.reload();
  // The step says what to write once; the box doesn't repeat it.
  await expect(card.getByLabel("About you")).not.toHaveAttribute("placeholder");
  await card.getByLabel("About you").fill("Open 9 to 7.");
  await card.getByRole("button", { name: "Save" }).click();
  await expect(card).toBeHidden();
  expect(saved).toEqual({ proactive: false, rules: "Open 9 to 7." });
  // Nothing opened the card, so focus starts at the page heading.
  await expect(page.getByRole("heading", { level: 1 })).toBeFocused();
});

test("rules told in onboarding show in Settings right away", async ({ page }) => {
  let rules = "";
  await page.route("**/api/me", route => route.fulfill(json(me("business"))));
  await page.route("**/api/agent", route => route.fulfill(json({ proactive: true, rules, facts: [], needs: [], tickets: [], watching: [], last_checked: null })));
  await page.route("**/api/agent/settings", route => { rules = route.request().postDataJSON().rules; return route.fulfill(json({ proactive: true, rules })); });
  await page.route("**/api/setup/next", route => route.fulfill(json(rules
    ? { persona: "business", done: true, progress: { done: 4, total: 4 } }
    : { persona: "business", done: true, progress: { done: 3, total: 4 }, step: step("agent_facts", "tell_agent", { app: "agent", optional: true, button: "Save" }) })));
  await page.goto("/");
  const card = page.getByRole("dialog", { name: "Title agent_facts" });
  await card.getByLabel("About you").fill("Open 9 to 7.");
  await card.getByRole("button", { name: "Save" }).click();
  await expect(card).toBeHidden();
  // Same visit, no reload: Settings reads what Home already loaded.
  await page.evaluate(() => { location.hash = "settings"; });
  await page.getByRole("tab", { name: "Your agent" }).click();
  await expect(page.getByLabel("Rules for your agent")).toHaveValue("Open 9 to 7.");
});

test("closing a required step leaves it with the agent's head, one tap from fixing", async ({ page }) => {
  await page.route("**/api/me", route => route.fulfill(json(me("business"))));
  await page.route("**/api/agent", route => route.fulfill(json({ proactive: true, rules: "", facts: [], needs: [], tickets: [], watching: [], last_checked: null })));
  await page.route("**/api/setup/next", route => route.fulfill(json({ persona: "business", done: false, progress: { done: 0, total: 4 },
    step: step("whatsapp_connect", "connect", { title: "Connect WhatsApp and your Facebook Page", button: "Connect WhatsApp and Page" }) })));
  await page.goto("/");
  const card = page.getByRole("dialog", { name: "Connect WhatsApp and your Facebook Page" });
  await expect(card).toBeVisible();
  await page.keyboard.press("Escape");
  await expect(card).toBeHidden();
  // Home itself stays calm; what's left sits with the agent's head.
  await expect(page.getByText(/Setup isn't finished/)).toHaveCount(0);
  await page.getByRole("button", { name: "Your agent: 1 thing to finish" }).click();
  const head = page.getByRole("dialog", { name: "A few things to finish" });
  await expect(head.getByText("Connect WhatsApp and your Facebook Page")).toBeVisible();
  await expect(head.getByRole("link", { name: "Connect WhatsApp and Page" })).toBeVisible();
  await page.keyboard.press("Escape");
  await expect(head).toBeHidden();
});
