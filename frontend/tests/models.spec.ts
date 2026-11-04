import { expect, test } from "@playwright/test";

const json = (body: unknown) => ({ contentType: "application/json", body: JSON.stringify(body) });
const models = [
  { id: "meta-models/muse-spark-open-1026", label: "Muse Spark Open 1026 · open weights", provider: "baseten", open_weights: true },
  { id: "meta-models/muse-spark-open", label: "Muse Spark Open · open weights", provider: "baseten", open_weights: true },
  { id: "muse-spark-1.3", label: "Muse Spark 1.3 · Meta API", provider: "meta", open_weights: false },
  { id: "muse-spark-1.2", label: "Muse Spark 1.2 · Meta API", provider: "meta", open_weights: false },
  { id: "muse-spark-1.1", label: "Muse Spark 1.1 · Meta API", provider: "meta", open_weights: false },
];
const settings = (model: string) => ({ has_key: false, workspace_ai: true, model, brain: model.startsWith("meta-models/") ? "open" : "meta",
  meta_brain: true, open_model: models[0].id, meta_model: "muse-spark-1.3", models });
test.beforeEach(({ page }) => page.route("**/api/stream", route => route.fulfill({ status: 404, ...json({ message: "Not found." }) })));

for (const viewport of [{ width: 1280, height: 800 }, { width: 390, height: 760 }]) {
  test(`the person picks any listed Meta model and it saves at once (${viewport.width}px)`, async ({ page }) => {
    await page.setViewportSize(viewport);
    await page.route("**/api/me", route => route.fulfill(json({ signed_in: true, name: "Test", assets: [], selected: [], permissions: [], persona: "business" })));
    await page.route("**/api/settings/ai", route => route.fulfill(json(settings(models[0].id))));
    const sent: unknown[] = [];
    await page.route("**/api/settings/ai/model", route => {
      const body = route.request().postDataJSON() as { model: string };
      sent.push(body);
      return route.fulfill(json(settings(body.model)));
    });
    await page.goto("/#settings");
    await page.getByRole("tab", { name: "AI model" }).click();
    const list = page.getByRole("radiogroup", { name: "Model that runs your agents" });
    await expect(list.getByRole("radio")).toHaveCount(5);
    await expect(list.getByRole("radio", { name: "Muse Spark Open 1026" })).toBeChecked();
    await expect(list.getByText("open weights", { exact: true })).toHaveCount(2);
    await expect(list.getByText("Meta Model API · Stupid's key")).toHaveCount(3);
    await expect(page.getByText("Also used: Muse Wonder (videos), Muse Voice Transcribe (voice notes), SAM 3.1 (ad crops).")).toBeVisible();

    await list.getByText("Muse Spark 1.2", { exact: true }).click();
    await expect.poll(() => sent).toEqual([{ model: "muse-spark-1.2" }]);
    await expect(list.getByRole("radio", { name: "Muse Spark 1.2" })).toBeChecked();
    await expect(page.getByText("Agents run on muse-spark-1.2 through Meta's Model API")).toBeVisible();

    // The window never scrolls the page, and the cards are set apart by tone, not lines.
    expect(await page.evaluate(() => document.scrollingElement!.scrollHeight <= innerHeight)).toBe(true);
    const border = await list.getByRole("radio").first().evaluate(radio => {
      const card = radio.closest(".model-list [role=radiogroup] > *")!;
      const s = getComputedStyle(card);
      return [s.borderTopWidth, s.borderBottomWidth, s.backgroundColor];
    });
    expect(border.slice(0, 2)).toEqual(["0px", "0px"]);
    expect(border[2]).not.toBe("rgba(0, 0, 0, 0)");
  });
}
