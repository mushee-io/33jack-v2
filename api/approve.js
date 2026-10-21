import {gateLegacy} from "./_lib/legacy-access.js";
import { signApproval } from "./_lib/approval.js";
import { verifyTelegramApproval } from "./_lib/telegram-auth.js";
import {
  addAuditEvent,
  getOrCreateTelegramWorkspace,
  getPayment,
  getTelegramWorkspaceMembership,
  roleCan,
  transitionPayment
} from "./_lib/db.js";
import { verifyWhatsAppLaunch } from "./_lib/whatsapp-auth.js";
import { verifyWeChatLaunch } from "./_lib/wechat-auth.js";
import {
  PAYMENT_STATUS,
  assertApprovalAllowed,
  requiredAcknowledgements
} from "./_lib/state.js";

function approvalChannelName({ telegramAuth, whatsappAuth, wechatAuth }) {
  if (telegramAuth) return "telegram-mini-app";
  if (whatsappAuth) return "whatsapp-web";
  if (wechatAuth) return "wechat-web";
  return "web";
}

export default async function handler(req, res) {
  if (!["telegram","whatsapp","wechat"].includes(String(req.body?.channel||"").toLowerCase()) && !gateLegacy(req,res)) return;
  if (req.method !== "POST") return res.status(405).json({ error: "POST only" });

  try {
    const body = req.body || {};
    if (!body.paymentId) {
      return res.status(400).json({ error: "paymentId is required" });
    }

    const payment = await getPayment(body.paymentId);
    if (!payment) return res.status(404).json({ error: "Payment not found" });

    const acknowledgements = body.acknowledgements || {};
    let approvalActor = "human-approver";
    let telegramAuth = null;
    let whatsappAuth = null;
    let wechatAuth = null;
    let workspaceContext = null;
    const approvalChannel = String(body.channel || "").toLowerCase();

    if (approvalChannel === "telegram") {
      telegramAuth = verifyTelegramApproval({
        initData: body.telegramInitData,
        launchToken: body.telegramLaunchToken,
        paymentId: payment.id
      });
      workspaceContext = await getOrCreateTelegramWorkspace(telegramAuth.user);
      if (!roleCan(workspaceContext.member.role, "approve")) {
        return res.status(403).json({ error: "Your workspace role cannot approve payments" });
      }
      if (!payment.workspace_id || String(payment.workspace_id) !== String(workspaceContext.workspace.id)) {
        return res.status(403).json({ error: "Payment is not available to this workspace" });
      }
      approvalActor = `telegram-user:${telegramAuth.user.id}`;
    } else if (approvalChannel === "whatsapp") {
      whatsappAuth = verifyWhatsAppLaunch(body.whatsappLaunchToken, payment.id);
      workspaceContext = await getTelegramWorkspaceMembership(
        `whatsapp:${whatsappAuth.whatsappUserId}`
      );
      if (!workspaceContext) {
        return res.status(403).json({ error: "WhatsApp workspace membership is missing" });
      }
      if (!roleCan(workspaceContext.member.role, "approve")) {
        return res.status(403).json({ error: "Your workspace role cannot approve payments" });
      }
      if (
        !payment.workspace_id ||
        String(payment.workspace_id) !== String(workspaceContext.workspace.id) ||
        String(whatsappAuth.workspaceId) !== String(workspaceContext.workspace.id)
      ) {
        return res.status(403).json({ error: "Payment is not available to this WhatsApp workspace" });
      }
      approvalActor = `whatsapp-user:${whatsappAuth.whatsappUserId}`;
    } else if (approvalChannel === "wechat") {
      wechatAuth = verifyWeChatLaunch(body.wechatLaunchToken, payment.id);
      workspaceContext = await getTelegramWorkspaceMembership(
        `wechat:${wechatAuth.wechatOpenId}`
      );
      if (!workspaceContext) {
        return res.status(403).json({ error: "WeChat workspace membership is missing" });
      }
      if (!roleCan(workspaceContext.member.role, "approve")) {
        return res.status(403).json({ error: "Your workspace role cannot approve payments" });
      }
      if (
        !payment.workspace_id ||
        String(payment.workspace_id) !== String(workspaceContext.workspace.id) ||
        String(wechatAuth.workspaceId) !== String(workspaceContext.workspace.id)
      ) {
        return res.status(403).json({ error: "Payment is not available to this WeChat workspace" });
      }
      approvalActor = `wechat-user:${wechatAuth.wechatOpenId}`;
    }

    assertApprovalAllowed(payment, acknowledgements);

    const amountUsdg = Number(body.amountUsdg || body.amountUsdc || 1);
    if (!Number.isFinite(amountUsdg) || amountUsdg <= 0) {
      return res.status(400).json({ error: "amountUsdg must be a positive number" });
    }

    const channel = approvalChannelName({ telegramAuth, whatsappAuth, wechatAuth });
    const signed = signApproval({
      paymentId: payment.id,
      invoiceName: payment.invoice_name,
      supplier: payment.supplier,
      sourceCurrency: payment.source_currency,
      destinationCurrency: payment.destination_currency,
      sourceAmount: payment.source_amount,
      destinationAmount: payment.destination_amount,
      route: payment.route,
      amountUsdg,
      channel,
      telegramUserId: telegramAuth ? String(telegramAuth.user.id) : null,
      whatsappUserId: whatsappAuth ? String(whatsappAuth.whatsappUserId) : null,
      wechatOpenId: wechatAuth ? String(wechatAuth.wechatOpenId) : null,
      workspaceId: workspaceContext?.workspace?.id || payment.workspace_id || null,
      approverRole: workspaceContext?.member?.role || null
    });

    const commonAudit = {
      channel,
      telegram_user_id: telegramAuth ? String(telegramAuth.user.id) : null,
      whatsapp_user_id: whatsappAuth ? String(whatsappAuth.whatsappUserId) : null,
      wechat_open_id: wechatAuth ? String(wechatAuth.wechatOpenId) : null,
      workspace_id: workspaceContext?.workspace?.id || payment.workspace_id || null,
      approver_role: workspaceContext?.member?.role || null
    };

    await transitionPayment(
      payment.id,
      PAYMENT_STATUS.APPROVED,
      {
        approval: {
          expires_at: signed.payload.expiresAt,
          acknowledgements,
          amount_usdg: amountUsdg,
          mode: signed.mode
        }
      },
      approvalActor,
      {
        required_acknowledgements: requiredAcknowledgements(payment),
        provided_acknowledgements: acknowledgements,
        approval_expires_at: signed.payload.expiresAt,
        amount_usdg: amountUsdg,
        ...commonAudit
      }
    );

    await addAuditEvent(payment.id, "payment_approved", approvalActor, {
      route: payment.route,
      source_amount: payment.source_amount,
      source_currency: payment.source_currency,
      destination_currency: payment.destination_currency,
      expires_at: signed.payload.expiresAt,
      ...commonAudit
    });

    return res.status(200).json({
      approvalToken: signed.token,
      expiresAt: signed.payload.expiresAt,
      mode: signed.mode,
      payment: {
        id: payment.id,
        status: PAYMENT_STATUS.APPROVED,
        supplier: payment.supplier,
        route: payment.route
      }
    });
  } catch (error) {
    return res.status(400).json({
      error: "Approval rejected",
      detail: error?.message || "Unknown approval error"
    });
  }
}
