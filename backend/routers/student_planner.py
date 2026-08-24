import json
import os
import io
import re
from PyPDF2 import PdfReader
from fastapi import APIRouter, Depends, UploadFile, File, HTTPException
from pydantic import BaseModel
from db import PostgresDB
from routers.auth import get_current_user
from typing import Optional, List

router = APIRouter(prefix="/api/student", tags=["Student Planner"])

# NOTE: No module-level AI client — we use ai_helper which handles
# Google Gemini → Groq fallback automatically.

class PlanRequest(BaseModel):
    student_id: str
    resume_text: str = ""
    study_goal: str = ""
    class_level: str = ""
    subject: str = ""

class ProgressUpdateRequest(BaseModel):
    student_id: str
    day: str
    task: str
    completed: bool

class AiAssistantRequest(BaseModel):
    student_id: str
    message: str

STORE_PATH = os.path.join(os.path.dirname(os.path.dirname(__file__)), "planner_store.json")

def _load_store() -> dict:
    if not os.path.exists(STORE_PATH):
        return {"plans": {}, "progress": {}, "notifications": {}}
    try:
        with open(STORE_PATH, "r", encoding="utf-8") as f:
            data = json.load(f)
        data.setdefault("plans", {})
        data.setdefault("progress", {})
        data.setdefault("notifications", {})
        return data
    except Exception:
        return {"plans": {}, "progress": {}, "notifications": {}}

def _save_store(data: dict) -> None:
    with open(STORE_PATH, "w", encoding="utf-8") as f:
        json.dump(data, f, indent=2)

def _db_available() -> bool:
    return PostgresDB.pool is not None

def _strip_json_markdown(text: str) -> str:
    text = (text or "").strip()
    if text.startswith("```json"):
        text = text[7:]
    if text.startswith("```"):
        text = text[3:]
    if text.endswith("```"):
        text = text[:-3]
    text = text.strip()
    match = re.search(r"\{.*\}", text, re.DOTALL)
    return match.group(0) if match else text

def _fallback_plan(req: PlanRequest) -> dict:
    subject = (req.subject or "your subject").strip()
    class_level = (req.class_level or "your class").strip()
    goal = (req.study_goal or req.resume_text or f"Learn {subject} for {class_level}").strip()
    focus = subject if subject != "your subject" else goal[:80]
    days = [
        ("Foundation", "List key chapters, terms, and exam expectations"),
        ("Core Concepts", "Study the most important concepts with examples"),
        ("Diagrams and Processes", "Draw, label, and explain important diagrams or flows"),
        ("NCERT/Textbook Practice", "Solve textbook questions and mark weak areas"),
        ("Application Questions", "Practice reasoning, case-based, and assertion questions"),
        ("Revision", "Make short notes and revise weak topics"),
        ("Mock Test", "Take a timed test and review mistakes"),
    ]
    return {
        "title": f"7-day plan for {focus}",
        "week_plan": [
            {
                "day": f"Day {idx}",
                "goal": f"{label}: {goal}",
                "tasks": [
                    task,
                    f"Spend 30 minutes learning {focus} with notes",
                    "Write 5 recall questions and answer them without looking",
                ],
                "time_estimate": "60-90 minutes",
                "search_query": f"{class_level} {subject} {label} study guide".strip(),
                "resources": [],
                "progress": {},
            }
            for idx, (label, task) in enumerate(days, start=1)
        ],
    }

async def _save_plan(student_id: str, plan_data: dict) -> None:
    if _db_available():
        async with PostgresDB.pool.acquire() as conn:
            existing = await conn.fetchval("SELECT id FROM student_plans WHERE student_id = $1", student_id)
            if existing:
                await conn.execute("UPDATE student_plans SET plan_json = $1 WHERE student_id = $2", json.dumps(plan_data), student_id)
                await conn.execute("DELETE FROM student_progress WHERE student_id = $1", student_id)
            else:
                await conn.execute("INSERT INTO student_plans (student_id, plan_json) VALUES ($1, $2)", student_id, json.dumps(plan_data))

            for daily_plan in plan_data.get("week_plan", []):
                day = daily_plan.get("day")
                for task in daily_plan.get("tasks", []):
                    await conn.execute(
                        "INSERT INTO student_progress (student_id, day, task, completed) VALUES ($1, $2, $3, False)",
                        student_id, day, task
                    )
        return

    store = _load_store()
    store["plans"][student_id] = plan_data
    store["progress"][student_id] = {}
    for daily_plan in plan_data.get("week_plan", []):
        day = daily_plan.get("day")
        store["progress"][student_id].setdefault(day, {})
        for task in daily_plan.get("tasks", []):
            store["progress"][student_id][day][task] = False
    _save_store(store)

async def _get_plan(student_id: str) -> dict | None:
    if _db_available():
        async with PostgresDB.pool.acquire() as conn:
            row = await conn.fetchrow("SELECT plan_json FROM student_plans WHERE student_id = $1", student_id)
            if not row:
                return None
            plan_data = json.loads(row["plan_json"])
            progress_rows = await conn.fetch(
                "SELECT day, task, completed FROM student_progress WHERE student_id = $1", student_id
            )
            progress_map = {}
            for r in progress_rows:
                progress_map.setdefault(r["day"], {})[r["task"]] = r["completed"]
            for dp in plan_data.get("week_plan", []):
                dp["progress"] = progress_map.get(dp["day"], {})
            return plan_data

    store = _load_store()
    plan_data = store["plans"].get(student_id)
    if not plan_data:
        return None
    progress_map = store["progress"].get(student_id, {})
    for dp in plan_data.get("week_plan", []):
        dp["progress"] = progress_map.get(dp.get("day"), {})
    return plan_data

async def _update_progress(student_id: str, day: str, task: str, completed: bool) -> None:
    if _db_available():
        async with PostgresDB.pool.acquire() as conn:
            await conn.execute(
                "UPDATE student_progress SET completed = $1 WHERE student_id = $2 AND day = $3 AND task = $4",
                completed, student_id, day, task
            )
        return

    store = _load_store()
    store["progress"].setdefault(student_id, {}).setdefault(day, {})[task] = completed
    _save_store(store)

@router.post("/upload-resume")
async def upload_resume(file: UploadFile = File(...)):
    if not file.filename.endswith(".pdf"):
        raise HTTPException(status_code=400, detail="Only PDF allowed")
    try:
        content = await file.read()
        reader = PdfReader(io.BytesIO(content))
        text = ""
        for page in reader.pages:
            text += (page.extract_text() or "") + "\n"
        return {"resume_text": text.strip(), "status": "processed"}
    except Exception as e:
        raise HTTPException(status_code=500, detail=f"PDF reading error: {str(e)}")


def scrape_resources(query: str, max_results: int = 3) -> list:
    """Search DuckDuckGo using ddgs API for learning resources."""
    if os.environ.get("ENABLE_RESOURCE_SEARCH", "").strip() != "1":
        return []

    try:
        try:
            from ddgs import DDGS
        except Exception:
            from duckduckgo_search import DDGS
        search_query = query + " tutorial learn"
        results = []
        with DDGS() as ddgs:
            for idx, r in enumerate(ddgs.text(search_query)):
                if idx >= max_results:
                    break
                results.append({
                    "title": r.get('title', ''),
                    "url": r.get('href', '')
                })
        return results
    except Exception as e:
        print(f"Scrape error for '{query}': {e}")
        return []


class RecommendationRequest(BaseModel):
    student_id: str
    topic_breakdown: list
    overall_accuracy: int
    weak_topics: list
    strong_topics: list

@router.post("/ml-recommendations")
async def get_ml_recommendations(req: RecommendationRequest):
    from ai_helper import generate_text_async

    prompt = f"""
Act as an expert personalized learning recommendation engine.
Analyze the following student's performance data and generate EXACTLY 3 highly specific, actionable study recommendations.

Overall Accuracy: {req.overall_accuracy}%
Strong Topics: {req.strong_topics}
Weak Topics: {req.weak_topics}
Topic Breakdown: {req.topic_breakdown}

For each recommendation, provide:
1. "title": A catchy, action-oriented title.
2. "reason": Why you are recommending this based on their exact data.
3. "action": The specific action they should take.
4. "type": "weakness", "strength", or "explore".

Return STRICT JSON format EXACTLY like this (NO Markdown wrappers, no ```json, just JSON):
{{
  "recommendations": [
    {{
      "title": "Master Newton's Laws",
      "reason": "Your accuracy is only 45% in this topic.",
      "action": "Re-read the chapter and take a practice quiz.",
      "type": "weakness"
    }}
  ]
}}
"""
    try:
        text_resp, provider = await generate_text_async(prompt)
        text_resp = text_resp.strip()
        if text_resp.startswith("```"):
            text_resp = text_resp.strip("`").removeprefix("json").strip()
        data = json.loads(text_resp)
        return {"recommendations": data.get("recommendations", [])}
    except Exception as e:
        print("ML Recommendation error:", e)
        return {"recommendations": []}

class EnrichTopicRequest(BaseModel):
    board: str
    classLabel: str
    subject: str
    chapterTitle: str
    topicTitle: str

@router.post("/enrich-topic")
async def enrich_topic(req: EnrichTopicRequest):
    from ai_helper import generate_text_async
    import json
    import re

    prompt = f"""
Act as an expert high school teacher for {req.board} ({req.classLabel}).
You are creating an extremely high-quality, comprehensive learning module for the subject of {req.subject}.
Chapter: {req.chapterTitle}
Topic: {req.topicTitle}

Your goal is to generate:
1. "description": A very detailed, multi-paragraph textbook-style explanation of the topic, using Markdown. It should explain the core concepts, real-world applications, and why it matters.
2. "mcq": Exactly 3 challenging multiple-choice questions testing conceptual understanding.
3. "questions": Exactly 2 subjective analysis questions with hints and expected concepts.
4. "misconceptions": Exactly 2 common misconception traps with probes and corrections.

Return STRICT JSON format EXACTLY matching this structure (no Markdown wrappers around the JSON, just the raw JSON object):
{{
  "description": "...",
  "mcq": [
    {{
      "id": "mcq1",
      "text": "Question text?",
      "options": ["Option A", "Option B", "Option C", "Option D"],
      "correctIndex": 1,
      "explanation": "Why this is correct."
    }}
  ],
  "questions": [
    {{
      "id": "q1",
      "text": "Subjective question?",
      "hint": "Think about...",
      "expectedConcepts": ["concept1", "concept2"],
      "estimatedTime": "5 min"
    }}
  ],
  "misconceptions": [
    {{
      "id": "m1",
      "probe": "Do you think X is Y?",
      "options": ["Yes, because...", "No, actually..."],
      "correctIndex": 1,
      "correction": "The truth is...",
      "detectKeywords": ["wrong word"]
    }}
  ]
}}
"""
    try:
        text_resp, provider = await generate_text_async(prompt)
        text_resp = text_resp.strip()
        if text_resp.startswith("```"):
            text_resp = text_resp.strip("`").removeprefix("json").strip()
        data = json.loads(text_resp)
        return data
    except Exception as e:
        print("Enrich Topic error:", e)
        return {}

@router.post("/generate-plan")
async def generate_plan(req: PlanRequest):
    from ai_helper import generate_text_async

    source_context = req.resume_text or req.study_goal
    if not source_context:
        raise HTTPException(status_code=422, detail="Provide resume_text or study_goal")

    prompt = f"""
Generate a structured 7-day learning plan for this student.
Class level: {req.class_level or "Not specified"}
Subject: {req.subject or "Not specified"}
Study goal: {req.study_goal or "Build a practical study plan from the provided context"}

Include:
- daily goals
- skills to improve
- difficulty level
- estimated time per day
- a short search_query per day (used to find online resources)

Student context: {source_context}

Return STRICT JSON format EXACTLY like this (NO Markdown wrappers, just JSON):
{{
  "title": "...",
  "week_plan": [
    {{
      "day": "Day 1",
      "goal": "...",
      "tasks": ["...", "..."],
      "time_estimate": "2 hours",
      "search_query": "python data structures beginner"
    }}
  ]
}}
"""

    provider = "local/fallback"
    try:
        text_resp, provider = await generate_text_async(prompt)
        print(f"[generate-plan] Served by {provider}")
    except RuntimeError as e:
        text_resp = json.dumps(_fallback_plan(req))

    if provider == "local/fallback":
        plan_data = _fallback_plan(req)
    else:
        # Clean JSON if wrapped in markdown
        text_resp = _strip_json_markdown(text_resp)

        try:
            plan_data = json.loads(text_resp)
        except json.JSONDecodeError as e:
            print(f"AI returned invalid planner JSON, using fallback: {e}")
            plan_data = _fallback_plan(req)

    try:
        # Scrape real resource links for each day using the search_query
        for day_plan in plan_data.get("week_plan", []):
            query = day_plan.get("search_query") or day_plan.get("goal", "")
            resources = scrape_resources(query)
            day_plan["resources"] = resources
            day_plan.setdefault("progress", {})

        await _save_plan(req.student_id, plan_data)

        return {"status": "success", "plan": plan_data}
    except Exception as e:
        raise HTTPException(status_code=500, detail=str(e))

@router.get("/plan/{student_id}")
async def get_plan(student_id: str):
    try:
        return {"plan": await _get_plan(student_id)}
    except Exception as e:
        raise HTTPException(status_code=500, detail=str(e))

@router.post("/update-progress")
async def update_progress(req: ProgressUpdateRequest):
    try:
        await _update_progress(req.student_id, req.day, req.task, req.completed)
        return {"status": "success"}
    except Exception as e:
        raise HTTPException(status_code=500, detail=str(e))

@router.get("/notifications/{student_id}")
async def get_notifications(student_id: str):
    try:
        if _db_available():
            async with PostgresDB.pool.acquire() as conn:
                rows = await conn.fetch(
                    "SELECT id, message, read_status, created_at as timestamp FROM notifications WHERE receiver_id = $1 ORDER BY created_at DESC",
                    student_id
                )
                return {"notifications": [dict(r) for r in rows]}
        store = _load_store()
        return {"notifications": store["notifications"].get(student_id, [])}
    except Exception as e:
        raise HTTPException(status_code=500, detail=str(e))

@router.post("/notifications/read/{notification_id}")
async def mark_notification_read(notification_id: int):
    try:
        if _db_available():
            async with PostgresDB.pool.acquire() as conn:
                await conn.execute("UPDATE notifications SET read_status = True WHERE id = $1", str(notification_id))
                return {"status": "success"}
        store = _load_store()
        for notifications in store["notifications"].values():
            for notification in notifications:
                if str(notification.get("id")) == str(notification_id):
                    notification["read_status"] = True
        _save_store(store)
        return {"status": "success"}
    except Exception as e:
        raise HTTPException(status_code=500, detail=str(e))

@router.get("/notifications-legacy/{student_id}")
async def get_notifications_legacy(student_id: str):
    try:
        if _db_available():
            async with PostgresDB.pool.acquire() as conn:
                rows = await conn.fetch(
                    "SELECT id, message, read_status, created_at as timestamp FROM notifications WHERE receiver_id = $1 ORDER BY created_at DESC",
                    student_id
                )
                return {"notifications": [dict(r) for r in rows]}
        store = _load_store()
        return {"notifications": store["notifications"].get(student_id, [])}
    except Exception as e:
        raise HTTPException(status_code=500, detail=str(e))

@router.post("/notifications/read-legacy/{notification_id}")
async def mark_notification_read_legacy(notification_id: int):
    try:
        if _db_available():
            async with PostgresDB.pool.acquire() as conn:
                await conn.execute("UPDATE notifications SET read_status = True WHERE id = $1", str(notification_id))
                return {"status": "success"}
        return {"status": "success"}
    except Exception as e:
        raise HTTPException(status_code=500, detail=str(e))


@router.post("/ai-assistant")
async def ai_assistant(req: AiAssistantRequest):
    """Study assistant — uses current plan + progress as context. Gemini → Groq fallback."""
    from ai_helper import generate_text_async

    try:
        plan_data = await _get_plan(req.student_id)
        plan_context = json.dumps(plan_data, indent=2) if plan_data else "No active plan."

        prompt = f"""You are a helpful AI study planner and study assistant for a student.
Here is their current weekly study plan and progress:

{plan_context}

The student asks: "{req.message}"

Give a helpful, concise, and encouraging response. If they ask what to do today, look at incomplete tasks and guide them. If they do not have a plan yet, suggest a clear next step and ask what class, subject, and exam goal they want to plan for."""

        response_text, provider = await generate_text_async(prompt)
        print(f"[ai-assistant] Served by {provider}")
        return {"status": "success", "response": response_text}

    except RuntimeError as e:
        return {
            "status": "success",
            "response": "I can help you plan your studies. Tell me your class, subject, exam date, and how much time you can study each day.",
        }
    except Exception as e:
        if isinstance(e, HTTPException):
            raise e
        raise HTTPException(status_code=500, detail=str(e))

@router.get("/notifications-db/{student_id}")
async def get_notifications_db(student_id: str):
    try:
        async with PostgresDB.pool.acquire() as conn:
            rows = await conn.fetch(
                "SELECT id, message, read_status, created_at as timestamp FROM notifications WHERE receiver_id = $1 ORDER BY created_at DESC",
                student_id
            )
            return {"notifications": [dict(r) for r in rows]}
    except Exception as e:
        raise HTTPException(status_code=500, detail=str(e))

@router.post("/notifications/read-db/{notification_id}")
async def mark_notification_read_db(notification_id: int):
    try:
        async with PostgresDB.pool.acquire() as conn:
            await conn.execute("UPDATE notifications SET read_status = True WHERE id = $1", str(notification_id))
            return {"status": "success"}
    except Exception as e:
        raise HTTPException(status_code=500, detail=str(e))
