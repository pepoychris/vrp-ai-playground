"""Guards the pinned stack in ``compose.yaml`` without needing Docker.

This test lives with the backend suite because that is the Python suite the phase
runs; it validates repository-level infrastructure decisions that the MVP freezes:
pinned images, Ollama isolation, persistent volumes and the approved Ollama
environment.
"""

from __future__ import annotations

import re
import unittest

from api.tests.support import COMPOSE_FILE, published_host_ports, service_blocks


def read_compose() -> str:
    return COMPOSE_FILE.read_text(encoding="utf-8")


class ComposeContractTests(unittest.TestCase):
    def setUp(self) -> None:
        if not COMPOSE_FILE.is_file():
            self.fail(f"compose.yaml is missing at {COMPOSE_FILE}")
        self.compose = read_compose()

    def test_no_image_uses_the_latest_tag(self) -> None:
        images = re.findall(r"^\s{4}image:\s*(\S+)\s*$", self.compose, flags=re.MULTILINE)
        self.assertTrue(images, "compose.yaml must pin at least one image")
        for image in images:
            self.assertIn(":", image, f"{image} is not pinned to a tag")
            self.assertNotIn(":latest", image)

    def test_pinned_base_images_match_the_phase_0_registry(self) -> None:
        self.assertIn("image: ollama/ollama:0.34.2", self.compose)
        self.assertIn("FROM python:3.14.7-slim-bookworm", (COMPOSE_FILE.parent / "api" / "Dockerfile").read_text(encoding="utf-8"))
        self.assertIn("FROM node:24.21.0-bookworm-slim", (COMPOSE_FILE.parent / "frontend" / "Dockerfile").read_text(encoding="utf-8"))

    def test_only_api_and_frontend_publish_host_ports(self) -> None:
        services = service_blocks(self.compose)

        self.assertEqual({"api", "frontend", "ollama"}, set(services))
        self.assertEqual(["8000:8000"], published_host_ports(services["api"]))
        self.assertEqual(["8080:8080"], published_host_ports(services["frontend"]))
        self.assertEqual([], published_host_ports(services["ollama"]))

    def test_ollama_ports_are_never_published(self) -> None:
        services = service_blocks(self.compose)

        self.assertEqual([], published_host_ports(services["ollama"]))
        for name, block in services.items():
            for entry in published_host_ports(block):
                self.assertNotIn("11434", entry, f"{name} must not publish the Ollama port")

    def test_ollama_environment_is_the_approved_one(self) -> None:
        for expected in (
            'OLLAMA_NO_CLOUD: "1"',
            'OLLAMA_NUM_PARALLEL: "1"',
            'OLLAMA_MAX_LOADED_MODELS: "1"',
        ):
            self.assertIn(expected, self.compose)

    def test_persistent_volumes_are_declared(self) -> None:
        self.assertIn("ollama-models:/root/.ollama", self.compose)
        self.assertIn("sqlite-data:/data", self.compose)
        self.assertIn("volumes:", self.compose)

    def test_ollama_is_only_on_the_internal_network(self) -> None:
        ollama_block = self.compose.split("  api:", maxsplit=1)[0]
        self.assertIn("networks:\n      - backend", ollama_block)
        self.assertNotIn("networks:\n      - edge", ollama_block)


if __name__ == "__main__":
    unittest.main()
