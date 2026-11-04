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
  const open = page.getByRole("dialog").getByRole("link", { name: "Open in Meta", exact: true });
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

for (const [kind, name, instruction] of [
  ["instagram", "Instagram", "Switch to Professional"],
  ["whatsapp", "WhatsApp", "Find the business account and number"],
  ["messenger", "Facebook Page", "Create a Page if you need one"],
  ["ads", "Meta Ads", "Choose or create an ad account"],
]) {
  for (const stage of ["connect", "choose", "fix", "ready"]) {
    test(`tutorial fixtures: ${name} resumes at ${stage}`, async ({ page }) => {
      await page.goto(`http://127.0.0.1:8032/?fixtures=1&tutorial=${kind}&stage=${stage}#setup`);
      await expect(page.getByText("Nothing on this page is real.")).toBeVisible();
      await page.getByRole("button", { name: `${stage === "connect" ? "Connect" : "Manage"} ${name}`, exact: true }).click();
      const dialog = page.getByRole("dialog");
      if (stage === "connect") {
        await expect(dialog.getByText("What you need", { exact: true })).toBeVisible();
        await expect(dialog.getByText(instruction, { exact: true })).toBeVisible();
        await expect(dialog.getByText(/Come back here. Stupid checks/)).toBeVisible();
        await expect(dialog.getByRole("link", { name: "Continue with Facebook" })).toHaveAttribute("href", "/api/v1/meta/oauth/start");
      } else if (stage === "choose") {
        const account = dialog.getByRole("switch", { name: `Sample ${kind} account` });
        await expect(account).not.toBeChecked();
        await account.click();
        await expect(account).toBeChecked();
        await expect(dialog.getByText(`${name} is ready.`, { exact: true })).toBeVisible();
      } else if (stage === "fix") {
        await expect(page.getByText("Needs one step")).toBeVisible();
        await expect(dialog.getByRole("link", { name: "Open in Meta", exact: true })).toHaveAttribute("target", "_blank");
        await page.evaluate(() => document.dispatchEvent(new Event("visibilitychange")));
        await expect(dialog.getByText(`${name} is ready.`, { exact: true })).toBeVisible();
        await expect(page.getByText("Needs one step")).toHaveCount(0);
      } else {
        await expect(dialog.getByText(`${name} is ready.`, { exact: true })).toBeVisible();
        await expect(dialog.getByRole("button", { name: "Done", exact: true })).toBeVisible();
      }
    });
  }
}

test("a failed tutorial refresh leaves the issue and progress in place", async ({ page }) => {
  await page.goto("http://127.0.0.1:8032/?fixtures=1&tutorial=whatsapp&stage=fix&refresh=fail#setup");
  await page.getByRole("button", { name: "Manage WhatsApp" }).click();
  await page.getByRole("button", { name: "Check again" }).click();
  await expect(page.getByText("Meta could not be reached. Try again.")).toBeVisible();
  await expect(page.getByText("Needs one step")).toBeVisible();
  await expect(page.getByRole("dialog").getByText("Meta has locked this WhatsApp account.")).toBeVisible();
  await expect(page.getByRole("button", { name: "Done", exact: true })).toHaveCount(0);
});

test("Before you start explains the account requirements before sign-in", async ({ page }) => {
  await page.route("**/api/me", route => route.fulfill(json({ signed_in: false })));
  await page.goto("/");
  await page.getByText("Before you start", { exact: true }).click();
  await expect(page.getByText(/For Instagram, have a public Professional account/)).toBeVisible();
  await expect(page.getByText(/Business verification is needed only when Meta asks/)).toBeVisible();
});

test("tutorial progress only fills after Meta confirms the change", async ({ page }) => {
  await page.goto("http://127.0.0.1:8032/?fixtures=1&tutorial=instagram&stage=connect#setup");
  await page.getByRole("button", { name: "Connect Instagram" }).click();
  const progress = page.getByRole("progressbar", { name: "Instagram setup progress" });
  await expect(progress).toHaveAttribute("aria-valuenow", "0");
  await page.getByRole("button", { name: "Check again" }).click();
  await expect(page.getByText("Checked just now.")).toBeVisible();
  await expect(progress).toHaveAttribute("aria-valuenow", "0");
  await expect(page.locator(".tutorial-complete")).toHaveCount(0);
  await page.goto("http://127.0.0.1:8032/?fixtures=1&tutorial=instagram&stage=fix#setup");
  await page.getByRole("button", { name: "Manage Instagram" }).click();
  await expect(progress).toHaveAttribute("aria-valuenow", "2");
  await page.getByRole("button", { name: "Check again" }).click();
  await expect(progress).toHaveAttribute("aria-valuenow", "3");
  await expect(page.locator(".tutorial-just-completed")).toHaveText("Instagram is ready.");
});

test("reduced motion completes setup without animations or view transitions", async ({ page }) => {
  await page.emulateMedia({ reducedMotion: "reduce" });
  await page.goto("http://127.0.0.1:8032/?fixtures=1&tutorial=whatsapp&stage=fix#setup");
  await page.getByRole("button", { name: "Manage WhatsApp" }).click();
  await page.evaluate(() => { Object.defineProperty(document, "startViewTransition", { value: () => { throw new Error("Reduced motion must skip view transitions"); } }); });
  await page.getByRole("button", { name: "Check again" }).click();
  await expect(page.getByRole("progressbar")).toHaveAttribute("aria-valuenow", "3");
  await expect(page.getByText("WhatsApp is ready.", { exact: true })).toBeVisible();
  expect(await page.locator(".tutorial-step").evaluate(el => getComputedStyle(el).animationName)).toBe("none");
  expect(await page.locator(".tutorial-complete path").evaluate(el => getComputedStyle(el).animationName)).toBe("none");
  expect(await page.locator(".astryx-progress-bar-fill").evaluate(el => getComputedStyle(el).transitionDuration)).toBe("0s");
});

test("setup also completes when View Transitions is unavailable", async ({ page }) => {
  await page.goto("http://127.0.0.1:8032/?fixtures=1&tutorial=ads&stage=fix#setup");
  await page.getByRole("button", { name: "Manage Meta Ads" }).click();
  await page.evaluate(() => Object.defineProperty(document, "startViewTransition", { value: undefined }));
  await page.getByRole("button", { name: "Check again" }).click();
  await expect(page.getByRole("progressbar")).toHaveAttribute("aria-valuenow", "3");
  await expect(page.getByText("Meta Ads is ready.", { exact: true })).toBeVisible();
});

test("returning from Meta can add an app when another app was already ready", async ({ page }) => {
  const initial = { signed_in: true, name: "Test", assets: [ads], selected: [ads.key], permissions: ["ads_read"] };
  await page.route("**/api/me", route => route.fulfill(json(initial)));
  let checks = 0;
  await page.route("**/api/connections/refresh", route => {
    checks++;
    return route.fulfill(json({ assets: [ads, instagram], selected: [ads.key, instagram.key], problems: [],
      permissions: ["ads_read", "instagram_basic", "instagram_manage_insights", "instagram_manage_comments", "instagram_manage_messages"] }));
  });
  await page.goto("/#setup");
  await expect(page.getByRole("heading", { name: "You're set" })).toBeVisible();
  await page.getByRole("button", { name: "Connect Instagram" }).click();
  await expect(page.getByRole("progressbar")).toHaveAttribute("aria-valuenow", "0");
  await page.evaluate(() => document.dispatchEvent(new Event("visibilitychange")));
  await expect(page.getByRole("progressbar")).toHaveAttribute("aria-valuenow", "3");
  await expect(page.getByRole("dialog").getByText("Instagram is ready.", { exact: true })).toBeVisible();
  expect(checks).toBe(1);
});
