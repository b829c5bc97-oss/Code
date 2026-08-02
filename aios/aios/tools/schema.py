"""A small, dependency-free JSON Schema validator.

Scope is deliberately narrow: the subset of draft-07 that tool parameter
schemas actually use. It exists for three reasons a general library would not
serve as well:

1. **Zero dependencies** - the kernel must boot anywhere.
2. **Coercion.** Language models emit ``"3"`` where a schema says integer and
   ``"true"`` where it says boolean. Rejecting those wastes a whole repair
   round-trip, so we coerce when it is lossless and unambiguous, and only fail
   when it is not.
3. **Error messages written for a model to act on** - every message names the
   path, what was expected and what arrived, because these strings are fed back
   into the repair prompt.
"""

from __future__ import annotations

import re
from typing import Any

_TYPE_MAP: dict[str, tuple[type, ...]] = {
    "string": (str,),
    "number": (int, float),
    "integer": (int,),
    "boolean": (bool,),
    "array": (list, tuple),
    "object": (dict,),
    "null": (type(None),),
}

_TRUE = {"true", "yes", "1", "on"}
_FALSE = {"false", "no", "0", "off"}


class ValidationError(Exception):
    def __init__(self, errors: list[str]) -> None:
        super().__init__("; ".join(errors))
        self.errors = errors


def validate(instance: Any, schema: dict[str, Any], *, path: str = "") -> list[str]:
    """Return a list of human-readable errors (empty means valid)."""
    return _validate(instance, schema, path or "$")


def coerce(instance: Any, schema: dict[str, Any]) -> Any:
    """Apply defaults and lossless type coercion. Never raises."""
    return _coerce(instance, schema)


def validate_and_coerce(instance: Any, schema: dict[str, Any]) -> Any:
    """Coerce first, then validate. Raises :class:`ValidationError`."""
    coerced = _coerce(instance, schema)
    errors = _validate(coerced, schema, "$")
    if errors:
        raise ValidationError(errors)
    return coerced


# --------------------------------------------------------------------------


def _validate(instance: Any, schema: dict[str, Any], path: str) -> list[str]:
    if not schema or schema is True:
        return []
    errors: list[str] = []

    if "const" in schema and instance != schema["const"]:
        errors.append(f"{path}: expected constant {schema['const']!r}, got {instance!r}")

    if "enum" in schema and instance not in schema["enum"]:
        allowed = ", ".join(repr(v) for v in schema["enum"][:12])
        errors.append(f"{path}: {instance!r} is not one of [{allowed}]")

    expected = schema.get("type")
    if expected:
        types = [expected] if isinstance(expected, str) else list(expected)
        if not any(_is_type(instance, t) for t in types):
            errors.append(
                f"{path}: expected {' or '.join(types)}, got {type(instance).__name__}"
            )
            return errors  # further checks would be noise

    if isinstance(instance, str):
        errors += _validate_string(instance, schema, path)
    if isinstance(instance, int | float) and not isinstance(instance, bool):
        errors += _validate_number(instance, schema, path)
    if isinstance(instance, list | tuple):
        errors += _validate_array(list(instance), schema, path)
    if isinstance(instance, dict):
        errors += _validate_object(instance, schema, path)

    for key, combinator in (("anyOf", any), ("oneOf", None), ("allOf", all)):
        if key not in schema:
            continue
        subresults = [_validate(instance, sub, path) for sub in schema[key]]
        passed = [r for r in subresults if not r]
        if key == "anyOf" and not passed:
            errors.append(f"{path}: does not match any allowed schema")
        elif key == "oneOf" and len(passed) != 1:
            errors.append(f"{path}: must match exactly one allowed schema (matched {len(passed)})")
        elif key == "allOf":
            for sub in subresults:
                errors += sub
        del combinator

    if "not" in schema and not _validate(instance, schema["not"], path):
        errors.append(f"{path}: matches a forbidden schema")

    return errors


def _validate_string(value: str, schema: dict[str, Any], path: str) -> list[str]:
    errors: list[str] = []
    if (mn := schema.get("minLength")) is not None and len(value) < mn:
        errors.append(f"{path}: string shorter than minLength {mn}")
    if (mx := schema.get("maxLength")) is not None and len(value) > mx:
        errors.append(f"{path}: string longer than maxLength {mx}")
    if (pattern := schema.get("pattern")) is not None:
        try:
            if not re.search(pattern, value):
                errors.append(f"{path}: does not match pattern {pattern!r}")
        except re.error:  # pragma: no cover - malformed schema
            pass
    return errors


def _validate_number(value: float, schema: dict[str, Any], path: str) -> list[str]:
    errors: list[str] = []
    if (mn := schema.get("minimum")) is not None and value < mn:
        errors.append(f"{path}: {value} is below minimum {mn}")
    if (mx := schema.get("maximum")) is not None and value > mx:
        errors.append(f"{path}: {value} is above maximum {mx}")
    if (mn := schema.get("exclusiveMinimum")) is not None and value <= mn:
        errors.append(f"{path}: {value} must be greater than {mn}")
    if (mx := schema.get("exclusiveMaximum")) is not None and value >= mx:
        errors.append(f"{path}: {value} must be less than {mx}")
    if (mult := schema.get("multipleOf")) and mult > 0 and abs(value % mult) > 1e-9:
        errors.append(f"{path}: {value} is not a multiple of {mult}")
    return errors


def _validate_array(value: list[Any], schema: dict[str, Any], path: str) -> list[str]:
    errors: list[str] = []
    if (mn := schema.get("minItems")) is not None and len(value) < mn:
        errors.append(f"{path}: needs at least {mn} items, got {len(value)}")
    if (mx := schema.get("maxItems")) is not None and len(value) > mx:
        errors.append(f"{path}: allows at most {mx} items, got {len(value)}")
    if schema.get("uniqueItems"):
        seen = [repr(v) for v in value]
        if len(set(seen)) != len(seen):
            errors.append(f"{path}: items must be unique")
    item_schema = schema.get("items")
    if isinstance(item_schema, dict):
        for index, item in enumerate(value):
            errors += _validate(item, item_schema, f"{path}[{index}]")
    return errors


def _validate_object(value: dict[str, Any], schema: dict[str, Any], path: str) -> list[str]:
    errors: list[str] = []
    properties: dict[str, Any] = schema.get("properties", {})
    for name in schema.get("required", []):
        if name not in value:
            errors.append(f"{path}: missing required property {name!r}")
    for key, item in value.items():
        if key in properties:
            errors += _validate(item, properties[key], f"{path}.{key}")
    if schema.get("additionalProperties") is False:
        extra = set(value) - set(properties)
        if extra:
            known = ", ".join(sorted(properties)) or "(none)"
            errors.append(
                f"{path}: unexpected propert{'y' if len(extra) == 1 else 'ies'} "
                f"{', '.join(sorted(extra))}; allowed: {known}"
            )
    elif isinstance(schema.get("additionalProperties"), dict):
        sub = schema["additionalProperties"]
        for key, item in value.items():
            if key not in properties:
                errors += _validate(item, sub, f"{path}.{key}")
    if (mn := schema.get("minProperties")) is not None and len(value) < mn:
        errors.append(f"{path}: needs at least {mn} properties")
    return errors


def _is_type(value: Any, expected: str) -> bool:
    if expected == "integer":
        return isinstance(value, int) and not isinstance(value, bool)
    if expected == "number":
        return isinstance(value, int | float) and not isinstance(value, bool)
    if expected == "boolean":
        return isinstance(value, bool)
    return isinstance(value, _TYPE_MAP.get(expected, ()))


# --------------------------------------------------------------------------
# Coercion
# --------------------------------------------------------------------------


def _coerce(instance: Any, schema: dict[str, Any]) -> Any:
    if not isinstance(schema, dict) or not schema:
        return instance

    expected = schema.get("type")
    types = [expected] if isinstance(expected, str) else list(expected or [])

    if instance is None and "default" in schema:
        return schema["default"]

    if "object" in types or ("properties" in schema and isinstance(instance, dict)):
        if not isinstance(instance, dict):
            return instance
        properties: dict[str, Any] = schema.get("properties", {})
        out = dict(instance)
        for key, sub in properties.items():
            if key in out:
                out[key] = _coerce(out[key], sub)
            elif "default" in sub:
                out[key] = sub["default"]
        return out

    if "array" in types:
        if isinstance(instance, str):
            # A model asked for a list sometimes sends a single value.
            instance = [instance]
        if isinstance(instance, list | tuple):
            item_schema = schema.get("items")
            if isinstance(item_schema, dict):
                return [_coerce(item, item_schema) for item in instance]
            return list(instance)
        return instance

    if isinstance(instance, str):
        text = instance.strip()
        if "boolean" in types:
            if text.lower() in _TRUE:
                return True
            if text.lower() in _FALSE:
                return False
        if "integer" in types:
            try:
                return int(text, 10)
            except ValueError:
                try:
                    as_float = float(text)
                except ValueError:
                    return instance
                return int(as_float) if as_float.is_integer() else instance
        if "number" in types:
            try:
                return float(text)
            except ValueError:
                return instance
        if "null" in types and text.lower() in {"none", "null", ""}:
            return None

    if isinstance(instance, int | float) and not isinstance(instance, bool) and "string" in types:
        return str(instance)
    if isinstance(instance, bool) and "string" in types:
        return "true" if instance else "false"
    if isinstance(instance, float) and "integer" in types and instance.is_integer():
        return int(instance)

    return instance


def describe(schema: dict[str, Any]) -> str:
    """One-line human summary of a parameter schema, used in prompts and --help."""
    properties: dict[str, Any] = schema.get("properties", {})
    required = set(schema.get("required", []))
    parts = []
    for name, sub in properties.items():
        kind = sub.get("type", "any")
        kind = kind if isinstance(kind, str) else "|".join(kind)
        parts.append(f"{name}: {kind}" + ("" if name in required else "?"))
    return "{" + ", ".join(parts) + "}"
