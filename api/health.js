import {gateLegacy} from "./_lib/legacy-access.js";
import { getPayoutProviderReadiness } from "./_lib/payout-provider.js";
import { getPolicyConfig } from "./_lib/policy.js";
import { telegramReadiness } from "./_lib/telegram.js";
import { whatsappReadiness } from "./_lib/whatsapp.js";
import { wechatReadiness } from "./_lib/wechat.js";
import { listAuditEvents } from "./_lib/db.js";


async function whatsappDiagnostic() {
  const token = String(process.env.WHATSAPP_ACCESS_TOKEN || "").trim();
  const phoneId = String(process.env.WHATSAPP_PHONE_NUMBER_ID || "").trim();
  const version = String(process.env.WHATSAPP_GRAPH_VERSION || "v25.0").trim();

  let phoneProbe = { ok: false, reason: "missing_credentials" };
  if (token && phoneId) {
    try {
      const response = await fetch(
        `https://graph.facebook.com/${version}/${encodeURIComponent(phoneId)}?fields=id,display_phone_number,verified_name,quality_rating`,
        { headers: { Authorization: `Bearer ${token}` } }
      );
      const data = await response.json().catch(() => ({}));
      phoneProbe = response.ok && !data?.error
        ? {
            ok: true,
            httpStatus: response.status,
            idMatchesConfigured: String(data.id || "") === phoneId,
            hasDisplayPhoneNumber: Boolean(data.display_phone_number),
            hasVerifiedName: Boolean(data.verified_name),
            qualityRating: data.quality_rating || null
          }
        : {
            ok: false,
            httpStatus: response.status,
            error: {
              code: data?.error?.code ?? null,
              subcode: data?.error?.error_subcode ?? null,
              type: data?.error?.type || null,
              message: data?.error?.message || null
            }
          };
    } catch (error) {
      phoneProbe = { ok: false, reason: "probe_failed", message: error?.message || "Unknown error" };
    }
  }

  const wabaId = String(process.env.WHATSAPP_BUSINESS_ACCOUNT_ID || "").trim();
  const appId = String(process.env.WHATSAPP_APP_ID || "").trim();
  let tokenProbe = { ok: false, reason: "missing_token" };
  if (token) {
    try {
      const response = await fetch(
        `https://graph.facebook.com/${version}/debug_token?input_token=${encodeURIComponent(token)}`,
        { headers: { Authorization: `Bearer ${token}` } }
      );
      const data = await response.json().catch(() => ({}));
      const info = data?.data || {};
      tokenProbe = response.ok && !data?.error
        ? {
            ok: true,
            isValid: Boolean(info.is_valid),
            appId: info.app_id ? String(info.app_id) : null,
            expiresAt: Number(info.expires_at || 0) || null,
            dataAccessExpiresAt: Number(info.data_access_expires_at || 0) || null,
            scopes: Array.isArray(info.scopes)
              ? info.scopes.filter((scope) => String(scope).startsWith("whatsapp_"))
              : []
          }
        : {
            ok: false,
            httpStatus: response.status,
            error: data?.error?.message || "Could not debug access token"
          };
    } catch (error) {
      tokenProbe = { ok: false, reason: "probe_failed", message: error?.message || "Unknown error" };
    }
  }

  let permissionProbe = { ok: false, reason: "missing_token" };
  if (token) {
    try {
      const response = await fetch(
        `https://graph.facebook.com/${version}/me/permissions`,
        { headers: { Authorization: `Bearer ${token}` } }
      );
      const data = await response.json().catch(() => ({}));
      const rows = Array.isArray(data?.data) ? data.data : [];
      const granted = new Set(
        rows
          .filter((row) => String(row?.status || "").toLowerCase() === "granted")
          .map((row) => String(row?.permission || ""))
      );
      permissionProbe = response.ok && !data?.error
        ? {
            ok: true,
            messaging: granted.has("whatsapp_business_messaging"),
            management: granted.has("whatsapp_business_management")
          }
        : {
            ok: false,
            httpStatus: response.status,
            error: data?.error?.message || "Could not read token permissions"
          };
    } catch (error) {
      permissionProbe = { ok: false, reason: "probe_failed", message: error?.message || "Unknown error" };
    }
  }

  let wabaSubscription = { ok: false, reason: "missing_credentials" };
  if (token && wabaId) {
    try {
      const response = await fetch(
        `https://graph.facebook.com/${version}/${encodeURIComponent(wabaId)}/subscribed_apps`,
        { headers: { Authorization: `Bearer ${token}` } }
      );
      const data = await response.json().catch(() => ({}));
      wabaSubscription = response.ok && !data?.error
        ? {
            ok: true,
            httpStatus: response.status,
            subscribedAppCount: Array.isArray(data?.data) ? data.data.length : 0,
            hasSubscriptions: Array.isArray(data?.data) && data.data.length > 0,
            appIds: Array.isArray(data?.data)
              ? data.data.map((item) => String(item?.whatsapp_business_api_data?.id || item?.id || "")).filter(Boolean)
              : [],
            currentAppSubscribed: appId
              ? (Array.isArray(data?.data)
                  ? data.data
                      .map((item) => String(item?.whatsapp_business_api_data?.id || item?.id || ""))
                      .includes(appId)
                  : false)
              : null
          }
        : {
            ok: false,
            httpStatus: response.status,
            error: {
              code: data?.error?.code ?? null,
              subcode: data?.error?.error_subcode ?? null,
              type: data?.error?.type || null,
              message: data?.error?.message || null
            }
          };
    } catch (error) {
      wabaSubscription = { ok: false, reason: "probe_failed", message: error?.message || "Unknown error" };
    }
  }

  let wabaPhoneProbe = { ok: false, reason: "missing_credentials" };
  if (token && wabaId) {
    try {
      const response = await fetch(
        `https://graph.facebook.com/${version}/${encodeURIComponent(wabaId)}/phone_numbers`,
        { headers: { Authorization: `Bearer ${token}` } }
      );
      const data = await response.json().catch(() => ({}));
      const rows = Array.isArray(data?.data) ? data.data : [];
      wabaPhoneProbe = response.ok && !data?.error
        ? {
            ok: true,
            count: rows.length,
            configuredPhoneBelongsToWaba: rows.some((row) => String(row?.id || "") === phoneId)
          }
        : {
            ok: false,
            httpStatus: response.status,
            error: data?.error?.message || "Could not list WABA phone numbers"
          };
    } catch (error) {
      wabaPhoneProbe = { ok: false, reason: "probe_failed", message: error?.message || "Unknown error" };
    }
  }

  let events = [];
  try {
    events = await listAuditEvents(null, 300);
  } catch {}

  const whatsappEvents = events
    .filter((event) => String(event.event_type || "").startsWith("whatsapp_"))
    .slice(0, 50);
  const inbound = whatsappEvents.filter(
    (event) => event.event_type === "whatsapp_message_received"
  );
  const failures = whatsappEvents.filter(
    (event) => String(event.event_type || "").includes("failed")
  );

  return {
    phoneProbe,
    tokenProbe,
    permissionProbe,
    wabaSubscription,
    wabaPhoneProbe,
    audit: {
      whatsappEvents: whatsappEvents.length,
      inboundMessages: inbound.length,
      failures: failures.length,
      latestInboundAt: inbound[0]?.created_at || inbound[0]?.timestamp || null,
      latestInboundSenderLast4: (() => {
        let data = inbound[0]?.data || {};
        if (typeof data === "string") {
          try { data = JSON.parse(data); } catch { data = {}; }
        }
        const id = String(data?.whatsapp_user_id || "");
        return id ? id.slice(-4) : null;
      })(),
      latestReplyRecipientLast4: (() => {
        const reply = whatsappEvents.find((event) => event.event_type === "whatsapp_reply_sent");
        let data = reply?.data || {};
        if (typeof data === "string") {
          try { data = JSON.parse(data); } catch { data = {}; }
        }
        return data?.recipient_last4 || null;
      })(),
      latestEventTypes: whatsappEvents.slice(0, 12).map((event) => {
        let data = event.data || {};
        if (typeof data === "string") {
          try { data = JSON.parse(data); } catch { data = {}; }
        }
        return {
          type: event.event_type,
          at: event.created_at || event.timestamp || null,
          messageType: data?.message_type || null,
          deliveryStatus: data?.status || null,
          recipientId: data?.recipient_id ? "••••" + String(data.recipient_id).slice(-4) : null,
          errorCode: data?.error_code ?? null,
          errorTitle: data?.error_title || null,
          errorMessage: data?.error_message || data?.error || null,
          errorDetails: data?.error_details || null,
          dataKeys: data && typeof data === "object" ? Object.keys(data).slice(0, 12) : []
        };
      })
    }
  };
}

export default async function handler(req, res) {
  if (!gateLegacy(req,res)) return;
  const payoutProvider = getPayoutProviderReadiness();
  const payoutPolicy = getPolicyConfig();
  const telegram = telegramReadiness();
  const whatsapp = whatsappReadiness();
  const wechat = wechatReadiness();
  const diagnostic = String(req.query?.diagnostic || "").toLowerCase() === "whatsapp"
    ? await whatsappDiagnostic()
    : null;
  const checks = {
    ai: Boolean(process.env.GROQ_API_KEY),
    database: Boolean(process.env.DATABASE_URL),
    secureApprovals: Boolean(process.env.APPROVAL_HMAC_SECRET),
    devnetSigner: Boolean(process.env.SOLANA_DEVNET_PAYER_SECRET_KEY),
    settlementRecipient: Boolean(process.env.SOLANA_SETTLEMENT_RECEIVER),
    routeQuotes: Boolean(process.env.ROUTE_QUOTES_JSON),
    externalPayoutQuotes: payoutProvider.wiseQuoteReady,
    externalPayoutTransfer: payoutProvider.wiseTransferReady,
    externalPayoutBalanceConfigured: payoutProvider.wiseBalanceConfigured,
    externalPayoutAutoFunding: payoutProvider.wiseAutoFundingEnabled,
    externalPayoutFunding: payoutProvider.wiseFundingReady
  };

  const coreReady =
    checks.ai &&
    checks.database &&
    checks.secureApprovals;

  const devnetReady =
    checks.devnetSigner &&
    checks.settlementRecipient;

  return res.status(200).json({
    ok: true,
    service: "33jack",
    aiProvider: process.env.GROQ_API_KEY ? "groq" : "none",
    environment: process.env.VERCEL_ENV || process.env.NODE_ENV || "local",
    network: "solana-devnet",
    payoutProvider: payoutProvider.provider,
    channels: {
      whatsapp,
      telegram,
      wechat
    },
    ...(diagnostic ? { whatsappDiagnostic: diagnostic } : {}),
    payoutPolicy: {
      configured: payoutPolicy.configured,
      allowedCurrencies: payoutPolicy.allowedCurrencies,
      singleLimitUsd: payoutPolicy.singleLimitUsd,
      kybRequired: payoutPolicy.kybRequired,
      kybStatus: payoutPolicy.kybStatus,
      blockedCountriesConfigured: payoutPolicy.blockedCountries.length > 0
    },
    mode: coreReady && devnetReady ? "integrated-devnet" : "development",
    checks,
    readiness: {
      core: coreReady,
      solanaDevnet: devnetReady,
      externalPayoutSandbox:
        payoutProvider.externalSandbox && payoutProvider.wiseTransferReady,
      productionMoneyMovement: false
    },
    note:
      "Production money movement stays false until licensed payout/FX partners, KYB/KYC, authorization, monitoring and production custody controls are integrated."
  });
}
