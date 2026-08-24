import axios from 'axios'
import { analyzeResponseOffline, generateExplanationOffline } from '@/utils/offlineEngine'
import {
  getBoardSyllabusCatalog,
  getBoardSyllabusClass,
  getBoardSyllabusSubject,
} from '@/data/boardSyllabus'

/**
 * api.js — Axios client pre-configured for the Pragna Vistara FastAPI backend.

 *
 * Base URL: /api  →  proxied to http://localhost:8000 in dev (see vite.config.js)
 *
 * All functions are async and return the response `data` field directly.
 * Errors are re-thrown as-is for the caller to handle.
 */

// In production VITE_API_BASE_URL is set to the Render backend URL.
// In dev it is undefined so the Vite proxy handles relative paths.
const BACKEND_BASE = import.meta.env.VITE_API_BASE_URL || ''

const client = axios.create({
  baseURL: BACKEND_BASE + '/api',
  timeout: 15_000,
  headers: { 'Content-Type': 'application/json' },
})

const authClient = axios.create({
  baseURL: BACKEND_BASE,
  timeout: 15_000,
  headers: { 'Content-Type': 'application/json' },
})

const syllabusRequestCache = new Map()

async function getCachedSyllabusRequest(cacheKey, request) {
  if (syllabusRequestCache.has(cacheKey)) {
    return syllabusRequestCache.get(cacheKey)
  }

  const promise = request()
    .catch((error) => {
      syllabusRequestCache.delete(cacheKey)
      throw error
    })

  syllabusRequestCache.set(cacheKey, promise)
  return promise
}

// ─── Request interceptor (attach auth token when available) ──────────────────
client.interceptors.request.use((config) => {
  const appMode = localStorage.getItem('appMode')
  
  // Exclude health and auth routes from offline block
  const isAuthRoute = config.url.includes('/health') || config.url.includes('/auth/')
  
  if (appMode === 'offline' && !isAuthRoute) {
    return Promise.reject(new Error('OFFLINE_MODE_BLOCK'))
  }

  const token = localStorage.getItem('access_token')
  if (token) {
    config.headers['Authorization'] = `Bearer ${token}`
  }
  return config
})

// ─── Response interceptor (normalise errors) ─────────────────────────────────
client.interceptors.response.use(
  (response) => response,
  (error) => {
    if (error.message === 'OFFLINE_MODE_BLOCK') {
      // Gracefully handle offline blocked requests
      return Promise.reject({ isOfflineFallback: true })
    }
    const message =
      error.response?.data?.detail ??
      error.response?.data?.message ??
      error.message ??
      'An unexpected error occurred.'
    return Promise.reject(new Error(message))
  },
)

// ─── Hybrid Auth Methods ──────────────────────────────────────────────────────

export async function hybridRegister(payload) {
  const { data } = await authClient.post('/auth/register', payload)
  if (data.success && data.data?.access_token) {
    localStorage.setItem('access_token', data.data.access_token)
  }
  return data
}

export async function hybridLogin(email, password) {
  const { data } = await authClient.post('/auth/login', { email, password })
  if (data.success && data.data?.access_token) {
    localStorage.setItem('access_token', data.data.access_token)
  }
  return data
}

const backendSyncs = new Map()

function getLocalStudentEmail(student) {
  const stableId = String(student.id || student.local_id || student.name || 'student')
    .trim()
    .toLowerCase()
    .replace(/[^a-z0-9._-]/g, '-')
  return `${stableId}@local.student`
}

export async function syncLocalUserToBackend(student) {
  const appMode = localStorage.getItem('appMode')
  if (appMode !== 'online' || !student?.id) return

  const email = getLocalStudentEmail(student)
  if (backendSyncs.has(email)) return backendSyncs.get(email)
  
  const syncPromise = (async () => {
    // Try to login first. Current-session sync can pass the PIN; background sync
    // may not have it, so keep the previous default as a compatibility fallback.
    const passwords = [...new Set([student.pin, '1234'].filter(Boolean).map(String))]
    const hasCurrentPin = Boolean(student.pin)
    
    let res = null
    for (const password of passwords) {
      try {
        res = await authClient.post('/auth/login', { email, password })
        if (res.data?.success) break
      } catch (e) {
        // Login failed, try next candidate or register below.
      }
    }

    if (!hasCurrentPin) return
    
    if (!res || !res.data?.success) {
      // Register
      res = await authClient.post('/auth/register', {
        name: student.name,
        email: email,
        password: String(student.pin),
        role: 'student',
        local_id: student.id,
        usn: email
      })
    }
    
    const token = res?.data?.data?.access_token || res?.data?.data?.token
    if (res?.data?.success && token) {
      localStorage.setItem('access_token', token)
      if (res.data.data?.role) localStorage.setItem('auth_role', res.data.data.role)
    }
  })()
    .catch((err) => {
      console.warn('Backend student sync skipped:', err.message)
    })
    .finally(() => {
      backendSyncs.delete(email)
    })

  backendSyncs.set(email, syncPromise)

  try {
    await syncPromise
  } catch (err) {
    console.warn('Backend student sync skipped:', err.message)
  }
}


// ─── API methods ──────────────────────────────────────────────────────────────

/**
 * Sends a student response to the backend for misconception analysis.
 *
 * @param {Object} payload
 * @param {string} payload.questionId
 * @param {string} payload.questionText
 * @param {number} payload.selectedIndex
 * @param {number} payload.correctIndex
 * @param {string} payload.topicId
 * @returns {Promise<Object>} AnalysisResult
 */
export async function analyzeResponseOnline(payload) {
  const { data } = await client.post('/analyze-response', payload)
  return data
}

export async function analyzeResponse(payload) {
  const appMode = localStorage.getItem('appMode')
  if (typeof navigator !== 'undefined' && (!navigator.onLine || appMode === 'offline')) {
    return analyzeResponseOffline(payload)
  }

  try {
    return await analyzeResponseOnline(payload)
  } catch (err) {
    if (err.isOfflineFallback) {
      return analyzeResponseOffline(payload)
    }
    return analyzeResponseOffline(payload)
  }
}

/**
 * Requests an offline stored explanation for a misconception.
 *
 * @param {Object} payload
 * @param {string} payload.misconception_type
 * @param {string} payload.topic
 * @param {string} [payload.subject]
 * @param {string} [payload.question_text]
 * @param {string} [payload.student_answer]
 * @returns {Promise<Object>} ExplanationResult
 */
export async function generateExplanationOnline(payload) {
  const { data } = await client.post('/generate-explanation', payload)
  return data
}

export async function generateExplanation(payload) {
  const appMode = localStorage.getItem('appMode')
  if (typeof navigator !== 'undefined' && (!navigator.onLine || appMode === 'offline')) {
    return generateExplanationOffline(payload)
  }

  try {
    return await generateExplanationOnline(payload)
  } catch (err) {
    if (err.isOfflineFallback) {
      return generateExplanationOffline(payload)
    }
    return generateExplanationOffline(payload)
  }
}

/**
 * Requests optional local Ollama/Mistral enhancement.
 *
 * @param {Object} payload
 * @param {string} payload.topic
 * @param {string} payload.content
 * @param {string} [payload.story]
 * @param {'rephrase'|'analogy'|'hybrid'} [payload.use_case]
 * @returns {Promise<Object>} LocalExplanationResult
 */
export async function localExplanation(payload) {
  const { data } = await client.post('/local-explanation', payload)
  return data
}

/**
 * Validates newly generated content (questions / explanations) before storing.
 *
 * @param {Object} payload
 * @param {string} payload.contentType   - 'question' | 'explanation'
 * @param {Object} payload.content       - The content object to validate
 * @returns {Promise<Object>} ValidationResult
 */
export async function validateContent(payload) {
  const { data } = await client.post('/validate-content', payload)
  return data
}

const FALLBACK_CATALOG = {
  "total_pages": 5000,
  "classes": [
    {
      "class_slug": "class-12",
      "class_label": "Class XII",
      "total_pages": 2000,
      "subject_count": 10,
      "subjects": [
        {
          "subject_slug": "biology",
          "subject_label": "Biology",
          "total_pages": 200,
          "document_count": 1,
          "chapter_count": 10,
          "documents": [
            {
              "document_title": "Biology Textbook XII",
              "document_kind": "textbook"
            }
          ]
        },
        {
          "subject_slug": "chemistry",
          "subject_label": "Chemistry",
          "total_pages": 200,
          "document_count": 2,
          "chapter_count": 10,
          "documents": [
            {
              "document_title": "Chemistry Textbook Part - 1 XII",
              "document_kind": "textbook"
            },
            {
              "document_title": "Chemistry Textbook Part - 2 XII",
              "document_kind": "textbook"
            }
          ]
        },
        {
          "subject_slug": "computer-science",
          "subject_label": "Computer Science",
          "total_pages": 200,
          "document_count": 1,
          "chapter_count": 10,
          "documents": [
            {
              "document_title": "Computer Science Textbook XII",
              "document_kind": "textbook"
            }
          ]
        },
        {
          "subject_slug": "electronics",
          "subject_label": "Electronics",
          "total_pages": 200,
          "document_count": 1,
          "chapter_count": 10,
          "documents": [
            {
              "document_title": "Electronics Textbook XII",
              "document_kind": "textbook"
            }
          ]
        },
        {
          "subject_slug": "english",
          "subject_label": "English",
          "total_pages": 200,
          "document_count": 2,
          "chapter_count": 10,
          "documents": [
            {
              "document_title": "English Textbook XII",
              "document_kind": "textbook"
            },
            {
              "document_title": "English Workbook XII",
              "document_kind": "workbook"
            }
          ]
        },
        {
          "subject_slug": "hindi",
          "subject_label": "Hindi",
          "total_pages": 200,
          "document_count": 2,
          "chapter_count": 10,
          "documents": [
            {
              "document_title": "Hindi Textbook XII",
              "document_kind": "textbook"
            },
            {
              "document_title": "Hindi Workbook XII",
              "document_kind": "workbook"
            }
          ]
        },
        {
          "subject_slug": "kannada",
          "subject_label": "Kannada",
          "total_pages": 200,
          "document_count": 2,
          "chapter_count": 10,
          "documents": [
            {
              "document_title": "Kannada Textbook XII",
              "document_kind": "textbook"
            },
            {
              "document_title": "Kannada Workbook XII",
              "document_kind": "workbook"
            }
          ]
        },
        {
          "subject_slug": "mathematics",
          "subject_label": "Mathematics",
          "total_pages": 200,
          "document_count": 2,
          "chapter_count": 10,
          "documents": [
            {
              "document_title": "Maths Textbook Part - 1 XII",
              "document_kind": "textbook"
            },
            {
              "document_title": "Maths Textbook Part - 2 XII",
              "document_kind": "textbook"
            }
          ]
        },
        {
          "subject_slug": "physics",
          "subject_label": "Physics",
          "total_pages": 200,
          "document_count": 2,
          "chapter_count": 10,
          "documents": [
            {
              "document_title": "Physics Textbook Part - 1 XII",
              "document_kind": "textbook"
            },
            {
              "document_title": "Physics Textbook Part - 2 XII",
              "document_kind": "textbook"
            }
          ]
        },
        {
          "subject_slug": "sanskrit",
          "subject_label": "Sanskrit",
          "total_pages": 200,
          "document_count": 1,
          "chapter_count": 10,
          "documents": [
            {
              "document_title": "Sanskrit Textbook XII",
              "document_kind": "textbook"
            }
          ]
        }
      ]
    },
    {
      "class_slug": "class-11",
      "class_label": "Class XI",
      "total_pages": 2000,
      "subject_count": 10,
      "subjects": [
        {
          "subject_slug": "biology",
          "subject_label": "Biology",
          "total_pages": 200,
          "document_count": 1,
          "chapter_count": 10,
          "documents": [
            {
              "document_title": "Biology Textbook XI",
              "document_kind": "textbook"
            }
          ]
        },
        {
          "subject_slug": "chemistry",
          "subject_label": "Chemistry",
          "total_pages": 200,
          "document_count": 2,
          "chapter_count": 10,
          "documents": [
            {
              "document_title": "Chemistry Textbook Part - 1 XI",
              "document_kind": "textbook"
            },
            {
              "document_title": "Chemistry Textbook Part - 2 XI",
              "document_kind": "textbook"
            }
          ]
        },
        {
          "subject_slug": "computer-science",
          "subject_label": "Computer Science",
          "total_pages": 200,
          "document_count": 1,
          "chapter_count": 10,
          "documents": [
            {
              "document_title": "Computer Science Textbook XI",
              "document_kind": "textbook"
            }
          ]
        },
        {
          "subject_slug": "electronics",
          "subject_label": "Electronics",
          "total_pages": 200,
          "document_count": 1,
          "chapter_count": 10,
          "documents": [
            {
              "document_title": "Electronics Textbook XI",
              "document_kind": "textbook"
            }
          ]
        },
        {
          "subject_slug": "english",
          "subject_label": "English",
          "total_pages": 200,
          "document_count": 2,
          "chapter_count": 10,
          "documents": [
            {
              "document_title": "English Textbook XI",
              "document_kind": "textbook"
            },
            {
              "document_title": "English Workbook XI",
              "document_kind": "workbook"
            }
          ]
        },
        {
          "subject_slug": "hindi",
          "subject_label": "Hindi",
          "total_pages": 200,
          "document_count": 2,
          "chapter_count": 10,
          "documents": [
            {
              "document_title": "Hindi Textbook XI",
              "document_kind": "textbook"
            },
            {
              "document_title": "Hindi Workbook XI",
              "document_kind": "workbook"
            }
          ]
        },
        {
          "subject_slug": "kannada",
          "subject_label": "Kannada",
          "total_pages": 200,
          "document_count": 1,
          "chapter_count": 10,
          "documents": [
            {
              "document_title": "Kannada Textbook XI",
              "document_kind": "textbook"
            }
          ]
        },
        {
          "subject_slug": "mathematics",
          "subject_label": "Mathematics",
          "total_pages": 200,
          "document_count": 1,
          "chapter_count": 10,
          "documents": [
            {
              "document_title": "Mathematics Textbook XI",
              "document_kind": "textbook"
            }
          ]
        },
        {
          "subject_slug": "physics",
          "subject_label": "Physics",
          "total_pages": 200,
          "document_count": 2,
          "chapter_count": 10,
          "documents": [
            {
              "document_title": "Physics Textbook Part - 1 XI",
              "document_kind": "textbook"
            },
            {
              "document_title": "Physics Textbook Part - 2 XI",
              "document_kind": "textbook"
            }
          ]
        },
        {
          "subject_slug": "sanskrit",
          "subject_label": "Sanskrit",
          "total_pages": 200,
          "document_count": 1,
          "chapter_count": 10,
          "documents": [
            {
              "document_title": "Sanskrit Textbook XI",
              "document_kind": "textbook"
            }
          ]
        }
      ]
    },
    {
      "class_slug": "class-10",
      "class_label": "Class X",
      "total_pages": 1400,
      "subject_count": 7,
      "subjects": [
        {
          "subject_slug": "english",
          "subject_label": "English",
          "total_pages": 200,
          "document_count": 2,
          "chapter_count": 10,
          "documents": [
            {
              "document_title": "English Textbook 1",
              "document_kind": "textbook"
            },
            {
              "document_title": "English Textbook 2",
              "document_kind": "textbook"
            }
          ]
        },
        {
          "subject_slug": "kannada",
          "subject_label": "Kannada",
          "total_pages": 200,
          "document_count": 1,
          "chapter_count": 10,
          "documents": [
            {
              "document_title": "Kannada Textbook",
              "document_kind": "textbook"
            }
          ]
        },
        {
          "subject_slug": "mathematics",
          "subject_label": "Mathematics",
          "total_pages": 200,
          "document_count": 2,
          "chapter_count": 10,
          "documents": [
            {
              "document_title": "Maths Textbook 1",
              "document_kind": "textbook"
            },
            {
              "document_title": "Maths Textbook 2",
              "document_kind": "textbook"
            }
          ]
        },
        {
          "subject_slug": "physical-education",
          "subject_label": "Physical Education",
          "total_pages": 200,
          "document_count": 1,
          "chapter_count": 10,
          "documents": [
            {
              "document_title": "Physical Education Textbook",
              "document_kind": "textbook"
            }
          ]
        },
        {
          "subject_slug": "sanskrit",
          "subject_label": "Sanskrit",
          "total_pages": 200,
          "document_count": 1,
          "chapter_count": 10,
          "documents": [
            {
              "document_title": "Sanskrit Textbook",
              "document_kind": "textbook"
            }
          ]
        },
        {
          "subject_slug": "science",
          "subject_label": "Science",
          "total_pages": 200,
          "document_count": 2,
          "chapter_count": 10,
          "documents": [
            {
              "document_title": "Science Textbook 1",
              "document_kind": "textbook"
            },
            {
              "document_title": "Science Textbook 2",
              "document_kind": "textbook"
            }
          ]
        },
        {
          "subject_slug": "social-science",
          "subject_label": "Social Science",
          "total_pages": 200,
          "document_count": 2,
          "chapter_count": 10,
          "documents": [
            {
              "document_title": "Social Science Textbook 1",
              "document_kind": "textbook"
            },
            {
              "document_title": "Social Science Textbook 2",
              "document_kind": "textbook"
            }
          ]
        }
      ]
    },
    {
      "class_slug": "class-09",
      "class_label": "Class IX",
      "total_pages": 1400,
      "subject_count": 7,
      "subjects": [
        {
          "subject_slug": "english",
          "subject_label": "English",
          "total_pages": 200,
          "document_count": 1,
          "chapter_count": 10,
          "documents": [
            {
              "document_title": "English Textbook",
              "document_kind": "textbook"
            }
          ]
        },
        {
          "subject_slug": "hindi",
          "subject_label": "Hindi",
          "total_pages": 200,
          "document_count": 1,
          "chapter_count": 10,
          "documents": [
            {
              "document_title": "Hindi Textbook",
              "document_kind": "textbook"
            }
          ]
        },
        {
          "subject_slug": "kannada",
          "subject_label": "Kannada",
          "total_pages": 200,
          "document_count": 1,
          "chapter_count": 10,
          "documents": [
            {
              "document_title": "Kannada Textbook",
              "document_kind": "textbook"
            }
          ]
        },
        {
          "subject_slug": "mathematics",
          "subject_label": "Mathematics",
          "total_pages": 200,
          "document_count": 2,
          "chapter_count": 10,
          "documents": [
            {
              "document_title": "Maths Textbook 1",
              "document_kind": "textbook"
            },
            {
              "document_title": "Maths Textbook 2",
              "document_kind": "textbook"
            }
          ]
        },
        {
          "subject_slug": "sanskrit",
          "subject_label": "Sanskrit",
          "total_pages": 200,
          "document_count": 1,
          "chapter_count": 10,
          "documents": [
            {
              "document_title": "Sanskrit Textbook",
              "document_kind": "textbook"
            }
          ]
        },
        {
          "subject_slug": "science",
          "subject_label": "Science",
          "total_pages": 200,
          "document_count": 1,
          "chapter_count": 10,
          "documents": [
            {
              "document_title": "Science Textbook",
              "document_kind": "textbook"
            }
          ]
        },
        {
          "subject_slug": "social-science",
          "subject_label": "Social Science",
          "total_pages": 200,
          "document_count": 2,
          "chapter_count": 10,
          "documents": [
            {
              "document_title": "Social Science Textbook 1",
              "document_kind": "textbook"
            },
            {
              "document_title": "Social Science Textbook 2",
              "document_kind": "textbook"
            }
          ]
        }
      ]
    },
    {
      "class_slug": "class-08",
      "class_label": "Class VIII",
      "total_pages": 1400,
      "subject_count": 7,
      "subjects": [
        {
          "subject_slug": "english",
          "subject_label": "English",
          "total_pages": 200,
          "document_count": 1,
          "chapter_count": 10,
          "documents": [
            {
              "document_title": "English Textbook",
              "document_kind": "textbook"
            }
          ]
        },
        {
          "subject_slug": "hindi",
          "subject_label": "Hindi",
          "total_pages": 200,
          "document_count": 1,
          "chapter_count": 10,
          "documents": [
            {
              "document_title": "Hindi Textbook",
              "document_kind": "textbook"
            }
          ]
        },
        {
          "subject_slug": "kannada",
          "subject_label": "Kannada",
          "total_pages": 200,
          "document_count": 1,
          "chapter_count": 10,
          "documents": [
            {
              "document_title": "Kannada Textbook",
              "document_kind": "textbook"
            }
          ]
        },
        {
          "subject_slug": "mathematics",
          "subject_label": "Mathematics",
          "total_pages": 200,
          "document_count": 2,
          "chapter_count": 10,
          "documents": [
            {
              "document_title": "Maths Textbook 1",
              "document_kind": "textbook"
            },
            {
              "document_title": "Maths Textbook 2",
              "document_kind": "textbook"
            }
          ]
        },
        {
          "subject_slug": "sanskrit",
          "subject_label": "Sanskrit",
          "total_pages": 200,
          "document_count": 1,
          "chapter_count": 10,
          "documents": [
            {
              "document_title": "Sanskrit Textbook",
              "document_kind": "textbook"
            }
          ]
        },
        {
          "subject_slug": "science",
          "subject_label": "Science",
          "total_pages": 200,
          "document_count": 2,
          "chapter_count": 10,
          "documents": [
            {
              "document_title": "Science Textbook 1",
              "document_kind": "textbook"
            },
            {
              "document_title": "Science Textbook 2",
              "document_kind": "textbook"
            }
          ]
        },
        {
          "subject_slug": "social-science",
          "subject_label": "Social Science",
          "total_pages": 200,
          "document_count": 1,
          "chapter_count": 10,
          "documents": [
            {
              "document_title": "Social Science Textbook",
              "document_kind": "textbook"
            }
          ]
        }
      ]
    },
    {
      "class_slug": "class-07",
      "class_label": "Class VII",
      "total_pages": 1400,
      "subject_count": 7,
      "subjects": [
        {
          "subject_slug": "english",
          "subject_label": "English",
          "total_pages": 200,
          "document_count": 1,
          "chapter_count": 10,
          "documents": [
            {
              "document_title": "English Textbook",
              "document_kind": "textbook"
            }
          ]
        },
        {
          "subject_slug": "hindi",
          "subject_label": "Hindi",
          "total_pages": 200,
          "document_count": 1,
          "chapter_count": 10,
          "documents": [
            {
              "document_title": "Hindi Textbook",
              "document_kind": "textbook"
            }
          ]
        },
        {
          "subject_slug": "kannada",
          "subject_label": "Kannada",
          "total_pages": 200,
          "document_count": 3,
          "chapter_count": 10,
          "documents": [
            {
              "document_title": "Kannada Textbook 1",
              "document_kind": "textbook"
            },
            {
              "document_title": "Kannada Textbook 2",
              "document_kind": "textbook"
            },
            {
              "document_title": "Kannada Textbook 3",
              "document_kind": "textbook"
            }
          ]
        },
        {
          "subject_slug": "mathematics",
          "subject_label": "Mathematics",
          "total_pages": 200,
          "document_count": 2,
          "chapter_count": 10,
          "documents": [
            {
              "document_title": "Maths Textbook 1",
              "document_kind": "textbook"
            },
            {
              "document_title": "Maths Textbook 2",
              "document_kind": "textbook"
            }
          ]
        },
        {
          "subject_slug": "sanskrit",
          "subject_label": "Sanskrit",
          "total_pages": 200,
          "document_count": 1,
          "chapter_count": 10,
          "documents": [
            {
              "document_title": "Sanskrit Textbook",
              "document_kind": "textbook"
            }
          ]
        },
        {
          "subject_slug": "science",
          "subject_label": "Science",
          "total_pages": 200,
          "document_count": 1,
          "chapter_count": 10,
          "documents": [
            {
              "document_title": "Science Textbook",
              "document_kind": "textbook"
            }
          ]
        },
        {
          "subject_slug": "social-science",
          "subject_label": "Social Science",
          "total_pages": 200,
          "document_count": 2,
          "chapter_count": 10,
          "documents": [
            {
              "document_title": "Social Science Textbook 1",
              "document_kind": "textbook"
            },
            {
              "document_title": "Social Science Textbook 2",
              "document_kind": "textbook"
            }
          ]
        }
      ]
    },
    {
      "class_slug": "class-06",
      "class_label": "Class VI",
      "total_pages": 1400,
      "subject_count": 7,
      "subjects": [
        {
          "subject_slug": "english",
          "subject_label": "English",
          "total_pages": 200,
          "document_count": 1,
          "chapter_count": 10,
          "documents": [
            {
              "document_title": "English Textbook",
              "document_kind": "textbook"
            }
          ]
        },
        {
          "subject_slug": "hindi",
          "subject_label": "Hindi",
          "total_pages": 200,
          "document_count": 1,
          "chapter_count": 10,
          "documents": [
            {
              "document_title": "Hindi Textbook",
              "document_kind": "textbook"
            }
          ]
        },
        {
          "subject_slug": "kannada",
          "subject_label": "Kannada",
          "total_pages": 200,
          "document_count": 3,
          "chapter_count": 10,
          "documents": [
            {
              "document_title": "Kannada Textbook 1",
              "document_kind": "textbook"
            },
            {
              "document_title": "Kannada Textbook 2",
              "document_kind": "textbook"
            },
            {
              "document_title": "Kannada Textbook 3",
              "document_kind": "textbook"
            }
          ]
        },
        {
          "subject_slug": "mathematics",
          "subject_label": "Mathematics",
          "total_pages": 200,
          "document_count": 2,
          "chapter_count": 10,
          "documents": [
            {
              "document_title": "Maths Textbook 1",
              "document_kind": "textbook"
            },
            {
              "document_title": "Maths Textbook 2",
              "document_kind": "textbook"
            }
          ]
        },
        {
          "subject_slug": "sanskrit",
          "subject_label": "Sanskrit",
          "total_pages": 200,
          "document_count": 1,
          "chapter_count": 10,
          "documents": [
            {
              "document_title": "Sanskrit Textbook",
              "document_kind": "textbook"
            }
          ]
        },
        {
          "subject_slug": "science",
          "subject_label": "Science",
          "total_pages": 200,
          "document_count": 1,
          "chapter_count": 10,
          "documents": [
            {
              "document_title": "Science Textbook",
              "document_kind": "textbook"
            }
          ]
        },
        {
          "subject_slug": "social-science",
          "subject_label": "Social Science",
          "total_pages": 200,
          "document_count": 2,
          "chapter_count": 10,
          "documents": [
            {
              "document_title": "Social Science Textbook 1",
              "document_kind": "textbook"
            },
            {
              "document_title": "Social Science Textbook 2",
              "document_kind": "textbook"
            }
          ]
        }
      ]
    },
    {
      "class_slug": "class-05",
      "class_label": "Class V",
      "total_pages": 1000,
      "subject_count": 5,
      "subjects": [
        {
          "subject_slug": "english",
          "subject_label": "English",
          "total_pages": 200,
          "document_count": 1,
          "chapter_count": 10,
          "documents": [
            {
              "document_title": "English Textbook",
              "document_kind": "textbook"
            }
          ]
        },
        {
          "subject_slug": "evs",
          "subject_label": "EVS",
          "total_pages": 200,
          "document_count": 1,
          "chapter_count": 10,
          "documents": [
            {
              "document_title": "EVS Textbook",
              "document_kind": "textbook"
            }
          ]
        },
        {
          "subject_slug": "hindi",
          "subject_label": "Hindi",
          "total_pages": 200,
          "document_count": 1,
          "chapter_count": 10,
          "documents": [
            {
              "document_title": "Hindi Textbook",
              "document_kind": "textbook"
            }
          ]
        },
        {
          "subject_slug": "kannada",
          "subject_label": "Kannada",
          "total_pages": 200,
          "document_count": 2,
          "chapter_count": 10,
          "documents": [
            {
              "document_title": "Kannada Textbook 1",
              "document_kind": "textbook"
            },
            {
              "document_title": "Kannada Textbook 2",
              "document_kind": "textbook"
            }
          ]
        },
        {
          "subject_slug": "mathematics",
          "subject_label": "Mathematics",
          "total_pages": 200,
          "document_count": 2,
          "chapter_count": 10,
          "documents": [
            {
              "document_title": "Maths Textbook 1",
              "document_kind": "textbook"
            },
            {
              "document_title": "Maths Textbook 2",
              "document_kind": "textbook"
            }
          ]
        }
      ]
    },
    {
      "class_slug": "class-04",
      "class_label": "Class IV",
      "total_pages": 1000,
      "subject_count": 5,
      "subjects": [
        {
          "subject_slug": "english",
          "subject_label": "English",
          "total_pages": 200,
          "document_count": 1,
          "chapter_count": 10,
          "documents": [
            {
              "document_title": "English Textbook",
              "document_kind": "textbook"
            }
          ]
        },
        {
          "subject_slug": "evs",
          "subject_label": "EVS",
          "total_pages": 200,
          "document_count": 1,
          "chapter_count": 10,
          "documents": [
            {
              "document_title": "EVS Textbook",
              "document_kind": "textbook"
            }
          ]
        },
        {
          "subject_slug": "hindi",
          "subject_label": "Hindi",
          "total_pages": 200,
          "document_count": 1,
          "chapter_count": 10,
          "documents": [
            {
              "document_title": "Hindi Textbook",
              "document_kind": "textbook"
            }
          ]
        },
        {
          "subject_slug": "kannada",
          "subject_label": "Kannada",
          "total_pages": 200,
          "document_count": 2,
          "chapter_count": 10,
          "documents": [
            {
              "document_title": "Kannada Textbook 1",
              "document_kind": "textbook"
            },
            {
              "document_title": "Kannada Textbook 2",
              "document_kind": "textbook"
            }
          ]
        },
        {
          "subject_slug": "mathematics",
          "subject_label": "Mathematics",
          "total_pages": 200,
          "document_count": 2,
          "chapter_count": 10,
          "documents": [
            {
              "document_title": "Maths Textbook 1",
              "document_kind": "textbook"
            },
            {
              "document_title": "Maths Textbook 2",
              "document_kind": "textbook"
            }
          ]
        }
      ]
    },
    {
      "class_slug": "class-03",
      "class_label": "Class III",
      "total_pages": 1000,
      "subject_count": 5,
      "subjects": [
        {
          "subject_slug": "english",
          "subject_label": "English",
          "total_pages": 200,
          "document_count": 1,
          "chapter_count": 10,
          "documents": [
            {
              "document_title": "English Textbook",
              "document_kind": "textbook"
            }
          ]
        },
        {
          "subject_slug": "evs",
          "subject_label": "EVS",
          "total_pages": 200,
          "document_count": 1,
          "chapter_count": 10,
          "documents": [
            {
              "document_title": "EVS Textbook",
              "document_kind": "textbook"
            }
          ]
        },
        {
          "subject_slug": "hindi",
          "subject_label": "Hindi",
          "total_pages": 200,
          "document_count": 1,
          "chapter_count": 10,
          "documents": [
            {
              "document_title": "Hindi Textbook",
              "document_kind": "textbook"
            }
          ]
        },
        {
          "subject_slug": "kannada",
          "subject_label": "Kannada",
          "total_pages": 200,
          "document_count": 3,
          "chapter_count": 10,
          "documents": [
            {
              "document_title": "Kannada Textbook 1",
              "document_kind": "textbook"
            },
            {
              "document_title": "Kannada Textbook 2",
              "document_kind": "textbook"
            },
            {
              "document_title": "Kannada Textbook 3",
              "document_kind": "textbook"
            }
          ]
        },
        {
          "subject_slug": "mathematics",
          "subject_label": "Mathematics",
          "total_pages": 200,
          "document_count": 2,
          "chapter_count": 10,
          "documents": [
            {
              "document_title": "Maths Textbook 1",
              "document_kind": "textbook"
            },
            {
              "document_title": "Maths Textbook 2",
              "document_kind": "textbook"
            }
          ]
        }
      ]
    },
    {
      "class_slug": "class-02",
      "class_label": "Class II",
      "total_pages": 1000,
      "subject_count": 5,
      "subjects": [
        {
          "subject_slug": "english",
          "subject_label": "English",
          "total_pages": 200,
          "document_count": 1,
          "chapter_count": 10,
          "documents": [
            {
              "document_title": "English Textbook",
              "document_kind": "textbook"
            }
          ]
        },
        {
          "subject_slug": "evs",
          "subject_label": "EVS",
          "total_pages": 200,
          "document_count": 1,
          "chapter_count": 10,
          "documents": [
            {
              "document_title": "EVS Textbook",
              "document_kind": "textbook"
            }
          ]
        },
        {
          "subject_slug": "hindi",
          "subject_label": "Hindi",
          "total_pages": 200,
          "document_count": 1,
          "chapter_count": 10,
          "documents": [
            {
              "document_title": "Hindi Textbook",
              "document_kind": "textbook"
            }
          ]
        },
        {
          "subject_slug": "kannada",
          "subject_label": "Kannada",
          "total_pages": 200,
          "document_count": 3,
          "chapter_count": 10,
          "documents": [
            {
              "document_title": "Kannada Textbook 1",
              "document_kind": "textbook"
            },
            {
              "document_title": "Kannada Textbook 2",
              "document_kind": "textbook"
            },
            {
              "document_title": "Kannada Textbook 3",
              "document_kind": "textbook"
            }
          ]
        },
        {
          "subject_slug": "mathematics",
          "subject_label": "Mathematics",
          "total_pages": 200,
          "document_count": 1,
          "chapter_count": 10,
          "documents": [
            {
              "document_title": "Maths Textbook",
              "document_kind": "textbook"
            }
          ]
        }
      ]
    },
    {
      "class_slug": "class-01",
      "class_label": "Class I",
      "total_pages": 800,
      "subject_count": 4,
      "subjects": [
        {
          "subject_slug": "english",
          "subject_label": "English",
          "total_pages": 200,
          "document_count": 1,
          "chapter_count": 10,
          "documents": [
            {
              "document_title": "English Textbook",
              "document_kind": "textbook"
            }
          ]
        },
        {
          "subject_slug": "evs",
          "subject_label": "EVS",
          "total_pages": 200,
          "document_count": 1,
          "chapter_count": 10,
          "documents": [
            {
              "document_title": "EVS Textbook",
              "document_kind": "textbook"
            }
          ]
        },
        {
          "subject_slug": "kannada",
          "subject_label": "Kannada",
          "total_pages": 200,
          "document_count": 3,
          "chapter_count": 10,
          "documents": [
            {
              "document_title": "Kannada Textbook 1",
              "document_kind": "textbook"
            },
            {
              "document_title": "Kannada Textbook 2",
              "document_kind": "textbook"
            },
            {
              "document_title": "Kannada Textbook 3",
              "document_kind": "textbook"
            }
          ]
        },
        {
          "subject_slug": "mathematics",
          "subject_label": "Mathematics",
          "total_pages": 200,
          "document_count": 1,
          "chapter_count": 10,
          "documents": [
            {
              "document_title": "Maths Textbook",
              "document_kind": "textbook"
            }
          ]
        }
      ]
    }
  ]
}

export async function getSyllabusCatalog(boardId = 'state') {
  return getBoardSyllabusCatalog(boardId)
}

export async function getSyllabusClass(classSlug, boardId = 'state') {
  const foundClass = getBoardSyllabusClass(classSlug, boardId)
  if (!foundClass) throw new Error(`Class "${classSlug}" not found`)
  return foundClass
}

export async function getSyllabusSubject(classSlug, subjectSlug, boardId = 'state') {
  const foundClass = getBoardSyllabusClass(classSlug, boardId)
  if (!foundClass) throw new Error(`Class "${classSlug}" not found`)
  const foundSubject = getBoardSyllabusSubject(classSlug, subjectSlug, boardId)
  if (!foundSubject) throw new Error(`Subject "${subjectSlug}" not found in ${classSlug}`)
  return foundSubject
}

export async function getSyllabusDocument(documentId) {
  // Documents are embedded in subjects; scan all classes/subjects for a match
  for (const cls of FALLBACK_CATALOG.classes) {
    for (const subj of cls.subjects) {
      const doc = subj.documents?.find(d => d.document_id === documentId)
      if (doc) return doc
    }
  }
  throw new Error(`Document "${documentId}" not found`)
}

export async function searchSyllabus(query, limit = 20) {
  const q = (query ?? '').toLowerCase().trim()
  if (!q) return { results: [] }

  const results = []
  for (const cls of FALLBACK_CATALOG.classes) {
    if (results.length >= limit) break
    for (const subj of cls.subjects) {
      if (results.length >= limit) break
      if (
        subj.subject_label.toLowerCase().includes(q) ||
        subj.subject_slug.includes(q) ||
        cls.class_label.toLowerCase().includes(q)
      ) {
        results.push({
          class_slug: cls.class_slug,
          class_label: cls.class_label,
          subject_slug: subj.subject_slug,
          subject_label: subj.subject_label,
        })
      }
    }
  }
  return { results }
}

export default client
