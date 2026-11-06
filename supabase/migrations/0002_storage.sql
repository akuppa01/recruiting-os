-- Private buckets for resumes and ingested files. Object path convention: <user_id>/<...>.
insert into storage.buckets (id, name, public) values ('resumes', 'resumes', false), ('ingest-files', 'ingest-files', false)
on conflict (id) do nothing;

create policy storage_own_select on storage.objects for select
  using (bucket_id in ('resumes','ingest-files') and (storage.foldername(name))[1] = auth.uid()::text);
create policy storage_own_insert on storage.objects for insert
  with check (bucket_id in ('resumes','ingest-files') and (storage.foldername(name))[1] = auth.uid()::text);
create policy storage_own_update on storage.objects for update
  using (bucket_id in ('resumes','ingest-files') and (storage.foldername(name))[1] = auth.uid()::text);
create policy storage_own_delete on storage.objects for delete
  using (bucket_id in ('resumes','ingest-files') and (storage.foldername(name))[1] = auth.uid()::text);
