#!/usr/bin/env python3
"""Build the deterministic Phase 2 fixture GLB assets.

These fixtures are procedural stand-ins, not final art. The repository has no Blender
toolchain, so every asset is written straight to valid glTF 2.0 binary from data using
only the Python standard library. The runbook records that limitation.

Sources of truth read by this generator:

* ``frontend/src/scene/asset-contract.json``: stable asset ids, file names, root node
  names, node translations, material names and the animation clips (name, duration and
  channels) each asset must expose.
* ``frontend/src/scene/visual-tokens.json``: the shared palette, so a fixture colour and
  the frontend token can never drift apart.

Usage:

    python frontend/tools/build_fixture_assets.py
    python frontend/tools/build_fixture_assets.py --check

``--check`` rebuilds every asset in memory and fails when a file on disk differs from
the contract, which is the deterministic guard used by the verification commands.
"""

from __future__ import annotations

import argparse
import json
import math
import struct
import sys
from pathlib import Path

FRONTEND_DIR = Path(__file__).resolve().parents[1]
SCENE_DIR = FRONTEND_DIR / "src" / "scene"
CONTRACT_PATH = SCENE_DIR / "asset-contract.json"
TOKENS_PATH = SCENE_DIR / "visual-tokens.json"
OUTPUT_DIR = FRONTEND_DIR / "public" / "assets" / "models"

GENERATOR = "roboroute-nexus-phase2-fixture-generator"

# glTF 2.0 constants (https://registry.khronos.org/glTF/specs/2.0/glTF-2.0.html).
FLOAT = 5126
UNSIGNED_SHORT = 5123
ARRAY_BUFFER = 34962
ELEMENT_ARRAY_BUFFER = 34963

# Box geometry for every asset node, authored as
# (center_x, center_y, center_z, size_x, size_y, size_z) in metres.
Box = tuple[float, float, float, float, float, float]

NODE_GEOMETRY: dict[str, list[Box]] = {
    "RobotVehicle": [
        (0.0, 0.42, 0.0, 1.70, 0.42, 0.95),
        (0.0, 0.74, 0.0, 0.80, 0.24, 0.80),
        (0.62, 0.16, 0.50, 0.30, 0.30, 0.14),
        (-0.62, 0.16, 0.50, 0.30, 0.30, 0.14),
        (0.62, 0.16, -0.50, 0.30, 0.30, 0.14),
        (-0.62, 0.16, -0.50, 0.30, 0.30, 0.14),
    ],
    "RobotClaw": [
        (0.0, 0.10, 0.0, 0.46, 0.20, 0.46),
        (0.0, 0.20, 0.0, 0.22, 0.24, 0.22),
    ],
    "ClawFingerLeft": [(-0.05, -0.19, 0.0, 0.10, 0.38, 0.14)],
    "ClawFingerRight": [(0.05, -0.19, 0.0, 0.10, 0.38, 0.14)],
    "BarrierPost": [
        (0.0, 0.55, 0.0, 0.34, 1.10, 0.34),
        (0.0, 1.12, 0.0, 0.40, 0.08, 0.40),
    ],
    "BarrierArm": [(0.90, -0.04, 0.0, 1.80, 0.16, 0.18)],
    "DepotLandmark": [
        (0.0, 0.10, 0.0, 3.20, 0.20, 3.20),
        (1.30, 0.75, 1.30, 0.24, 1.30, 0.24),
        (-1.30, 0.75, 1.30, 0.24, 1.30, 0.24),
        (1.30, 0.75, -1.30, 0.24, 1.30, 0.24),
        (-1.30, 0.75, -1.30, 0.24, 1.30, 0.24),
        (0.0, 1.46, 0.0, 3.30, 0.18, 3.30),
        (0.0, 1.62, 0.0, 0.30, 0.16, 0.30),
    ],
    "BuildingFixture": [
        (0.0, 0.60, 0.0, 2.40, 1.20, 2.40),
        (0.0, 1.26, 0.0, 2.60, 0.12, 2.60),
        (0.0, 1.46, 0.0, 1.20, 0.28, 1.20),
        (1.42, 0.32, 0.0, 0.44, 0.64, 1.60),
    ],
}

# Unit cube corners per face, ordered so the two triangles keep counter-clockwise
# winding when viewed from outside.
BOX_FACES: dict[str, tuple[tuple[float, float, float], tuple[tuple[int, int, int], ...]]] = {
    "front": ((0.0, 0.0, 1.0), ((-1, -1, 1), (1, -1, 1), (1, 1, 1), (-1, 1, 1))),
    "back": ((0.0, 0.0, -1.0), ((1, -1, -1), (-1, -1, -1), (-1, 1, -1), (1, 1, -1))),
    "top": ((0.0, 1.0, 0.0), ((-1, 1, 1), (1, 1, 1), (1, 1, -1), (-1, 1, -1))),
    "bottom": ((0.0, -1.0, 0.0), ((-1, -1, -1), (1, -1, -1), (1, -1, 1), (-1, -1, 1))),
    "right": ((1.0, 0.0, 0.0), ((1, -1, 1), (1, -1, -1), (1, 1, -1), (1, 1, 1))),
    "left": ((-1.0, 0.0, 0.0), ((-1, -1, -1), (-1, -1, 1), (-1, 1, 1), (-1, 1, -1))),
}


def srgb_channel_to_linear(value: float) -> float:
    """Convert one sRGB channel in [0, 1] to the linear space glTF stores."""

    return value / 12.92 if value <= 0.04045 else ((value + 0.055) / 1.055) ** 2.4


def hex_to_linear_rgba(hex_color: str) -> list[float]:
    raw = hex_color.lstrip("#")
    if len(raw) != 6:
        raise ValueError(f"expected a #rrggbb colour, received {hex_color!r}")
    channels = [int(raw[index : index + 2], 16) / 255.0 for index in (0, 2, 4)]
    return [round(srgb_channel_to_linear(channel), 6) for channel in channels] + [1.0]


def box_geometry(box: Box) -> tuple[list[float], list[float], list[int]]:
    center_x, center_y, center_z, size_x, size_y, size_z = box
    positions: list[float] = []
    normals: list[float] = []
    indices: list[int] = []
    base = 0
    for normal, corners in BOX_FACES.values():
        for corner_x, corner_y, corner_z in corners:
            positions.extend(
                (
                    center_x + corner_x * size_x / 2.0,
                    center_y + corner_y * size_y / 2.0,
                    center_z + corner_z * size_z / 2.0,
                )
            )
            normals.extend(normal)
        indices.extend((base, base + 1, base + 2, base, base + 2, base + 3))
        base += 4
    return positions, normals, indices


def merge_boxes(boxes: list[Box]) -> tuple[list[float], list[float], list[int]]:
    positions: list[float] = []
    normals: list[float] = []
    indices: list[int] = []
    for box in boxes:
        box_positions, box_normals, box_indices = box_geometry(box)
        offset = len(positions) // 3
        positions.extend(box_positions)
        normals.extend(box_normals)
        indices.extend(index + offset for index in box_indices)
    return positions, normals, indices


def euler_degrees_to_quaternion(x: float, y: float, z: float) -> list[float]:
    """Convert intrinsic XYZ Euler degrees to a normalised glTF quaternion."""

    half_x, half_y, half_z = (math.radians(value) / 2.0 for value in (x, y, z))
    cos_x, sin_x = math.cos(half_x), math.sin(half_x)
    cos_y, sin_y = math.cos(half_y), math.sin(half_y)
    cos_z, sin_z = math.cos(half_z), math.sin(half_z)
    return [
        round(sin_x * cos_y * cos_z - cos_x * sin_y * sin_z, 6),
        round(cos_x * sin_y * cos_z + sin_x * cos_y * sin_z, 6),
        round(cos_x * cos_y * sin_z - sin_x * sin_y * cos_z, 6),
        round(cos_x * cos_y * cos_z + sin_x * sin_y * sin_z, 6),
    ]


class GltfBuilder:
    """Minimal single-buffer glTF 2.0 binary writer."""

    def __init__(self) -> None:
        self._binary = bytearray()
        self._views: list[dict] = []
        self._accessors: list[dict] = []
        self._meshes: list[dict] = []
        self._nodes: list[dict] = []
        self._materials: list[dict] = []
        self._animations: list[dict] = []

    def _add_view(self, payload: bytes, target: int | None) -> int:
        while len(self._binary) % 4:
            self._binary.append(0)
        offset = len(self._binary)
        self._binary.extend(payload)
        view: dict = {"buffer": 0, "byteOffset": offset, "byteLength": len(payload)}
        if target is not None:
            view["target"] = target
        self._views.append(view)
        return len(self._views) - 1

    def _add_float_accessor(
        self,
        values: list[float],
        type_name: str,
        components: int,
        target: int | None,
        with_bounds: bool,
    ) -> int:
        payload = struct.pack(f"<{len(values)}f", *values)
        view = self._add_view(payload, target)
        accessor: dict = {
            "bufferView": view,
            "componentType": FLOAT,
            "count": len(values) // components,
            "type": type_name,
        }
        if with_bounds:
            rows = [values[index : index + components] for index in range(0, len(values), components)]
            accessor["min"] = [min(row[axis] for row in rows) for axis in range(components)]
            accessor["max"] = [max(row[axis] for row in rows) for axis in range(components)]
        self._accessors.append(accessor)
        return len(self._accessors) - 1

    def add_vec3s(self, vectors: list[list[float]], target: int | None, with_bounds: bool) -> int:
        return self._add_float_accessor(
            [component for vector in vectors for component in vector], "VEC3", 3, target, with_bounds
        )

    def add_vec4s(self, vectors: list[list[float]], with_bounds: bool) -> int:
        return self._add_float_accessor(
            [component for vector in vectors for component in vector], "VEC4", 4, None, with_bounds
        )

    def add_scalars(self, values: list[float], with_bounds: bool) -> int:
        return self._add_float_accessor(values, "SCALAR", 1, None, with_bounds)

    def add_indices(self, indices: list[int]) -> int:
        if max(indices) > 65535:
            raise ValueError("fixture meshes must stay inside the 16 bit index range")
        payload = struct.pack(f"<{len(indices)}H", *indices)
        view = self._add_view(payload, ELEMENT_ARRAY_BUFFER)
        self._accessors.append(
            {
                "bufferView": view,
                "componentType": UNSIGNED_SHORT,
                "count": len(indices),
                "type": "SCALAR",
            }
        )
        return len(self._accessors) - 1

    def add_mesh(self, name: str, positions: list[float], normals: list[float], indices: list[int], material: int) -> int:
        position_accessor = self.add_vec3s(_rows(positions, 3), ARRAY_BUFFER, True)
        normal_accessor = self.add_vec3s(_rows(normals, 3), ARRAY_BUFFER, False)
        index_accessor = self.add_indices(indices)
        self._meshes.append(
            {
                "name": name,
                "primitives": [
                    {
                        "attributes": {"POSITION": position_accessor, "NORMAL": normal_accessor},
                        "indices": index_accessor,
                        "material": material,
                    }
                ],
            }
        )
        return len(self._meshes) - 1

    def add_node(self, name: str, translation: list[float], children: list[int], mesh: int | None) -> int:
        node: dict = {"name": name, "translation": translation}
        if mesh is not None:
            node["mesh"] = mesh
        if children:
            node["children"] = children
        self._nodes.append(node)
        return len(self._nodes) - 1

    def add_material(self, material: dict) -> int:
        self._materials.append(material)
        return len(self._materials) - 1

    def add_animation(self, name: str, sampler_inputs: list[tuple[int, int, str]]) -> None:
        self._animations.append(
            {
                "name": name,
                "samplers": [
                    {"input": time_accessor, "output": value_accessor, "interpolation": interpolation}
                    for time_accessor, value_accessor, interpolation in sampler_inputs
                ],
            }
        )

    def attach_animation_channels(self, channels: list[dict]) -> None:
        self._animations[-1]["channels"] = channels

    def build(self, scene_name: str, root_nodes: list[int]) -> bytes:
        while len(self._binary) % 4:
            self._binary.append(0)
        binary = bytes(self._binary)

        document: dict = {
            "asset": {"version": "2.0", "generator": GENERATOR},
            "scene": 0,
            "scenes": [{"name": scene_name, "nodes": root_nodes}],
            "nodes": self._nodes,
            "meshes": self._meshes,
            "materials": self._materials,
            "accessors": self._accessors,
            "bufferViews": self._views,
            "buffers": [{"byteLength": len(binary)}],
        }
        if self._animations:
            document["animations"] = self._animations

        json_bytes = json.dumps(document, separators=(",", ":"), sort_keys=True).encode("utf-8")
        while len(json_bytes) % 4:
            json_bytes += b" "
        while len(binary) % 4:
            binary += b"\x00"

        header = struct.pack("<III", 0x46546C67, 2, 12 + 8 + len(json_bytes) + 8 + len(binary))
        json_chunk = struct.pack("<II", len(json_bytes), 0x4E4F534A) + json_bytes
        binary_chunk = struct.pack("<II", len(binary), 0x004E4942) + binary
        return header + json_chunk + binary_chunk


def _rows(values: list[float], width: int) -> list[list[float]]:
    return [values[index : index + width] for index in range(0, len(values), width)]


def build_asset(asset: dict, palette: dict[str, str]) -> bytes:
    builder = GltfBuilder()
    material_spec = asset["material"]
    try:
        base_color = hex_to_linear_rgba(palette[material_spec["paletteKey"]])
    except KeyError as error:
        raise KeyError(f"{asset['id']}: palette key {error.args[0]!r} is missing") from error

    pbr: dict = {
        "baseColorFactor": base_color,
        "metallicFactor": material_spec["metallicFactor"],
        "roughnessFactor": material_spec["roughnessFactor"],
    }
    emissive_key = material_spec.get("emissivePaletteKey")
    if emissive_key:
        pbr.setdefault("emissiveFactor", hex_to_linear_rgba(palette[emissive_key])[:3])
    material_index = builder.add_material({"name": material_spec["name"], "pbrMetallicRoughness": pbr})

    node_indices: dict[str, int] = {}
    # Children are created after their parents, so a two-pass walk keeps the node
    # index of every child available when the parent is written.
    specs_by_name = {node["name"]: node for node in asset["nodes"]}
    if asset["rootNode"] not in specs_by_name:
        raise KeyError(f"{asset['id']}: root node {asset['rootNode']!r} is not declared")

    def create_node(name: str) -> int:
        if name in node_indices:
            return node_indices[name]
        spec = specs_by_name.get(name)
        if spec is None:
            raise KeyError(f"{asset['id']}: clip or hierarchy references undeclared node {name!r}")
        children = [create_node(child) for child in spec.get("children", [])]
        boxes = NODE_GEOMETRY.get(name)
        if boxes is None:
            # A transform-only group is allowed as long as it has children; a leaf
            # node without geometry would be an asset mistake.
            if not children:
                raise KeyError(f"{asset['id']}: no fixture geometry is defined for node {name!r}")
            mesh_index = None
        else:
            positions, normals, indices = merge_boxes(boxes)
            mesh_index = builder.add_mesh(f"{name}Mesh", positions, normals, indices, material_index)
        node_indices[name] = builder.add_node(
            name, spec.get("translation", [0, 0, 0]), children, mesh_index
        )
        return node_indices[name]

    root_index = create_node(asset["rootNode"])

    for clip in asset["clips"]:
        sampler_inputs: list[tuple[int, int, str]] = []
        channels: list[dict] = []
        for channel in clip["channels"]:
            times = channel["times"]
            if times[0] != 0:
                raise ValueError(f"{asset['id']}/{clip['clipName']}: first key must be at t=0")
            if abs(times[-1] - clip["durationSeconds"]) > 1e-9:
                raise ValueError(
                    f"{asset['id']}/{clip['clipName']}: last key must land on the clip duration"
                )
            if channel["node"] not in node_indices:
                raise KeyError(
                    f"{asset['id']}/{clip['clipName']}: channel targets unknown node {channel['node']!r}"
                )
            time_accessor = builder.add_scalars(list(times), True)
            if channel["path"] == "translation":
                vectors = [[float(value) for value in vector] for vector in channel["vectors"]]
                value_accessor = builder.add_vec3s(vectors, None, False)
            elif channel["path"] == "rotation":
                vectors = [euler_degrees_to_quaternion(*vector) for vector in channel["vectors"]]
                value_accessor = builder.add_vec4s(vectors, False)
            else:
                raise ValueError(f"{asset['id']}: unsupported animation path {channel['path']!r}")
            sampler_inputs.append((time_accessor, value_accessor, "LINEAR"))
            channels.append(
                {
                    "sampler": len(sampler_inputs) - 1,
                    "target": {"node": node_indices[channel["node"]], "path": channel["path"]},
                }
            )
        builder.add_animation(clip["clipName"], sampler_inputs)
        builder.attach_animation_channels(channels)

    return builder.build(asset["sceneName"], [root_index])


def load_json(path: Path) -> dict:
    return json.loads(path.read_text(encoding="utf-8"))


def main(argv: list[str] | None = None) -> int:
    parser = argparse.ArgumentParser(description=__doc__)
    parser.add_argument(
        "--check",
        action="store_true",
        help="fail when a fixture on disk differs from the generated bytes",
    )
    args = parser.parse_args(argv)

    contract = load_json(CONTRACT_PATH)
    if contract["generator"] != GENERATOR:
        print(f"generator mismatch: contract expects {contract['generator']!r}", file=sys.stderr)
        return 2
    palette = load_json(TOKENS_PATH)["palette"]

    OUTPUT_DIR.mkdir(parents=True, exist_ok=True)
    failures: list[str] = []
    for asset in contract["assets"]:
        payload = build_asset(asset, palette)
        target = OUTPUT_DIR / asset["fileName"]
        if args.check:
            if not target.exists():
                failures.append(f"{asset['fileName']}: missing")
                continue
            if target.read_bytes() != payload:
                failures.append(f"{asset['fileName']}: differs from the generated contract")
            continue
        target.write_bytes(payload)
        print(f"wrote {target.relative_to(FRONTEND_DIR)} ({len(payload)} bytes)")

    if args.check:
        if failures:
            for failure in failures:
                print(f"FAIL {failure}", file=sys.stderr)
            return 1
        print(f"OK: {len(contract['assets'])} fixture assets match the contract")
    return 0


if __name__ == "__main__":
    raise SystemExit(main())
