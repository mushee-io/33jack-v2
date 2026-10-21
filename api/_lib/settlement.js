const NETWORKS = {
  celo: {
    id: "celo",
    name: "Celo",
    mode: "demo",
    status: "demo",
    asset: "USDC / USDT / cUSD",
    baseFeeUsd: 0.02,
    latencySeconds: 5,
    reliability: 0.99
  },
  solana: {
    id: "solana",
    name: "Solana",
    mode: "devnet",
    status: "available",
    asset: "USDG / USDC",
    baseFeeUsd: 0.01,
    latencySeconds: 4,
    reliability: 0.998
  },
  morph: {
    id: "morph",
    name: "Morph",
    mode: process.env.MORPH_RPC_URL ? "test" : "demo",
    status: process.env.MORPH_RPC_URL ? "available" : "demo",
    asset: "USDC",
    baseFeeUsd: 0.04,
    latencySeconds: 8,
    reliability: 0.995
  },
  base: {
    id: "base",
    name: "Base",
    mode: process.env.BASE_RPC_URL ? "test" : "demo",
    status: process.env.BASE_RPC_URL ? "available" : "demo",
    asset: "USDC",
    baseFeeUsd: 0.06,
    latencySeconds: 10,
    reliability: 0.996
  }
};

const PROVIDERS = {
  wise: {
    id: "wise",
    name: "Wise Sandbox",
    mode: process.env.WISE_SANDBOX_TOKEN ? "sandbox" : "demo",
    status: "available",
    supportedCurrencies: ["USD", "GBP", "EUR", "CNY", "INR"],
    fixedFeeUsd: 1.25,
    feeBps: 28,
    etaSeconds: 90,
    reliability: 0.998
  },
  atlas: {
    id: "atlas",
    name: "Atlas Demo Rail",
    mode: "demo",
    status: "demo",
    supportedCurrencies: ["USD", "GBP", "EUR", "CNY", "INR"],
    fixedFeeUsd: 0.6,
    feeBps: 18,
    etaSeconds: 55,
    reliability: 0.994
  },
  orbit: {
    id: "orbit",
    name: "Orbit Demo Rail",
    mode: "demo",
    status: "demo",
    supportedCurrencies: ["USD", "GBP", "EUR", "CNY", "INR"],
    fixedFeeUsd: 0.35,
    feeBps: 12,
    etaSeconds: 150,
    reliability: 0.972
  }
};

const FX = {
  USD: 1,
  GBP: 0.742,
  EUR: 0.864,
  CNY: 7.12,
  INR: 88.2
};

function upper(value, fallback = "") {
  return String(value || fallback).trim().toUpperCase();
}

function clamp(value, min, max) {
  return Math.min(max, Math.max(min, value));
}

function hashSeed(input = "") {
  let h = 2166136261;
  for (const ch of String(input)) {
    h ^= ch.charCodeAt(0);
    h = Math.imul(h, 16777619);
  }
  return Math.abs(h >>> 0);
}

function routeId(parts) {
  return "route_" + hashSeed(parts.join(":")).toString(36);
}

function normalizePriority(value) {
  const v = String(value || "balanced").toLowerCase();
  return ["cheapest", "fastest", "reliability", "best_fx", "balanced"].includes(v) ? v : "balanced";
}

export function getSettlementRegistry() {
  return {
    networks: Object.values(NETWORKS),
    providers: Object.values(PROVIDERS)
  };
}

export function normalizePaymentIntent(input = {}) {
  const sourceCurrency = upper(input.sourceCurrency, "USD");
  const destinationCurrency = upper(input.destinationCurrency, "GBP");
  const amount = Math.max(1, Number(input.sourceAmount || input.amount || 10000));
  const priority = normalizePriority(input.priority);
  const policy = {
    maxFeeBps: Number(input.policy?.maxFeeBps ?? 100),
    minReliability: Number(input.policy?.minReliability ?? 0.97),
    maxSettlementSeconds: Number(input.policy?.maxSettlementSeconds ?? 600),
    preferredNetworks: Array.isArray(input.policy?.preferredNetworks) ? input.policy.preferredNetworks.map((x) => String(x).toLowerCase()) : [],
    blockedNetworks: Array.isArray(input.policy?.blockedNetworks) ? input.policy.blockedNetworks.map((x) => String(x).toLowerCase()) : [],
    preferredProviders: Array.isArray(input.policy?.preferredProviders) ? input.policy.preferredProviders.map((x) => String(x).toLowerCase()) : [],
    blockedProviders: Array.isArray(input.policy?.blockedProviders) ? input.policy.blockedProviders.map((x) => String(x).toLowerCase()) : [],
    preferredStablecoins: Array.isArray(input.policy?.preferredStablecoins) && input.policy.preferredStablecoins.length ? input.policy.preferredStablecoins.map((x) => upper(x)) : ["USDC"],
    fallbackEnabled: input.policy?.fallbackEnabled !== false
  };

  return {
    id: input.id || "intent_" + hashSeed([sourceCurrency, destinationCurrency, amount, input.beneficiaryId || "demo"].join(":")).toString(36),
    beneficiaryId: input.beneficiaryId || "demo-beneficiary",
    destinationCountry: upper(input.destinationCountry, destinationCurrency === "GBP" ? "GB" : destinationCurrency === "EUR" ? "EU" : ""),
    sourceCurrency,
    sourceAmount: amount,
    destinationCurrency,
    priority,
    deadline: input.deadline || null,
    policy,
    mode: "demo"
  };
}

function fxRate(source, destination) {
  const sourceUsd = FX[source] || 1;
  const destinationUsd = FX[destination] || 1;
  return destinationUsd / sourceUsd;
}

function scoreRoute(route, intent) {
  const feeRatio = route.estimatedTotalCost / Math.max(intent.sourceAmount, 1);
  const costScore = clamp(100 - feeRatio * 10000, 0, 100);
  const speedScore = clamp(100 - route.estimatedSettlementSeconds / 6, 0, 100);
  const reliabilityScore = clamp(route.reliabilityScore * 100, 0, 100);
  const fxScore = clamp(100 - route.fxSpreadBps * 2, 0, 100);

  const weights = {
    cheapest: [0.62, 0.12, 0.18, 0.08],
    fastest: [0.18, 0.58, 0.18, 0.06],
    reliability: [0.15, 0.1, 0.68, 0.07],
    best_fx: [0.2, 0.1, 0.15, 0.55],
    balanced: [0.34, 0.22, 0.3, 0.14]
  }[intent.priority];

  let score = costScore * weights[0] + speedScore * weights[1] + reliabilityScore * weights[2] + fxScore * weights[3];
  if (intent.policy.preferredNetworks.includes(route.network.id)) score += 4;
  if (intent.policy.preferredProviders.includes(route.provider.id)) score += 4;
  return Number(clamp(score, 0, 100).toFixed(2));
}

function buildCandidate(intent, network, provider, index) {
  const stablecoin = intent.policy.preferredStablecoins[0] || "USDC";
  const networkFee = network.baseFeeUsd + index * 0.01;
  const providerFee = intent.sourceAmount * (provider.feeBps / 10000) + provider.fixedFeeUsd;
  const fxSpreadBps = provider.id === "orbit" ? 8 : provider.id === "atlas" ? 14 : 20;
  const fxCost = intent.sourceAmount * (fxSpreadBps / 10000);
  const total = networkFee + providerFee + fxCost;
  const rate = fxRate(intent.sourceCurrency, intent.destinationCurrency) * (1 - fxSpreadBps / 10000);
  const destinationAmount = Math.max(0, (intent.sourceAmount - total) * rate);
  const reliability = Number((network.reliability * provider.reliability).toFixed(4));
  const eta = network.latencySeconds + provider.etaSeconds + index * 7;

  const route = {
    routeId: routeId([intent.id, network.id, provider.id]),
    sourceAmount: intent.sourceAmount,
    destinationAmount: Number(destinationAmount.toFixed(2)),
    sourceCurrency: intent.sourceCurrency,
    destinationCurrency: intent.destinationCurrency,
    stablecoin,
    network,
    provider,
    estimatedNetworkFee: Number(networkFee.toFixed(2)),
    estimatedProviderFee: Number(providerFee.toFixed(2)),
    estimatedFxCost: Number(fxCost.toFixed(2)),
    estimatedTotalCost: Number(total.toFixed(2)),
    estimatedSettlementSeconds: eta,
    reliabilityScore: reliability,
    liquidityScore: Number((0.94 + ((index + 2) % 5) / 100).toFixed(2)),
    complianceStatus: "eligible_demo",
    providerHealth: provider.status,
    privacyLevel: network.id === "morph" ? "enhanced-ready" : "standard",
    fxSpreadBps,
    steps: [
      { type: "funding", label: `${intent.sourceCurrency} payment intent`, mode: "demo" },
      { type: "stablecoin", label: stablecoin, mode: "demo" },
      { type: "network", label: network.name, mode: network.mode },
      { type: "provider", label: provider.name, mode: provider.mode },
      { type: "destination", label: `${intent.destinationCurrency} recipient rail`, mode: "demo" }
    ],
    status: "quoted",
    mode: [network.mode, provider.mode].includes("demo") ? "demo" : "test"
  };

  route.policy = {
    feeBps: Number((route.estimatedTotalCost / intent.sourceAmount * 10000).toFixed(2)),
    passesFee: route.estimatedTotalCost / intent.sourceAmount * 10000 <= intent.policy.maxFeeBps,
    passesReliability: reliability >= intent.policy.minReliability,
    passesSpeed: eta <= intent.policy.maxSettlementSeconds,
    networkAllowed: !intent.policy.blockedNetworks.includes(network.id),
    providerAllowed: !intent.policy.blockedProviders.includes(provider.id)
  };
  route.policy.allowed = Object.values(route.policy).filter((x) => typeof x === "boolean").every(Boolean);
  route.score = scoreRoute(route, intent);
  return route;
}

export function quoteSettlementRoutes(input = {}) {
  const intent = normalizePaymentIntent(input);
  const networks = Object.values(NETWORKS);
  const providers = Object.values(PROVIDERS).filter((p) => p.supportedCurrencies.includes(intent.destinationCurrency));
  const routes = [];
  let index = 0;

  for (const network of networks) {
    for (const provider of providers) {
      routes.push(buildCandidate(intent, network, provider, index++));
    }
  }

  const allowed = routes.filter((route) => route.policy.allowed).sort((a, b) => b.score - a.score);
  const blocked = routes.filter((route) => !route.policy.allowed).sort((a, b) => b.score - a.score);
  const ranked = [...allowed, ...blocked];
  const recommended = allowed[0] || null;

  return {
    mode: "demo",
    generatedAt: new Date().toISOString(),
    paymentIntent: intent,
    recommendedRoute: recommended,
    alternativeRoutes: ranked.filter((route) => route.routeId !== recommended?.routeId).slice(0, 5),
    evaluatedRoutes: ranked,
    policyChecks: {
      eligibleRoutes: allowed.length,
      blockedRoutes: blocked.length,
      fallbackEnabled: intent.policy.fallbackEnabled
    },
    explanation: recommended
      ? `33JACK selected ${recommended.network.name} → ${recommended.provider.name} because it produced the strongest ${intent.priority.replace("_", " ")} score while satisfying the configured policy.`
      : "No route satisfied the current settlement policy."
  };
}

export function executeDemoSettlement({ quote, routeId: requestedRouteId, approved = false } = {}) {
  if (!approved) {
    return {
      ok: false,
      status: "awaiting_approval",
      detail: "Execution requires explicit approval of the exact settlement terms."
    };
  }

  const routes = quote?.evaluatedRoutes || [];
  const route = routes.find((item) => item.routeId === requestedRouteId) || quote?.recommendedRoute;
  if (!route) {
    return { ok: false, status: "failed", detail: "No valid settlement route was supplied." };
  }
  if (!route.policy?.allowed) {
    return { ok: false, status: "failed", detail: "The selected route does not satisfy settlement policy." };
  }

  const id = "settle_" + hashSeed([route.routeId, quote.paymentIntent?.id].join(":")).toString(36);
  return {
    ok: true,
    id,
    mode: "demo",
    status: "reconciled",
    route,
    timeline: [
      { status: "payment_intent_created", at: new Date().toISOString() },
      { status: "routes_discovered", at: new Date().toISOString(), detail: `${routes.length} routes evaluated` },
      { status: "policy_passed", at: new Date().toISOString() },
      { status: "approved", at: new Date().toISOString() },
      { status: "executing_demo", at: new Date().toISOString() },
      { status: "recipient_credited_demo", at: new Date().toISOString() },
      { status: "reconciled", at: new Date().toISOString() }
    ],
    receipt: {
      reference: "DEMO-" + id.slice(-8).toUpperCase(),
      network: route.network.name,
      provider: route.provider.name,
      destinationAmount: route.destinationAmount,
      destinationCurrency: route.destinationCurrency,
      reconciled: true
    },
    warning: "Demo settlement only. No customer funds or onchain assets moved."
  };
}
