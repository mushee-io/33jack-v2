import assert from "node:assert/strict";
import { test } from "node:test";
import { CELO_NETWORK, CELO_TOKENS, normalizeCeloProposal, parseTokenAmount, prepareCeloTransfer, normalizeAddress, verifyCeloPayment } from "../api/_lib/celo-v2.js";
import { requireAgent, requireHumanApproval } from "../api/_lib/agent-v2-auth.js";

test("network metadata and native token addresses", () => {
  assert.equal(CELO_NETWORK.chainId, 42220);
  assert.equal(CELO_TOKENS.USDC.decimals, 6);
  assert.equal(CELO_TOKENS.USDT.decimals, 6);
  assert.equal(CELO_TOKENS.cUSD.decimals, 18);
});
test("precise base units and overflow rejection", () => {
  assert.equal(parseTokenAmount("1.234567", 6), "1234567");
  assert.equal(parseTokenAmount("0.000000000000000001", 18), "1");
  assert.throws(() => parseTokenAmount("1.0000001", 6), /precision/);
  assert.throws(() => parseTokenAmount("-1", 6), /positive/);
  assert.throws(() => parseTokenAmount("0", 6), /greater/);
  assert.throws(() => parseTokenAmount("101", 6), /limit/);
});
test("recipient and exact ERC20 transfer encoding", () => {
  const to = "0x1111111111111111111111111111111111111111";
  const payer = "0x2222222222222222222222222222222222222222";
  const proposal = normalizeCeloProposal({ token:"USDC", amount:"1.25", recipient:to, payer });
  const tx = prepareCeloTransfer(proposal);
  assert.equal(tx.chainId, 42220);
  assert.equal(tx.to.toLowerCase(), CELO_TOKENS.USDC.address.toLowerCase());
  assert.equal(tx.data, "0xa9059cbb" + "0".repeat(24) + to.slice(2) + BigInt(1250000).toString(16).padStart(64, "0"));
  assert.throws(() => normalizeAddress("0x" + "0".repeat(40)), /zero/);
  assert.throws(() => normalizeCeloProposal({token:"FAKE",amount:"1",recipient:to}), /Supported/);
});
test("unconfigured and invalid agent keys fail closed", () => {
  delete process.env.JACK_AGENT_API_KEYS_JSON;
  delete process.env.JACK_APPROVAL_API_KEY;
  assert.equal(requireAgent({ headers: {} }).status, 503);
  process.env.JACK_AGENT_API_KEYS_JSON = JSON.stringify({ bot: "a".repeat(32) });
  assert.equal(requireAgent({ headers: { "x-jack-agent-id": "bot", authorization: "Bearer wrong" } }).status, 401);
  assert.equal(requireAgent({ headers: { "x-jack-agent-id": "bot", authorization: "Bearer " + "a".repeat(32) } }).agentId, "bot");
  assert.equal(requireHumanApproval({ headers: {} }).status, 503);
  process.env.JACK_APPROVAL_API_KEY = "b".repeat(32);
  assert.equal(requireHumanApproval({ headers: { "x-jack-approval-key": "a".repeat(32) } }).status, 403);
  assert.equal(requireHumanApproval({ headers: { "x-jack-approval-key": "b".repeat(32) } }).allowed, true);
  delete process.env.JACK_AGENT_API_KEYS_JSON;
  delete process.env.JACK_APPROVAL_API_KEY;
});

test("onchain receipt verification requires exact official contract, amount and recipient", async () => {
  const recipient = "0x1111111111111111111111111111111111111111";
  const payer = "0x2222222222222222222222222222222222222222";
  const proposal = normalizeCeloProposal({ token: "USDC", amount: "1.25", recipient, payer });
  const txHash = "0x" + "a".repeat(64);
  const topic = "0xddf252ad1be2c89b69c2b068fc378daa952ba7f163c4a11628f55a4df523b3ef";
  const fromTopic = "0x" + "0".repeat(24) + payer.slice(2);
  const toTopic = "0x" + "0".repeat(24) + recipient.slice(2);
  const event = { address: proposal.tokenAddress, topics: [topic, fromTopic, toTopic], data: "0x" + BigInt(proposal.amountUnits).toString(16).padStart(64, "0"), logIndex: "0x0" };
  const receipt = { transactionHash: txHash, blockNumber: "0x64", status: "0x1", logs: [event] };
  const original = globalThis.fetch;
  let chainId = "0xa4ec";
  try {
    globalThis.fetch = async (_url, options) => {
      const { method } = JSON.parse(options.body);
      const responses = {
        eth_chainId: chainId,
        eth_getTransactionReceipt: receipt,
        eth_blockNumber: "0x66",
        eth_getBlockByNumber: { timestamp: "0x6a6a6a6a" }
      };
      return { ok: true, json: async () => ({ jsonrpc: "2.0", id: 33, result: responses[method] }) };
    };
    const verified = await verifyCeloPayment(proposal, txHash);
    assert.equal(verified.pending, false);
    assert.equal(verified.amountUnits, "1250000");
    assert.equal(verified.confirmations, 3);
    assert.equal(verified.to, recipient);
    receipt.logs = [{ ...event, address: "0x3333333333333333333333333333333333333333" }];
    await assert.rejects(verifyCeloPayment(proposal, txHash), /No exact approved/);
    receipt.logs = [{ ...event, topics: [topic, fromTopic, "0x" + "0".repeat(24) + "4".repeat(40)] }];
    await assert.rejects(verifyCeloPayment(proposal, txHash), /No exact approved/);
    receipt.logs = [event];
    chainId = "0x1";
    await assert.rejects(verifyCeloPayment(proposal, txHash), /not connected/);
  } finally {
    globalThis.fetch = original;
  }
});

import { invoiceChannelAgentId, assertInvoiceEligibility, safeInvoiceSummary } from "../api/_lib/channel-v2-auth.js";

test("channel invoice role, risk and no automatic FX", () => {
  const payment = { id: "pay_inv", status: "analyzed", source_currency: "GBP", source_amount: 125, risk:{duplicate:true, beneficiary_changed:true} };
  assert.throws(() => assertInvoiceEligibility(payment, {}), /acknowledgement/);
  assert.throws(() => assertInvoiceEligibility(payment, {duplicate:true}), /beneficiary_changed/);
  assert.deepEqual(assertInvoiceEligibility(payment, {duplicate:true,beneficiary_changed:true}).flags, ["duplicate","beneficiary_changed"]);
  assert.throws(()=>assertInvoiceEligibility({ ...payment, status:"settled_celo" },{duplicate:true,beneficiary_changed:true}), /not eligible/);
  assert.throws(()=>assertInvoiceEligibility({...payment, risk:{missing_fields:["supplier"]}},{}),/Resolve missing/);
  const summary = safeInvoiceSummary(payment,"operator");
  assert.equal(summary.originalAmount,"125");
  assert.equal(summary.originalCurrency,"GBP");
  assert.equal(summary.canPropose,true);
  assert.equal(summary.canApprove,false);
  assert.equal(safeInvoiceSummary(payment,"approver").canPropose,false);
  assert.equal(invoiceChannelAgentId("one"),invoiceChannelAgentId("one"));
  assert.notEqual(invoiceChannelAgentId("one"),invoiceChannelAgentId("two"));
});
