/**
 * ChatbotPage.jsx — /chatbot
 * Integrated from Awaaz ChatPage.jsx into PrernaVasthara design system.
 *
 * Auth: uses useAuthSessionCtx() — real JWT token from backend.
 * Backend: POST /agent/chat (requires Authorization: Bearer <token>)
 * Offline-first: queues messages when offline.
 */

import { useState, useEffect, useRef, useCallback } from 'react'
import { Bot, Trash2, AlertCircle, Volume2, VolumeX } from 'lucide-react'
import { useStudent } from '@/context/StudentContext'
import useOnlineStatus from '@/hooks/useOnlineStatus'
import { useAuthSessionCtx } from '@/context/AuthSessionContext'
import { getAnonId } from '@/utils/identity'
import { saveProgressEvent } from '@/utils/indexedDB'
import AgentPipeline from './chatbot/AgentPipeline'
import ChatInput from './chatbot/ChatInput'

// ─── Config ───────────────────────────────────────────────────────────────────
const CHAT_ENDPOINT = '/agent/chat'

function getChatResponseText(payload, fallback = 'How can I help you?') {
  const data = payload?.data || payload || {}
  return [
    data.response,
    data.next_question,
    data.message,
    data.detail,
  ].filter(Boolean).join('\n\n') || fallback
}

function getBrowserSpeechLang(language) {
  return ({ en: 'en-IN', hi: 'hi-IN', kn: 'kn-IN' })[language] || 'en-IN'
}

// ─── Intent classification ────────────────────────────────────────────────────
const TASK_KEYWORDS = [
  'analyze','recommend','suggest','assess',
  'compare','syllabus','exam','test','assignment','homework',
  'schedule', 'routine', 'progress', 'tracker'
]
const PLANNER_KEYWORDS = ['plan','planner','schedule','roadmap','study plan','weekly plan','learning path']
const TEACHER_KEYWORDS = [
  'teach','teacher','learn with me','question me','quiz me','ask me',
  'explain','help with','study','learn','understand','concept','topic','subject',
  'doubt','question about','what is','how does','why does','define','difference between',
  'tell me', 'can you explain'
]

function isTaskIntent(text) {
  if (!text) return false
  const lower = text.toLowerCase()
  return TASK_KEYWORDS.some(kw => lower.includes(kw)) || PLANNER_KEYWORDS.some(kw => lower.includes(kw))
}
function isPlannerIntent(text) {
  if (!text) return false
  const lower = text.toLowerCase()
  return PLANNER_KEYWORDS.some(kw => lower.includes(kw))
}
function isTeacherIntent(text) {
  if (!text) return false
  const lower = text.toLowerCase()
  return TEACHER_KEYWORDS.some(kw => lower.includes(kw))
}

// ─── Helpers ──────────────────────────────────────────────────────────────────
function getInitials(name = '') {
  return name.split(' ').map(n => n[0]).join('').toUpperCase().slice(0, 2) || '?'
}

function TypingIndicator() {
  return (
    <div className="flex items-end gap-2 animate-fade-in">
      <div className="w-8 h-8 rounded-full bg-primary-500/20 border border-primary-500/30 flex items-center justify-center flex-shrink-0">
        <Bot className="w-4 h-4 text-primary-500" />
      </div>
      <div className="bg-surface-card border border-surface-border rounded-2xl rounded-bl-sm px-4 py-3">
        <div className="flex items-center gap-1">
          {[0, 1, 2].map(i => (
            <span
              key={i}
              className="w-1.5 h-1.5 rounded-full bg-surface-muted animate-bounce"
              style={{ animationDelay: `${i * 150}ms`, animationDuration: '0.9s' }}
            />
          ))}
        </div>
      </div>
    </div>
  )
}

function SpeakingIndicator() {
  return (
    <div className="flex items-center justify-center gap-1.5 text-xs text-primary-500 animate-fade-in">
      {[0, 1, 2, 3, 4].map(i => (
        <span
          key={i}
          className="w-1 rounded-full bg-primary-500/80 animate-pulse"
          style={{
            height: `${8 + (i % 3) * 5}px`,
            animationDelay: `${i * 120}ms`,
          }}
        />
      ))}
      <span className="ml-1 text-surface-muted">Speaking</span>
    </div>
  )
}

const EMOTION_BADGES = {
  neutral: '😐 neutral',
  excited: '😊 excited',
  confused: '🤔 confused',
  stressed: '😟 stressed',
}

function detectTextLanguage(text = '') {
  if (/[\u0C80-\u0CFF]/.test(text)) return 'kn'
  if (/[\u0900-\u097F]/.test(text)) return 'hi'
  return 'en'
}

function normalizeVoiceMeta(emotion = {}) {
  return {
    emotion: emotion.detected_emotion || emotion.emotion || 'neutral',
    language: emotion.language || 'en',
    pitch_mean: emotion.pitch_mean ?? 0,
    energy: emotion.energy ?? 0,
    tempo: emotion.tempo ?? 0,
    anon_id: emotion.anon_id || '',
    timestamp: emotion.timestamp,
  }
}

function MessageBubble({ message, studentInitials, onReplay }) {
  const isUser = message.role === 'user'
  const hasAgentFlow = message.agent_flow?.length > 0
  const voiceMeta = message.voice_meta

  return (
    <div className={`flex items-end gap-2 animate-fade-in ${isUser ? 'flex-row-reverse' : ''}`}>
      {/* Avatar */}
      <div className={`
        w-8 h-8 rounded-full flex items-center justify-center flex-shrink-0 text-xs font-bold
        ${isUser
          ? 'bg-primary-500 text-white'
          : 'bg-primary-500/20 border border-primary-500/30 text-primary-500'
        }
      `}>
        {isUser ? studentInitials : <Bot className="w-4 h-4" />}
      </div>

      {/* Bubble + Pipeline */}
      <div className={`flex flex-col gap-1 max-w-[75%] ${isUser ? 'items-end' : 'items-start'}`}>
        {/* Agent pipeline (AI messages only) */}
        {!isUser && hasAgentFlow && (
          <AgentPipeline
            steps={message.agent_flow}
            done={message.pipeline_done ?? true}
            error={message.pipeline_error ?? null}
          />
        )}

        {/* Text bubble */}
        {message.text && (
          <div className="flex items-start gap-1.5">
            <div className={`
              px-4 py-3 rounded-2xl text-sm leading-relaxed whitespace-pre-wrap
              ${isUser
                ? 'bg-primary-500 text-white rounded-br-sm'
                : 'bg-surface-card border border-surface-border text-surface-text rounded-bl-sm'
              }
            `}>
              {message.text}
            </div>
            {!isUser && onReplay && (
              <button
                type="button"
                onClick={() => onReplay(message.text, message.voice_language || detectTextLanguage(message.text))}
                title="Replay voice"
                className="mt-1 p-1.5 rounded-lg text-surface-muted hover:text-primary-500 hover:bg-primary-500/10 transition-colors flex-shrink-0"
              >
                <Volume2 className="w-3.5 h-3.5" />
              </button>
            )}
          </div>
        )}

        {/* Attached image preview */}
        {message.imagePreview && (
          <img
            src={message.imagePreview}
            alt="Attached"
            className="max-w-[200px] rounded-xl border border-surface-border object-cover"
          />
        )}

        {/* File chip */}
        {message.fileName && !message.imagePreview && (
          <div className="flex items-center gap-1.5 px-3 py-1.5 rounded-lg bg-surface-card border border-surface-border text-xs text-surface-muted">
            📎 {message.fileName}
          </div>
        )}

        {voiceMeta && (
          <div className={`flex flex-wrap items-center gap-1.5 px-1 text-[10px] ${isUser ? 'justify-end' : 'justify-start'}`}>
            <span className="rounded-full border border-surface-border bg-surface-card px-2 py-0.5 text-surface-muted">
              {voiceMeta.language?.toUpperCase?.() || 'EN'}
            </span>
            <span className="rounded-full border border-surface-border bg-surface-card px-2 py-0.5 text-surface-muted">
              {EMOTION_BADGES[voiceMeta.emotion] || EMOTION_BADGES.neutral}
            </span>
          </div>
        )}

        {/* Timestamp */}
        <span className="text-[10px] text-surface-muted px-1">
          {message.time}
        </span>
      </div>
    </div>
  )
}

// ─── Offline queue helpers ─────────────────────────────────────────────────────
const QUEUE_KEY = 'pv_chat_queue'
function loadQueue() {
  try { return JSON.parse(sessionStorage.getItem(QUEUE_KEY) || '[]') } catch { return [] }
}
function saveQueue(q) {
  sessionStorage.setItem(QUEUE_KEY, JSON.stringify(q))
}

// ─── Main Component ────────────────────────────────────────────────────────────
export default function ChatbotPage() {
  const { currentStudent } = useStudent()
  const isOnline = useOnlineStatus()
  const { token, isAuthenticated, isInitialising, adkSession } = useAuthSessionCtx()

  const [messages, setMessages] = useState([])
  const [input, setInput] = useState('')
  const [loading, setLoading] = useState(false)
  const [errorMsg, setErrorMsg] = useState('')
  const [currentFile, setCurrentFile] = useState(null)
  const [filePreview, setFilePreview] = useState(null)
  const [listening, setListening] = useState(false)
  const [speaking, setSpeaking] = useState(false)
  const [voiceMuted, setVoiceMuted] = useState(false)
  const [teacherMode, setTeacherMode] = useState(false)
  const [teacherSubject, setTeacherSubject] = useState('')
  const [offlineQueue, setOfflineQueue] = useState(loadQueue)

  const bottomRef = useRef(null)
  const speechAudioRef = useRef(null)
  const speechAbortRef = useRef(null)
  const spokenMessagesRef = useRef(new Set())
  const lastVoiceLanguageRef = useRef(null)

  const studentInitials = getInitials(currentStudent?.name)

  // Auto-scroll to bottom on new message
  useEffect(() => {
    bottomRef.current?.scrollIntoView({ behavior: 'smooth', block: 'nearest' })
  }, [messages, loading])

  // Replay offline queue when back online and authenticated
  useEffect(() => {
    if (isOnline && isAuthenticated && offlineQueue.length > 0) {
      const queue = [...offlineQueue]
      setOfflineQueue([])
      saveQueue([])
      queue.forEach(text => sendMessage(text, null, true))
    }
  }, [isOnline, isAuthenticated]) // eslint-disable-line

  // Welcome message
  useEffect(() => {
    const authNote = isInitialising
      ? ' (Setting up your session…)'
      : !isAuthenticated && isOnline
        ? ' (Authenticating with backend…)'
        : ''
    setMessages([{
      role: 'assistant',
      text: `Hi${currentStudent?.name ? ` ${currentStudent.name}` : ''}! 👋 I'm your AI learning assistant.${authNote} Ask me anything about your studies!`,
      agent_flow: [],
      speak: false,
      time: new Date().toLocaleTimeString([], { hour: '2-digit', minute: '2-digit' }),
    }])
  }, [currentStudent?.name, isAuthenticated]) // eslint-disable-line

  // ─── Voice Input ───────────────────────────────────────────────────────────
  const stopSpeech = useCallback(() => {
    console.log('[voice:tts] stop requested')
    speechAbortRef.current?.abort()
    speechAbortRef.current = null
    window.speechSynthesis?.cancel()
    if (speechAudioRef.current) {
      speechAudioRef.current.pause()
      URL.revokeObjectURL(speechAudioRef.current.src)
    }
    speechAudioRef.current = null
    setSpeaking(false)
  }, [])

  const speakText = useCallback(async (text, language) => {
    if (!text?.trim()) return
    stopSpeech()
    console.log('[voice:tts] request start', { language, chars: text.length })

    const controller = new AbortController()
    speechAbortRef.current = controller
    setSpeaking(true)

    try {
      const res = await fetch('/voice/speak', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ text, language }),
        signal: controller.signal,
      })
      console.log('[voice:tts] response received', { ok: res.ok, status: res.status, contentType: res.headers.get('content-type') })
      if (!res.ok) {
        const detail = await res.text().catch(() => '')
        throw new Error(detail || 'Voice output failed')
      }

      const audioData = await res.blob()
      console.log('[voice:tts] audio blob created', { size: audioData.size, type: audioData.type })
      const audioUrl = URL.createObjectURL(audioData)
      const audio = new Audio(audioUrl)
      speechAudioRef.current = audio
      audio.onended = () => {
        console.log('[voice:tts] playback ended')
        URL.revokeObjectURL(audioUrl)
        speechAudioRef.current = null
        setSpeaking(false)
      }
      audio.onerror = () => {
        console.warn('[voice:tts] playback error')
        URL.revokeObjectURL(audioUrl)
        speechAudioRef.current = null
        setSpeaking(false)
      }
      console.log('[voice:tts] playback start')
      await audio.play()
    } catch (err) {
      if (err.name !== 'AbortError') {
        console.warn('[voice:tts] failed:', err)
        if ('speechSynthesis' in window) {
          const utterance = new SpeechSynthesisUtterance(text)
          utterance.lang = getBrowserSpeechLang(language)
          utterance.onend = () => setSpeaking(false)
          utterance.onerror = () => setSpeaking(false)
          window.speechSynthesis.cancel()
          window.speechSynthesis.speak(utterance)
          return
        }
      }
      setSpeaking(false)
    }
  }, [stopSpeech])

  useEffect(() => {
    const lastIndex = messages.length - 1
    const last = messages[lastIndex]
    if (!last || last.role !== 'assistant' || !last.text || last.pipeline_done === false || last.speak === false || voiceMuted) {
      return
    }

    const speechKey = `${lastIndex}:${last.text}`
    if (spokenMessagesRef.current.has(speechKey)) return
    spokenMessagesRef.current.add(speechKey)

    const language = last.voice_language || detectTextLanguage(last.text)
    console.log('[voice:tts] auto-play assistant message', { language, index: lastIndex })
    speakText(last.text, language)
  }, [messages, speakText, voiceMuted])

  const startVoice = useCallback(() => {
    const SpeechRecognition = window.SpeechRecognition || window.webkitSpeechRecognition
    if (!SpeechRecognition) {
      alert('Voice not supported in this browser. Use Chrome.')
      return
    }

    const recognition = new SpeechRecognition()
    recognition.lang = ({ en: 'en-IN', hi: 'hi-IN', kn: 'kn-IN' })[localStorage.getItem('edu-sakhi-language')] || 'en-IN'
    recognition.interimResults = false
    recognition.maxAlternatives = 1
    recognition.onstart = () => setListening(true)
    recognition.onend = () => setListening(false)
    recognition.onresult = (event) => {
      const transcript = event.results[0][0].transcript
      setInput(transcript)
    }
    recognition.onerror = (event) => console.error('[voice:stt] error:', event.error)
    recognition.start()
  }, [])

  // ─── File handling ─────────────────────────────────────────────────────────
  const handleFileSelect = (e) => {
    const file = e.target.files?.[0]
    if (!file) return
    setCurrentFile(file)
    if (file.type.startsWith('image/')) {
      const reader = new FileReader()
      reader.onload = (ev) => setFilePreview({ name: file.name, src: ev.target.result })
      reader.readAsDataURL(file)
    } else {
      setFilePreview({ name: file.name })
    }
    e.target.value = ''
  }

  const clearFile = () => {
    setCurrentFile(null)
    setFilePreview(null)
  }

  // ─── Send message ──────────────────────────────────────────────────────────
  const sendMessage = useCallback(async (text, file, isReplay = false, voiceMeta = null) => {
    if (!text?.trim() && !file) return
    const now = new Date().toLocaleTimeString([], { hour: '2-digit', minute: '2-digit' })

    // Add user bubble
    const userMsg = {
      role: 'user',
      text: text || '',
      imagePreview: file?.type?.startsWith('image/') ? filePreview?.src : null,
      fileName: file && !file.type?.startsWith('image/') ? file.name : null,
      voice_meta: voiceMeta,
      time: now,
    }
    setMessages(prev => [...prev, userMsg])

    // Offline: queue and bail
    if (!isOnline) {
      const newQueue = [...loadQueue(), text]
      saveQueue(newQueue)
      setOfflineQueue(newQueue)
      setMessages(prev => [...prev, {
        role: 'assistant',
        text: '📶 You\'re offline. Your message has been queued and will be sent when you\'re back online.',
        agent_flow: [],
        pipeline_done: true,
        time: now,
      }])
      return
    }

    setLoading(true)
    setErrorMsg('')

    // ── Branch A: file + planner intent ── /upload-resume → /generate-plan ──
    if (file && isPlannerIntent(text)) {
      setMessages(prev => [...prev, {
        role: 'assistant', text: '',
        agent_flow: [
          { agent: 'Uploaded ✓',          status: 'running', message: 'Reading your resume…' },
          { agent: 'Extraction Agent',     status: 'waiting', message: 'Extracting skills and experience…' },
          { agent: 'Webscraper Agent',     status: 'waiting', message: 'Finding learning resources…' },
          { agent: 'Weekly Planner Agent', status: 'waiting', message: 'Building your 7-day plan…' },
        ],
        pipeline_done: false, time: now,
      }])
      const updateFlow = (flow) => setMessages(prev => {
        const copy = [...prev]
        const idx = copy.findLastIndex(m => m.role === 'assistant' && m.pipeline_done === false)
        if (idx !== -1) copy[idx] = { ...copy[idx], agent_flow: flow }
        return copy
      })
      try {
        const fd = new FormData(); fd.append('file', file)
        const uploadRes = await fetch('/api/student/upload-resume', { method: 'POST', body: fd })
        if (!uploadRes.ok) throw new Error('Resume upload failed')
        const { resume_text } = await uploadRes.json()
        updateFlow([
          { agent: 'Uploaded ✓',          status: 'success', message: 'Resume received.' },
          { agent: 'Extraction Agent',     status: 'running', message: 'Extracting skills…' },
          { agent: 'Webscraper Agent',     status: 'waiting', message: 'Finding learning resources…' },
          { agent: 'Weekly Planner Agent', status: 'waiting', message: 'Building your 7-day plan…' },
        ])
        updateFlow([
          { agent: 'Uploaded ✓',          status: 'success', message: 'Resume received.' },
          { agent: 'Extraction Agent',     status: 'success', message: 'Skills extracted.' },
          { agent: 'Webscraper Agent',     status: 'running', message: 'Scraping learning resources…' },
          { agent: 'Weekly Planner Agent', status: 'waiting', message: 'Building your 7-day plan…' },
        ])
        const studentId = currentStudent?.id || 'default_student'
        const planRes = await fetch('/api/student/generate-plan', {
          method: 'POST',
          headers: { 'Content-Type': 'application/json' },
          body: JSON.stringify({ student_id: studentId, resume_text }),
        })
        if (!planRes.ok) throw new Error('Plan generation failed')
        setMessages(prev => {
          const copy = [...prev]
          const idx = copy.findLastIndex(m => m.role === 'assistant' && m.pipeline_done === false)
          if (idx !== -1) copy[idx] = {
            role: 'assistant',
            text: "Done — your weekly plan is set. I'll track your progress.",
            agent_flow: [
              { agent: 'Uploaded ✓',          status: 'success', message: 'Resume received.' },
              { agent: 'Extraction Agent',     status: 'success', message: 'Skills extracted.' },
              { agent: 'Webscraper Agent',     status: 'success', message: 'Resources found.' },
              { agent: 'Weekly Planner Agent', status: 'success', message: 'Plan generated.' },
            ],
            pipeline_done: true, time: now,
          }
          return copy
        })
      } catch (err) {
        setMessages(prev => {
          const copy = [...prev]
          const idx = copy.findLastIndex(m => m.role === 'assistant' && m.pipeline_done === false)
          if (idx !== -1) copy[idx] = {
            role: 'assistant',
            text: `❌ ${err.message || 'Plan generation failed. Please try again.'}`,
            agent_flow: [{ agent: 'Weekly Planner Agent', status: 'error', message: 'Pipeline failed.' }],
            pipeline_done: true, time: now,
          }
          return copy
        })
      } finally { setLoading(false) }
      return
    }

    // ── Branch B: file only → resume extraction ───────────────────────────────
    if (file) {
      setMessages(prev => [...prev, {
        role: 'assistant', text: '',
        agent_flow: [
          { agent: 'Uploaded ✓',      status: 'running', message: 'Reading your file…' },
          { agent: 'Extraction Agent', status: 'waiting', message: 'Processing content…' },
        ],
        pipeline_done: false, time: now,
      }])
      try {
        const fd = new FormData(); fd.append('file', file)
        setMessages(prev => {
          const copy = [...prev]
          const idx = copy.findLastIndex(m => m.role === 'assistant' && m.pipeline_done === false)
          if (idx !== -1) copy[idx] = { ...copy[idx], agent_flow: [
            { agent: 'Uploaded ✓',      status: 'success', message: 'File received.' },
            { agent: 'Extraction Agent', status: 'running', message: 'Processing content…' },
          ]}
          return copy
        })
        const uploadRes = await fetch('/api/student/upload-resume', { method: 'POST', body: fd })
        if (!uploadRes.ok) throw new Error('File upload failed')
        const { resume_text } = await uploadRes.json()
        const preview = resume_text.slice(0, 400).trim()
        setMessages(prev => {
          const copy = [...prev]
          const idx = copy.findLastIndex(m => m.role === 'assistant' && m.pipeline_done === false)
          if (idx !== -1) copy[idx] = {
            role: 'assistant',
            text: `📄 Resume processed!\n\n${preview}${resume_text.length > 400 ? '…' : ''}\n\nWant a study plan? Just say "generate my plan"!`,
            agent_flow: [
              { agent: 'Uploaded ✓',      status: 'success', message: 'File received.' },
              { agent: 'Extraction Agent', status: 'success', message: 'Content extracted.' },
            ],
            pipeline_done: true, time: now,
          }
          return copy
        })
      } catch (err) {
        setMessages(prev => {
          const copy = [...prev]
          const idx = copy.findLastIndex(m => m.role === 'assistant' && m.pipeline_done === false)
          if (idx !== -1) copy[idx] = {
            role: 'assistant',
            text: `❌ ${err.message || 'File processing failed.'}`,
            agent_flow: [{ agent: 'Extraction Agent', status: 'error', message: 'Failed.' }],
            pipeline_done: true, time: now,
          }
          return copy
        })
      } finally { setLoading(false) }
      return
    }

    // ── Branch C: casual message → direct LLM, no pipeline card ──────────────
    if (teacherMode || isTeacherIntent(text)) {
      try {
        const anonId = await getAnonId()
        const language = localStorage.getItem('edu-sakhi-language') || 'en'
        const res = await fetch(CHAT_ENDPOINT, {
          method: 'POST',
          headers: { 'Content-Type': 'application/json' },
          body: JSON.stringify({
            message: text,
            language,
            teacher_active: teacherMode,
            student_id: currentStudent?.id || 'guest',
            anon_id: anonId,
          }),
        })
        const payload = await res.json()
        const data = payload?.data || payload
        if (data.teacher_active) {
          setTeacherMode(true)
          setTeacherSubject(data.subject || '')
        }
        if (data.progress_record) await saveProgressEvent(data.progress_record)
        setMessages(prev => [...prev, {
          role: 'assistant',
          text: getChatResponseText(payload, 'Teacher assistant is ready. What would you like to study?'),
          agent_flow: data.agent_flow || [],
          pipeline_done: true,
          time: now,
        }])
      } catch (err) {
        setMessages(prev => [...prev, {
          role: 'assistant',
          text: `Teacher pipeline failed: ${err.message || 'Please try again.'}`,
          agent_flow: [{ agent: 'Teacher Agent', status: 'error', message: 'Pipeline failed.' }],
          pipeline_done: true,
          time: now,
        }])
      } finally { setLoading(false) }
      return
    }

    if (!isTaskIntent(text)) {
      try {
        const res = await fetch('/api/chat/direct', {
          method: 'POST',
          headers: { 'Content-Type': 'application/json' },
          body: JSON.stringify({ message: text, student_id: currentStudent?.id }),
        })
        const data = await res.json()
        setMessages(prev => [...prev, {
          role: 'assistant',
          text: getChatResponseText(data),
          agent_flow: [],
          pipeline_done: true,
          time: now,
        }])
      } catch {
        setMessages(prev => [...prev, {
          role: 'assistant',
          text: '❌ Something went wrong. Please try again.',
          agent_flow: [], pipeline_done: true, time: now,
        }])
      } finally { setLoading(false) }
      return
    }

    // ── Branch D: task intent → existing ADK /run_sse pipeline (UNCHANGED) ────
    setMessages(prev => [...prev, {
      role: 'assistant',
      text: '',
      agent_flow: [
        { agent: 'Validation Agent', status: 'running', message: 'Checking query relevance…' },
      ],
      pipeline_done: false,
      time: now,
    }])

    try {
      const headers = {
        'Content-Type': 'application/json',
        'Accept': 'text/event-stream',
      }

      const payload = {
        appName: "agent",
        newMessage: { role: "user", parts: [{ text: text || '' }] },
        sessionId: adkSession?.sessionId,
        stateDelta: null,
        streaming: false,
        userId: "user",
      }

      const res = await fetch('/run_sse', { method: 'POST', headers, body: JSON.stringify(payload) })

      if (!res.ok) {
        const errData = await res.json().catch(() => ({}))
        throw new Error(errData.detail || errData.message || `Server error ${res.status}`)
      }

      if (!res.body) {
        throw new Error("Streaming not supported in this browser.")
      }

      const reader = res.body.getReader()
      const decoder = new TextDecoder()
      let buffer = ""
      const textParts = []
      let sseError = null

      while (true) {
        const { done, value } = await reader.read()
        if (done) break

        buffer += decoder.decode(value, { stream: true })

        let newlineIndex
        while ((newlineIndex = buffer.indexOf("\n")) !== -1) {
          let line = buffer.slice(0, newlineIndex)
          buffer = buffer.slice(newlineIndex + 1)

          line = line.trim()
          if (!line) continue

          const jsonPart = line.startsWith("data:") ? line.slice(5).trim() : line

          try {
            const parsed = JSON.parse(jsonPart)
            // Check for top-level error from ADK
            if (parsed?.error) {
              sseError = parsed.error
              break
            }
            if (parsed?.content?.parts) {
              parsed.content.parts.forEach(p => {
                if (p.text) textParts.push(p.text)
              })
            }
            // Handle ADK event format with actions
            if (parsed?.actions?.state_delta || parsed?.text) {
              if (parsed.text) textParts.push(parsed.text)
            }
          } catch {
            console.warn("Failed to parse SSE chunk:", line)
          }
        }
        if (sseError) break
      }

      // If ADK pipeline errored (quota/model issue), fall back to direct chat
      if (sseError || textParts.length === 0) {
        console.warn('ADK pipeline error, falling back to direct chat:', sseError)
        try {
          const fallbackRes = await fetch('/api/chat/direct', {
            method: 'POST',
            headers: { 'Content-Type': 'application/json' },
            body: JSON.stringify({ message: text, student_id: currentStudent?.id }),
          })
          const fallbackData = await fallbackRes.json()
          const fallbackText = getChatResponseText(fallbackData, 'How can I help you with your studies?')
          setMessages(prev => {
            const copy = [...prev]
            const lastIdx = copy.findLastIndex(m => m.role === 'assistant' && m.pipeline_done === false)
            if (lastIdx !== -1) {
              copy[lastIdx] = {
                role: 'assistant',
                text: fallbackText,
                agent_flow: [],
                pipeline_done: true,
                time: now,
              }
            }
            return copy
          })
          return
        } catch (fallbackErr) {
          console.error('Fallback chat also failed:', fallbackErr)
        }
      }

      const responseText = textParts.join("") || "I'm here to help! What would you like to learn about?"

      setMessages(prev => {
        const copy = [...prev]
        const lastIdx = copy.findLastIndex(m => m.role === 'assistant' && m.pipeline_done === false)
        if (lastIdx !== -1) {
          copy[lastIdx] = {
            role: 'assistant',
            text: responseText,
            agent_flow: [],
            pipeline_done: true,
            time: now,
          }
        }
        return copy
      })
    } catch (err) {
      console.error('Chat error:', err)
      const errText = err.message?.includes('401')
        ? '🔐 Session expired. Please refresh the page to re-authenticate.'
        : `❌ ${err.message || 'Something went wrong. Please try again.'}`

      setMessages(prev => {
        const copy = [...prev]
        const lastIdx = copy.findLastIndex(m => m.role === 'assistant' && m.pipeline_done === false)
        if (lastIdx !== -1) {
          copy[lastIdx] = {
            role: 'assistant',
            text: errText,
            agent_flow: [
              { agent: 'Validation Agent', status: 'error', message: 'Request failed.' },
            ],
            pipeline_done: true,
            time: now,
          }
        }
        return copy
      })
    } finally {
      setLoading(false)
    }
  }, [isOnline, currentStudent, filePreview, token, adkSession])

  const handleSubmit = (e) => {
    e?.preventDefault()
    const text = input.trim()
    if (!text && !currentFile) return
    lastVoiceLanguageRef.current = detectTextLanguage(text)
    setInput('')
    sendMessage(text, currentFile)
    clearFile()
  }

  const clearChat = () => {
    setMessages([{
      role: 'assistant',
      text: `Chat cleared! How can I help you, ${currentStudent?.name || 'there'}?`,
      agent_flow: [],
      time: new Date().toLocaleTimeString([], { hour: '2-digit', minute: '2-digit' }),
    }])
  }

  return (
    <div className="container-page max-w-3xl mx-auto px-4 sm:px-6 py-4 flex flex-col h-[calc(100vh-4rem)] sm:h-[calc(100vh-5rem)]">

      {/* ── Page header ── */}
      <div className="flex items-center justify-between mb-4 flex-shrink-0">
        <div className="flex items-center gap-3">
          <div className="w-10 h-10 rounded-xl bg-primary-500/10 border border-primary-500/30 flex items-center justify-center">
            <Bot className="w-5 h-5 text-primary-500" />
          </div>
          <div>
            <h1 className="text-lg font-display font-bold text-surface-text">AI Learning Assistant</h1>
            <p className="text-xs text-surface-muted">
              {!isOnline
                ? <span className="flex items-center gap-1 text-accent-amber">
                    <span className="w-1.5 h-1.5 rounded-full bg-accent-amber inline-block" />
                    Offline — messages will be queued
                  </span>
                : isInitialising
                  ? <span className="flex items-center gap-1 text-surface-muted">
                      <span className="w-1.5 h-1.5 rounded-full bg-surface-muted inline-block animate-pulse" />
                      Setting up session…
                    </span>
                  : isAuthenticated
                    ? <span className="flex items-center gap-1">
                        <span className="w-1.5 h-1.5 rounded-full bg-accent-teal inline-block animate-pulse-slow" />
                        Online · Session active
                      </span>
                    : <span className="flex items-center gap-1 text-accent-amber">
                        <span className="w-1.5 h-1.5 rounded-full bg-accent-amber inline-block" />
                        Authenticating…
                      </span>
              }
            </p>
          </div>
        </div>

        <div className="flex items-center gap-2">
          <button
            onClick={() => {
              const nextMuted = !voiceMuted
              console.log('[voice:tts] mute toggled', { muted: nextMuted })
              setVoiceMuted(nextMuted)
              if (nextMuted) stopSpeech()
            }}
            title={voiceMuted ? 'Unmute voice output' : 'Mute voice output'}
            className={`p-2 rounded-lg transition-colors ${
              voiceMuted
                ? 'text-accent-rose bg-accent-rose/10'
                : 'text-surface-muted hover:text-primary-500 hover:bg-primary-500/10'
            }`}
          >
            {voiceMuted ? <VolumeX className="w-4 h-4" /> : <Volume2 className="w-4 h-4" />}
          </button>
          {/* Offline queue badge */}
          {offlineQueue.length > 0 && (
            <span className="text-xs px-2 py-1 rounded-full bg-accent-amber/10 text-accent-amber border border-accent-amber/30">
              {offlineQueue.length} queued
            </span>
          )}
          <button
            onClick={clearChat}
            title="Clear chat"
            id="chat-clear-btn"
            className="p-2 rounded-lg text-surface-muted hover:text-accent-rose hover:bg-accent-rose/10 transition-colors"
          >
            <Trash2 className="w-4 h-4" />
          </button>
        </div>
      </div>

      {/* ── Error bar ── */}
      {errorMsg && (
        <div className="mb-3 p-3 rounded-xl bg-accent-rose/10 border border-accent-rose/30 flex items-center gap-2 text-sm text-accent-rose flex-shrink-0">
          <AlertCircle className="w-4 h-4 flex-shrink-0" />
          {errorMsg}
          <button onClick={() => setErrorMsg('')} className="ml-auto text-accent-rose hover:opacity-70">
            ×
          </button>
        </div>
      )}

      {/* ── Messages area ── */}
      {teacherMode && <div className="mb-3 rounded-xl border border-primary-500/30 bg-primary-500/10 px-4 py-2 text-sm text-primary-500">Teacher Agent Active{teacherSubject ? ` - ${teacherSubject}` : ''}</div>}
      <div
        id="chat-messages-area"
        className="flex-1 overflow-y-auto space-y-4 pr-1 mb-4 scroll-smooth"
      >
        {messages.map((msg, i) => (
          <MessageBubble key={i} message={msg} studentInitials={studentInitials} onReplay={speakText} />
        ))}

        {/* Typing indicator */}
        {loading && <TypingIndicator />}
        {speaking && <SpeakingIndicator />}

        <div ref={bottomRef} />
      </div>

      {/* ── Input bar ── */}
      <div className="flex-shrink-0 pb-2">
        <ChatInput
          value={input}
          onChange={(e) => setInput(e.target.value)}
          onSubmit={handleSubmit}
          onMic={startVoice}
          micActive={listening}
          loading={loading}
          disabled={loading || isInitialising}
          filePreview={filePreview}
          onClearFile={clearFile}
          onFileSelect={handleFileSelect}
          placeholder={
            !isOnline
              ? 'Offline — message will be queued'
              : isInitialising
                ? 'Setting up session…'
                : 'Ask anything about your studies…'
          }
        />
        <p className="text-center text-[10px] text-surface-muted mt-2">
          AI responses are for learning support only. Always verify with your teacher.
        </p>
      </div>
    </div>
  )
}
