import assert from "node:assert/strict";
import { test } from "node:test";
import { CELO_NETWORK, CELO_TOKENS, normalizeCeloProposal, parseTokenAmount, prepareCeloTransfer, normalizeAddress } from "../api/_lib/celo-v2.js";
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
