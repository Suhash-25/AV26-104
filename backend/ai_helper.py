"""
ai_helper.py — Unified AI generation helper using Groq (primary).

Get a free Groq API key at: https://console.groq.com/keys
Set GROQ_API_KEY in backend/.env
"""

import os
from typing import Optional


def _local_tutor_fallback(prompt: str) -> str:
    """Small fallback so the chat UI never goes silent when hosted AI fails."""
    user_message = prompt
    marker = "User message:"
    if marker in prompt:
        user_message = prompt.split(marker, 1)[1].strip()
    elif "Student:" in prompt:
        user_message = prompt.rsplit("Student:", 1)[1].strip()

    user_message = user_message.split("\n\n", 1)[0].strip()
    lower_message = user_message.lower()

    if any(word in lower_message for word in ("hi", "hello", "hey")) and len(lower_message.split()) <= 4:
        return "Hi! I can help with explanations, homework practice, revision plans, and doubts. What subject are you studying today?"

    return (
        "I can help with that. The live AI provider is unavailable right now, so here is a quick study approach:\n\n"
        f"1. Topic: {user_message or 'your question'}\n"
        "2. Break it into the main idea, key terms, and one example.\n"
        "3. Try explaining it in your own words, then ask me a more specific doubt and I will guide you step by step.\n\n"
        "For full AI answers, check the backend terminal for the Groq error and restart the backend after fixing it."
    )


def _try_groq(prompt: str, model: str) -> Optional[str]:
    """Attempt Groq generation. Returns text or None on failure."""
    groq_key = os.environ.get("GROQ_API_KEY", "").strip()
    if not groq_key:
        return None
    try:
        from groq import Groq
        client = Groq(api_key=groq_key)
        completion = client.chat.completions.create(
            model=model,
            messages=[{"role": "user", "content": prompt}],
            temperature=0.7,
            max_tokens=1024,
        )
        return completion.choices[0].message.content
    except Exception as e:
        print(f"[ai_helper] Groq error ({model}): {str(e)[:120]}")
        return None


def generate_text(prompt: str) -> tuple[str, str]:
    """
    Generate text using Groq.
    Returns (response_text, provider_name).
    Raises RuntimeError if all models fail.
    """
    groq_models = [
        os.environ.get("GROQ_MODEL", "").strip(),
        "openai/gpt-oss-20b",
        "openai/gpt-oss-120b",
        "groq/compound-mini",
    ]
    for model in groq_models:
        if not model:
            continue
        result = _try_groq(prompt, model)
        if result:
            return result, f"groq/{model}"

    return _local_tutor_fallback(prompt), "local/fallback"


async def generate_text_async(prompt: str) -> tuple[str, str]:
    """Async wrapper around generate_text (runs in thread pool)."""
    import asyncio
    loop = asyncio.get_event_loop()
    return await loop.run_in_executor(None, generate_text, prompt)
