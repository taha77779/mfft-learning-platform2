-- إنهاء محاولة MFFT وحفظ المؤشرات الأولية فقط.
-- شغّل هذا النص مرة واحدة في Supabase > SQL Editor.
-- لا ينفّذ هذا الإجراء تصنيفاً إلى مندفع/متروٍّ؛ ذلك يحتاج حدوداً بحثية معتمدة.

create or replace function public.mfft_student_finish_attempt(
  p_token_hash text,
  p_attempt_id uuid
)
returns jsonb
language plpgsql
security definer
set search_path = pg_catalog, public
as $function$
declare
  v_student_id uuid;
  v_test_id uuid;
  v_status text;
  v_total_questions integer := 0;
  v_answer_rows integer := 0;
  v_completed_questions integer := 0;
  v_total_errors integer := 0;
  v_first_correct integer := 0;
  v_mean_first_response_ms numeric;
  v_accuracy_percentage numeric;
  v_existing public.mfft_results%rowtype;
  v_result public.mfft_results%rowtype;
  v_first_event_rows integer := 0;
begin
  if p_token_hash is null or length(p_token_hash) <> 64 then
    return jsonb_build_object('error', 'رمز الجلسة غير صالح.');
  end if;

  if p_attempt_id is null then
    return jsonb_build_object('error', 'رقم المحاولة غير موجود.');
  end if;

  -- التحقق من جلسة الطالب النشطة.
  select s.student_id
    into v_student_id
  from public.mfft_student_sessions as s
  join public.mfft_students as st
    on st.id = s.student_id
  where s.token_hash = p_token_hash
    and s.revoked_at is null
    and s.expires_at > clock_timestamp()
    and st.is_active is true
  limit 1;

  if v_student_id is null then
    return jsonb_build_object('error', 'انتهت جلسة الطالب أو لم تعد صالحة. سجّل الدخول مجدداً.');
  end if;

  -- قفل المحاولة لمنع إنهائها مرتين بالتزامن.
  select a.test_id, a.status
    into v_test_id, v_status
  from public.mfft_attempts as a
  where a.id = p_attempt_id
    and a.student_id = v_student_id
  for update;

  if not found then
    return jsonb_build_object('error', 'المحاولة غير موجودة أو لا تخص هذا الطالب.');
  end if;

  -- جعل طلب الإنهاء آمناً عند إعادة إرساله.
  if v_status = 'completed' then
    select r.*
      into v_existing
    from public.mfft_results as r
    where r.attempt_id = p_attempt_id
    limit 1;

    if found then
      return jsonb_build_object(
        'success', true,
        'already_completed', true,
        'result', to_jsonb(v_existing)
      );
    end if;

    return jsonb_build_object('error', 'المحاولة معلّمة كمكتملة لكن سجل نتيجتها غير موجود؛ يلزم فحصها إدارياً.');
  end if;

  if v_status <> 'in_progress' then
    return jsonb_build_object('error', 'حالة المحاولة لا تسمح بإنهائها.');
  end if;

  select count(*)
    into v_total_questions
  from public.mfft_questions as q
  where q.test_id = v_test_id;

  if v_total_questions < 1 then
    return jsonb_build_object('error', 'لا توجد أسئلة مرتبطة بهذه المحاولة.');
  end if;

  select
    count(*),
    count(*) filter (where aa.is_correct is true),
    coalesce(sum(aa.total_errors), 0),
    round(avg(aa.first_response_ms)::numeric)
  into
    v_answer_rows,
    v_completed_questions,
    v_total_errors,
    v_mean_first_response_ms
  from public.mfft_attempt_answers as aa
  where aa.attempt_id = p_attempt_id;

  if v_answer_rows <> v_total_questions
     or v_completed_questions <> v_total_questions
     or exists (
       select 1
       from public.mfft_attempt_answers as aa
       where aa.attempt_id = p_attempt_id
         and aa.first_response_ms is null
     )
  then
    return jsonb_build_object(
      'error',
      'لم تُجب عن جميع الأسئلة بعد. أكمل الأسئلة المتبقية ثم أعد الإنهاء.'
    );
  end if;

  -- دقة الاستجابة الأولى: أول اختيار مسجل لكل سؤال، لا الإجابة النهائية بعد المحاولات.
  select
    count(*),
    count(*) filter (where first_event.is_correct is true)
  into
    v_first_event_rows,
    v_first_correct
  from (
    select distinct on (ae.attempt_answer_id)
      ae.attempt_answer_id,
      ae.is_correct
    from public.mfft_answer_events as ae
    join public.mfft_attempt_answers as aa
      on aa.id = ae.attempt_answer_id
    where aa.attempt_id = p_attempt_id
    order by ae.attempt_answer_id, ae.selected_at asc, ae.id asc
  ) as first_event;

  if v_first_event_rows <> v_total_questions then
    return jsonb_build_object(
      'error',
      'سجلات الاستجابة غير مكتملة لبعض الأسئلة؛ لم تُحفظ النتيجة.'
    );
  end if;

  v_accuracy_percentage :=
    round((v_first_correct::numeric / v_total_questions::numeric) * 100, 2);

  update public.mfft_attempts
  set
    status = 'completed',
    completed_at = clock_timestamp()
  where id = p_attempt_id
    and student_id = v_student_id
    and status = 'in_progress';

  insert into public.mfft_results (
    attempt_id,
    total_questions,
    correct_answers,
    total_errors,
    mean_first_response_ms,
    accuracy_percentage
  )
  values (
    p_attempt_id,
    v_total_questions,
    v_first_correct,
    v_total_errors,
    v_mean_first_response_ms,
    v_accuracy_percentage
  )
  returning * into v_result;

  return jsonb_build_object(
    'success', true,
    'already_completed', false,
    'result', to_jsonb(v_result)
  );
end;
$function$;

revoke all on function public.mfft_student_finish_attempt(text, uuid)
  from public, anon, authenticated;

grant execute on function public.mfft_student_finish_attempt(text, uuid)
  to service_role;
