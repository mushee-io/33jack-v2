import postgres from "postgres";
import crypto from "node:crypto";
import { assertTransition } from "./state.js";

let sql;
let ready = false;

const memory = globalThis.__33jackStore || (globalThis.__33jackStore = {
  payments: [],
  events: [],
  beneficiaries: [],
  workspaces: [],
  members: [],
  preferences: [],
  invites: [],
  beneficiaryControls: [],
  channelMessageClaims: new Set()
});

function db() {
  if (!process.env.DATABASE_URL) {
    const isProduction =
      process.env.VERCEL_ENV === "production" ||
      process.env.NODE_ENV === "production";

    if (isProduction) {
      throw new Error("DATABASE_URL is required in production. Memory persistence is disabled.");
    }
    return null;
  }

  if (!sql) sql = postgres(process.env.DATABASE_URL, { ssl: "require", max: 2 });
  return sql;
}

export async function ensureSchema() {
  const client = db();
  if (!client || ready) return Boolean(client);

  await client`
    create table if not exists jack_payments (
      id text primary key,
      invoice_name text not null,
      invoice_number text,
      invoice_hash text,
      supplier text,
      source_currency text,
      destination_currency text,
      source_amount numeric,
      destination_amount text,
      route text,
      route_options jsonb,
      beneficiary jsonb,
      risk jsonb,
      status text not null,
      settlement_signature text,
      approval jsonb,
      invoice_meta jsonb,
      workspace_id text,
      created_at timestamptz not null default now(),
      updated_at timestamptz not null default now()
    )
  `;

  await client`alter table jack_payments add column if not exists invoice_number text`;
  await client`alter table jack_payments add column if not exists invoice_hash text`;
  await client`alter table jack_payments add column if not exists route_options jsonb`;
  await client`alter table jack_payments add column if not exists beneficiary jsonb`;
  await client`alter table jack_payments add column if not exists approval jsonb`;
  await client`alter table jack_payments add column if not exists invoice_meta jsonb`;
  await client`alter table jack_payments add column if not exists workspace_id text`;

  await client`
    create index if not exists jack_payments_invoice_hash_idx
    on jack_payments(invoice_hash)
  `;
  await client`
    create index if not exists jack_payments_supplier_idx
    on jack_payments(lower(supplier))
  `;
  await client`
    create index if not exists jack_payments_status_idx
    on jack_payments(status)
  `;
  await client`
    create index if not exists jack_payments_workspace_idx
    on jack_payments(workspace_id, created_at desc)
  `;

  await client`
    create table if not exists jack_events (
      id bigserial primary key,
      payment_id text,
      event_type text not null,
      actor text not null default 'system',
      data jsonb,
      created_at timestamptz not null default now()
    )
  `;
  await client`
    create index if not exists jack_events_payment_idx
    on jack_events(payment_id, created_at desc)
  `;

  await client`
    create table if not exists jack_channel_message_claims (
      channel text not null,
      message_id text not null,
      claimed_at timestamptz not null default now(),
      primary key (channel, message_id)
    )
  `;

  await client`
    create table if not exists jack_beneficiaries (
      id bigserial primary key,
      supplier_key text not null,
      supplier_name text not null,
      destination_currency text,
      bank_name text,
      account_last4 text,
      country text,
      payment_handle text,
      metadata jsonb,
      first_seen_at timestamptz not null default now(),
      last_seen_at timestamptz not null default now(),
      unique(supplier_key, destination_currency)
    )
  `;

  await client`
    create table if not exists jack_workspaces (
      id text primary key,
      name text not null,
      owner_telegram_id text not null,
      kyb_status text not null default 'not_configured',
      created_at timestamptz not null default now(),
      updated_at timestamptz not null default now()
    )
  `;

  await client`
    create table if not exists jack_workspace_members (
      workspace_id text not null,
      telegram_user_id text not null,
      display_name text,
      username text,
      role text not null default 'viewer',
      status text not null default 'active',
      created_at timestamptz not null default now(),
      updated_at timestamptz not null default now(),
      primary key (workspace_id, telegram_user_id)
    )
  `;
  await client`
    create index if not exists jack_workspace_members_user_idx
    on jack_workspace_members(telegram_user_id, status)
  `;

  await client`
    create table if not exists jack_workspace_invites (
      code text primary key,
      workspace_id text not null,
      role text not null,
      created_by text not null,
      expires_at timestamptz not null,
      used_by text,
      used_at timestamptz,
      created_at timestamptz not null default now()
    )
  `;

  await client`
    create table if not exists jack_user_preferences (
      workspace_id text not null,
      telegram_user_id text not null,
      payment_updates boolean not null default true,
      risk_alerts boolean not null default true,
      payout_updates boolean not null default true,
      receipt_messages boolean not null default true,
      updated_at timestamptz not null default now(),
      primary key (workspace_id, telegram_user_id)
    )
  `;

  await client`
    create table if not exists jack_beneficiary_controls (
      workspace_id text not null,
      supplier_key text not null,
      destination_currency text not null default '',
      status text not null default 'review',
      note text,
      updated_by text not null,
      updated_at timestamptz not null default now(),
      primary key (workspace_id, supplier_key, destination_currency)
    )
  `;
  ready = true;
  return true;
}

function normalizeSupplier(value) {
  return String(value || "").trim().toLowerCase().replace(/\s+/g, " ");
}

export async function getPayment(id) {
  if (!id) return null;
  const client = db();
  if (!client) return memory.payments.find((p) => String(p.id) === String(id)) || null;
  await ensureSchema();
  const rows = await client`select * from jack_payments where id = ${String(id)} limit 1`;
  return rows[0] || null;
}

export async function findPaymentByInvoiceHash(invoiceHash) {
  if (!invoiceHash) return null;
  const client = db();
  if (!client) return memory.payments.find((p) => p.invoice_hash === invoiceHash) || null;
  await ensureSchema();
  const rows = await client`
    select * from jack_payments
    where invoice_hash = ${invoiceHash}
    order by created_at desc
    limit 1
  `;
  return rows[0] || null;
}

export async function savePayment(payment) {
  if (!payment?.id || !payment?.invoice_name) throw new Error("Payment id and invoice_name are required");

  const client = db();
  if (!client) {
    const idx = memory.payments.findIndex((x) => x.id === payment.id);
    if (idx >= 0) {
      const existing = memory.payments[idx];
      memory.payments[idx] = {
        ...existing,
        ...payment,
        risk: payment.risk === undefined ? existing.risk : payment.risk,
        route_options: payment.route_options === undefined ? existing.route_options : payment.route_options,
        beneficiary: payment.beneficiary === undefined ? existing.beneficiary : payment.beneficiary,
        approval: payment.approval === undefined ? existing.approval : payment.approval,
        invoice_meta: payment.invoice_meta === undefined ? existing.invoice_meta : payment.invoice_meta,
        workspace_id: payment.workspace_id === undefined ? existing.workspace_id : payment.workspace_id,
        updated_at: new Date().toISOString()
      };
      return memory.payments[idx];
    }
    const row = {
      ...payment,
      created_at: new Date().toISOString(),
      updated_at: new Date().toISOString()
    };
    memory.payments.unshift(row);
    return row;
  }

  await ensureSchema();

  const risk = payment.risk === undefined ? null : JSON.stringify(payment.risk);
  const routeOptions = payment.route_options === undefined ? null : JSON.stringify(payment.route_options);
  const beneficiary = payment.beneficiary === undefined ? null : JSON.stringify(payment.beneficiary);
  const approval = payment.approval === undefined ? null : JSON.stringify(payment.approval);
  const invoiceMeta = payment.invoice_meta === undefined ? null : JSON.stringify(payment.invoice_meta);

  const [row] = await client`
    insert into jack_payments (
      id, invoice_name, invoice_number, invoice_hash, supplier,
      source_currency, destination_currency, source_amount, destination_amount,
      route, route_options, beneficiary, risk, status, settlement_signature, approval, invoice_meta, workspace_id
    ) values (
      ${payment.id}, ${payment.invoice_name}, ${payment.invoice_number || null},
      ${payment.invoice_hash || null}, ${payment.supplier || null},
      ${payment.source_currency || null}, ${payment.destination_currency || null},
      ${payment.source_amount ?? null}, ${payment.destination_amount || null},
      ${payment.route || null},
      ${routeOptions}::jsonb, ${beneficiary}::jsonb, ${risk}::jsonb,
      ${payment.status || "analyzed"}, ${payment.settlement_signature || null},
      ${approval}::jsonb, ${invoiceMeta}::jsonb, ${payment.workspace_id || null}
    )
    on conflict (id) do update set
      invoice_name = coalesce(excluded.invoice_name, jack_payments.invoice_name),
      invoice_number = coalesce(excluded.invoice_number, jack_payments.invoice_number),
      invoice_hash = coalesce(excluded.invoice_hash, jack_payments.invoice_hash),
      supplier = coalesce(excluded.supplier, jack_payments.supplier),
      source_currency = coalesce(excluded.source_currency, jack_payments.source_currency),
      destination_currency = coalesce(excluded.destination_currency, jack_payments.destination_currency),
      source_amount = coalesce(excluded.source_amount, jack_payments.source_amount),
      destination_amount = coalesce(excluded.destination_amount, jack_payments.destination_amount),
      route = coalesce(excluded.route, jack_payments.route),
      route_options = coalesce(excluded.route_options, jack_payments.route_options),
      beneficiary = coalesce(excluded.beneficiary, jack_payments.beneficiary),
      risk = coalesce(excluded.risk, jack_payments.risk),
      status = excluded.status,
      settlement_signature = coalesce(excluded.settlement_signature, jack_payments.settlement_signature),
      approval = coalesce(excluded.approval, jack_payments.approval),
      invoice_meta = coalesce(excluded.invoice_meta, jack_payments.invoice_meta),
      workspace_id = coalesce(excluded.workspace_id, jack_payments.workspace_id),
      updated_at = now()
    returning *
  `;
  return row;
}

export async function transitionPayment(id, nextStatus, patch = {}, actor = "system", data = {}) {
  const existing = await getPayment(id);
  if (!existing) throw new Error("Payment not found");
  assertTransition(existing.status, nextStatus);
  const updated = await savePayment({
    ...patch,
    id: existing.id,
    invoice_name: existing.invoice_name,
    status: nextStatus
  });
  await addAuditEvent(id, "payment_status_changed", actor, {
    from: existing.status,
    to: nextStatus,
    ...data
  });
  return updated;
}

export async function listPayments(limit = 25) {
  const client = db();
  if (!client) return memory.payments.slice(0, limit);
  await ensureSchema();
  return client`select * from jack_payments order by created_at desc limit ${limit}`;
}

export async function deleteAuditEventsByPaymentIds(ids = []) {
  const normalized = [...new Set((ids || []).filter(Boolean).map((id) => String(id)))];
  if (!normalized.length) return 0;

  const client = db();
  if (!client) {
    const before = memory.events.length;
    memory.events = memory.events.filter((event) => !normalized.includes(String(event.payment_id || "")));
    return before - memory.events.length;
  }

  await ensureSchema();
  const rows = await client`
    delete from jack_events
    where payment_id = any(${normalized}::text[])
    returning id
  `;
  return rows.length;
}

export async function deletePayment(id) {
  const value = String(id || "").trim();
  if (!value) return null;

  const client = db();
  if (!client) {
    const index = memory.payments.findIndex((payment) => String(payment.id) === value);
    if (index < 0) return null;
    const [removed] = memory.payments.splice(index, 1);
    memory.events = memory.events.filter((event) => String(event.payment_id || "") !== value);
    return removed;
  }

  await ensureSchema();
  await client`delete from jack_events where payment_id = ${value}`;
  const rows = await client`delete from jack_payments where id = ${value} returning *`;
  return rows[0] || null;
}


export async function listPaymentsByWorkspace(workspaceId, limit = 100) {
  if (!workspaceId) return [];
  const client = db();
  if (!client) {
    return memory.payments
      .filter((p) => String(p.workspace_id || "") === String(workspaceId))
      .slice(0, limit);
  }
  await ensureSchema();
  return client`
    select * from jack_payments
    where workspace_id = ${String(workspaceId)}
    order by created_at desc
    limit ${Math.min(Math.max(Number(limit) || 100, 1), 250)}
  `;
}

export async function assignPaymentWorkspace(paymentId, workspaceId) {
  const payment = await getPayment(paymentId);
  if (!payment) throw new Error("Payment not found");
  if (payment.workspace_id && String(payment.workspace_id) !== String(workspaceId)) {
    throw new Error("Payment already belongs to another workspace");
  }
  return savePayment({
    ...payment,
    workspace_id: String(workspaceId),
    status: payment.status
  });
}

export async function addAuditEvent(paymentId, eventType, actor = "system", data = {}) {
  const event = {
    payment_id: paymentId || null,
    event_type: eventType,
    actor,
    data,
    created_at: new Date().toISOString()
  };
  const client = db();
  if (!client) {
    memory.events.unshift({ id: memory.events.length + 1, ...event });
    return event;
  }
  await ensureSchema();
  const [row] = await client`
    insert into jack_events (payment_id, event_type, actor, data)
    values (${paymentId || null}, ${eventType}, ${actor}, ${JSON.stringify(data)}::jsonb)
    returning *
  `;
  return row;
}

export async function listAuditEvents(paymentId, limit = 50) {
  const client = db();
  if (!client) {
    return memory.events
      .filter((e) => !paymentId || String(e.payment_id) === String(paymentId))
      .slice(0, limit);
  }
  await ensureSchema();
  if (paymentId) {
    return client`
      select * from jack_events
      where payment_id = ${String(paymentId)}
      order by created_at desc
      limit ${limit}
    `;
  }
  return client`select * from jack_events order by created_at desc limit ${limit}`;
}

export async function claimChannelMessage(channel, messageId) {
  const normalizedChannel = String(channel || "").trim().toLowerCase();
  const normalizedMessageId = String(messageId || "").trim();
  if (!normalizedChannel || !normalizedMessageId) return false;

  const key = normalizedChannel + ":" + normalizedMessageId;
  const client = db();

  if (!client) {
    if (memory.channelMessageClaims.has(key)) return false;
    memory.channelMessageClaims.add(key);
    return true;
  }

  await ensureSchema();
  const rows = await client`
    insert into jack_channel_message_claims (channel, message_id)
    values (${normalizedChannel}, ${normalizedMessageId})
    on conflict (channel, message_id) do nothing
    returning message_id
  `;
  return rows.length === 1;
}

export async function deleteBeneficiary(id) {
  const numericId = Number(id);
  if (!Number.isFinite(numericId)) return null;

  const client = db();
  if (!client) {
    const index = memory.beneficiaries.findIndex((beneficiary) => Number(beneficiary.id) === numericId);
    if (index < 0) return null;
    const [removed] = memory.beneficiaries.splice(index, 1);
    return removed;
  }

  await ensureSchema();
  const rows = await client`
    delete from jack_beneficiaries
    where id = ${numericId}
    returning *
  `;
  return rows[0] || null;
}

export async function getBeneficiaryHistory(supplier, destinationCurrency) {
  const supplierKey = normalizeSupplier(supplier);
  if (!supplierKey) return null;
  const client = db();
  if (!client) {
    return memory.beneficiaries.find((b) =>
      b.supplier_key === supplierKey &&
      (!destinationCurrency || b.destination_currency === destinationCurrency)
    ) || null;
  }
  await ensureSchema();
  const rows = await client`
    select * from jack_beneficiaries
    where supplier_key = ${supplierKey}
      and (${destinationCurrency || null}::text is null or destination_currency = ${destinationCurrency || null})
    order by last_seen_at desc
    limit 1
  `;
  return rows[0] || null;
}

export async function upsertBeneficiary({ supplier, destinationCurrency, beneficiary = {}, metadata = {} }) {
  const supplierKey = normalizeSupplier(supplier);
  if (!supplierKey || !supplier) return null;

  const record = {
    supplier_key: supplierKey,
    supplier_name: supplier,
    destination_currency: destinationCurrency || null,
    bank_name: beneficiary.bank_name || null,
    account_last4: beneficiary.account_last4 || null,
    country: beneficiary.country || null,
    payment_handle: beneficiary.payment_handle || null,
    metadata
  };

  const client = db();
  if (!client) {
    const idx = memory.beneficiaries.findIndex((b) =>
      b.supplier_key === supplierKey && b.destination_currency === record.destination_currency
    );
    if (idx >= 0) {
      memory.beneficiaries[idx] = {
        ...memory.beneficiaries[idx],
        ...record,
        last_seen_at: new Date().toISOString()
      };
      return memory.beneficiaries[idx];
    }
    const row = {
      id: memory.beneficiaries.length + 1,
      ...record,
      first_seen_at: new Date().toISOString(),
      last_seen_at: new Date().toISOString()
    };
    memory.beneficiaries.unshift(row);
    return row;
  }

  await ensureSchema();
  const [row] = await client`
    insert into jack_beneficiaries (
      supplier_key, supplier_name, destination_currency, bank_name,
      account_last4, country, payment_handle, metadata
    ) values (
      ${record.supplier_key}, ${record.supplier_name}, ${record.destination_currency},
      ${record.bank_name}, ${record.account_last4}, ${record.country},
      ${record.payment_handle}, ${JSON.stringify(metadata)}::jsonb
    )
    on conflict (supplier_key, destination_currency) do update set
      supplier_name = excluded.supplier_name,
      bank_name = coalesce(excluded.bank_name, jack_beneficiaries.bank_name),
      account_last4 = coalesce(excluded.account_last4, jack_beneficiaries.account_last4),
      country = coalesce(excluded.country, jack_beneficiaries.country),
      payment_handle = coalesce(excluded.payment_handle, jack_beneficiaries.payment_handle),
      metadata = coalesce(excluded.metadata, jack_beneficiaries.metadata),
      last_seen_at = now()
    returning *
  `;
  return row;
}

export async function listBeneficiaries(limit = 100) {
  const client = db();
  if (!client) return memory.beneficiaries.slice(0, limit);
  await ensureSchema();
  return client`
    select id, supplier_name, destination_currency, bank_name,
           account_last4, country, payment_handle, metadata,
           first_seen_at, last_seen_at
    from jack_beneficiaries
    order by last_seen_at desc
    limit ${limit}
  `;
}


function telegramUserShape(user = {}) {
  const id = String(user.id || "").trim();
  if (!id) throw new Error("Telegram user id is required");
  const displayName = [user.first_name, user.last_name].filter(Boolean).join(" ").trim();
  return {
    id,
    display_name: displayName || user.username || ("Telegram " + id),
    username: String(user.username || "").trim() || null
  };
}

function validRole(value) {
  const role = String(value || "").toLowerCase();
  if (!["owner", "admin", "approver", "operator", "viewer"].includes(role)) {
    throw new Error("Invalid workspace role");
  }
  return role;
}

export function roleCan(role, capability) {
  const value = String(role || "").toLowerCase();
  const permissions = {
    owner: new Set(["view", "operate", "approve", "manage_team", "manage_beneficiaries"]),
    admin: new Set(["view", "operate", "approve", "manage_team", "manage_beneficiaries"]),
    approver: new Set(["view", "approve"]),
    operator: new Set(["view", "operate"]),
    viewer: new Set(["view"])
  };
  return Boolean(permissions[value]?.has(capability));
}

export async function getOrCreateTelegramWorkspace(user = {}) {
  const tg = telegramUserShape(user);
  const client = db();
  if (!client) {
    let membership = memory.members.find((m) => m.telegram_user_id === tg.id && m.status === "active");
    if (!membership) {
      const workspace = {
        id: "ws_" + crypto.createHash("sha256").update("telegram:" + tg.id).digest("hex").slice(0, 16),
        name: "33Jack Workspace",
        owner_telegram_id: tg.id,
        kyb_status: "not_configured",
        created_at: new Date().toISOString(),
        updated_at: new Date().toISOString()
      };
      memory.workspaces.push(workspace);
      membership = {
        workspace_id: workspace.id,
        telegram_user_id: tg.id,
        display_name: tg.display_name,
        username: tg.username,
        role: "owner",
        status: "active",
        created_at: new Date().toISOString(),
        updated_at: new Date().toISOString()
      };
      memory.members.push(membership);
    } else {
      membership.display_name = tg.display_name;
      membership.username = tg.username;
      membership.updated_at = new Date().toISOString();
    }
    const workspace = memory.workspaces.find((w) => w.id === membership.workspace_id);
    return { workspace, member: membership };
  }

  await ensureSchema();
  let rows = await client`
    select m.*, w.name as workspace_name, w.owner_telegram_id, w.kyb_status
    from jack_workspace_members m
    join jack_workspaces w on w.id = m.workspace_id
    where m.telegram_user_id = ${tg.id} and m.status = 'active'
    order by m.created_at asc
    limit 1
  `;
  if (!rows.length) {
    const workspaceId = "ws_" + crypto.createHash("sha256").update("telegram:" + tg.id).digest("hex").slice(0, 16);
    await client`
      insert into jack_workspaces (id, name, owner_telegram_id)
      values (${workspaceId}, ${"33Jack Workspace"}, ${tg.id})
      on conflict (id) do nothing
    `;
    await client`
      insert into jack_workspace_members (workspace_id, telegram_user_id, display_name, username, role, status)
      values (${workspaceId}, ${tg.id}, ${tg.display_name}, ${tg.username}, 'owner', 'active')
      on conflict (workspace_id, telegram_user_id) do update set
        display_name = excluded.display_name,
        username = excluded.username,
        status = 'active',
        updated_at = now()
    `;
    rows = await client`
      select m.*, w.name as workspace_name, w.owner_telegram_id, w.kyb_status
      from jack_workspace_members m
      join jack_workspaces w on w.id = m.workspace_id
      where m.workspace_id = ${workspaceId} and m.telegram_user_id = ${tg.id}
      limit 1
    `;
  } else {
    await client`
      update jack_workspace_members
      set display_name = ${tg.display_name}, username = ${tg.username}, updated_at = now()
      where workspace_id = ${rows[0].workspace_id} and telegram_user_id = ${tg.id}
    `;
  }
  const row = rows[0];
  return {
    workspace: { id: row.workspace_id, name: row.workspace_name, owner_telegram_id: row.owner_telegram_id, kyb_status: row.kyb_status },
    member: { workspace_id: row.workspace_id, telegram_user_id: row.telegram_user_id, display_name: tg.display_name, username: tg.username, role: row.role, status: row.status }
  };
}

export async function getTelegramWorkspaceMembership(userId) {
  const id = String(userId || "").trim();
  if (!id) return null;
  const client = db();
  if (!client) {
    const member = memory.members.find((m) => m.telegram_user_id === id && m.status === "active");
    if (!member) return null;
    return { workspace: memory.workspaces.find((w) => w.id === member.workspace_id), member };
  }
  await ensureSchema();
  const rows = await client`
    select m.*, w.name as workspace_name, w.owner_telegram_id, w.kyb_status
    from jack_workspace_members m
    join jack_workspaces w on w.id = m.workspace_id
    where m.telegram_user_id = ${id} and m.status = 'active'
    order by m.created_at asc
    limit 1
  `;
  if (!rows.length) return null;
  const row = rows[0];
  return {
    workspace: { id: row.workspace_id, name: row.workspace_name, owner_telegram_id: row.owner_telegram_id, kyb_status: row.kyb_status },
    member: { workspace_id: row.workspace_id, telegram_user_id: row.telegram_user_id, display_name: row.display_name, username: row.username, role: row.role, status: row.status }
  };
}

export async function listWorkspaceMembers(workspaceId) {
  const client = db();
  if (!client) return memory.members.filter((m) => m.workspace_id === String(workspaceId) && m.status === "active");
  await ensureSchema();
  return client`
    select workspace_id, telegram_user_id, display_name, username, role, status, created_at, updated_at
    from jack_workspace_members
    where workspace_id = ${String(workspaceId)} and status = 'active'
    order by case role when 'owner' then 0 when 'admin' then 1 when 'approver' then 2 when 'operator' then 3 else 4 end, created_at asc
  `;
}

export async function createWorkspaceInvite(workspaceId, createdBy, role = "viewer", ttlMinutes = 1440) {
  const normalizedRole = validRole(role === "owner" ? "admin" : role);
  const code = crypto.randomBytes(5).toString("hex").toUpperCase();
  const expiresAt = new Date(Date.now() + Math.min(Math.max(Number(ttlMinutes) || 1440, 10), 10080) * 60000);
  const client = db();
  const invite = { code, workspace_id: String(workspaceId), role: normalizedRole, created_by: String(createdBy), expires_at: expiresAt.toISOString(), used_by: null, used_at: null, created_at: new Date().toISOString() };
  if (!client) { memory.invites.push(invite); return invite; }
  await ensureSchema();
  const [row] = await client`
    insert into jack_workspace_invites (code, workspace_id, role, created_by, expires_at)
    values (${code}, ${String(workspaceId)}, ${normalizedRole}, ${String(createdBy)}, ${expiresAt.toISOString()})
    returning *
  `;
  return row;
}

export async function joinWorkspaceInvite(user = {}, code) {
  const tg = telegramUserShape(user);
  const inviteCode = String(code || "").trim().toUpperCase();
  if (!inviteCode) throw new Error("Invite code is required");
  const client = db();
  if (!client) {
    const invite = memory.invites.find((i) => i.code === inviteCode && !i.used_by && Date.parse(i.expires_at) > Date.now());
    if (!invite) throw new Error("Invite code is invalid or expired");
    memory.members.forEach((m) => { if (m.telegram_user_id === tg.id) m.status = "inactive"; });
    const member = { workspace_id: invite.workspace_id, telegram_user_id: tg.id, display_name: tg.display_name, username: tg.username, role: invite.role, status: "active", created_at: new Date().toISOString(), updated_at: new Date().toISOString() };
    memory.members.push(member);
    invite.used_by = tg.id; invite.used_at = new Date().toISOString();
    return { workspace: memory.workspaces.find((w) => w.id === invite.workspace_id), member };
  }
  await ensureSchema();
  const rows = await client`
    select * from jack_workspace_invites
    where code = ${inviteCode} and used_by is null and expires_at > now()
    limit 1
  `;
  if (!rows.length) throw new Error("Invite code is invalid or expired");
  const invite = rows[0];
  await client`update jack_workspace_members set status = 'inactive', updated_at = now() where telegram_user_id = ${tg.id} and status = 'active'`;
  await client`
    insert into jack_workspace_members (workspace_id, telegram_user_id, display_name, username, role, status)
    values (${invite.workspace_id}, ${tg.id}, ${tg.display_name}, ${tg.username}, ${invite.role}, 'active')
    on conflict (workspace_id, telegram_user_id) do update set
      display_name = excluded.display_name, username = excluded.username, role = excluded.role, status = 'active', updated_at = now()
  `;
  await client`update jack_workspace_invites set used_by = ${tg.id}, used_at = now() where code = ${inviteCode}`;
  return getTelegramWorkspaceMembership(tg.id);
}

export async function setWorkspaceMemberRole(workspaceId, targetUserId, role) {
  const normalizedRole = validRole(role);
  if (normalizedRole === "owner") throw new Error("Owner role cannot be assigned here");
  const client = db();
  if (!client) {
    const member = memory.members.find((m) => m.workspace_id === String(workspaceId) && m.telegram_user_id === String(targetUserId));
    if (!member || member.role === "owner") throw new Error("Workspace member not found or cannot change owner");
    member.role = normalizedRole; member.updated_at = new Date().toISOString(); return member;
  }
  await ensureSchema();
  const rows = await client`
    update jack_workspace_members set role = ${normalizedRole}, updated_at = now()
    where workspace_id = ${String(workspaceId)} and telegram_user_id = ${String(targetUserId)} and role <> 'owner'
    returning *
  `;
  if (!rows.length) throw new Error("Workspace member not found or cannot change owner");
  return rows[0];
}

export async function getTelegramPreferences(workspaceId, userId) {
  const client = db();
  const defaults = { workspace_id: String(workspaceId), telegram_user_id: String(userId), payment_updates: true, risk_alerts: true, payout_updates: true, receipt_messages: true };
  if (!client) return memory.preferences.find((p) => p.workspace_id === String(workspaceId) && p.telegram_user_id === String(userId)) || defaults;
  await ensureSchema();
  const rows = await client`select * from jack_user_preferences where workspace_id = ${String(workspaceId)} and telegram_user_id = ${String(userId)} limit 1`;
  return rows[0] || defaults;
}

export async function updateTelegramPreferences(workspaceId, userId, patch = {}) {
  const current = await getTelegramPreferences(workspaceId, userId);
  const next = {
    payment_updates: patch.payment_updates == null ? Boolean(current.payment_updates) : Boolean(patch.payment_updates),
    risk_alerts: patch.risk_alerts == null ? Boolean(current.risk_alerts) : Boolean(patch.risk_alerts),
    payout_updates: patch.payout_updates == null ? Boolean(current.payout_updates) : Boolean(patch.payout_updates),
    receipt_messages: patch.receipt_messages == null ? Boolean(current.receipt_messages) : Boolean(patch.receipt_messages)
  };
  const client = db();
  if (!client) {
    const idx = memory.preferences.findIndex((p) => p.workspace_id === String(workspaceId) && p.telegram_user_id === String(userId));
    const row = { workspace_id: String(workspaceId), telegram_user_id: String(userId), ...next, updated_at: new Date().toISOString() };
    if (idx >= 0) memory.preferences[idx] = row; else memory.preferences.push(row);
    return row;
  }
  await ensureSchema();
  const [row] = await client`
    insert into jack_user_preferences (workspace_id, telegram_user_id, payment_updates, risk_alerts, payout_updates, receipt_messages)
    values (${String(workspaceId)}, ${String(userId)}, ${next.payment_updates}, ${next.risk_alerts}, ${next.payout_updates}, ${next.receipt_messages})
    on conflict (workspace_id, telegram_user_id) do update set
      payment_updates = excluded.payment_updates, risk_alerts = excluded.risk_alerts, payout_updates = excluded.payout_updates, receipt_messages = excluded.receipt_messages, updated_at = now()
    returning *
  `;
  return row;
}

export async function listBeneficiaryControls(workspaceId) {
  const client = db();
  if (!client) return memory.beneficiaryControls.filter((row) => row.workspace_id === String(workspaceId));
  await ensureSchema();
  return client`select * from jack_beneficiary_controls where workspace_id = ${String(workspaceId)} order by updated_at desc`;
}

export async function setBeneficiaryControl(workspaceId, supplier, destinationCurrency, status, note, updatedBy) {
  const supplierKey = normalizeSupplier(supplier);
  if (!supplierKey) throw new Error("Supplier is required");
  const normalizedStatus = String(status || "").toLowerCase();
  if (!["allowlisted", "review", "blocked"].includes(normalizedStatus)) throw new Error("Invalid beneficiary control status");
  const currency = String(destinationCurrency || "").toUpperCase();
  const client = db();
  const row = { workspace_id: String(workspaceId), supplier_key: supplierKey, destination_currency: currency, status: normalizedStatus, note: String(note || "").trim() || null, updated_by: String(updatedBy), updated_at: new Date().toISOString() };
  if (!client) {
    const idx = memory.beneficiaryControls.findIndex((x) => x.workspace_id === row.workspace_id && x.supplier_key === row.supplier_key && x.destination_currency === row.destination_currency);
    if (idx >= 0) memory.beneficiaryControls[idx] = row; else memory.beneficiaryControls.push(row);
    return row;
  }
  await ensureSchema();
  const [saved] = await client`
    insert into jack_beneficiary_controls (workspace_id, supplier_key, destination_currency, status, note, updated_by)
    values (${row.workspace_id}, ${row.supplier_key}, ${row.destination_currency}, ${row.status}, ${row.note}, ${row.updated_by})
    on conflict (workspace_id, supplier_key, destination_currency) do update set
      status = excluded.status, note = excluded.note, updated_by = excluded.updated_by, updated_at = now()
    returning *
  `;
  return saved;
}

export async function getBeneficiaryControl(workspaceId, supplier, destinationCurrency) {
  const supplierKey = normalizeSupplier(supplier);
  if (!supplierKey) return null;
  const currency = String(destinationCurrency || "").toUpperCase();
  const client = db();
  if (!client) return memory.beneficiaryControls.find((x) => x.workspace_id === String(workspaceId) && x.supplier_key === supplierKey && x.destination_currency === currency) || null;
  await ensureSchema();
  const rows = await client`
    select * from jack_beneficiary_controls
    where workspace_id = ${String(workspaceId)} and supplier_key = ${supplierKey} and destination_currency = ${currency}
    limit 1
  `;
  return rows[0] || null;
}

export function persistenceMode() {
  if (process.env.DATABASE_URL) return "postgres";
  const isProduction =
    process.env.VERCEL_ENV === "production" ||
    process.env.NODE_ENV === "production";
  return isProduction ? "unavailable" : "memory";
}


// Celo uses its own approval/transaction state. Mirror a confirmed invoice
// into the legacy dashboard only after onchain confirmation in jack_v2_intents.
export async function markCeloInvoiceSettled(paymentId, workspaceId, txHash) {
  const client = db();
  if (!client) throw new Error("DATABASE_URL required for confirmed Celo invoices");
  await ensureSchema();
  const rows = await client`
    update jack_payments set
      status = 'settled_celo',
      settlement_signature = ${String(txHash)},
      updated_at = now()
    where id = ${String(paymentId)}
      and workspace_id = ${String(workspaceId)}
      and status in ('analyzed', 'failed')
    returning id
  `;
  if (rows.length) {
    await addAuditEvent(paymentId, "payment_status_changed", "celo-v2-rail", {
      to:"settled_celo", signature:String(txHash), chain_id:42220,
      workspace_id:String(workspaceId)
    });
    return true;
  }
  const existing = await getPayment(paymentId);
  return existing?.status === "settled_celo" &&
    String(existing?.settlement_signature || "").toLowerCase() === String(txHash).toLowerCase();
}
