from __future__ import annotations

import base64
import binascii
import json
from collections.abc import Mapping

PROTOCOL_VERSION = 3
MAX_LINE_BYTES = 64 * 1024
MAX_PCM_CHUNK_BYTES = 45_000
MAX_CONTEXTUAL_PHRASES = 64
MAX_CONTEXTUAL_PHRASE_LENGTH = 100
MAX_CAPTURE_ID_LENGTH = 200
MAX_SPEECH_ID_LENGTH = 200
MAX_SPEECH_TEXT_LENGTH = 32_000
MAX_SPEECH_SEQUENCE = 2**31 - 1


class ProtocolError(ValueError):
    """A bounded, user-safe sidecar protocol error."""


def parse_command(line: bytes) -> dict[str, object]:
    if not line or len(line) > MAX_LINE_BYTES:
        raise ProtocolError("Pipecat command must be between 1 byte and 64 KiB.")
    try:
        value = json.loads(line)
    except (UnicodeDecodeError, json.JSONDecodeError) as error:
        raise ProtocolError("Malformed JSON command.") from error
    if not isinstance(value, dict):
        raise ProtocolError("Pipecat command must be an object.")
    return value


def request_id(command: Mapping[str, object]) -> str:
    value = command.get("requestId")
    if not isinstance(value, str) or not value or len(value) > 200:
        raise ProtocolError("Pipecat command has an invalid request ID.")
    return value


def capture_id(command: Mapping[str, object]) -> str:
    value = command.get("captureId")
    if not isinstance(value, str) or not value or len(value) > MAX_CAPTURE_ID_LENGTH:
        raise ProtocolError("Pipecat command has an invalid capture ID.")
    return value


def speech_id(command: Mapping[str, object]) -> str:
    value = command.get("speechId")
    if not isinstance(value, str) or not value or len(value) > MAX_SPEECH_ID_LENGTH:
        raise ProtocolError("Pipecat command has an invalid speech ID.")
    return value


def speech_text(command: Mapping[str, object]) -> str:
    value = command.get("text")
    if not isinstance(value, str) or not value.strip() or len(value) > MAX_SPEECH_TEXT_LENGTH:
        raise ProtocolError("Pipecat speech text is invalid.")
    return value


def positive_integer(command: Mapping[str, object], name: str, maximum: int) -> int:
    value = command.get(name)
    if isinstance(value, bool) or not isinstance(value, int) or value <= 0 or value > maximum:
        raise ProtocolError(f"Pipecat command has an invalid {name}.")
    return value


def nonnegative_integer(command: Mapping[str, object], name: str, maximum: int) -> int:
    value = command.get(name)
    if isinstance(value, bool) or not isinstance(value, int) or value < 0 or value > maximum:
        raise ProtocolError(f"Pipecat command has an invalid {name}.")
    return value


def contextual_phrases(command: Mapping[str, object]) -> tuple[str, ...]:
    value = command.get("contextualPhrases", [])
    if not isinstance(value, list) or len(value) > MAX_CONTEXTUAL_PHRASES:
        raise ProtocolError("Pipecat contextual phrases are invalid.")
    phrases: list[str] = []
    for item in value:
        if not isinstance(item, str):
            raise ProtocolError("Pipecat contextual phrases are invalid.")
        phrase = item.strip()
        if not phrase or len(phrase) > MAX_CONTEXTUAL_PHRASE_LENGTH:
            raise ProtocolError("Pipecat contextual phrases are invalid.")
        phrases.append(phrase)
    return tuple(phrases)


def decode_pcm(value: object) -> bytes:
    if not isinstance(value, str):
        raise ProtocolError("PCM data must be base64 text.")
    try:
        data = base64.b64decode(value, validate=True)
    except (ValueError, binascii.Error) as error:
        raise ProtocolError("PCM data is not valid base64.") from error
    if not data or len(data) > MAX_PCM_CHUNK_BYTES or len(data) % 2:
        raise ProtocolError("PCM chunk must be non-empty, even, and at most 45,000 bytes.")
    return data
