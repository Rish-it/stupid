import { expect, test } from "@playwright/test";
import { readFileSync } from "node:fs";
import { resolve } from "node:path";
import { gzipSync } from "node:zlib";

const json = (body: unknown) => ({ contentType: "application/json", body: JSON.stringify(body) });

test("first-load JavaScript stays within 200 kB gzip", async ({ page }) => {
  const scripts = new Set<string>();
  page.on("response", response => {
    const path = new URL(response.url()).pathname;
    if (response.request().resourceType() === "script" && path.startsWith("/assets/") && path.endsWith(".js")) scripts.add(path);
  });
  await page.route("**/api/me", route => route.fulfill(json({ signed_in: false })));
  await page.goto("/");
  await expect(page.getByRole("heading", { level: 1 })).toBeVisible();
  await page.waitForLoadState("networkidle");
  const total = [...scripts].reduce((sum, path) => sum + gzipSync(readFileSync(resolve("frontend/dist", path.slice(1)))).byteLength, 0);
  expect(total).toBeGreaterThan(0);
  expect([...scripts].some(path => /Mascot|Tutorial|Setup/.test(path))).toBe(false);
  expect(total).toBeLessThanOrEqual(200_000);
  console.log(`First-load JavaScript: ${total} bytes gzip across ${scripts.size} scripts`);
});
