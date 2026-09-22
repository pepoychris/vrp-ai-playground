"""Genera el GLB de prueba de la Fase 0 (un cubo, sin texturas ni dependencias).

El asset es determinista y se puede regenerar:

    python spike/fase0/glb/tools/make_fixture_glb.py

Se escribe glTF 2.0 binario valido (un chunk JSON y un chunk BIN de un unico buffer
con POSITION, NORMAL e indices). No se usa ninguna libreria: solo la estructura
descrita en https://registry.khronos.org/glTF/specs/2.0/glTF-2.0.html
"""

from __future__ import annotations

import json
import struct
from pathlib import Path

OUTPUT = Path(__file__).resolve().parents[1] / "assets" / "spike-cube.glb"

CUBE_FACES = {
    "front": ((0.0, 0.0, 1.0), ((-1, -1, 1), (1, -1, 1), (1, 1, 1), (-1, 1, 1))),
    "back": ((0.0, 0.0, -1.0), ((1, -1, -1), (-1, -1, -1), (-1, 1, -1), (1, 1, -1))),
    "top": ((0.0, 1.0, 0.0), ((-1, 1, 1), (1, 1, 1), (1, 1, -1), (-1, 1, -1))),
    "bottom": ((0.0, -1.0, 0.0), ((-1, -1, -1), (1, -1, -1), (1, -1, 1), (-1, -1, 1))),
    "right": ((1.0, 0.0, 0.0), ((1, -1, 1), (1, -1, -1), (1, 1, -1), (1, 1, 1))),
    "left": ((-1.0, 0.0, 0.0), ((-1, -1, -1), (-1, -1, 1), (-1, 1, 1), (-1, 1, -1))),
}


def build_geometry() -> tuple[bytes, bytes, bytes, int]:
    positions: list[float] = []
    normals: list[float] = []
    indices: list[int] = []
    vertex = 0
    for normal, corners in CUBE_FACES.values():
        for corner in corners:
            positions.extend(float(value) for value in corner)
            normals.extend(normal)
        indices.extend([vertex, vertex + 1, vertex + 2, vertex, vertex + 2, vertex + 3])
        vertex += 4
    position_bytes = struct.pack(f"<{len(positions)}f", *positions)
    normal_bytes = struct.pack(f"<{len(normals)}f", *normals)
    index_bytes = struct.pack(f"<{len(indices)}H", *indices)
    return position_bytes, normal_bytes, index_bytes, vertex


def build_glb() -> bytes:
    position_bytes, normal_bytes, index_bytes, vertex_count = build_geometry()
    binary = position_bytes + normal_bytes + index_bytes
    # Los bufferView de acceso a atributos deben empezar en offset multiplo de 4.
    while len(binary) % 4:
        binary += b"\x00"

    document = {
        "asset": {"version": "2.0", "generator": "roboroute-nexus-phase0-fixture"},
        "scene": 0,
        "scenes": [{"name": "SpikeScene", "nodes": [0]}],
        "nodes": [{"name": "SpikeCube", "mesh": 0}],
        "meshes": [
            {
                "name": "SpikeCubeMesh",
                "primitives": [
                    {
                        "attributes": {"POSITION": 0, "NORMAL": 1},
                        "indices": 2,
                        "material": 0,
                    }
                ],
            }
        ],
        "materials": [
            {
                "name": "SpikeMaterial",
                "pbrMetallicRoughness": {
                    "baseColorFactor": [0.25, 0.65, 0.95, 1.0],
                    "metallicFactor": 0.1,
                    "roughnessFactor": 0.6,
                },
            }
        ],
        "accessors": [
            {
                "bufferView": 0,
                "componentType": 5126,
                "count": vertex_count,
                "type": "VEC3",
                "min": [-1.0, -1.0, -1.0],
                "max": [1.0, 1.0, 1.0],
            },
            {
                "bufferView": 1,
                "componentType": 5126,
                "count": vertex_count,
                "type": "VEC3",
            },
            {
                "bufferView": 2,
                "componentType": 5123,
                "count": len(index_bytes) // 2,
                "type": "SCALAR",
            },
        ],
        "bufferViews": [
            {"buffer": 0, "byteOffset": 0, "byteLength": len(position_bytes), "target": 34962},
            {
                "buffer": 0,
                "byteOffset": len(position_bytes),
                "byteLength": len(normal_bytes),
                "target": 34962,
            },
            {
                "buffer": 0,
                "byteOffset": len(position_bytes) + len(normal_bytes),
                "byteLength": len(index_bytes),
                "target": 34963,
            },
        ],
        "buffers": [{"byteLength": len(binary)}],
    }

    json_bytes = json.dumps(document, separators=(",", ":"), sort_keys=True).encode("utf-8")
    while len(json_bytes) % 4:
        json_bytes += b" "
    while len(binary) % 4:
        binary += b"\x00"

    header = struct.pack("<III", 0x46546C67, 2, 12 + 8 + len(json_bytes) + 8 + len(binary))
    json_chunk = struct.pack("<II", len(json_bytes), 0x4E4F534A) + json_bytes
    binary_chunk = struct.pack("<II", len(binary), 0x004E4942) + binary
    return header + json_chunk + binary_chunk


def main() -> int:
    OUTPUT.parent.mkdir(parents=True, exist_ok=True)
    payload = build_glb()
    OUTPUT.write_bytes(payload)
    print(f"escrito {OUTPUT.relative_to(Path.cwd()) if OUTPUT.is_relative_to(Path.cwd()) else OUTPUT}")
    print(f"bytes: {len(payload)}")
    return 0


if __name__ == "__main__":
    raise SystemExit(main())
