/**
 * PlannerPage.jsx — /planner
 * Integrated from CarpulseAI StudentAiPlanner into PV design system.
 *
 * Features:
 *  - Resume upload (PDF) → text extraction via backend
 *  - AI-generated 7-day study plan (Gemini)
 *  - Day cards with task checkboxes & progress tracking
 *  - Per-day scraped resource links
 *  - Inline AI study assistant chat
 *  - Offline-aware (shows banner when offline)
 *
 * Backend: /api/student/* (CarpulseAI student_planner router)
 */

import { useState, useEffect, useRef } from 'react'
import {
  Upload, Sparkles, RotateCcw, CheckCircle, Clock,
  ExternalLink, MessageCircle, ChevronDown, ChevronUp,
  Send, FileText, AlertCircle
} from 'lucide-react'
import { useStudent } from '@/context/StudentContext'
import useOnlineStatus from '@/hooks/useOnlineStatus'
import { useAuthSessionCtx } from '@/context/AuthSessionContext'

// ─── API helpers ──────────────────────────────────────────────────────────────
function makeApiPost(getToken) {
  return async function apiPost(path, body, isFormData = false) {
    const token = getToken()
    const headers = {}
    if (token) headers['Authorization'] = `Bearer ${token}`
    if (!isFormData) headers['Content-Type'] = 'application/json'
    const res = await fetch(path, {
      method: 'POST',
      headers,
      body: isFormData ? body : JSON.stringify(body),
    })
    if (!res.ok) throw new Error(`HTTP ${res.status}`)
    return res.json()
  }
}

function makeApiGet(getToken) {
  return async function apiGet(path) {
    const token = getToken()
    const headers = {}
    if (token) headers['Authorization'] = `Bearer ${token}`
    const res = await fetch(path, { headers })
    if (!res.ok) throw new Error(`HTTP ${res.status}`)
    return res.json()
  }
}

// ─── Main Component ───────────────────────────────────────────────────────────
export default function PlannerPage() {
  const { currentStudent } = useStudent()
  const isOnline = useOnlineStatus()
  const { token, isAuthenticated, isInitialising } = useAuthSessionCtx()

  // Build token-aware helpers on the fly
  const apiPost = makeApiPost(() => token)
  const apiGet  = makeApiGet(() => token)

  const [plan, setPlan] = useState(null)
  const [uploading, setUploading] = useState(false)
  const [generating, setGenerating] = useState(false)
  const [resumeText, setResumeText] = useState('')
  const [studyGoal, setStudyGoal] = useState('Learn Biology for Class 12')
  const [classLevel, setClassLevel] = useState('Class 12')
  const [subject, setSubject] = useState('Biology')
  const [dailyTime, setDailyTime] = useState('60-90 minutes')
  const [uploadSuccess, setUploadSuccess] = useState(false)
  const [error, setError] = useState('')

  // AI chat state
  const [chatMessages, setChatMessages] = useState([])
  const [chatInput, setChatInput] = useState('')
  const [chatLoading, setChatLoading] = useState(false)
  const [showChat, setShowChat] = useState(false)
  const chatEndRef = useRef(null)

  const studentId = currentStudent?.id || 'default_student'

  // Fetch existing plan on mount
  useEffect(() => {
    if (!isOnline) return
    apiGet(`/api/student/plan/${studentId}`)
      .then(res => { if (res.plan) setPlan(res.plan) })
      .catch(() => {}) // No plan yet, that's fine
  }, [studentId, isOnline])

  // Scroll chat to bottom
  useEffect(() => {
    chatEndRef.current?.scrollIntoView({ behavior: 'smooth' })
  }, [chatMessages])

  // ─── File upload ─────────────────────────────────────────────────────────
  const handleFileUpload = async (e) => {
    const file = e.target.files[0]
    if (!file) return
    setUploading(true)
    setUploadSuccess(false)
    setError('')

    const fd = new FormData()
    fd.append('file', file)

    try {
      const res = await apiPost('/api/student/upload-resume', fd, true)
      setResumeText(res.resume_text)
      setUploadSuccess(true)
    } catch (err) {
      setError('Error uploading resume. Please try again.')
    } finally {
      setUploading(false)
    }
  }

  // ─── Generate plan ───────────────────────────────────────────────────────
  const generatePlan = async () => {
    if (!resumeText && !studyGoal.trim()) {
      setError('Enter a study goal or upload a resume first.')
      return
    }
    setGenerating(true)
    setError('')

    try {
      const generated = await apiPost('/api/student/generate-plan', {
        student_id: studentId,
        resume_text: resumeText,
        study_goal: `${studyGoal.trim()} Daily study time: ${dailyTime.trim() || '60-90 minutes'}`,
        class_level: classLevel.trim(),
        subject: subject.trim(),
      })
      if (generated.plan) {
        setPlan(generated.plan)
      } else {
        const res = await apiGet(`/api/student/plan/${studentId}`)
        if (res.plan) setPlan(res.plan)
      }
    } catch (err) {
      setError(`Error generating plan: ${err.message || 'Please try again.'}`)
    } finally {
      setGenerating(false)
    }
  }

  // ─── Toggle task ─────────────────────────────────────────────────────────
  const toggleTask = async (day, task, currentStatus) => {
    const isNowCompleted = !currentStatus
    // Optimistic update
    const updatedPlan = JSON.parse(JSON.stringify(plan))
    const dayIdx = updatedPlan.week_plan.findIndex(p => p.day === day)
    if (dayIdx > -1) {
      if (!updatedPlan.week_plan[dayIdx].progress) updatedPlan.week_plan[dayIdx].progress = {}
      updatedPlan.week_plan[dayIdx].progress[task] = isNowCompleted
      setPlan(updatedPlan)
    }

    // Save to Progress Dashboard analytics if checking off
    if (isNowCompleted) {
      import('@/utils/indexedDB').then(({ saveProgressEvent }) => {
        saveProgressEvent({
          student_id: currentStudent?.id || 'guest',
          topicId: `task-${Date.now()}`,
          topicLabel: task.length > 30 ? task.substring(0, 30) + '...' : task,
          subjectId: 'planner',
          subjectLabel: 'Study Planner',
          chapterId: day,
          chapterLabel: day,
          classId: 'N/A',
          classLabel: 'Planner',
          totalQuestions: 1,
          correctAnswers: 1,
          wrongAnswers: 0,
          scorePct: 100,
          masteryScore: 100,
          questionResults: [],
          misconceptionType: 'Task Completed',
          confidenceLevel: 'high',
          createdAt: Date.now(),
        }).catch(() => {})
      })
    }

    try {
      await apiPost('/api/student/update-progress', {
        student_id: studentId,
        day, task,
        completed: isNowCompleted,
      })
    } catch {
      // Revert on failure
      const res = await apiGet(`/api/student/plan/${studentId}`)
      if (res.plan) setPlan(res.plan)
    }
  }

  // ─── Progress calculation ────────────────────────────────────────────────
  const calculateProgress = () => {
    if (!plan?.week_plan) return 0
    let total = 0, completed = 0
    plan.week_plan.forEach(day => {
      if (day.tasks) {
        total += day.tasks.length
        day.tasks.forEach(t => { if (day.progress?.[t]) completed++ })
      }
    })
    return total === 0 ? 0 : Math.round((completed / total) * 100)
  }

  // ─── AI chat ─────────────────────────────────────────────────────────────
  const sendChatMessage = async () => {
    if (!chatInput.trim()) return
    const userMsg = chatInput.trim()
    setChatMessages(prev => [...prev, { role: 'user', text: userMsg }])
    setChatInput('')
    setChatLoading(true)

    try {
      const res = await apiPost('/api/student/ai-assistant', {
        student_id: studentId,
        message: userMsg,
      })
      setChatMessages(prev => [...prev, { role: 'ai', text: res.response }])
    } catch {
      setChatMessages(prev => [...prev, { role: 'ai', text: 'Sorry, I had an error. Please try again.' }])
    } finally {
      setChatLoading(false)
    }
  }

  const progressPct = calculateProgress()

  return (
    <div className="container-page max-w-5xl mx-auto px-4 sm:px-6 py-6">
      {/* Header */}
      <div className="text-center mb-8">
        <div className="inline-flex items-center justify-center w-14 h-14 rounded-2xl bg-primary-500/10 border border-primary-500/30 mb-4">
          <Sparkles className="w-7 h-7 text-primary-500" />
        </div>
        <h1 className="text-2xl sm:text-3xl font-display font-bold text-surface-text mb-2">
          AI Study Planner
        </h1>
        <p className="text-surface-muted text-sm sm:text-base">
          Upload your resume. Let AI build your personalized study path.
        </p>
      </div>

      {/* Offline banner */}
      {!isOnline && (
        <div className="mb-6 p-4 rounded-xl bg-accent-amber/10 border border-accent-amber/30 flex items-center gap-3">
          <AlertCircle className="w-5 h-5 text-accent-amber flex-shrink-0" />
          <p className="text-sm text-accent-amber">You're offline. AI features require an internet connection.</p>
        </div>
      )}

      {/* Error */}
      {error && (
        <div className="mb-6 p-4 rounded-xl bg-accent-rose/10 border border-accent-rose/30 flex items-center gap-3">
          <AlertCircle className="w-5 h-5 text-accent-rose flex-shrink-0" />
          <p className="text-sm text-accent-rose">{error}</p>
          <button onClick={() => setError('')} className="ml-auto text-accent-rose hover:opacity-70">×</button>
        </div>
      )}

      {!plan ? (
        /* ─── Upload Section ─── */
        <div className="card p-6 sm:p-8">
          <div className="inline-flex items-center justify-center w-20 h-20 rounded-full bg-primary-500/10 border border-primary-500/20 mb-6">
            <FileText className="w-10 h-10 text-primary-500" />
          </div>
          <h2 className="text-xl font-display font-bold text-surface-text mb-3 text-center">
            Let's build your AI Plan!
          </h2>
          <p className="text-surface-muted text-sm max-w-xl mx-auto mb-8 leading-relaxed text-center">
            Enter what you want to study or upload a PDF resume. The AI planner will create a 7-day roadmap with tasks, time estimates, progress tracking, and resources.
          </p>

          <div className="grid grid-cols-1 sm:grid-cols-3 gap-3 mb-4">
            <label className="text-left">
              <span className="block text-xs font-semibold text-surface-muted mb-1">Class</span>
              <input
                value={classLevel}
                onChange={(e) => setClassLevel(e.target.value)}
                className="w-full rounded-xl border border-surface-border bg-surface px-3 py-2 text-sm text-surface-text focus:outline-none focus:ring-2 focus:ring-primary-500/40"
                placeholder="Class 12"
              />
            </label>
            <label className="text-left">
              <span className="block text-xs font-semibold text-surface-muted mb-1">Subject</span>
              <input
                value={subject}
                onChange={(e) => setSubject(e.target.value)}
                className="w-full rounded-xl border border-surface-border bg-surface px-3 py-2 text-sm text-surface-text focus:outline-none focus:ring-2 focus:ring-primary-500/40"
                placeholder="Biology"
              />
            </label>
            <label className="text-left sm:col-span-1">
              <span className="block text-xs font-semibold text-surface-muted mb-1">Daily Time</span>
              <input
                value={dailyTime}
                onChange={(e) => setDailyTime(e.target.value)}
                className="w-full rounded-xl border border-surface-border bg-surface px-3 py-2 text-sm text-surface-text focus:outline-none focus:ring-2 focus:ring-primary-500/40"
                placeholder="60-90 minutes"
              />
            </label>
          </div>

          <textarea
            value={studyGoal}
            onChange={(e) => setStudyGoal(e.target.value)}
            className="w-full min-h-24 rounded-xl border border-surface-border bg-surface px-4 py-3 text-sm text-surface-text placeholder:text-surface-muted/60 focus:outline-none focus:ring-2 focus:ring-primary-500/40 mb-5"
            placeholder="Example: I want to learn Class 12 Biology, especially genetics and biotechnology, for board exams."
          />

          <button
            onClick={generatePlan}
            disabled={generating || !isOnline || !studyGoal.trim()}
            className="btn-primary px-6 py-3 rounded-xl font-semibold flex items-center gap-2 mx-auto mb-8
              bg-accent-teal text-white hover:bg-accent-teal/90 transition-all disabled:opacity-50
              shadow-glow-teal"
          >
            {generating ? (
              <span className="w-5 h-5 border-2 border-white/30 border-t-white rounded-full animate-spin" />
            ) : (
              <Sparkles className="w-4 h-4" />
            )}
            {generating ? 'Generating…' : 'Generate AI Study Plan'}
          </button>

          {/* Upload button */}
          <div className="relative inline-block mb-4 left-1/2 -translate-x-1/2">
            <input
              type="file"
              accept=".pdf"
              onChange={handleFileUpload}
              id="planner-resume-upload"
              className="absolute inset-0 w-full h-full opacity-0 cursor-pointer"
            />
            <button
              className="btn-primary px-6 py-3 rounded-xl font-semibold flex items-center gap-2 bg-primary-500 text-white hover:bg-primary-600 transition-all disabled:opacity-50"
              disabled={uploading || !isOnline}
            >
              <Upload className="w-4 h-4" />
              {uploading ? 'Extracting Text…' : 'Upload Resume (PDF)'}
            </button>
          </div>

          {uploadSuccess && (
            <div className="mt-6 animate-fade-in">
              <div className="flex items-center justify-center gap-2 text-accent-teal mb-4">
                <CheckCircle className="w-5 h-5" />
                <span className="font-semibold text-sm">Resume processed successfully!</span>
              </div>
              <button
                onClick={generatePlan}
                disabled={generating || !isOnline}
                className="btn-primary px-6 py-3 rounded-xl font-semibold flex items-center gap-2 mx-auto
                  bg-accent-teal text-white hover:bg-accent-teal/90 transition-all disabled:opacity-50
                  shadow-glow-teal"
              >
                {generating ? (
                  <span className="w-5 h-5 border-2 border-white/30 border-t-white rounded-full animate-spin" />
                ) : (
                  <Sparkles className="w-4 h-4" />
                )}
                {generating ? 'Generating…' : 'Generate AI Plan'}
              </button>
            </div>
          )}
        </div>
      ) : (
        /* ─── Plan Display ─── */
        <div className="space-y-6">
          {/* Progress header */}
          <div className="card p-5">
            <div className="flex items-center justify-between mb-3">
              <div>
                <h2 className="text-lg font-display font-bold text-surface-text">Your Weekly Plan</h2>
                <p className="text-sm text-surface-muted">Progress: {progressPct}% Complete</p>
              </div>
              <button
                onClick={() => { if (window.confirm('Erase current plan and generate a new one?')) { setPlan(null); setResumeText(''); setUploadSuccess(false) } }}
                className="p-2 rounded-lg text-surface-muted hover:text-accent-rose hover:bg-accent-rose/10 transition-colors"
                title="Regenerate plan"
              >
                <RotateCcw className="w-4 h-4" />
              </button>
            </div>
            {/* Progress bar */}
            <div className="h-2.5 rounded-full bg-surface-border overflow-hidden">
              <div
                className="h-full rounded-full transition-all duration-500 ease-out"
                style={{
                  width: `${progressPct}%`,
                  background: progressPct >= 80
                    ? 'linear-gradient(90deg, #2DD4BF, #34d399)'
                    : progressPct >= 40
                      ? 'linear-gradient(90deg, #FBBF24, #fcd34d)'
                      : 'linear-gradient(90deg, var(--tw-gradient-from, #F23E36), #f87171)',
                }}
              />
            </div>
          </div>

          {/* Day cards grid */}
          <div className="grid grid-cols-1 sm:grid-cols-2 lg:grid-cols-3 gap-4">
            {plan.week_plan.map((dayPlan, idx) => {
              const dayTasks = dayPlan.tasks || []
              const dayCompleted = dayTasks.filter(t => dayPlan.progress?.[t]).length
              const dayPct = dayTasks.length === 0 ? 0 : Math.round((dayCompleted / dayTasks.length) * 100)

              return (
                <div
                  key={idx}
                  className={`card overflow-hidden flex flex-col border-t-4 transition-all animate-fade-in ${
                    dayPct === 100 ? 'border-t-accent-teal' : 'border-t-primary-500'
                  }`}
                  style={{ animationDelay: `${idx * 80}ms` }}
                >
                  {/* Day header */}
                  <div className={`px-4 py-3 border-b border-surface-border ${dayPct === 100 ? 'bg-accent-teal/5' : ''}`}>
                    <div className="flex items-center justify-between mb-1">
                      <h3 className="font-semibold text-sm text-surface-text flex items-center gap-1.5">
                        {dayPct === 100 && <CheckCircle className="w-4 h-4 text-accent-teal" />}
                        {dayPlan.day}
                      </h3>
                      <span className="text-xs px-2 py-0.5 rounded-full bg-accent-blue/10 text-accent-blue font-medium flex items-center gap-1">
                        <Clock className="w-3 h-3" />
                        {dayPlan.time_estimate}
                      </span>
                    </div>
                    <p className="text-xs text-surface-muted leading-relaxed">{dayPlan.goal}</p>
                    {/* Mini progress */}
                    <div className="mt-2 h-1 rounded-full bg-surface-border overflow-hidden">
                      <div className={`h-full rounded-full transition-all duration-300 ${dayPct === 100 ? 'bg-accent-teal' : 'bg-primary-500'}`} style={{ width: `${dayPct}%` }} />
                    </div>
                    <p className="text-[10px] text-surface-muted text-right mt-1">{dayCompleted}/{dayTasks.length} tasks</p>
                  </div>

                  {/* Tasks */}
                  <div className="px-4 py-3 flex-1">
                    <ul className="space-y-2">
                      {dayTasks.map((task, tidx) => {
                        const isCompleted = dayPlan.progress?.[task]
                        return (
                          <li key={tidx} className="flex items-start gap-2.5">
                            <input
                              type="checkbox"
                              checked={isCompleted || false}
                              onChange={() => toggleTask(dayPlan.day, task, isCompleted || false)}
                              className="mt-0.5 w-4 h-4 rounded border-surface-border accent-accent-teal cursor-pointer flex-shrink-0"
                            />
                            <span className={`text-xs leading-relaxed transition-all ${isCompleted ? 'text-surface-muted line-through' : 'text-surface-text'}`}>
                              {task}
                            </span>
                          </li>
                        )
                      })}
                    </ul>
                  </div>

                  {/* Resources */}
                  {dayPlan.resources?.length > 0 && (
                    <div className="px-4 py-2.5 border-t border-surface-border bg-accent-amber/5">
                      <p className="text-[10px] font-semibold text-accent-amber uppercase tracking-wider mb-1.5 flex items-center gap-1">
                        <ExternalLink className="w-3 h-3" /> Resources
                      </p>
                      {dayPlan.resources.map((res, ridx) => (
                        <a
                          key={ridx}
                          href={res.url}
                          target="_blank"
                          rel="noopener noreferrer"
                          className="block text-xs text-accent-blue hover:underline truncate mb-0.5"
                        >
                          {res.title}
                        </a>
                      ))}
                    </div>
                  )}
                </div>
              )
            })}
          </div>

          {/* AI Assistant Chat */}
          <div className="card overflow-hidden">
            <button
              onClick={() => setShowChat(!showChat)}
              className="w-full px-5 py-4 flex items-center justify-between bg-gradient-to-r from-primary-500 to-primary-600 text-white cursor-pointer hover:from-primary-600 hover:to-primary-700 transition-all"
            >
              <span className="font-semibold text-sm flex items-center gap-2">
                <MessageCircle className="w-4 h-4" /> AI Study Assistant
              </span>
              {showChat ? <ChevronDown className="w-4 h-4" /> : <ChevronUp className="w-4 h-4" />}
            </button>

            {showChat && (
              <div>
                {/* Messages */}
                <div className="h-64 overflow-y-auto p-4 space-y-3 bg-surface">
                  {chatMessages.length === 0 && (
                    <div className="text-center text-surface-muted pt-12">
                      <MessageCircle className="w-8 h-8 mx-auto mb-2 opacity-40" />
                      <p className="text-sm">Ask me anything about your study plan!</p>
                      <p className="text-xs mt-1">Try: "What should I focus on today?"</p>
                    </div>
                  )}
                  {chatMessages.map((msg, i) => (
                    <div key={i} className={`flex ${msg.role === 'user' ? 'justify-end' : 'justify-start'}`}>
                      <div className={`max-w-[75%] px-4 py-2.5 rounded-2xl text-sm leading-relaxed whitespace-pre-wrap ${
                        msg.role === 'user'
                          ? 'bg-primary-500 text-white rounded-br-sm'
                          : 'bg-surface-card border border-surface-border text-surface-text rounded-bl-sm'
                      }`}>
                        {msg.text}
                      </div>
                    </div>
                  ))}
                  {chatLoading && (
                    <div className="flex justify-start">
                      <div className="px-4 py-2.5 rounded-2xl rounded-bl-sm bg-surface-card border border-surface-border text-surface-muted text-sm flex items-center gap-2">
                        <span className="w-4 h-4 border-2 border-surface-muted/30 border-t-surface-muted rounded-full animate-spin" />
                        Thinking…
                      </div>
                    </div>
                  )}
                  <div ref={chatEndRef} />
                </div>

                {/* Input */}
                <div className="flex border-t border-surface-border">
                  <input
                    type="text"
                    value={chatInput}
                    onChange={(e) => setChatInput(e.target.value)}
                    onKeyDown={(e) => e.key === 'Enter' && sendChatMessage()}
                    placeholder="Ask your AI study assistant…"
                    className="flex-1 px-4 py-3 bg-transparent text-sm text-surface-text placeholder:text-surface-muted/60 focus:outline-none"
                  />
                  <button
                    onClick={sendChatMessage}
                    disabled={chatLoading || !chatInput.trim()}
                    className="px-4 py-3 bg-primary-500 text-white hover:bg-primary-600 disabled:opacity-40 transition-colors"
                  >
                    <Send className="w-4 h-4" />
                  </button>
                </div>
              </div>
            )}
          </div>
        </div>
      )}
    </div>
  )
}
