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
