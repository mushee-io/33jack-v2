export const PAYMENT_STATUS = Object.freeze({
  ANALYZED: "analyzed",
  APPROVED: "approved",
  SETTLING: "settling",
  SETTLED_DEMO: "settled_demo",
  SETTLED_DEVNET: "settled_devnet",
  SETTLED_CELO: "settled_celo",
  REJECTED: "rejected",
  FAILED: "failed"
});

const transitions = {
  analyzed: new Set(["approved", "rejected", "settled_celo"]),
  approved: new Set(["settling", "rejected"]),
  settling: new Set(["settled_demo", "settled_devnet", "failed"]),
  failed: new Set(["approved", "rejected", "settled_devnet", "settled_demo", "settled_celo"]),
  settled_demo: new Set(),
  settled_devnet: new Set(),
  settled_celo: new Set(),
  rejected: new Set()
};

export function assertTransition(current, next) {
  if (!current) {
    if (next !== PAYMENT_STATUS.ANALYZED) {
      throw new Error(`New payments must start at analyzed, not ${next}`);
    }
    return;
  }
  if (current === next) return;
  if (!transitions[current]?.has(next)) {
    throw new Error(`Invalid payment transition: ${current} → ${next}`);
  }
}

export function requiredAcknowledgements(payment) {
  const risk = payment?.risk || {};
  const required = [];
  if (risk.duplicate) required.push("duplicate");
  if (risk.beneficiary_changed) required.push("beneficiary_changed");
  if (risk.suspicious) required.push("suspicious");
  return required;
}

export function assertApprovalAllowed(payment, acknowledgements = {}) {
  if (!payment) throw new Error("Payment not found");
  if (![PAYMENT_STATUS.ANALYZED, PAYMENT_STATUS.FAILED].includes(payment.status)) {
    throw new Error(`Payment cannot be approved from status ${payment.status}`);
  }

  const missingFields = Array.isArray(payment.risk?.missing_fields)
    ? payment.risk.missing_fields.filter(Boolean)
    : [];
  if (missingFields.length) {
    throw new Error(`Payment is missing required invoice fields: ${missingFields.join(", ")}`);
  }

  const required = requiredAcknowledgements(payment);
  const missingAck = required.filter((key) => acknowledgements[key] !== true);
  if (missingAck.length) {
    throw new Error(`Explicit acknowledgement required: ${missingAck.join(", ")}`);
  }
  return true;
}
