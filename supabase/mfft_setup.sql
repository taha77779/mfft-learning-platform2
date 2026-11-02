-- MFFT platform migration (additive) — run only after checking the existing schema.
-- Expected existing tables/columns are documented in README-AR.txt.
create extension if not exists pgcrypto;

-- Extend the existing students table; existing student records remain intact.
alter table public.students add column if not exists phone text;
alter table public.students add column if not exists age integer;
alter table public.students add column if not exists email text;
alter table public.students add column if not exists student_code text;
alter table public.students add column if not exists pin_hash text;
alter table public.students add column if not exists retry_allowed boolean not null default false;
create unique index if not exists students_student_code_unique on public.students(student_code) where student_code is not null;

alter table public.attempts add column if not exists attempt_no integer not null default 1;

create table if not exists public.student_sessions (
  id uuid primary key default gen_random_uuid(),
  student_id uuid not null references public.students(id) on delete cascade,
  token_hash text not null unique,
  expires_at timestamptz not null,
  created_at timestamptz not null default now()
);
create table if not exists public.answer_events (
  id bigint generated always as identity primary key,
  attempt_id uuid not null references public.attempts(id) on delete cascade,
  question_id uuid not null references public.questions(id) on delete cascade,
  option_id uuid not null references public.question_options(id) on delete cascade,
  is_correct boolean not null,
  response_ms integer not null default 0,
  created_at timestamptz not null default now()
);

alter table public.students enable row level security;
alter table public.tests enable row level security;
alter table public.questions enable row level security;
alter table public.question_options enable row level security;
alter table public.attempts enable row level security;
alter table public.answers enable row level security;
alter table public.results enable row level security;
alter table public.admins enable row level security;
alter table public.student_sessions enable row level security;
alter table public.answer_events enable row level security;

-- Replace any previous policies on these tables so no older permissive rule can expose data.
do $$ declare r record; begin
 for r in select schemaname,tablename,policyname from pg_policies
  where schemaname='public' and tablename in ('students','tests','questions','question_options','attempts','answers','results','admins','student_sessions','answer_events')
 loop execute format('drop policy if exists %I on %I.%I',r.policyname,r.schemaname,r.tablename); end loop;
end $$;

-- Admin-only table access.
create policy "admin manage students" on public.students for all to authenticated
using (exists(select 1 from public.admins a where a.id=auth.uid()))
with check (exists(select 1 from public.admins a where a.id=auth.uid()));
create policy "admin manage tests" on public.tests for all to authenticated
using (exists(select 1 from public.admins a where a.id=auth.uid()))
with check (exists(select 1 from public.admins a where a.id=auth.uid()));
create policy "admin manage questions" on public.questions for all to authenticated
using (exists(select 1 from public.admins a where a.id=auth.uid()))
with check (exists(select 1 from public.admins a where a.id=auth.uid()));
create policy "admin manage options" on public.question_options for all to authenticated
using (exists(select 1 from public.admins a where a.id=auth.uid()))
with check (exists(select 1 from public.admins a where a.id=auth.uid()));
create policy "admin manage attempts" on public.attempts for all to authenticated
using (exists(select 1 from public.admins a where a.id=auth.uid()))
with check (exists(select 1 from public.admins a where a.id=auth.uid()));
create policy "admin manage answers" on public.answers for all to authenticated
using (exists(select 1 from public.admins a where a.id=auth.uid()))
with check (exists(select 1 from public.admins a where a.id=auth.uid()));
create policy "admin manage results" on public.results for all to authenticated
using (exists(select 1 from public.admins a where a.id=auth.uid()))
with check (exists(select 1 from public.admins a where a.id=auth.uid()));
create policy "admin read own admin row" on public.admins for select to authenticated using (auth.uid()=id);

-- Public can see only the active test listing. Question and option tables remain private;
-- participants retrieve sanitized question payloads through a SECURITY DEFINER RPC.
create policy "public read active tests" on public.tests for select to anon,authenticated using (is_active=true);

-- Storage: signed image URLs require SELECT permission. Image object names are UUIDs.
drop policy if exists "read mfft images" on storage.objects;
create policy "read mfft images for signed urls" on storage.objects for select to anon,authenticated using (bucket_id='mfft-images');
drop policy if exists "admins upload mfft images" on storage.objects;
create policy "admins upload mfft images" on storage.objects for insert to authenticated
with check (bucket_id='mfft-images' and exists(select 1 from public.admins a where a.id=auth.uid()));
drop policy if exists "admins update mfft images" on storage.objects;
create policy "admins update mfft images" on storage.objects for update to authenticated
using (bucket_id='mfft-images' and exists(select 1 from public.admins a where a.id=auth.uid()))
with check (bucket_id='mfft-images' and exists(select 1 from public.admins a where a.id=auth.uid()));

-- Create a student account. Phone is used as the initial PIN but stored only as a bcrypt hash.
create or replace function public.mfft_admin_create_student(p_name text,p_phone text,p_age integer,p_email text default null)
returns jsonb language plpgsql security definer set search_path=public,extensions as $$
declare v_id uuid; v_code text; v_phone text;
begin
 if not exists(select 1 from public.admins where id=auth.uid()) then raise exception 'غير مصرح: المدير فقط يستطيع إضافة الطلاب'; end if;
 v_phone=regexp_replace(coalesce(p_phone,''),'\s','','g');
 if length(trim(coalesce(p_name,'')))<2 then raise exception 'اسم الطالب غير صالح'; end if;
 if length(v_phone)<6 then raise exception 'رقم الهاتف غير صالح'; end if;
 if p_age is null or p_age<5 or p_age>100 then raise exception 'العمر غير صالح'; end if;
 v_code='MFFT-'||upper(substr(replace(gen_random_uuid()::text,'-',''),1,10));
 insert into public.students(student_name,phone,age,email,student_code,pin_hash,retry_allowed)
 values(trim(p_name),v_phone,p_age,nullif(trim(coalesce(p_email,'')),''),v_code,crypt(v_phone,gen_salt('bf')),false)
 returning id into v_id;
 return jsonb_build_object('student_id',v_id,'student_code',v_code,'student_name',trim(p_name));
end $$;
grant execute on function public.mfft_admin_create_student(text,text,integer,text) to authenticated;

-- Student login creates an expiring opaque session token; only its SHA-256 hash is stored.
create or replace function public.mfft_student_login(p_student_code text,p_phone text)
returns jsonb language plpgsql security definer set search_path=public,extensions as $$
declare s public.students%rowtype; v_token text;
begin
 select * into s from public.students where student_code=upper(trim(p_student_code)) limit 1;
 if s.id is null or s.pin_hash is null or crypt(regexp_replace(coalesce(p_phone,''),'\s','','g'),s.pin_hash)<>s.pin_hash then
   raise exception 'الرقم المعرف أو رقم الهاتف غير صحيح';
 end if;
 v_token=replace(gen_random_uuid()::text,'-','')||replace(gen_random_uuid()::text,'-','');
 insert into public.student_sessions(student_id,token_hash,expires_at)
 values(s.id,encode(digest(v_token,'sha256'),'hex'),now()+interval '12 hours');
 return jsonb_build_object('token',v_token,'student_id',s.id,'student_name',s.student_name);
end $$;
grant execute on function public.mfft_student_login(text,text) to anon,authenticated;

-- Remove the earlier anonymous name-only attempt API from the first prototype.
drop function if exists public.mfft_start_attempt(text,uuid);

-- Start the same currently active test for all students. One second attempt requires admin approval.
create or replace function public.mfft_start_student_attempt(p_token text)
returns jsonb language plpgsql security definer set search_path=public as $$
declare v_student uuid; v_test uuid; v_count integer; v_retry boolean; v_attempt uuid; v_no integer;
begin
 select student_id into v_student from public.student_sessions
 where token_hash=encode(digest(coalesce(p_token,''),'sha256'),'hex') and expires_at>now()
 order by created_at desc limit 1;
 if v_student is null then raise exception 'انتهت جلسة الدخول. سجّل الدخول مجدداً'; end if;
 select id into v_test from public.tests where is_active=true order by created_at desc limit 1;
 if v_test is null then raise exception 'لا يوجد اختبار مفعّل حالياً'; end if;
 select count(*) into v_count from public.attempts where student_id=v_student and test_id=v_test;
 select retry_allowed into v_retry from public.students where id=v_student;
 if v_count=0 then v_no=1;
 elsif v_count=1 and coalesce(v_retry,false) then v_no=2;
 else raise exception 'لا توجد محاولة أخرى متاحة. راجع إدارة الاختبار إذا طُلب منك الإعادة'; end if;
 insert into public.attempts(student_id,test_id,started_at,status,attempt_no)
 values(v_student,v_test,now(),'in_progress',v_no) returning id into v_attempt;
 if v_no=2 then update public.students set retry_allowed=false where id=v_student; end if;
 return jsonb_build_object('attempt_id',v_attempt,'test_id',v_test,'attempt_no',v_no);
end $$;
grant execute on function public.mfft_start_student_attempt(text) to anon,authenticated;

-- Return question image paths and option IDs only. Correctness is never sent to the browser.
create or replace function public.mfft_get_test_questions(p_test_id uuid)
returns jsonb language plpgsql security definer set search_path=public as $$
declare output jsonb;
begin
 select jsonb_agg(jsonb_build_object('id',q.id,'question_order',q.question_order,
  'original_url',q.original_image,
  'options',(select jsonb_agg(jsonb_build_object('id',o.id,'image_url',o.image_url) order by o.id)
    from public.question_options o where o.question_id=q.id)) order by q.question_order)
 into output from public.questions q join public.tests t on t.id=q.test_id
 where q.test_id=p_test_id and t.is_active=true;
 return coalesce(output,'[]'::jsonb);
end $$;
grant execute on function public.mfft_get_test_questions(uuid) to anon,authenticated;

-- Remove unauthenticated first-prototype overloads; new RPC calls require a student session token.
drop function if exists public.mfft_record_choice(uuid,uuid,uuid,integer);
drop function if exists public.mfft_finish_attempt(uuid);

-- Record each click. first_response_ms remains the first click latency; every click is logged.
create or replace function public.mfft_record_choice(p_attempt_id uuid,p_question_id uuid,p_option_id uuid,p_response_ms integer,p_token text)
returns boolean language plpgsql security definer set search_path=public as $$
declare v_correct boolean; v_prior integer; v_selected uuid; v_student uuid; v_session_student uuid;
begin
 select student_id into v_session_student from public.student_sessions where token_hash=encode(digest(coalesce(p_token,''),'sha256'),'hex') and expires_at>now() order by created_at desc limit 1;
 select a.student_id into v_student from public.attempts a join public.questions q on q.test_id=a.test_id
 where a.id=p_attempt_id and a.status='in_progress' and q.id=p_question_id;
 if v_student is null or v_session_student is distinct from v_student then raise exception 'جلسة الدخول غير صالحة لهذه المحاولة'; end if;
 select is_correct into v_correct from public.question_options where id=p_option_id and question_id=p_question_id;
 if v_correct is null then raise exception 'الخيار غير صالح'; end if;
 select total_errors,selected_option_id into v_prior,v_selected from public.answers where attempt_id=p_attempt_id and question_id=p_question_id;
 if v_prior is not null and v_selected is not null and exists(select 1 from public.question_options where id=v_selected and is_correct) then raise exception 'تمت الإجابة عن هذا السؤال'; end if;
 insert into public.answer_events(attempt_id,question_id,option_id,is_correct,response_ms)
 values(p_attempt_id,p_question_id,p_option_id,v_correct,greatest(coalesce(p_response_ms,0),0));
 if v_prior is null then
  insert into public.answers(attempt_id,question_id,first_response_ms,total_errors,selected_option_id,is_correct,answered_at)
  values(p_attempt_id,p_question_id,greatest(coalesce(p_response_ms,0),0),case when v_correct then 0 else 1 end,p_option_id,v_correct,case when v_correct then now() else null end);
 else
  update public.answers set total_errors=total_errors+case when v_correct then 0 else 1 end,
   selected_option_id=p_option_id,is_correct=v_correct,answered_at=case when v_correct then now() else null end
  where attempt_id=p_attempt_id and question_id=p_question_id;
 end if;
 return v_correct;
end $$;
grant execute on function public.mfft_record_choice(uuid,uuid,uuid,integer,text) to anon,authenticated;

create or replace function public.mfft_finish_attempt(p_attempt_id uuid,p_token text)
returns jsonb language plpgsql security definer set search_path=public as $$
declare qcount integer; answered integer; errs integer; avgms numeric; rid uuid; v_student uuid; v_session_student uuid;
begin
 select student_id into v_session_student from public.student_sessions where token_hash=encode(digest(coalesce(p_token,''),'sha256'),'hex') and expires_at>now() order by created_at desc limit 1;
 select student_id into v_student from public.attempts where id=p_attempt_id and status='in_progress';
 if v_student is null or v_session_student is distinct from v_student then raise exception 'المحاولة أو جلسة الدخول غير صالحة'; end if;
 select count(*) into qcount from public.questions q join public.attempts a on a.test_id=q.test_id where a.id=p_attempt_id;
 select count(*),coalesce(sum(total_errors),0),coalesce(round(avg(first_response_ms)),0)
 into answered,errs,avgms from public.answers where attempt_id=p_attempt_id and is_correct=true;
 if answered<qcount then raise exception 'لم تكتمل الإجابة عن جميع الأسئلة'; end if;
 update public.attempts set completed_at=now(),status='completed' where id=p_attempt_id;
 insert into public.results(attempt_id,total_questions,total_errors,average_response_ms,classification)
 values(p_attempt_id,qcount,errs,avgms,'غير مصنف معيارياً') returning id into rid;
 return jsonb_build_object('id',rid,'total_questions',qcount,'total_errors',errs,'average_response_ms',avgms,'classification','غير مصنف معيارياً');
end $$;
grant execute on function public.mfft_finish_attempt(uuid,text) to anon,authenticated;

create or replace function public.mfft_admin_allow_retry(p_student_id uuid)
returns boolean language plpgsql security definer set search_path=public as $$
begin
 if not exists(select 1 from public.admins where id=auth.uid()) then raise exception 'غير مصرح'; end if;
 if not exists(select 1 from public.students where id=p_student_id) then raise exception 'الطالب غير موجود'; end if;
 update public.students set retry_allowed=true where id=p_student_id;
 return true;
end $$;
grant execute on function public.mfft_admin_allow_retry(uuid) to authenticated;

-- No anonymous table access to sessions/events. Admins can inspect attempts/results via policies above.
revoke all on public.student_sessions from anon,authenticated;
revoke all on public.answer_events from anon,authenticated;
revoke all on public.answer_events from anon,authenticated;
