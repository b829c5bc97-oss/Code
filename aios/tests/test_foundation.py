"""Foundation layer: identifiers, errors, redaction, config, schema."""

from __future__ import annotations

import asyncio
import json

import pytest

from aios.foundation import errors, ids, redaction
from aios.foundation.config import Config
from aios.foundation.errors import Remedy, classify
from aios.tools import schema


class TestIds:
    def test_ids_are_unique_and_sortable(self):
        generated = [ids.new_id("run_") for _ in range(2000)]
        assert len(set(generated)) == 2000
        assert generated == sorted(generated), "ids must sort chronologically"

    def test_ids_are_path_safe(self):
        identifier = ids.new_id("stp_")
        assert "/" not in identifier and " " not in identifier
        assert identifier.startswith("stp_") and len(identifier) == 30

    def test_monotonic_within_one_millisecond(self):
        burst = [ids.new_id() for _ in range(500)]
        assert burst == sorted(burst)


class TestErrorTaxonomy:
    @pytest.mark.parametrize(
        ("raised", "expected", "retryable"),
        [
            (TimeoutError("slow"), errors.ToolTimeout, True),
            (PermissionError("nope"), errors.PermissionDenied, False),
            (ValueError("bad"), errors.InvalidArguments, False),
            (json.JSONDecodeError("x", "y", 0), errors.StructuredOutputError, False),
            (ConnectionResetError(104, "reset"), errors.TransientError, True),
            (RuntimeError("?"), errors.ToolExecutionError, False),
        ],
    )
    def test_classification(self, raised, expected, retryable):
        classified = classify(raised)
        assert isinstance(classified, expected)
        assert classified.retryable is retryable

    def test_classify_is_idempotent(self):
        original = errors.RateLimited("slow down", retry_after=5)
        assert classify(original) is original

    def test_cancellation_is_never_swallowed(self):
        assert isinstance(classify(asyncio.CancelledError()), errors.Cancelled)

    def test_remedies_route_recovery(self):
        assert errors.InvalidArguments("x").remedy is Remedy.REPAIR_INPUT
        assert errors.ToolNotFound("x").remedy is Remedy.SUBSTITUTE
        assert errors.ContextOverflow("x").remedy is Remedy.DECOMPOSE
        assert errors.PermissionDenied("x").remedy is Remedy.ESCALATE
        assert errors.SandboxViolation("x").remedy is Remedy.ABORT


class TestRedaction:
    @pytest.mark.parametrize(
        "secret",
        [
            "sk-ant-api03-abcdefghijklmnopqrstuvwxyz012345",
            "ghp_abcdefghijklmnopqrstuvwxyz0123456789",
            "AKIAIOSFODNN7EXAMPLE",
            "AIzaSyA1234567890abcdefghijklmnopqrstuv",
            "xoxb-1234567890-abcdefghij",
        ],
    )
    def test_known_credential_shapes_are_removed(self, secret):
        text = f"the key is {secret} do not share"
        cleaned = redaction.redact_text(text)
        assert secret not in cleaned
        assert "REDACTED" in cleaned

    def test_sensitive_keys_are_masked_by_name(self):
        payload = {"api_key": "hunter2hunter2", "user": "ana", "nested": {"password": "abc123456"}}
        cleaned = redaction.redact(payload)
        assert cleaned["user"] == "ana"
        assert "hunter2" not in json.dumps(cleaned)
        assert "abc123456" not in json.dumps(cleaned)

    def test_placeholders_are_left_alone(self):
        payload = {"api_key": "${MY_KEY}", "token": "<your-token-here>"}
        assert redaction.redact(payload) == payload

    def test_same_secret_gets_a_stable_fingerprint(self):
        secret = "ghp_abcdefghijklmnopqrstuvwxyz0123456789"
        first = redaction.redact_text(f"a {secret}")
        second = redaction.redact_text(f"b {secret}")
        assert first.split("a ")[1] == second.split("b ")[1]

    def test_url_credentials_are_stripped(self):
        cleaned = redaction.redact_text("https://user:s3cretpassword@example.com/repo.git")
        assert "s3cretpassword" not in cleaned

    def test_contains_secret_detects_change(self):
        assert redaction.contains_secret("token=abcdef1234567890")
        assert not redaction.contains_secret("just some ordinary prose")

    def test_recursion_is_depth_limited(self):
        deep: dict = {}
        cursor = deep
        for _ in range(50):
            cursor["next"] = {}
            cursor = cursor["next"]
        assert "depth-limit" in json.dumps(redaction.redact(deep))

    def test_scrub_env_keeps_allowlisted(self):
        env = {"PATH": "/bin", "AWS_SECRET_ACCESS_KEY": "x", "HOME": "/root"}
        scrubbed = redaction.scrub_env(env, allow=["PATH"])
        assert "PATH" in scrubbed and "HOME" in scrubbed
        assert "AWS_SECRET_ACCESS_KEY" not in scrubbed


class TestConfig:
    def test_defaults_are_valid(self):
        Config().validate()

    def test_env_overrides_nested_sections(self):
        cfg = Config.load(env={"AIOS_EXECUTION_MAX_PARALLEL": "9",
                               "AIOS_SECURITY_MODE": "strict"})
        assert cfg.execution.max_parallel == 9
        assert cfg.security.mode == "strict"

    def test_explicit_overrides_beat_env(self):
        cfg = Config.load(
            env={"AIOS_EXECUTION_MAX_PARALLEL": "9"},
            overrides={"execution": {"max_parallel": 2}},
        )
        assert cfg.execution.max_parallel == 2

    def test_toml_file_is_read(self, tmp_path):
        path = tmp_path / "aios.toml"
        path.write_text(
            '[model]\nprovider = "offline"\n[budget]\nmax_usd = 1.5\n', encoding="utf-8"
        )
        cfg = Config.load(path, env={})
        assert cfg.model.provider == "offline"
        assert cfg.budget.max_usd == 1.5

    def test_list_options_accept_csv(self):
        cfg = Config.load(env={"AIOS_SECURITY_ALLOWED_HOSTS": "a.com, b.com"})
        assert cfg.security.allowed_hosts == ["a.com", "b.com"]

    def test_unknown_option_is_rejected(self, tmp_path):
        path = tmp_path / "aios.toml"
        path.write_text("[model]\nnot_a_real_option = 1\n", encoding="utf-8")
        with pytest.raises(errors.ConfigError, match="unknown option"):
            Config.load(path, env={})

    def test_invalid_values_are_rejected(self):
        with pytest.raises(errors.ConfigError):
            Config.load(env={"AIOS_SECURITY_MODE": "anarchy"})

    def test_derived_paths_are_inside_the_workspace(self, tmp_path):
        cfg = Config.load(overrides={"workspace": {"root": str(tmp_path)}}, env={})
        assert cfg.state_dir.is_relative_to(cfg.workspace_root)
        assert cfg.runs_dir.is_relative_to(cfg.state_dir)


class TestSchemaValidation:
    SCHEMA = {
        "type": "object",
        "properties": {
            "name": {"type": "string", "minLength": 1},
            "count": {"type": "integer", "minimum": 0},
            "enabled": {"type": "boolean", "default": True},
            "tags": {"type": "array", "items": {"type": "string"}},
            "mode": {"type": "string", "enum": ["fast", "slow"]},
        },
        "required": ["name"],
        "additionalProperties": False,
    }

    def test_valid_instance_passes(self):
        assert schema.validate({"name": "x"}, self.SCHEMA) == []

    def test_missing_required_is_reported_by_name(self):
        errors_found = schema.validate({}, self.SCHEMA)
        assert any("missing required property 'name'" in e for e in errors_found)

    def test_unknown_property_lists_the_allowed_ones(self):
        errors_found = schema.validate({"name": "x", "nope": 1}, self.SCHEMA)
        assert any("nope" in e and "allowed" in e for e in errors_found)

    @pytest.mark.parametrize(
        ("raw", "expected"),
        [("3", 3), (3.0, 3)],
    )
    def test_integer_coercion(self, raw, expected):
        assert schema.coerce({"count": raw}, self.SCHEMA)["count"] == expected

    @pytest.mark.parametrize(("raw", "expected"), [("true", True), ("no", False)])
    def test_boolean_coercion(self, raw, expected):
        assert schema.coerce({"enabled": raw}, self.SCHEMA)["enabled"] is expected

    def test_scalar_is_promoted_to_a_list(self):
        assert schema.coerce({"tags": "one"}, self.SCHEMA)["tags"] == ["one"]

    def test_defaults_are_applied(self):
        assert schema.coerce({"name": "x"}, self.SCHEMA)["enabled"] is True

    def test_uncoercible_value_raises(self):
        with pytest.raises(schema.ValidationError) as excinfo:
            schema.validate_and_coerce({"name": "x", "count": "many"}, self.SCHEMA)
        assert "count" in str(excinfo.value)

    def test_enum_violation_lists_options(self):
        found = schema.validate({"name": "x", "mode": "medium"}, self.SCHEMA)
        assert any("'fast'" in e for e in found)

    def test_describe_is_readable(self):
        assert "name: string" in schema.describe(self.SCHEMA)
