import crypto from "node:crypto";
import OpenAI from "openai";
import {
  addAuditEvent,
  assignPaymentWorkspace,
  createWorkspaceInvite,
  getOrCreateTelegramWorkspace,
  getPayment,
  getTelegramPreferences,
  getTelegramWorkspaceMembership,
  joinWorkspaceInvite,
  listAuditEvents,
  listBeneficiaries,
  listPaymentsByWorkspace,
  listWorkspaceMembers,
  roleCan
} from "./db.js";
import { signWeChatLaunch, verifyWeChatLaunch } from "./wechat-auth.js";

const MAX_INVOICE_BYTES = Math.floor(3.2 * 1024 * 1024);
const MAX_AUDIO_BYTES = 16 * 1024 * 1024;
const WECHAT_AGENT_MODEL = () =>
  String(process.env.GROQ_AGENT_MODEL || "openai/gpt-oss-20b").trim();
const WECHAT_TRANSCRIPTION_MODEL = () =>
  String(process.env.GROQ_WHISPER_MODEL || "whisper-large-v3-turbo").trim();

const tokenCache =
  globalThis.__33jackWeChatAccessToken ||
  (globalThis.__33jackWeChatAccessToken = { token: "", expiresAt: 0 });

function appBaseUrl(req) {
  const explicit = String(process.env.PUBLIC_APP_URL || process.env.APP_BASE_URL || "").trim();
  if (explicit) return explicit.replace(/\/$/, "");
  const host =
    req?.headers?.["x-forwarded-host"] ||
    req?.headers?.host ||
    process.env.VERCEL_PROJECT_PRODUCTION_URL ||
    "";
  return host
    ? `https://${String(host).replace(/^https?:\/\//, "").replace(/\/$/, "")}`
    : "";
}

function wechatToken() {
  return String(process.env.WECHAT_TOKEN || "").trim();
}

function wechatAppId() {
  return String(process.env.WECHAT_APP_ID || "").trim();
}

function wechatAppSecret() {
  return String(process.env.WECHAT_APP_SECRET || "").trim();
}

function encodingAesKey() {
  return String(process.env.WECHAT_ENCODING_AES_KEY || "").trim();
}

function sha1Signature(parts = []) {
  return crypto
    .createHash("sha1")
    .update(parts.map((part) => String(part ?? "")).sort().join(""))
    .digest("hex");
}

function safeEqual(a, b) {
  const left = Buffer.from(String(a || ""));
  const right = Buffer.from(String(b || ""));
  return left.length === right.length && crypto.timingSafeEqual(left, right);
}

function decodeXml(value) {
  return String(value || "")
    .replace(/&lt;/g, "<")
    .replace(/&gt;/g, ">")
    .replace(/&quot;/g, '"')
    .replace(/&apos;/g, "'")
    .replace(/&amp;/g, "&");
}

function xmlField(xml, name) {
  const safe = String(name).replace(/[^A-Za-z0-9_:-]/g, "");
  const cdata = new RegExp(
    `<${safe}(?:\\s[^>]*)?><!\\[CDATA\\[([\\s\\S]*?)\\]\\]><\\/${safe}>`,
    "i"
  );
  const cdataMatch = String(xml || "").match(cdata);
  if (cdataMatch) return cdataMatch[1];

  const plain = new RegExp(
    `<${safe}(?:\\s[^>]*)?>([\\s\\S]*?)<\\/${safe}>`,
    "i"
  );
  const match = String(xml || "").match(plain);
  return match ? decodeXml(match[1].trim()) : "";
}

function parseIncomingXml(xml) {
  return {
    toUserName: xmlField(xml, "ToUserName"),
    fromUserName: xmlField(xml, "FromUserName"),
    createTime: xmlField(xml, "CreateTime"),
    msgType: xmlField(xml, "MsgType").toLowerCase(),
    content: xmlField(xml, "Content"),
    picUrl: xmlField(xml, "PicUrl"),
    mediaId: xmlField(xml, "MediaId"),
    mediaId16k: xmlField(xml, "MediaId16K"),
    format: xmlField(xml, "Format"),
    msgId: xmlField(xml, "MsgId"),
    event: xmlField(xml, "Event").toLowerCase(),
    eventKey: xmlField(xml, "EventKey"),
    title: xmlField(xml, "Title"),
    description: xmlField(xml, "Description"),
    url: xmlField(xml, "Url")
  };
}

function aesKeyBuffer() {
  const raw = encodingAesKey();
  if (!raw) throw new Error("WECHAT_ENCODING_AES_KEY is not configured");
  const key = Buffer.from(raw + "=", "base64");
  if (key.length !== 32) {
    throw new Error("WECHAT_ENCODING_AES_KEY must decode to 32 bytes");
  }
  return key;
}

function unpadWeChat(buffer) {
  if (!buffer.length) throw new Error("WeChat encrypted payload is empty");
  const pad = buffer[buffer.length - 1];
  if (pad < 1 || pad > 32 || pad > buffer.length) {
    throw new Error("WeChat encrypted payload has invalid PKCS#7 padding");
  }
  for (let i = buffer.length - pad; i < buffer.length; i += 1) {
    if (buffer[i] !== pad) {
      throw new Error("WeChat encrypted payload padding is invalid");
    }
  }
  return buffer.subarray(0, buffer.length - pad);
}

function decryptWeChatPayload(encrypted) {
  const key = aesKeyBuffer();
  const iv = key.subarray(0, 16);
  const ciphertext = Buffer.from(String(encrypted || ""), "base64");
  const decipher = crypto.createDecipheriv("aes-256-cbc", key, iv);
  decipher.setAutoPadding(false);
  const decrypted = Buffer.concat([decipher.update(ciphertext), decipher.final()]);
  const full = unpadWeChat(decrypted);

  if (full.length < 20) throw new Error("WeChat encrypted payload is too short");
  const messageLength = full.readUInt32BE(16);
  const messageStart = 20;
  const messageEnd = messageStart + messageLength;
  if (messageEnd > full.length) {
    throw new Error("WeChat encrypted payload has an invalid message length");
  }

  const message = full.subarray(messageStart, messageEnd).toString("utf8");
  const payloadAppId = full.subarray(messageEnd).toString("utf8");
  const configuredAppId = wechatAppId();
  if (configuredAppId && payloadAppId && payloadAppId !== configuredAppId) {
    throw new Error("WeChat encrypted payload AppID does not match");
  }
  return message;
}

function verifyPlainSignature(req) {
  const token = wechatToken();
  if (!token) return false;
  const signature = String(req.query?.signature || "");
  const timestamp = String(req.query?.timestamp || "");
  const nonce = String(req.query?.nonce || "");
  return safeEqual(signature, sha1Signature([token, timestamp, nonce]));
}

function verifyEncryptedSignature(req, encrypted) {
  const token = wechatToken();
  if (!token) return false;
  const signature = String(req.query?.msg_signature || "");
  const timestamp = String(req.query?.timestamp || "");
  const nonce = String(req.query?.nonce || "");
  return safeEqual(
    signature,
    sha1Signature([token, timestamp, nonce, String(encrypted || "")])
  );
}

export function wechatReadiness() {
  const appCredentials = Boolean(wechatAppId() && wechatAppSecret());
  const manualAccessToken = Boolean(String(process.env.WECHAT_ACCESS_TOKEN || "").trim());
  return {
    configured: Boolean(wechatToken() && (appCredentials || manualAccessToken)),
    callbackTokenConfigured: Boolean(wechatToken()),
    appIdConfigured: Boolean(wechatAppId()),
    appSecretConfigured: Boolean(wechatAppSecret()),
    encodingAesKeyConfigured: Boolean(encodingAesKey()),
    secureModeReady: Boolean(
      wechatToken() &&
      wechatAppId() &&
      encodingAesKey()
    ),
    outboundMessagingReady: appCredentials || manualAccessToken,
    agentConfigured: Boolean(process.env.GROQ_API_KEY),
    voiceTranscriptionConfigured: Boolean(process.env.GROQ_API_KEY),
    agentModel: WECHAT_AGENT_MODEL(),
    transcriptionModel: WECHAT_TRANSCRIPTION_MODEL()
  };
}

async function getWeChatAccessToken() {
  const manual = String(process.env.WECHAT_ACCESS_TOKEN || "").trim();
  if (manual) return manual;

  if (tokenCache.token && Date.now() < tokenCache.expiresAt) {
    return tokenCache.token;
  }

  const appId = wechatAppId();
  const secret = wechatAppSecret();
  if (!appId || !secret) {
    throw new Error("WECHAT_APP_ID and WECHAT_APP_SECRET are required for outbound WeChat API calls");
  }

  const url =
    "https://api.weixin.qq.com/cgi-bin/token" +
    `?grant_type=client_credential&appid=${encodeURIComponent(appId)}&secret=${encodeURIComponent(secret)}`;
  const response = await fetch(url);
  const data = await response.json().catch(() => ({}));

  if (!response.ok || !data?.access_token) {
    throw new Error(
      data?.errmsg ||
      data?.message ||
      `Could not obtain WeChat access token (HTTP ${response.status})`
    );
  }

  const ttl = Math.max(60, Number(data.expires_in || 7200) - 300);
  tokenCache.token = String(data.access_token);
  tokenCache.expiresAt = Date.now() + ttl * 1000;
  return tokenCache.token;
}

async function sendText(openId, content) {
  const token = await getWeChatAccessToken();
  const response = await fetch(
    `https://api.weixin.qq.com/cgi-bin/message/custom/send?access_token=${encodeURIComponent(token)}`,
    {
      method: "POST",
      headers: { "Content-Type": "application/json; charset=utf-8" },
      body: JSON.stringify({
        touser: String(openId),
        msgtype: "text",
        text: {
          content: String(content || "").slice(0, 1800)
        }
      })
    }
  );

  const data = await response.json().catch(() => ({}));
  if (!response.ok || Number(data?.errcode || 0) !== 0) {
    throw new Error(
      data?.errmsg ||
      data?.message ||
      `WeChat send message failed with HTTP ${response.status}`
    );
  }
  return data;
}

async function retrieveMedia(mediaId, maxBytes = MAX_INVOICE_BYTES) {
  if (!mediaId) throw new Error("WeChat media ID is missing");
  const token = await getWeChatAccessToken();
  const response = await fetch(
    `https://api.weixin.qq.com/cgi-bin/media/get?access_token=${encodeURIComponent(token)}&media_id=${encodeURIComponent(mediaId)}`
  );

  const contentType = String(response.headers.get("content-type") || "");
  if (contentType.includes("application/json") || contentType.includes("text/json")) {
    const data = await response.json().catch(() => ({}));
    throw new Error(
      data?.errmsg ||
      data?.message ||
      `WeChat media download failed (HTTP ${response.status})`
    );
  }
  if (!response.ok) {
    throw new Error(`WeChat media download failed with HTTP ${response.status}`);
  }

  const bytes = Buffer.from(await response.arrayBuffer());
  if (bytes.length > maxBytes) {
    const mb = Math.max(1, Math.floor(maxBytes / (1024 * 1024)));
    throw new Error(`WeChat media is over the ${mb} MB 33Jack limit`);
  }
  return {
    bytes,
    mimeType: contentType || "application/octet-stream"
  };
}

async function analyzeWeChatImage(req, message, corridor = "USD") {
  const media = await retrieveMedia(message.mediaId, MAX_INVOICE_BYTES);
  const base = appBaseUrl(req);
  if (!base) throw new Error("PUBLIC_APP_URL is not configured");

  const extension =
    media.mimeType.includes("png") ? "png" :
    media.mimeType.includes("webp") ? "webp" :
    "jpg";

  const response = await fetch(`${base}/api/analyze`, {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify({
      fileName: `wechat_invoice_${message.msgId || Date.now()}.${extension}`,
      mimeType: media.mimeType || "image/jpeg",
      fileData: media.bytes.toString("base64"),
      corridor
    })
  });

  const data = await response.json().catch(() => ({}));
  if (!response.ok) {
    throw new Error(data?.detail || data?.error || "Invoice analysis failed");
  }
  return data;
}

async function transcribeWeChatVoice(message) {
  const mediaId = message.mediaId16k || message.mediaId;
  if (!mediaId) return "";

  const apiKey = String(process.env.GROQ_API_KEY || "").trim();
  if (!apiKey) {
    throw new Error("Voice notes need GROQ_API_KEY before WeChat transcription can run");
  }

  const media = await retrieveMedia(mediaId, MAX_AUDIO_BYTES);
  const format = String(message.format || "").toLowerCase();
  const extension =
    format.includes("speex") ? "spx" :
    format.includes("wav") ? "wav" :
    format.includes("mp3") ? "mp3" :
    "amr";

  const form = new FormData();
  form.append(
    "file",
    new Blob([media.bytes], { type: media.mimeType || "application/octet-stream" }),
    `wechat_voice_${message.msgId || Date.now()}.${extension}`
  );
  form.append("model", WECHAT_TRANSCRIPTION_MODEL());
  form.append("response_format", "json");
  form.append(
    "prompt",
    "33Jack business finance voice command. Preserve supplier names, invoice references, currencies and amounts exactly."
  );

  const response = await fetch("https://api.groq.com/openai/v1/audio/transcriptions", {
    method: "POST",
    headers: { Authorization: `Bearer ${apiKey}` },
    body: form
  });
  const data = await response.json().catch(() => ({}));
  if (!response.ok) {
    throw new Error(
      data?.error?.message ||
      data?.message ||
      `Groq voice transcription failed with HTTP ${response.status}`
    );
  }

  const transcript = String(data?.text || "").trim();
  if (!transcript) throw new Error("The WeChat voice message did not contain a usable transcript");
  return transcript;
}

function riskFlags(risk = {}) {
  const flags = [];
  if (risk.duplicate) flags.push("duplicate");
  if (risk.beneficiary_changed) flags.push("beneficiary changed");
  if (risk.suspicious) flags.push("suspicious");
  if (Array.isArray(risk.missing_fields) && risk.missing_fields.length) {
    flags.push(`missing: ${risk.missing_fields.join(", ")}`);
  }
  return flags;
}

function invoiceSummary(analysis = {}) {
  const flags = riskFlags(analysis.risk);
  const amount =
    analysis.source_amount && analysis.source_currency
      ? `${analysis.source_currency} ${Number(analysis.source_amount).toLocaleString()}`
      : "Not extracted";

  return [
    "33Jack invoice review",
    "",
    `Supplier: ${analysis.supplier || "Not extracted"}`,
    `Invoice: ${analysis.invoice_number || analysis.invoice_name || analysis.id || "—"}`,
    `Amount: ${amount}`,
    `Target: ${analysis.destination_currency || "—"}`,
    `Route: ${analysis.recommended_route || analysis.route || "Pending"}`,
    `Risk: ${flags.length ? flags.join("; ") : "No active deterministic flags"}`,
    "",
    "AI prepared the instruction. Exact approval and money movement stay inside 33Jack."
  ].join("\n");
}

function compactStatus(payments = []) {
  const active = payments.filter((p) =>
    ["analyzed", "approved", "settling", "failed"].includes(String(p.status || ""))
  );
  const settled = payments.filter((p) =>
    ["settled_demo", "settled_devnet", "settled_celo"].includes(String(p.status || ""))
  );
  const flagged = payments.filter((p) => riskFlags(p.risk).length > 0);
  return { active, settled, flagged };
}

function normalized(value) {
  return String(value || "").trim().toLowerCase().replace(/\s+/g, " ");
}

function findReferencedPayment(text, payments = []) {
  const query = normalized(text);
  const exact = payments.find((payment) =>
    [payment.id, payment.invoice_number, payment.invoice_name]
      .filter(Boolean)
      .some((value) => query.includes(normalized(value)))
  );
  if (exact) return exact;

  const supplierMatches = payments.filter((payment) => {
    const supplier = normalized(payment.supplier);
    return supplier && query.includes(supplier);
  });
  return supplierMatches.length === 1 ? supplierMatches[0] : null;
}

function wantsPaymentReview(text) {
  return /^\s*(pay|approve|review|settle|send)\b/i.test(String(text || "")) ||
    /\b(prepare|open)\s+(the\s+)?(payment|invoice|review)\b/i.test(String(text || ""));
}

function signedReviewUrl(base, payment, openId, workspaceId) {
  if (!base || !payment?.id) return "";
  const token = signWeChatLaunch({
    paymentId: payment.id,
    wechatOpenId: openId,
    workspaceId
  });
  return `${base}/?channel=wechat&paymentId=${encodeURIComponent(payment.id)}&wxToken=${encodeURIComponent(token)}`;
}

function scopedBeneficiaries(payments = [], beneficiaries = []) {
  const keys = new Set(
    payments.map((payment) =>
      `${normalized(payment.supplier)}|${String(payment.destination_currency || "").toUpperCase()}`
    )
  );
  return beneficiaries
    .filter((beneficiary) =>
      keys.has(
        `${normalized(beneficiary.supplier_name)}|${String(beneficiary.destination_currency || "").toUpperCase()}`
      )
    )
    .slice(0, 50)
    .map((beneficiary) => ({
      supplier: beneficiary.supplier_name,
      destination_currency: beneficiary.destination_currency,
      bank_name: beneficiary.bank_name || null,
      account_last4: beneficiary.account_last4 || null,
      country: beneficiary.country || null,
      last_seen_at: beneficiary.last_seen_at || null
    }));
}

function compactAgentPayment(payment = {}) {
  return {
    id: payment.id,
    supplier: payment.supplier || null,
    invoice: payment.invoice_number || payment.invoice_name || null,
    source_currency: payment.source_currency || null,
    source_amount: payment.source_amount == null ? null : Number(payment.source_amount),
    destination_currency: payment.destination_currency || null,
    destination_amount: payment.destination_amount || null,
    route: payment.route || payment.recommended_route || null,
    status: payment.status || null,
    risk: {
      duplicate: Boolean(payment.risk?.duplicate),
      beneficiary_changed: Boolean(payment.risk?.beneficiary_changed),
      suspicious: Boolean(payment.risk?.suspicious),
      missing_fields: Array.isArray(payment.risk?.missing_fields)
        ? payment.risk.missing_fields
        : []
    }
  };
}

function deterministicAnswer(question, payments = []) {
  const query = normalized(question);
  const { active, settled, flagged } = compactStatus(payments);
  if (/risk|attention|flag|problem/.test(query)) {
    if (!flagged.length) return "I do not see any current payment with an active risk flag in this workspace.";
    return `You have ${flagged.length} payment(s) needing risk review: ${flagged
      .slice(0, 5)
      .map((p) => `${p.supplier || p.id} (${p.invoice_number || p.id})`)
      .join(", ")}.`;
  }
  if (/settled|paid|complete/.test(query)) {
    return `${settled.length} payment(s) are settled in this workspace. ${active.length} remain active or pending.`;
  }
  return `This workspace has ${payments.length} payment record(s): ${active.length} active/pending, ${settled.length} settled and ${flagged.length} needing risk review.`;
}

async function answerWorkspaceAgent(question, workspace, payments, beneficiaries) {
  if (!process.env.GROQ_API_KEY) {
    return {
      text: deterministicAnswer(question, payments),
      mode: "deterministic"
    };
  }

  const client = new OpenAI({
    apiKey: process.env.GROQ_API_KEY,
    baseURL: "https://api.groq.com/openai/v1"
  });
  const response = await client.responses.create({
    model: WECHAT_AGENT_MODEL(),
    input: [{
      role: "system",
      content: [{
        type: "input_text",
        text: `You are 33Jack inside WeChat for one business workspace.
You may read only the supplied workspace payments and beneficiary fingerprints.
Never claim to have moved, approved, cancelled or settled money from chat.
Never reveal full bank account details.
If the user asks to pay, approve, send or settle an existing invoice, explain that 33Jack can prepare a secure Review & Pay link and final approval occurs in the controlled 33Jack flow.
If a requested payment cannot be identified, ask for the invoice reference or ask the user to send an invoice image.
Call out duplicate, beneficiary-change, suspicious or missing-field risk clearly.
Be concise and operational.`
      }]
    }, {
      role: "user",
      content: [{
        type: "input_text",
        text: JSON.stringify({
          workspace: { id: workspace.id, name: workspace.name || null },
          question,
          payments: payments.map(compactAgentPayment).slice(0, 50),
          beneficiaries
        })
      }]
    }]
  });

  return {
    text: String(response.output_text || deterministicAnswer(question, payments)).trim(),
    mode: "groq"
  };
}

async function messageAlreadySeen(messageKey) {
  if (!messageKey) return false;
  const events = await listAuditEvents(null, 500);
  return events.some((event) =>
    event.event_type === "wechat_message_received" &&
    String(event.data?.wechat_message_id || "") === String(messageKey)
  );
}

function responseText(res, status, body) {
  if (typeof res.status === "function") {
    const out = res.status(status);
    if (typeof out.setHeader === "function") {
      out.setHeader("Content-Type", "text/plain; charset=utf-8");
    }
    if (typeof out.send === "function") return out.send(String(body));
  }
  res.statusCode = status;
  res.setHeader?.("Content-Type", "text/plain; charset=utf-8");
  return res.end(String(body));
}

export async function handleWeChatReview(req, res) {
  try {
    const paymentId = String(req.query?.paymentId || "").trim();
    const token = String(req.query?.token || "").trim();
    if (!paymentId || !token) {
      return res.status(400).json({ error: "paymentId and token are required" });
    }

    const auth = verifyWeChatLaunch(token, paymentId);
    const membership = await getTelegramWorkspaceMembership(
      `wechat:${auth.wechatOpenId}`
    );
    if (!membership || !roleCan(membership.member.role, "view")) {
      return res.status(403).json({ error: "WeChat workspace access is not available" });
    }

    const payment = await getPayment(paymentId);
    if (!payment) return res.status(404).json({ error: "Payment not found" });

    if (
      !payment.workspace_id ||
      String(payment.workspace_id) !== String(membership.workspace.id) ||
      String(auth.workspaceId) !== String(membership.workspace.id)
    ) {
      return res.status(403).json({ error: "Payment is not available to this WeChat workspace" });
    }

    return res.status(200).json({
      payment,
      channel: "wechat",
      workspace: {
        id: membership.workspace.id,
        name: membership.workspace.name,
        role: membership.member.role,
        canApprove: roleCan(membership.member.role, "approve")
      }
    });
  } catch (error) {
    return res.status(401).json({
      error: "WeChat review authentication failed",
      detail: error?.message || "Unknown WeChat review error"
    });
  }
}

export async function sendWeChatPaymentReceipt({ payment, wechatOpenId, base = "" }) {
  if (!payment?.id) throw new Error("Payment is required for WeChat receipt");
  if (!wechatOpenId) throw new Error("WeChat OpenID is required for receipt");

  const identity = `wechat:${wechatOpenId}`;
  const membership = await getTelegramWorkspaceMembership(identity);
  if (!membership || String(payment.workspace_id || "") !== String(membership.workspace.id)) {
    throw new Error("Payment is not available to this WeChat workspace");
  }

  const preferences = await getTelegramPreferences(membership.workspace.id, identity);
  if (preferences.receipt_messages === false) {
    return { ok: true, idempotent: false, suppressed: true };
  }

  if (!["settled_demo", "settled_devnet", "settled_celo"].includes(String(payment.status || ""))) {
    throw new Error(`Payment is not settled yet (current status: ${payment.status || "unknown"})`);
  }

  const events = await listAuditEvents(payment.id, 100);
  const alreadySent = events.some((event) =>
    event.event_type === "wechat_receipt_sent" &&
    String(event.data?.wechat_open_id || "") === String(wechatOpenId)
  );
  if (alreadySent) return { ok: true, idempotent: true };

  const amount = payment.source_amount && payment.source_currency
    ? `${payment.source_currency} ${Number(payment.source_amount).toLocaleString()}`
    : "—";
  const status = payment.status === "settled_devnet"
    ? "Settled on Solana Devnet"
    : "Settled in controlled demo";

  const lines = [
    "33Jack payment complete",
    "",
    `Supplier: ${payment.supplier || "—"}`,
    `Invoice: ${payment.invoice_number || payment.invoice_name || payment.id}`,
    `Invoice amount: ${amount}`,
    `Destination: ${payment.destination_amount || payment.destination_currency || "—"}`,
    `Status: ${status}`,
    "Reconciled: ✓",
    payment.settlement_signature ? `Reference: ${payment.settlement_signature}` : null
  ].filter(Boolean);

  if (payment.status === "settled_devnet" && payment.settlement_signature) {
    lines.push(
      "",
      `Solana Explorer: https://explorer.solana.com/tx/${payment.settlement_signature}?cluster=devnet`
    );
  }
  if (base) lines.push("", `Open 33Jack: ${base}`);

  await sendText(wechatOpenId, lines.join("\n"));
  await addAuditEvent(payment.id, "wechat_receipt_sent", `wechat-user:${wechatOpenId}`, {
    wechat_open_id: String(wechatOpenId),
    workspace_id: membership.workspace.id,
    status: payment.status,
    settlement_signature: payment.settlement_signature || null
  });

  return { ok: true, idempotent: false };
}

async function processWeChatMessage(req, message) {
  const openId = String(message.fromUserName || "").trim();
  if (!openId) return;

  const messageKey =
    String(message.msgId || "").trim() ||
    crypto.createHash("sha1")
      .update(
        [
          openId,
          message.createTime,
          message.msgType,
          message.event,
          message.eventKey,
          message.content,
          message.mediaId
        ].join("|")
      )
      .digest("hex");

  if (await messageAlreadySeen(messageKey)) return;

  await addAuditEvent(null, "wechat_message_received", "wechat-webhook", {
    wechat_message_id: messageKey,
    wechat_open_id: openId,
    message_type: message.msgType || "unknown",
    event: message.event || null
  });

  const identity = `wechat:${openId}`;
  const workspaceContext = await getOrCreateTelegramWorkspace({
    id: identity,
    first_name: `WeChat ••••${openId.slice(-4)}`
  });
  const workspace = workspaceContext.workspace;
  const member = workspaceContext.member;
  const base = appBaseUrl(req);

  if (message.msgType === "event") {
    if (message.event === "subscribe") {
      await sendText(
        openId,
        [
          "33Jack is connected.",
          "",
          "Send an invoice image, ask a finance question, or send a voice command.",
          "Examples:",
          "What payments need my attention?",
          "Pay invoice NX-2026-0929-014",
          "STATUS",
          "",
          "Money movement always requires the signed Review & Pay flow."
        ].join("\n")
      );
    }
    return;
  }

  if (message.msgType === "image") {
    await sendText(openId, "Invoice image received. 33Jack is extracting and checking it…");
    const analysis = await analyzeWeChatImage(req, message, "USD");
    if (!analysis?.id) throw new Error("Invoice analysis did not return a payment id");

    await assignPaymentWorkspace(analysis.id, workspace.id);
    await addAuditEvent(
      analysis.id,
      "wechat_invoice_attached",
      `wechat-user:${openId}`,
      {
        workspace_id: workspace.id,
        wechat_open_id: openId,
        role: member.role,
        media_id: message.mediaId || null
      }
    );

    const reviewUrl = signedReviewUrl(base, analysis, openId, workspace.id);
    await sendText(
      openId,
      `${invoiceSummary(analysis)}${reviewUrl ? `\n\nReview & Pay: ${reviewUrl}\nCelo wallet checkout: ${reviewUrl.replace("/?channel=", "/app/celo?channel=")}` : ""}`
    );
    return;
  }

  let text = String(message.content || "").trim();
  if (message.msgType === "voice") {
    await sendText(openId, "Voice command received. 33Jack is transcribing it…");
    text = await transcribeWeChatVoice(message);
    await sendText(openId, `I heard: “${text.slice(0, 500)}”`);
  }

  if (message.msgType === "link") {
    text = [message.title, message.description, message.url].filter(Boolean).join("\n");
  }

  if (!text) {
    await sendText(openId, "Send a finance question, invoice image, or voice command. Send HELP for examples.");
    return;
  }

  const lower = text.toLowerCase();

  if (["help", "/help", "hi", "hello", "start"].includes(lower)) {
    await sendText(
      openId,
      [
        "33Jack on WeChat",
        "",
        "Ask normal finance questions, send invoice images, or use a voice command.",
        "",
        "Examples:",
        "What payments need my attention?",
        "Has Nexora been paid?",
        "Pay invoice NX-2026-0929-014",
        "",
        "Commands:",
        "STATUS · payment state",
        "TEAM · workspace members",
        "INVITE <role> · invite a teammate",
        "JOIN <code> · join a workspace",
        "",
        "Final money movement stays inside the signed Review & Pay flow."
      ].join("\n")
    );
    return;
  }

  if (lower === "status" || lower === "/status") {
    const payments = await listPaymentsByWorkspace(workspace.id, 50);
    const { active, settled, flagged } = compactStatus(payments);
    await sendText(
      openId,
      [
        "33Jack status",
        "",
        `Workspace: ${workspace.name || workspace.id}`,
        `Role: ${member.role}`,
        `Stored payments: ${payments.length}`,
        `Active / pending: ${active.length}`,
        `Settled: ${settled.length}`,
        `Risk review: ${flagged.length}`
      ].join("\n")
    );
    return;
  }

  if (lower === "team") {
    const members = await listWorkspaceMembers(workspace.id);
    await sendText(
      openId,
      [
        `33Jack team · ${workspace.name || workspace.id}`,
        "",
        ...members.map((item, index) =>
          `${index + 1}. ${item.display_name || "Member"} — ${item.role}${String(item.telegram_user_id) === identity ? " (you)" : ""}`
        ),
        "",
        roleCan(member.role, "manage_team")
          ? "Manage: INVITE <admin|approver|operator|viewer>"
          : "Your role can view the team but cannot manage it."
      ].join("\n")
    );
    return;
  }

  if (lower.startsWith("invite ")) {
    if (!roleCan(member.role, "manage_team")) {
      await sendText(openId, "Your workspace role cannot invite team members.");
      return;
    }
    const role = lower.split(/\s+/)[1] || "viewer";
    const invite = await createWorkspaceInvite(workspace.id, identity, role, 1440);
    await sendText(
      openId,
      [
        "33Jack workspace invite",
        "",
        `Role: ${invite.role}`,
        `Code: ${invite.code}`,
        "Expires: 24 hours",
        "",
        `The teammate can message: JOIN ${invite.code}`
      ].join("\n")
    );
    return;
  }

  if (lower.startsWith("join ")) {
    const code = text.split(/\s+/)[1] || "";
    const joined = await joinWorkspaceInvite(
      { id: identity, first_name: `WeChat ••••${openId.slice(-4)}` },
      code
    );
    await addAuditEvent(null, "workspace_member_joined", `wechat-user:${openId}`, {
      workspace_id: joined.workspace.id,
      role: joined.member.role,
      wechat_open_id: openId
    });
    await sendText(
      openId,
      `Joined ${joined.workspace.name || joined.workspace.id} as ${joined.member.role}. Send STATUS or TEAM to continue.`
    );
    return;
  }

  const [payments, allBeneficiaries] = await Promise.all([
    listPaymentsByWorkspace(workspace.id, 50),
    listBeneficiaries(200)
  ]);
  const beneficiaries = scopedBeneficiaries(payments, allBeneficiaries);
  const referenced = findReferencedPayment(text, payments);
  const reviewRequested = wantsPaymentReview(text);

  if (reviewRequested && referenced) {
    const state = String(referenced.status || "");
    if (["settled_demo", "settled_devnet", "settled_celo"].includes(state)) {
      await sendText(
        openId,
        `${referenced.supplier || "This invoice"} is already settled. Reference: ${referenced.invoice_number || referenced.invoice_name || referenced.id}.`
      );
      return;
    }
    if (!["analyzed", "failed"].includes(state)) {
      await sendText(
        openId,
        `That payment is currently ${state || "not ready"}. I won’t create a second approval path.`
      );
      return;
    }

    const answer = await answerWorkspaceAgent(text, workspace, payments, beneficiaries);
    const blockers = riskFlags(referenced.risk);
    const reviewUrl = signedReviewUrl(base, referenced, openId, workspace.id);
    await sendText(
      openId,
      [
        answer.text,
        "",
        `Invoice: ${referenced.invoice_number || referenced.invoice_name || referenced.id}`,
        blockers.length
          ? `Review required: ${blockers.join("; ")}.`
          : "No active deterministic risk flag is currently recorded.",
        reviewUrl ? `Review & Pay: ${reviewUrl}\nCelo wallet checkout: ${reviewUrl.replace("/?channel=", "/app/celo?channel=")}` : null
      ].filter(Boolean).join("\n")
    );
    await addAuditEvent(
      referenced.id,
      "wechat_payment_review_requested",
      `wechat-user:${openId}`,
      {
        workspace_id: workspace.id,
        wechat_open_id: openId,
        role: member.role,
        agent_mode: answer.mode,
        risk_flags: blockers
      }
    );
    return;
  }

  if (reviewRequested && !referenced) {
    const answer = await answerWorkspaceAgent(text, workspace, payments, beneficiaries);
    await sendText(
      openId,
      `${answer.text}\n\nI need a matching invoice/payment record before I can create a secure Review & Pay link. Send an invoice image or include its invoice reference.`
    );
    return;
  }

  const answer = await answerWorkspaceAgent(text, workspace, payments, beneficiaries);
  await sendText(openId, answer.text);
}

export async function handleWeChatWebhook(req, res, rawBody) {
  if (req.method === "GET") {
    const echostr = String(req.query?.echostr || "");
    const encrypted = String(req.query?.encrypt_type || "").toLowerCase() === "aes";

    if (encrypted && req.query?.msg_signature) {
      if (!verifyEncryptedSignature(req, echostr)) {
        return responseText(res, 403, "Forbidden");
      }
      try {
        return responseText(res, 200, decryptWeChatPayload(echostr));
      } catch {
        return responseText(res, 403, "Forbidden");
      }
    }

    if (!verifyPlainSignature(req)) {
      return responseText(res, 403, "Forbidden");
    }
    return responseText(res, 200, echostr);
  }

  if (req.method !== "POST") {
    return responseText(res, 405, "POST only");
  }

  const outerXml = rawBody?.length ? rawBody.toString("utf8") : "";
  if (!outerXml) return responseText(res, 400, "Invalid XML");

  let messageXml = outerXml;
  const encryptedBody = xmlField(outerXml, "Encrypt");

  if (encryptedBody) {
    if (!verifyEncryptedSignature(req, encryptedBody)) {
      return responseText(res, 401, "Invalid WeChat signature");
    }
    try {
      messageXml = decryptWeChatPayload(encryptedBody);
    } catch {
      return responseText(res, 400, "Invalid encrypted WeChat payload");
    }
  } else if (!verifyPlainSignature(req)) {
    return responseText(res, 401, "Invalid WeChat signature");
  }

  const message = parseIncomingXml(messageXml);
  if (!message.fromUserName) {
    return responseText(res, 200, "success");
  }

  try {
    await processWeChatMessage(req, message);
  } catch (error) {
    await addAuditEvent(null, "wechat_message_failed", "wechat-webhook", {
      wechat_open_id: message.fromUserName,
      message_id: message.msgId || null,
      message_type: message.msgType || null,
      error: error?.message || "Unknown WeChat error"
    }).catch(() => {});

    await sendText(
      message.fromUserName,
      `33Jack could not process that request: ${error?.message || "Unknown error"}`
    ).catch(() => {});
  }

  return responseText(res, 200, "success");
}
