import { expect, test } from "@playwright/test";
import { explainMeta, metaHelp } from "../src/metaHelp";

const codeCases = [
  [131031, "locked"], [131042, "billing"], [141006, "billing"], [141007, "timezone"], [141010, "verification"],
  [131045, "registration"], [133010, "registration"], [131030, "testRecipient"], [131026, "recipient"], [131047, "window"],
  [190, "expired"], [10, "permissions"], [200, "permissions"], [130429, "rate"], [4, "rate"], [17, "rate"], [613, "rate"],
] as const;
for (const [code, key] of codeCases) {
  test(`Meta error ${code} has actionable help`, () => {
    for (const error of [`Meta failed (${code})`, `(#${code}) message`, `${code}: message`]) {
      expect(explainMeta(error)).toEqual({ blocking: true, ...metaHelp[key] });
    }
  });
}
for (const [key, help] of Object.entries(metaHelp)) {
  test(`Meta state ${key} has plain words, a fix and an exact link`, () => {
    expect(explainMeta(key)).toEqual({ blocking: true, ...help });
    expect(help.text.length).toBeGreaterThan(10);
    expect(help.fix.length).toBeGreaterThan(25);
    expect(new URL(help.link).protocol).toBe("https:");
  });
}

test("plain server errors use the same help and preserve unknown reasons", () => {
  expect(explainMeta("Meta only allows a reply within 24 hours of their message.")).toEqual(explainMeta("window"));
  expect(explainMeta("Meta access expired. Connect again.")).toEqual(explainMeta("expired"));
  expect(explainMeta("The Page wasn't shared.")).toEqual(explainMeta("permissions"));
  expect(explainMeta("Unexpected reason (1310311)").text).toBe("Unexpected reason (1310311)");
  expect(explainMeta("An unknown Meta error").text).toBe("An unknown Meta error");
  expect(explainMeta("").fix).toContain("Setup");
  const issue = { blocking: false, text: "An account-specific limit", fix: "A verified fix", link: "https://www.facebook.com/" };
  expect(explainMeta(issue)).toBe(issue);
});

test("Messenger and Instagram window help links to their own policy", () => {
  for (const kind of ["messenger", "instagram"] as const) {
    const help = explainMeta("Meta allows replies within 24 hours", kind);
    expect(help.link).toContain("messenger-platform/policy");
    expect(help.fix).not.toContain("template");
  }
});
