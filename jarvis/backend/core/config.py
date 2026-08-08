"""
Central configuration for JARVIS.

All configuration is read from environment variables (optionally loaded from
a local `.env` file). Nothing sensitive is ever hard-coded — see
`.env.example` at the project root for the full list of supported variables.
"""
from __future__ import annotations

from functools import lru_cache
from typing import Literal

from pydantic_settings import BaseSettings, SettingsConfigDict


class Settings(BaseSettings):
    """Runtime settings for the JARVIS backend.

    Values are resolved in this order: real environment variables first,
    then a `.env` file (if present), then the defaults below.
    """

    model_config = SettingsConfigDict(
        env_file=".env",
        env_file_encoding="utf-8",
        extra="ignore",
    )

    # --- General ---
    app_name: str = "JARVIS"
    environment: Literal["development", "production"] = "development"
    cors_origins: str = "http://localhost:5173,http://127.0.0.1:5173"

    # --- AI provider (pluggable) ---
    # "mock" requires no API key and is used as a safe offline fallback so the
    # app is always runnable, even before a real provider is configured.
    ai_provider: Literal["mock", "openai", "anthropic"] = "mock"
    ai_model: str = ""  # empty => provider-specific default

    openai_api_key: str = ""
    anthropic_api_key: str = ""

    # --- Agent behaviour ---
    system_persona: str = (
        "You are JARVIS, a concise, capable personal AI assistant. "
        "You speak plainly, avoid filler, and never claim to have taken an "
        "action you did not actually perform."
    )
    max_history_messages: int = 20

    @property
    def cors_origin_list(self) -> list[str]:
        return [origin.strip() for origin in self.cors_origins.split(",") if origin.strip()]


@lru_cache
def get_settings() -> Settings:
    """Return a cached Settings instance (settings are effectively read-only)."""
    return Settings()
