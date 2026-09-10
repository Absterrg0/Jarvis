from __future__ import annotations

import base64
import unittest

from jarvis_voice_runtime.protocol import ProtocolError, decode_pcm, parse_command


class ProtocolTest(unittest.TestCase):
    def test_parses_a_bounded_object(self) -> None:
        self.assertEqual(parse_command(b'{"type":"shutdown","requestId":"one"}\n')["type"], "shutdown")

    def test_rejects_malformed_and_oversized_lines(self) -> None:
        with self.assertRaisesRegex(ProtocolError, "Malformed JSON"):
            parse_command(b"{")
        with self.assertRaisesRegex(ProtocolError, "64 KiB"):
            parse_command(b"x" * (64 * 1024 + 1))

    def test_decodes_only_bounded_int16_pcm(self) -> None:
        pcm = b"\x00\x00\xff\x7f"
        self.assertEqual(decode_pcm(base64.b64encode(pcm).decode()), pcm)
        with self.assertRaisesRegex(ProtocolError, "non-empty, even"):
            decode_pcm(base64.b64encode(b"x").decode())


if __name__ == "__main__":
    unittest.main()
