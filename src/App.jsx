import React, { useEffect, useState } from 'react'
import { supabase } from './supabase.js'

const ADMIN_HASH = '#/admin'
const shuffle = items => [...items].sort(() => Math.random() - 0.5)
const errorMessage = error => error?.message || 'حدث خطأ غير متوقع.'
const blankOptions = () => Array(8).fill(null)

export default function App() {
  const [page, setPage] = useState(location.hash === ADMIN_HASH ? 'admin' : 'student')
  const [admin, setAdmin] = useState(null)
  const [email, setEmail] = useState('')
  const [password, setPassword] = useState('')
  const [loading, setLoading] = useState(false)
  const [message, setMessage] = useState('')
  const [tab, setTab] = useState('students')
  const [student, setStudent] = useState({ name: '', phone: '', age: '', email: '' })
  const [createdCode, setCreatedCode] = useState('')
  const [students, setStudents] = useState([])
  const [studentCode, setStudentCode] = useState('')
  const [studentPhone, setStudentPhone] = useState('')
  const [studentSession, setStudentSession] = useState(null)
  const [tests, setTests] = useState([])
  const [testTitle, setTestTitle] = useState('')
  const [testInstructions, setTestInstructions] = useState('')
  const [editingId, setEditingId] = useState(null)

  // Question bank
  const [questionTest, setQuestionTest] = useState('')
  const [questionOrder, setQuestionOrder] = useState('1')
  const [originalFile, setOriginalFile] = useState(null)
  const [optionFiles, setOptionFiles] = useState(blankOptions)
  const [correctOption, setCorrectOption] = useState('0')
  const [questions, setQuestions] = useState([])

  useEffect(() => {
    const changePage = () => {
      setPage(location.hash === ADMIN_HASH ? 'admin' : 'student')
      setMessage('')
    }
    window.addEventListener('hashchange', changePage)
    return () => window.removeEventListener('hashchange', changePage)
  }, [])

  useEffect(() => {
    supabase.auth.getSession().then(({ data }) => verifyAdmin(data.session))
    const { data: { subscription } } = supabase.auth.onAuthStateChange((_event, session) => verifyAdmin(session))
    return () => subscription.unsubscribe()
  }, [])

  useEffect(() => {
    if (admin) {
      loadTests()
      loadStudents()
    }
  }, [admin])

  useEffect(() => {
    if (tab === 'questions' && questionTest) loadQuestions()
    else if (!questionTest) setQuestions([])
  }, [tab, questionTest])

  async function verifyAdmin(session) {
    if (!session) { setAdmin(null); return }
    const { data } = await supabase.from('admins').select('id,full_name').eq('id', session.user.id).maybeSingle()
    if (data) { setAdmin(data); setPage('admin') }
    else { setAdmin(null); await supabase.auth.signOut() }
  }

  async function adminLogin(event) {
    event.preventDefault(); setLoading(true); setMessage('')
    try {
      const { data, error } = await supabase.auth.signInWithPassword({ email, password })
      if (error) throw error
      const { data: profile, error: profileError } = await supabase.from('admins').select('id,full_name').eq('id', data.user.id).maybeSingle()
      if (profileError || !profile) { await supabase.auth.signOut(); throw new Error('هذا الحساب غير مسجل ضمن المسؤولين.') }
      setAdmin(profile); setMessage('تم تسجيل الدخول بنجاح.')
    } catch (error) { setMessage(errorMessage(error)) }
    finally { setLoading(false) }
  }

  async function loadStudents() {
    const { data, error } = await supabase.from('mfft_students')
      .select('id,student_code,student_name,age,email,is_active,created_at')
      .order('created_at', { ascending: false })
    if (error) setMessage(`تعذر تحميل الطلاب: ${error.message}`)
    else setStudents(data || [])
  }

  async function addStudent(event) {
    event.preventDefault(); setLoading(true); setMessage(''); setCreatedCode('')
    try {
      const { data, error } = await supabase.functions.invoke('admin-create-student', {
        body: { student_name: student.name.trim(), phone: student.phone.trim(), age: Number(student.age), email: student.email.trim() || null }
      })
      if (error) throw error
      if (!data?.student_code) throw new Error(data?.error || 'لم يتم استلام الرقم التعريفي.')
      setCreatedCode(data.student_code)
      setStudent({ name: '', phone: '', age: '', email: '' })
      setMessage('تمت إضافة الطالب بنجاح. سلّمه الرقم التعريفي وذكّره باستخدام رقم هاتفه للدخول.')
      await loadStudents()
    } catch (error) { setMessage(errorMessage(error)) }
    finally { setLoading(false) }
  }

  async function loadTests() {
    const { data, error } = await supabase.from('mfft_tests')
      .select('id,title,instructions,is_active,created_at')
      .order('created_at', { ascending: false })
    if (error) setMessage(`تعذر تحميل الاختبارات: ${error.message}`)
    else setTests(data || [])
  }

  async function saveTest(event) {
    event.preventDefault(); setLoading(true); setMessage('')
    try {
      const values = { title: testTitle.trim(), instructions: testInstructions.trim() }
      if (!values.title) throw new Error('أدخل عنوان الاختبار.')
      let response
      if (editingId) response = await supabase.from('mfft_tests').update(values).eq('id', editingId)
      else response = await supabase.from('mfft_tests').insert({ ...values, is_active: false, created_by: admin.id })
      if (response.error) throw response.error
      setTestTitle(''); setTestInstructions(''); setEditingId(null)
      setMessage(editingId ? 'تم تحديث الاختبار.' : 'تم إنشاء الاختبار كمسودة غير مفعّلة.')
      await loadTests()
    } catch (error) { setMessage(errorMessage(error)) }
    finally { setLoading(false) }
  }

  async function toggleTest(test) {
    setLoading(true); setMessage('')
    try {
      if (!test.is_active) {
        const { error: offError } = await supabase.from('mfft_tests').update({ is_active: false }).eq('is_active', true)
        if (offError) throw offError
      }
      const { error } = await supabase.from('mfft_tests').update({ is_active: !test.is_active }).eq('id', test.id)
      if (error) throw error
      setMessage('تم تحديث حالة الاختبار.'); await loadTests()
    } catch (error) { setMessage(errorMessage(error)) }
    finally { setLoading(false) }
  }

  async function uploadImage(file) {
    if (!file) throw new Error('اختر صورة أولاً.')
    if (!['image/png', 'image/jpeg', 'image/webp'].includes(file.type)) throw new Error('الصيغ المدعومة PNG وJPG وWEBP.')
    const ext = file.type === 'image/png' ? 'png' : file.type === 'image/webp' ? 'webp' : 'jpg'
    const path = `questions/${crypto.randomUUID()}.${ext}`
    const { error } = await supabase.storage.from('mfft-images').upload(path, file, { upsert: false, contentType: file.type })
    if (error) throw error
    return path
  }

  async function loadQuestions() {
    let response = await supabase.from('mfft_questions').select('*').eq('test_id', questionTest)
    if (response.error && /test_id/i.test(response.error.message || '')) {
      response = await supabase.from('mfft_questions').select('*').eq('mfft_test_id', questionTest)
    }
    if (response.error) { setMessage(`تعذر تحميل الأسئلة: ${response.error.message}`); return }
    try {
      const rows = await Promise.all((response.data || []).map(async q => {
        const originalPath = q.original_image || q.original_image_url || q.image_url || q.image_path
        const { data: original } = originalPath
          ? await supabase.storage.from('mfft-images').createSignedUrl(originalPath, 1800)
          : { data: null }
        let optionResponse = await supabase.from('mfft_options').select('*').eq('question_id', q.id)
        if (optionResponse.error && /question_id/i.test(optionResponse.error.message || '')) {
          optionResponse = await supabase.from('mfft_options').select('*').eq('mfft_question_id', q.id)
        }
        if (optionResponse.error) throw optionResponse.error
        const options = await Promise.all((optionResponse.data || []).map(async o => {
          const imagePath = o.image_url || o.image_path || o.option_image
          const { data: image } = imagePath
            ? await supabase.storage.from('mfft-images').createSignedUrl(imagePath, 1800)
            : { data: null }
          return { ...o, signedUrl: image?.signedUrl || '', is_correct: Boolean(o.is_correct ?? o.correct) }
        }))
        return { ...q, question_order: q.question_order ?? q.question_number ?? q.position ?? 0, signedUrl: original?.signedUrl || '', options }
      }))
      rows.sort((a, b) => a.question_order - b.question_order)
      setQuestions(rows)
    } catch (error) { setMessage(errorMessage(error)) }
  }

  async function saveQuestion(event) {
    event.preventDefault(); setLoading(true); setMessage('')
    const uploadedPaths = []
    let insertedQuestionId = null
    try {
      if (!questionTest) throw new Error('اختر الاختبار أولاً.')
      if (!originalFile || optionFiles.some(file => !file)) throw new Error('أكمل الصورة الأصلية والبدائل الثمانية.')
      const originalPath = await uploadImage(originalFile); uploadedPaths.push(originalPath)
      const questionVariants = [
        { test_id: questionTest, question_order: Number(questionOrder), original_image: originalPath },
        { mfft_test_id: questionTest, question_order: Number(questionOrder), original_image: originalPath },
        { test_id: questionTest, question_number: Number(questionOrder), original_image_url: originalPath },
        { mfft_test_id: questionTest, question_number: Number(questionOrder), original_image_url: originalPath },
        { test_id: questionTest, position: Number(questionOrder), image_url: originalPath }
      ]
      let questionResult = null
      for (const values of questionVariants) {
        questionResult = await supabase.from('mfft_questions').insert(values).select('*').single()
        if (!questionResult.error) break
        const msg = questionResult.error.message || ''
        if (!/column|schema cache|does not exist|could not find/i.test(msg)) break
      }
      if (questionResult?.error) throw questionResult.error
      insertedQuestionId = questionResult.data.id
      const optionRows = []
      for (let i = 0; i < 8; i++) {
        const imagePath = await uploadImage(optionFiles[i]); uploadedPaths.push(imagePath)
        optionRows.push({ question_id: insertedQuestionId, image_url: imagePath, is_correct: i === Number(correctOption) })
      }
      let optionResult = await supabase.from('mfft_options').insert(optionRows)
      if (optionResult.error && /question_id/i.test(optionResult.error.message || '')) {
        optionResult = await supabase.from('mfft_options').insert(optionRows.map(({ question_id, ...row }) => ({ ...row, mfft_question_id: insertedQuestionId })))
      }
      if (optionResult.error && /image_url/i.test(optionResult.error.message || '')) {
        const rows = optionRows.map(row => ({ question_id: row.question_id, image_path: row.image_url, is_correct: row.is_correct }))
        optionResult = await supabase.from('mfft_options').insert(rows)
      }
      if (optionResult.error) throw optionResult.error
      setMessage('تم حفظ السؤال والبدائل الثمانية.')
      setQuestionOrder(String(Number(questionOrder) + 1)); setOriginalFile(null); setOptionFiles(blankOptions()); setCorrectOption('0')
      await loadQuestions()
    } catch (error) {
      if (insertedQuestionId) await supabase.from('mfft_questions').delete().eq('id', insertedQuestionId)
      if (uploadedPaths.length) await supabase.storage.from('mfft-images').remove(uploadedPaths)
      setMessage(errorMessage(error))
    } finally { setLoading(false) }
  }

  async function studentLogin(event) {
    event.preventDefault(); setLoading(true); setMessage(''); setStudentSession(null)
    try {
      const { data, error } = await supabase.functions.invoke('student-login', {
        body: { student_code: studentCode.trim().toUpperCase(), phone: studentPhone.trim() }
      })
      if (error) throw error
      if (!data?.success || !data?.token || !data?.student) throw new Error(data?.error || 'تعذر تسجيل الدخول.')
      setStudentSession(data); setMessage('تم تسجيل الدخول بنجاح.')
    } catch (error) { setMessage(errorMessage(error)) }
    finally { setLoading(false) }
  }

  async function logoutAdmin() { await supabase.auth.signOut(); setAdmin(null); setTests([]); setStudents([]) }
  function logoutStudent() { setStudentSession(null); setStudentCode(''); setStudentPhone(''); setMessage('تم تسجيل الخروج.') }

  const input = { display: 'block', width: '100%', boxSizing: 'border-box', padding: 12, margin: '7px 0 15px', border: '1px solid #cbd5e1', borderRadius: 8, background: '#fff' }
  const button = { width: '100%', padding: 13, marginTop: 10, border: 0, borderRadius: 8, background: '#176b87', color: '#fff', fontWeight: 700, cursor: 'pointer' }
  const panel = { background: '#fff', maxWidth: 850, margin: '25px auto', padding: 24, borderRadius: 14, boxShadow: '0 3px 15px #0001' }
  const label = { display: 'block', fontWeight: 700, fontSize: 14, marginTop: 10 }

  return <div dir="rtl" style={{ minHeight: '100vh', background: '#f1f5f9', color: '#1e293b', fontFamily: 'Arial,sans-serif', paddingBottom: 20 }}>
    <header style={{ background: '#123b5d', color: '#fff', textAlign: 'center', padding: 22 }}>
      <h1>منصة MFFT التعليمية</h1><p>منصة الاختبارات والبحث العلمي</p>
    </header>
    {message && <div role="status" style={{ maxWidth: 850, margin: '15px auto', padding: 12, background: '#fff5e8', color: '#765322', borderRadius: 8 }}>{message}</div>}

    {page === 'admin' ? <main style={panel}>
      {!admin ? <><h2>دخول المدير</h2><form onSubmit={adminLogin}>
        <label style={label}>البريد الإلكتروني</label><input style={input} type="email" value={email} onChange={e => setEmail(e.target.value)} required />
        <label style={label}>كلمة المرور</label><input style={input} type="password" value={password} onChange={e => setPassword(e.target.value)} required />
        <button style={button} disabled={loading}>{loading ? 'جارٍ التحقق...' : 'دخول الإدارة'}</button>
      </form></> : <>
        <h2>لوحة الإدارة</h2><p>مرحباً {admin.full_name}</p>
        <nav style={{ display: 'flex', flexWrap: 'wrap', gap: 8, margin: '18px 0' }}>
          {[['students','الطلاب'],['tests','الاختبارات'],['questions','بنك الأسئلة']].map(([key, title]) => <button key={key} onClick={() => setTab(key)} style={{ ...button, width: 'auto', padding: '10px 16px', background: tab === key ? '#123b5d' : '#64748b' }}>{title}</button>)}
        </nav>
        {tab === 'students' && <>
          <h3>إضافة طالب</h3><p>ينشأ الرقم التعريفي تلقائياً، ويستخدم الطالب رقم هاتفه للدخول.</p>
          <form onSubmit={addStudent}>
            <label style={label}>اسم الطالب</label><input style={input} required value={student.name} onChange={e => setStudent({ ...student, name: e.target.value })} />
            <label style={label}>رقم الهاتف</label><input style={input} required type="tel" value={student.phone} onChange={e => setStudent({ ...student, phone: e.target.value })} />
            <label style={label}>العمر</label><input style={input} required type="number" min="5" max="100" value={student.age} onChange={e => setStudent({ ...student, age: e.target.value })} />
            <label style={label}>البريد الإلكتروني (اختياري)</label><input style={input} type="email" value={student.email} onChange={e => setStudent({ ...student, email: e.target.value })} />
            <button style={button} disabled={loading}>{loading ? 'جارٍ الإضافة...' : 'إضافة الطالب'}</button>
          </form>
          {createdCode && <div style={{ padding: 16, marginTop: 14, textAlign: 'center', background: '#e7f5ec', borderRadius: 9 }}><h3>الرقم التعريفي</h3><strong>{createdCode}</strong></div>}
          <h3>الطلاب ({students.length})</h3>
          <div style={{ overflowX: 'auto' }}><table style={{ width: '100%', borderCollapse: 'collapse' }}><thead><tr>{['الاسم','الرقم المعرف','العمر','الحالة'].map(x => <th key={x} style={{ padding: 8, borderBottom: '1px solid #ddd' }}>{x}</th>)}</tr></thead><tbody>{students.map(s => <tr key={s.id}><td style={{ padding: 8 }}>{s.student_name}</td><td style={{ padding: 8 }}>{s.student_code}</td><td style={{ padding: 8 }}>{s.age}</td><td style={{ padding: 8 }}>{s.is_active ? 'نشط' : 'موقوف'}</td></tr>)}</tbody></table></div>
        </>}
        {tab === 'tests' && <>
          <h3>إدارة الاختبارات</h3><form onSubmit={saveTest}>
            <label style={label}>عنوان الاختبار</label><input style={input} required value={testTitle} onChange={e => setTestTitle(e.target.value)} />
            <label style={label}>تعليمات الاختبار</label><textarea style={{ ...input, minHeight: 90 }} value={testInstructions} onChange={e => setTestInstructions(e.target.value)} />
            <button style={button} disabled={loading}>{editingId ? 'حفظ التعديلات' : 'إنشاء اختبار'}</button>
            {editingId && <button type="button" style={{ ...button, background: '#64748b' }} onClick={() => { setEditingId(null); setTestTitle(''); setTestInstructions('') }}>إلغاء التعديل</button>}
          </form>
          <h3>الاختبارات المسجلة ({tests.length})</h3>{tests.map(t => <article key={t.id} style={{ border: '1px solid #cbd5e1', borderRadius: 9, padding: 13, margin: '10px 0' }}>
            <strong>{t.title}</strong><p>{t.instructions || 'لا توجد تعليمات.'}</p><p>الحالة: {t.is_active ? 'نشط' : 'غير نشط'}</p>
            <button style={{ ...button, width: 'auto', padding: '8px 14px' }} onClick={() => { setEditingId(t.id); setTestTitle(t.title); setTestInstructions(t.instructions || '') }}>تعديل</button>
            <button style={{ ...button, width: 'auto', padding: '8px 14px', marginRight: 8 }} disabled={loading} onClick={() => toggleTest(t)}>{t.is_active ? 'تعطيل' : 'تفعيل'}</button>
          </article>)}
        </>}
        {tab === 'questions' && <>
          <h3>إضافة سؤال جديد</h3><p>ارفع الصورة الأصلية وثماني صور بديلة، ثم حدد موضع الصورة المطابقة.</p>
          <label style={label}>الاختبار المرتبط</label><select style={input} value={questionTest} onChange={e => setQuestionTest(e.target.value)}><option value="">اختر الاختبار</option>{tests.map(t => <option key={t.id} value={t.id}>{t.title}</option>)}</select>
          <form onSubmit={saveQuestion}>
            <label style={label}>ترتيب السؤال</label><input style={input} type="number" min="1" required value={questionOrder} onChange={e => setQuestionOrder(e.target.value)} />
            <label style={label}>الصورة الأصلية</label><input style={input} type="file" accept="image/png,image/jpeg,image/webp" onChange={e => setOriginalFile(e.target.files?.[0] || null)} />
            {optionFiles.map((file, i) => <div key={i}><label style={label}>البديل {i + 1}</label><input style={input} type="file" accept="image/png,image/jpeg,image/webp" onChange={e => setOptionFiles(a => a.map((v, j) => i === j ? (e.target.files?.[0] || null) : v))} /></div>)}
            <label style={label}>الإجابة الصحيحة</label><select style={input} value={correctOption} onChange={e => setCorrectOption(e.target.value)}>{Array.from({ length: 8 }, (_, i) => <option value={i} key={i}>البديل {i + 1}</option>)}</select>
            <button style={button} disabled={loading || !questionTest}>{loading ? 'جارٍ رفع الصور والحفظ...' : 'حفظ السؤال'}</button>
          </form>
          <h3>الأسئلة المحفوظة ({questions.length})</h3>
          {questions.map(q => <article key={q.id} style={{ border: '1px solid #cbd5e1', borderRadius: 9, padding: 13, margin: '12px 0' }}>
            <strong>السؤال {q.question_order}</strong>{q.signedUrl && <p><img src={q.signedUrl} alt="الصورة الأصلية" style={{ maxWidth: 150, maxHeight: 150, objectFit: 'contain' }} /></p>}
            <div style={{ display: 'grid', gridTemplateColumns: 'repeat(4,minmax(0,1fr))', gap: 8 }}>{q.options.map((o, i) => <div key={o.id} style={{ border: '1px solid #eee', padding: 5, textAlign: 'center' }}>{o.signedUrl && <img src={o.signedUrl} alt={`البديل ${i + 1}`} style={{ width: '100%', height: 75, objectFit: 'contain' }} />}<small>{i + 1}{o.is_correct ? ' ✓' : ''}</small></div>)}</div>
          </article>)}
        </>}
        <button style={{ ...button, background: '#64748b' }} onClick={logoutAdmin}>تسجيل الخروج</button>
      </>}
    </main> : <main style={{ ...panel, maxWidth: 520 }}>
      {!studentSession ? <><h2>دخول الطالب</h2><p>أدخل الرقم التعريفي ورقم الهاتف المسجل لدى الإدارة.</p><form onSubmit={studentLogin}>
        <label style={label}>الرقم التعريفي</label><input style={input} required value={studentCode} onChange={e => setStudentCode(e.target.value)} placeholder="MFFT-XXXXXXXX" />
        <label style={label}>رقم الهاتف</label><input style={input} required type="tel" value={studentPhone} onChange={e => setStudentPhone(e.target.value)} />
        <button style={button} disabled={loading}>{loading ? 'جارٍ التحقق...' : 'دخول الطالب'}</button>
      </form></> : <><h2>مرحباً {studentSession.student.student_name}</h2><p>تم التحقق من بياناتك بنجاح.</p><p>الرقم التعريفي: {studentSession.student.student_code}</p><p>سيظهر الاختبار بعد اكتمال ربط واجهة الأداء بدوال الاختبار.</p><button style={button} onClick={logoutStudent}>تسجيل الخروج</button></>}
    </main>}
    <footer style={{ textAlign: 'center', padding: 18, color: '#64748b' }}>منصة MFFT — النتائج مؤشرات وصفية وليست تشخيصاً نفسياً.</footer>
  </div>
}
