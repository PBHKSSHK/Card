-- ============================================================================
-- Cross-table views. Neither of these has a CREATE VIEW anywhere in the
-- source repo's committed SQL — both were created directly against the
-- database (same "no baseline" gap noted in 00000000000001_extensions.sql)
-- and reconstructed here from shared/schema.ts's TransactionFull/BuSummary
-- types plus every column actually dereferenced from them in the client
-- (see docs/recon-system-skill/references/database-schema.md's simpler
-- v_transactions_full for the base join shape; period_month and
-- cardholder_name were added because ReconQueue.tsx reads them directly off
-- rows from this view).
-- ============================================================================

create or replace view public.v_transactions_full as
select
  ct.id as transaction_id,
  ct.txn_date, ct.post_date, ct.merchant,
  ct.amount, ct.amount_hkd, ct.currency, ct.fx_rate,
  ct.reference, ct.description, ct.card_last4,
  ct.cardholder_name,
  ct.period_month,
  ub.bank as card_bank,
  ncca.card_identifier as card_name,
  rr.status as match_status,
  rr.match_type, rr.confidence, rr.matched_at,
  rr.notes as match_notes,
  mi.invoice_number, mi.billing_period, mi.amount as invoice_amount,
  ub.file_name as source_file,
  ct.batch_id, ct.created_at
from public.card_transactions ct
left join public.reconciliation_results rr on rr.transaction_id = ct.id
left join public.meta_invoices mi on rr.invoice_id = mi.id
left join public.upload_batches ub on ct.batch_id = ub.id
left join public.ns_credit_card_accounts ncca on ncca.card_last4 = ct.card_last4;

create or replace view public.v_bu_summary as
select
  e.code as entity_code,
  e.name as entity_name,
  d.code as department_code,
  d.name as department_name,
  count(al.id) as line_count,
  coalesce(sum(al.amount_hkd), 0) as total_amount,
  count(al.id) filter (where al.is_confirmed) as confirmed_count,
  coalesce(sum(al.amount_hkd) filter (where al.is_confirmed), 0) as confirmed_amount
from public.accounting_lines al
join public.entities e on e.id = al.entity_id
join public.departments d on d.id = al.department_id
group by e.code, e.name, d.code, d.name;
