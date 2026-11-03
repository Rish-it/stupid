import { expect, test } from "@playwright/test";

const json = (body: unknown) => ({ contentType: "application/json", body: JSON.stringify(body) });

test("Connections says which features Meta didn't allow and offers to connect again", async ({ page }) => {
  await page.route("**/api/me", route => route.fulfill(json({
    signed_in: true, name: "Test", selected: ["ads:act_1", "instagram:1"], permissions: ["ads_read", "instagram_basic", "instagram_manage_comments"],
    assets: [{ key: "ads:act_1", kind: "ads", id: "act_1", name: "Test ads" }, { key: "instagram:1", kind: "instagram", id: "1", name: "Test IG" }],
  })));
  await page.goto("/#connections");
  await expect(page.getByText("Off because Meta wasn't allowed to share them: reach and insights, DMs. Connect again and allow them to turn these on.")).toBeVisible();
  await expect(page.getByText(/your ad results/)).toBeHidden();
  await expect(page.getByRole("link", { name: "Connect again to allow them" })).toHaveCount(1);
  await expect(page.getByRole("link", { name: "Add another Meta Ads account" })).toBeVisible();
});
