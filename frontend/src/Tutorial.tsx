import { Link } from "@astryxdesign/core/Link";
import { HStack, VStack } from "@astryxdesign/core/Stack";
import { Text } from "@astryxdesign/core/Text";
import type { AssetKind } from "./api";
import SourceIcon from "./SourceIcon";

type Instruction = { title: string; text: string; href: string; label?: string };
const guides: Record<AssetKind, { need: string; steps: Instruction[] }> = {
  instagram: {
    need: "Instagram must be a Professional account linked to your Facebook Page. Have access to both, using the Facebook profile that manages the Page.",
    steps: [
      { title: "Switch to Professional", text: "In Instagram: Profile → More → Settings and activity → For professionals → Account type and tools → Switch to professional account. Pick your category, then Switch to professional account. Choose Creator for a creator or artist, or Business for a shop or service, then Next. A private profile becomes public and pending follow requests are accepted.", href: "https://help.instagram.com/502981923235522", label: "How to switch" },
      { title: "Link your Facebook Page", text: "In Instagram: Edit profile → Public business information (Business) or Profile information (Creator) → Page → Connect or create → Continue → Login to Facebook → Continue. Select your Page and tap Connect. The Page and Instagram must belong to the same business portfolio.", href: "https://www.facebook.com/business/help/898752960195806" },
      { title: "Allow access to messages", text: "On a computer, open Meta Business Suite → Inbox → Instagram. Confirm Allow access to messages, click Continue and sign in to Instagram if asked. If Inbox is missing, ask the person with full control for messaging access.", href: "https://business.facebook.com/latest/inbox" },
    ],
  },
  messenger: {
    need: "A Facebook Page for your business and a Facebook profile with access to its messages. A personal profile, even with professional mode, is a different thing.",
    steps: [
      { title: "Create a Page if you need one", text: "On Facebook: Pages → Create page → Public page → Next → Get started. Enter a Page name, category and optional bio, then Create Page. Follow the optional contact, photo and invite steps, then Done.", href: "https://www.facebook.com/pages/creation/" },
      { title: "Check your access", text: "In Meta Business Suite Settings, choose the business portfolio → Accounts → Pages → your Page. Ask someone with full control to assign you access to messages if it is missing. Use that same Facebook profile when connecting Stupid.", href: "https://www.facebook.com/business/help/1101781386943864" },
      { title: "Let customers message the Page", text: "On Facebook, switch into the Page using See all profiles. Open Settings & privacy → Settings → How people find and contact you. Turn on Allow people to message your Page. Messaging audience controls can also prevent new chats.", href: "https://www.facebook.com/help/307375982614147" },
    ],
  },
  whatsapp: {
    need: "A WhatsApp Business Platform account and a registered number shared by your business portfolio. Linking the WhatsApp app to a Page alone does not register a Platform number.",
    steps: [
      { title: "Find the business account and number", text: "In WhatsApp Manager, select the correct account, then Phone numbers. Check that your number is connected and its display name is approved. In account settings, check the time zone. For an existing WhatsApp app number, check Meta's supported migration or coexistence route before making changes.", href: "https://business.facebook.com/wa/manage/home/" },
      { title: "Using a test number?", text: "Meta's app dashboard → WhatsApp use case → Quickstart → Start using the API → API Setup. Choose the test number under From. Under To, add your recipient number and verify the code. Test resources can send test templates without a payment method. Only verified test recipients can receive them; reply from the recipient to open a 24-hour reply window.", href: "https://developers.facebook.com/documentation/business-messaging/whatsapp/get-started" },
      { title: "Using your own number?", text: "In API Setup, choose Add phone number. Enter your business details and display name, verify ownership by SMS or call, and finish registration. Verification of a number, approval of its name and verification of your business are separate steps. Follow only the requirements Meta shows for your account.", href: "https://developers.facebook.com/documentation/business-messaging/whatsapp/business-phone-numbers/registration" },
      { title: "Check production billing", text: "In Billing & payments, select this WhatsApp account → Payment methods. Production service replies can be charged, including within the 24-hour window. Test resources and free entry point windows have different rules. Stupid does not add a payment method or send a test message for you.", href: "https://business.facebook.com/latest/billing_hub/payment_methods/" },
      { title: "If Meta locks the account", text: "Error 131031 means Meta locked or restricted the account, or could not verify account details. Open Business Support Home, select this account and follow the reason shown. Choose Request review if offered. A verified business can still be locked; repeatedly reconnecting does not remove a restriction.", href: "https://business.facebook.com/business-support-home/" },
    ],
  },
  ads: {
    need: "An ad account you can view with your Facebook profile. You can read past results without launching an ad or adding a new payment method.",
    steps: [
      { title: "Choose or create an ad account", text: "In Meta Business Suite Settings → Accounts → Ad accounts → + Add. Choose Create a new ad account if you need one; enter its name, time zone and currency, then Next → My business. Review the terms checkbox, then Create ad account. Add payment info is for running ads; Done lets you finish without it. Choose time zone and currency carefully: changing them can require a new account.", href: "https://business.facebook.com/latest/settings/ad_accounts" },
      { title: "Use an existing account and check roles", text: "In Ad accounts → + Add, use Add an ad account for one you own, or Request access to an ad account in another business portfolio for a client's account. Its owner must approve access. Ask the owner to assign you permission to view performance, then use that Facebook profile in Stupid.", href: "https://www.facebook.com/business/help/915885887059947" },
      { title: "If the last 7 days are empty", text: "In Ads Manager, select the same ad account and Last 7 days. Check whether any campaigns delivered in that period. A new or paused campaign may have no results, and recent delivery can take time to appear. You do not need to spend money just to complete Stupid's setup.", href: "https://adsmanager.facebook.com/adsmanager/manage/campaigns/" },
    ],
  },
};

export default function Tutorial({ kind }: { kind: AssetKind }) {
  const guide = guides[kind];
  return (
    <VStack gap={4}>
      <HStack gap={3} align="center">
        <span aria-hidden><SourceIcon source={kind} size={32} /></span>
        <VStack gap={1}>
          <Text as="p" weight="semibold">What you need</Text>
          <Text as="p" type="supporting">{guide.need}</Text>
        </VStack>
      </HStack>
      <ol className="steps tutorial-steps">
        {guide.steps.map(step => (
          <li key={step.title}>
            <VStack gap={1}>
              <Text as="p" weight="semibold">{step.title}</Text>
              <Text as="p" type="supporting">{step.text}</Text>
              <Link hasUnderline isExternalLink href={step.href}>{step.label ?? `Open in Meta: ${step.title}`}</Link>
            </VStack>
          </li>
        ))}
      </ol>
      <Text as="p" weight="semibold">Share it with Stupid</Text>
      <ol className="steps">
        <li>Tap Continue with Facebook here. In Meta, check the Facebook profile you are continuing as.</li>
        <li>When Meta asks, select the business portfolio and the Page, Instagram account, WhatsApp account or ad account you use. Tick your current assets and allow the requested messages, comments, insights and ad results. Screens depend on your account and Meta may skip ones you have already completed.</li>
        <li>Review the access Meta requests and finish its confirmation. Come back here and switch on the account you want Stupid to use.</li>
      </ol>
      <Text as="p" type="supporting" size="sm">Missed an account? Facebook Settings & privacy → Settings → Business Integrations → Stupid → View and Edit. Tick the missing accounts or access, then Save. Use Renew if Meta says access expired, then Connect again in Stupid. <Link hasUnderline isExternalLink href="https://www.facebook.com/settings?tab=business_tools">Open Business Integrations</Link></Text>
      <Text as="p" type="supporting">Come back here. Stupid checks Meta when you return; Check again looks now. Progress changes only when Meta shares the account and any blocking issue is fixed.</Text>
    </VStack>
  );
}
