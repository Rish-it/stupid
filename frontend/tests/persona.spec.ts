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
  await expect(page.getByRole("link", { name: "Go" })).toHaveAttribute("href", "/api/v1/meta/oauth/start");
  await expect(page.getByText("Step 1 of 3")).toBeVisible();
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
  await page.route("**/api/agent", route => route.fulfill(json({ proactive: false, rules: "", needs: [], tickets: [], watching: [], last_checked: null })));
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
  await card.getByLabel("About you").fill("Open 9 to 7.");
  await card.getByRole("button", { name: "Save" }).click();
  await expect(card).toBeHidden();
  expect(saved).toEqual({ proactive: false, rules: "Open 9 to 7." });
});
