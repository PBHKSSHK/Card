-- ============================================================================
-- Security hardening round 2 — closes the confirmed findings from the
-- 2026-08 full audit that can be fixed with zero regression against the live
-- app (verified: the affected read paths are only reached by SuperOnly pages,
-- and the affected write paths are admin-only reference/settings data the
-- normal user flows never touch).
--
-- Deliberately NOT changed here (documented decisions, not oversights):
--   * matching_rules stays writable by any authenticated user — the Assign
--     "save as rule" flow (AssignModal) and the bulk rule import (UploadCentre)
--     are used by ordinary finance staff, not just admins. Locking it to
--     super-user would break a live feature. Threat model: all authenticated
--     users are trusted staff.
--   * reconciliation_results SELECT stays open to authenticated — the /recon
--     page (ReconQueue) is not SuperOnly and legitimately reads match status
--     for every authenticated operator. Its WRITE policy is already
--     entity-scoped.
--   * card_transactions / upload_batches INSERT keep WITH CHECK(true) and the
--     "user_id is null => visible" branch. No current row has a null owner, so
--     nothing leaks today; tightening the INSERT check would break the client
--     insert paths that legitimately omit user_id. Revisit only if null-owner
--     rows start appearing.
-- ============================================================================

-- ---- 1. NetSuite master / reference data: admin-write only -----------------
-- These are shared reference tables (chart of accounts, subsidiaries,
-- departments, employees, vendors, customers, credit-card accounts, project
-- codes). Everyone needs to READ them, but only a super user should mutate
-- them. The client only ever writes these from admin settings / import flows.
alter policy "ns_coa_write"           on public.ns_chart_of_accounts     to authenticated using (public.is_super_user()) with check (public.is_super_user());
alter policy "ns_sub_write"           on public.ns_subsidiaries          to authenticated using (public.is_super_user()) with check (public.is_super_user());
alter policy "ns_dept_write"          on public.ns_departments           to authenticated using (public.is_super_user()) with check (public.is_super_user());
alter policy "ns_emp_write"           on public.ns_employees             to authenticated using (public.is_super_user()) with check (public.is_super_user());
alter policy "ns_vend_write"          on public.ns_vendors               to authenticated using (public.is_super_user()) with check (public.is_super_user());
alter policy "ns_cust_write"          on public.ns_customers             to authenticated using (public.is_super_user()) with check (public.is_super_user());
alter policy "ns_cc_write"            on public.ns_credit_card_accounts  to authenticated using (public.is_super_user()) with check (public.is_super_user());
alter policy "ns_project_codes_write" on public.ns_project_codes         to authenticated using (public.is_super_user()) with check (public.is_super_user());

-- ---- 2. Global journal settings: admin-write only --------------------------
-- SettingsPage only renders the editor for admins, but the RLS previously let
-- ANY authenticated user rewrite cr_account / tolerances via the API.
alter policy "settings_update" on public.journal_settings to authenticated using (public.is_super_user());

-- ---- 3. Cross-subsidiary bank / GL data: super-user read only --------------
-- bank_transactions, ns_gl_entries and bank_recon_results are only ever read
-- by the /bank-recon page (SuperOnly) and its matching engine, so restricting
-- SELECT to super users closes the cross-subsidiary leak with no UI change.
alter policy "bank_transactions_select"  on public.bank_transactions  to authenticated using (public.is_super_user());
alter policy "ns_gl_entries_select"      on public.ns_gl_entries      to authenticated using (public.is_super_user());
alter policy "bank_recon_results_select" on public.bank_recon_results to authenticated using (public.is_super_user());

-- ---- 4. Storage: remove the over-broad "claims/" escape hatch --------------
-- The app writes every attachment under "<uid>/claim-<id>/..." (its own
-- folder), never under a literal "claims/" prefix, so the "claims/" branch in
-- these three policies grants nothing legitimate but WOULD let any
-- authenticated user read/write/delete anything placed under claims/*. Drop
-- the branch; keep own-folder + super-user access exactly as before.
drop policy if exists "documents_own_folder_upload" on storage.objects;
create policy "documents_own_folder_upload" on storage.objects
for insert to authenticated
with check (
  bucket_id = 'documents'
  and (storage.foldername(name))[1] = auth.uid()::text
);

drop policy if exists "documents_own_folder_read" on storage.objects;
create policy "documents_own_folder_read" on storage.objects
for select to authenticated
using (
  bucket_id = 'documents'
  and (
    (storage.foldername(name))[1] = auth.uid()::text
    or public.is_super_user()
  )
);

drop policy if exists "documents_own_folder_delete" on storage.objects;
create policy "documents_own_folder_delete" on storage.objects
for delete to authenticated
using (
  bucket_id = 'documents'
  and (
    (storage.foldername(name))[1] = auth.uid()::text
    or public.is_super_user()
  )
);
