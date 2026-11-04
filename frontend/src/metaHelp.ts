import type { InboxKind, Issue } from "./api";

const integrations = "https://www.facebook.com/settings?tab=business_tools";
const support = "https://business.facebook.com/business-support-home/";
const billing = "https://business.facebook.com/latest/billing_hub/payment_methods/";
const errors = "https://developers.facebook.com/documentation/business-messaging/whatsapp/support/error-codes";
const registration = "https://developers.facebook.com/documentation/business-messaging/whatsapp/business-phone-numbers/registration";

export const metaHelp = {
  locked: { text: "Meta has restricted this WhatsApp account.", fix: "Meta has restricted your business. Open Security Center and verify your business (not the paid Meta Verified badge). If Meta shows another reason, follow it in Business Support Home. Sending works here again as soon as Meta lifts it.", link: "https://business.facebook.com/latest/settings/security_center" },
  billing: { text: "Meta couldn't use this account's billing setup.", fix: "In Billing & payments, select the affected account. Check Payment methods, any unpaid balance, currency and time zone. Production WhatsApp replies can be charged, even inside 24 hours.", link: billing },
  timezone: { text: "This WhatsApp account needs a time zone.", fix: "In business Settings, select WhatsApp accounts and the affected account, then complete its time zone. Come back to Setup and Check again.", link: "https://business.facebook.com/latest/settings/whatsapp_account" },
  verification: { text: "Meta needs a business verification step.", fix: "Select your business in Security Center and follow the requirement Meta shows. Start verification is available only when Meta requires it. This is separate from a paid Meta Verified badge.", link: "https://business.facebook.com/latest/settings/security_center" },
  registration: { text: "This WhatsApp number isn't registered for messaging.", fix: "Select your account in WhatsApp Manager → Phone numbers. Complete ownership verification and registration for your own number. Meta's test number is already registered; don't delete an existing WhatsApp account to experiment.", link: registration },
  testRecipient: { text: "This recipient isn't on the test number's list.", fix: "In the app's WhatsApp API Setup, open the To list, add this recipient and verify the code on their phone. Use a recipient who agreed to test. Stupid sends nothing until you tap Send.", link: "https://developers.facebook.com/documentation/business-messaging/whatsapp/get-started" },
  recipient: { text: "WhatsApp couldn't deliver to this person.", fix: "Check the recipient's number. Ask them through an existing contact method to confirm WhatsApp is up to date and to message your business number. Meta doesn't always share a more specific reason; avoid repeated retries.", link: errors },
  window: { text: "The 24-hour reply window has ended.", fix: "Wait for the customer to send a new message before replying here. On WhatsApp, an approved template can be used outside the window through your business's template tools; Stupid doesn't send templates. Retrying the same text won't reopen the window.", link: "https://developers.facebook.com/documentation/business-messaging/whatsapp/messages/send-messages#customer-service-windows" },
  expired: { text: "Meta access has expired.", fix: "In Facebook Business Integrations → Stupid, use Renew if offered. Then return to Setup and Connect again with the Facebook profile that manages these accounts.", link: integrations },
  permissions: { text: "Meta hasn't allowed this access yet.", fix: "Facebook Business Integrations → Stupid → View and Edit: tick the accounts and access you need, then Save. Check your Page or ad account role with its owner, then Connect again in Setup.", link: integrations },
  rate: { text: "Meta is limiting requests for now.", fix: "Give Meta a little time, then try once more. Repeated retries can prolong the limit. Check Business Support Home for any account restriction if it continues.", link: support },
  adsEmpty: { text: "No ad results in the last 7 days.", fix: "In Ads Manager, select the same ad account and Last 7 days. Check whether any campaign delivered in that period. New or paused campaigns can have no results; recent delivery can take time to appear. No need to start an ad to finish setup.", link: "https://adsmanager.facebook.com/adsmanager/manage/campaigns/" },
  instagramMissing: { text: "Instagram didn't return an account.", fix: "Check that Instagram is Professional (Creator or Business) and linked to the Page you shared. In Setup, review the Instagram steps, then Connect again and select both accounts. An absent account doesn't tell us which requirement is missing.", link: "https://help.instagram.com/502981923235522" },
  instagramEmpty: { text: "No Instagram posts were shared yet.", fix: "Check the profile you selected in Setup. Instagram insights cover eligible Professional content, and historical personal-account activity may be unavailable. If you have posts, check the access you granted before assuming the account is empty.", link: integrations },
  instagramInsights: { text: "Instagram didn't share insights for this period.", fix: "In Business Integrations → Stupid → View and Edit, allow insights and Save. Then Connect again in Setup. Some metrics require enough followers or eligible Professional activity; a dash means unavailable, not zero.", link: integrations },
  messages: { text: "Messages aren't appearing yet.", fix: "For Instagram, open Meta Business Suite → Inbox → Instagram and allow access to messages. For a Facebook Page, check Settings → How people find and contact you → Allow people to message your Page, plus your messaging role. New messages appear only after Meta shares them.", link: "https://www.facebook.com/business/help/1757908718358038" },
} satisfies Record<string, Omit<Issue, "blocking">>;

const codes: Record<string, keyof typeof metaHelp> = {
  "131031": "locked", "131042": "billing", "141006": "billing", "141007": "timezone", "141010": "verification",
  "131045": "registration", "133010": "registration", "131030": "testRecipient", "131026": "recipient", "131047": "window",
  "190": "expired", "10": "permissions", "200": "permissions", "130429": "rate", "4": "rate", "17": "rate", "613": "rate",
};

export function explainMeta(input: string | Issue, kind?: InboxKind): Issue {
  if (typeof input !== "string") return input;
  let key: keyof typeof metaHelp | undefined;
  if (Object.hasOwn(metaHelp, input)) key = input as keyof typeof metaHelp;
  else {
    const code = input.match(/(?:^|[\s(#])(?:#)?(\d{1,6})(?=[\s):,]|$)/g)?.map(value => value.match(/\d+/)![0]).find(value => Object.hasOwn(codes, value));
    if (code) key = codes[code];
    else if (/24[ -]?hour|24 hours/i.test(input)) key = "window";
    else if (/access expired|token.*expired/i.test(input)) key = "expired";
    else if (/permission|wasn't shared|not authorized|not allowed/i.test(input)) key = "permissions";
  }
  if (key === "window" && (kind === "messenger" || kind === "instagram")) return {
    blocking: true, text: metaHelp.window.text,
    fix: "Wait for the customer to send a new message before replying here. Stupid uses Meta's standard 24-hour window for Messenger and Instagram. Retrying the same text won't reopen it.",
    link: "https://developers.facebook.com/documentation/business-messaging/messenger-platform/policy",
  };
  return key ? { blocking: true, ...metaHelp[key] } : {
    blocking: true, text: input || "Meta didn't share a reason.",
    fix: "Review your account's steps in Setup. Check Business Integrations → Stupid → View and Edit for missing access, then Connect again. If Meta shows a restriction, follow it in Business Support Home.", link: integrations,
  };
}
