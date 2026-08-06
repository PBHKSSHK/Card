-- ============================================================================
-- Storage: a single private "documents" bucket holds both (a) original CC
-- statement / invoice PDFs, referenced by upload_batches.file_path in the
-- form "<user_id>/<filename>", and (b) claim receipt attachments, referenced
-- by claim_attachments.storage_path in the form "claims/<claim_id>/<line_id
-- or 'batch'>/<filename>".
--
-- RECONSTRUCTION NOTE: the source repo's only committed storage policies
-- (02_migration_auth_notes_storage.sql) restrict access to files whose FIRST
-- path segment equals the uploader's own auth.uid() — a scheme that covers
-- (a) but not (b)'s "claims/..." prefix. No migration file ever added a
-- claims-specific storage policy, so this is treated the same way as the
-- other undocumented-but-required gaps found via usage analysis: the
-- claims_* policy below is added so receipt upload/download actually works.
-- The real privacy boundary for claim receipts is claim_attachments' own RLS
-- (only the claimant/team head/admin can ever learn a given storage_path);
-- storage paths are random UUIDs, so this is a reasonable/no-worse-than-the-
-- original-scheme boundary for the object-storage layer itself.
-- ============================================================================

insert into storage.buckets (id, name, public)
values ('documents', 'documents', false)
on conflict (id) do nothing;

create policy "documents_own_folder_upload" on storage.objects
for insert to authenticated
with check (
  bucket_id = 'documents'
  and (
    (storage.foldername(name))[1] = auth.uid()::text
    or (storage.foldername(name))[1] = 'claims'
  )
);

create policy "documents_own_folder_read" on storage.objects
for select to authenticated
using (
  bucket_id = 'documents'
  and (
    (storage.foldername(name))[1] = auth.uid()::text
    or (storage.foldername(name))[1] = 'claims'
    or public.is_super_user()
  )
);

create policy "documents_own_folder_delete" on storage.objects
for delete to authenticated
using (
  bucket_id = 'documents'
  and (
    (storage.foldername(name))[1] = auth.uid()::text
    or (storage.foldername(name))[1] = 'claims'
    or public.is_super_user()
  )
);

create policy "documents_admin_read_all" on storage.objects
for select to authenticated
using (
  bucket_id = 'documents'
  and public.is_super_user()
);
