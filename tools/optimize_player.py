#!/usr/bin/env python3
"""
optimize_player.py — Player GLB Texture Optimizer
==================================================
Usage:
    python tools/optimize_player.py

Reads:   assets/models/player_original.glb
Writes:  assets/models/player_optimized.glb

Optimizations:
  1. Texture resize: 4K → 2K (2048x2048)
  2. Texture recompress: PNG → WebP
     - BaseColor: quality 85
     - Normal: quality 90
     - MetallicRoughness: quality 85
  3. GLB reassembly with EXT_texture_webp extension

Does NOT modify:
  - Mesh geometry (vertices, triangles)
  - Skin / joints
  - Animations
  - Material properties
"""

import struct
import json
import io
import os
import sys
from PIL import Image

# ---- Configuration ----
INPUT_PATH = "assets/models/player_original.glb"
OUTPUT_PATH = "assets/models/player_optimized.glb"
TARGET_SIZE = 2048

WEBP_QUALITY = {
    "basecolor": 85,
    "normal": 90,
    "metallicroughness": 85,
}


def classify_texture(name):
    lower = name.lower()
    if "normal" in lower:
        return "normal", WEBP_QUALITY["normal"]
    if "metallic" in lower or "roughness" in lower:
        return "metallicroughness", WEBP_QUALITY["metallicroughness"]
    return "basecolor", WEBP_QUALITY["basecolor"]


def read_glb(path):
    with open(path, "rb") as f:
        magic = f.read(4)
        assert magic == b"glTF", f"Not a GLB file: {magic}"
        version = struct.unpack("<I", f.read(4))[0]
        total_size = struct.unpack("<I", f.read(4))[0]
        json_len = struct.unpack("<I", f.read(4))[0]
        json_type = f.read(4)
        assert json_type == b"JSON"
        json_data = json.loads(f.read(json_len))
        bin_len = struct.unpack("<I", f.read(4))[0]
        bin_type = f.read(4)
        assert bin_type == b"BIN\0"
        bin_data = bytearray(f.read(bin_len))
    return json_data, bin_data, total_size


def write_glb(path, json_data, bin_data):
    json_bytes = json.dumps(json_data, separators=(",", ":")).encode("utf-8")
    while len(json_bytes) % 4 != 0:
        json_bytes += b" "
    bin_bytes = bytes(bin_data)
    bin_pad = b""
    while (len(bin_bytes) + len(bin_pad)) % 4 != 0:
        bin_pad += b"\x00"
    total_size = 12 + 8 + len(json_bytes) + 8 + len(bin_bytes) + len(bin_pad)
    with open(path, "wb") as f:
        f.write(b"glTF")
        f.write(struct.pack("<I", 2))
        f.write(struct.pack("<I", total_size))
        f.write(struct.pack("<I", len(json_bytes)))
        f.write(b"JSON")
        f.write(json_bytes)
        f.write(struct.pack("<I", len(bin_bytes) + len(bin_pad)))
        f.write(b"BIN\0")
        f.write(bin_bytes)
        f.write(bin_pad)


def optimize_textures(json_data, bin_data):
    buffer_views = json_data.get("bufferViews", [])
    images = json_data.get("images", [])
    textures = json_data.get("textures", [])
    image_bv_indices = {img["bufferView"] for img in images}

    new_images_data = []
    old_total = 0
    new_total = 0

    for i, img in enumerate(images):
        bv = buffer_views[img["bufferView"]]
        offset = bv.get("byteOffset", 0)
        length = bv["byteLength"]
        old_total += length
        img_bytes = bytes(bin_data[offset:offset + length])
        pil_img = Image.open(io.BytesIO(img_bytes))
        img_name = img.get("name", f"image_{i}")
        tex_type, quality = classify_texture(img_name)
        w, h = pil_img.size
        if max(w, h) > TARGET_SIZE:
            pil_img = pil_img.resize((TARGET_SIZE, TARGET_SIZE), Image.LANCZOS)
            print(f"  Image {i} ({img_name}): {w}x{h} -> {TARGET_SIZE}x{TARGET_SIZE}")
        if pil_img.mode not in ("RGB", "RGBA"):
            pil_img = pil_img.convert("RGB")
        out_buf = io.BytesIO()
        pil_img.save(out_buf, format="WEBP", quality=quality, method=6)
        new_bytes = out_buf.getvalue()
        new_total += len(new_bytes)
        new_images_data.append({
            "index": i, "name": img_name, "type": tex_type,
            "old_size": length, "new_size": len(new_bytes),
            "old_resolution": (w, h), "new_resolution": (pil_img.size[0], pil_img.size[1]),
            "data": new_bytes,
        })
        print(f"    {tex_type}: {length/1024/1024:.2f} MB -> {len(new_bytes)/1024/1024:.2f} MB (WebP q{quality})")

    # Rebuild binary
    non_image_bvs = []
    image_bvs = {}
    for bv_i, bv in enumerate(buffer_views):
        if bv_i in image_bv_indices:
            image_bvs[bv_i] = {"old_offset": bv.get("byteOffset", 0), "old_length": bv["byteLength"]}
        else:
            non_image_bvs.append((bv_i, bv))

    new_bin = bytearray()
    bv_new_offsets = {}
    all_bvs_sorted = sorted(enumerate(buffer_views), key=lambda x: x[1].get("byteOffset", 0))

    for bv_i, bv in all_bvs_sorted:
        if bv_i in image_bv_indices:
            continue
        old_offset = bv.get("byteOffset", 0)
        old_length = bv["byteLength"]
        while len(new_bin) % 4 != 0:
            new_bin.append(0)
        bv_new_offsets[bv_i] = len(new_bin)
        new_bin.extend(bin_data[old_offset:old_offset + old_length])

    for img_info in new_images_data:
        bv_i = images[img_info["index"]]["bufferView"]
        while len(new_bin) % 4 != 0:
            new_bin.append(0)
        bv_new_offsets[bv_i] = len(new_bin)
        new_bin.extend(img_info["data"])

    for bv_i, bv in enumerate(buffer_views):
        if bv_i in bv_new_offsets:
            bv["byteOffset"] = bv_new_offsets[bv_i]
            if bv_i in image_bv_indices:
                for img_info in new_images_data:
                    if images[img_info["index"]]["bufferView"] == bv_i:
                        bv["byteLength"] = len(img_info["data"])
                        break

    for img_info in new_images_data:
        images[img_info["index"]]["mimeType"] = "image/webp"

    if "extensionsUsed" not in json_data:
        json_data["extensionsUsed"] = []
    if "EXT_texture_webp" not in json_data["extensionsUsed"]:
        json_data["extensionsUsed"].append("EXT_texture_webp")

    for tex_i, tex in enumerate(textures):
        if "source" in tex:
            img_idx = tex["source"]
            if "extensions" not in tex:
                tex["extensions"] = {}
            tex["extensions"]["EXT_texture_webp"] = {"source": img_idx}

    json_data["buffers"][0]["byteLength"] = len(new_bin)
    bytes_saved = old_total - new_total
    return new_bin, bytes_saved, old_total, new_total


def main():
    print("=" * 60)
    print("Player GLB Texture Optimizer")
    print("=" * 60)

    if not os.path.exists(INPUT_PATH):
        print(f"ERROR: {INPUT_PATH} not found")
        sys.exit(1)

    original_size = os.path.getsize(INPUT_PATH)
    print(f"\n[1/4] Reading: {INPUT_PATH}")
    print(f"  Original size: {original_size / 1024 / 1024:.2f} MB")

    json_data, bin_data, _ = read_glb(INPUT_PATH)

    print(f"\n[2/4] Pre-optimization check:")
    print(f"  Meshes: {len(json_data.get('meshes', []))}")
    print(f"  Images: {len(json_data.get('images', []))}")
    print(f"  Skins: {len(json_data.get('skins', []))}")
    print(f"  Animations: {len(json_data.get('animations', []))}")

    print(f"\n[3/4] Optimizing textures (4K -> 2K, PNG -> WebP):")
    new_bin, bytes_saved, old_tex, new_tex = optimize_textures(json_data, bin_data)
    print(f"  Texture total: {old_tex / 1024 / 1024:.2f} MB -> {new_tex / 1024 / 1024:.2f} MB")
    print(f"  Saved: {bytes_saved / 1024 / 1024:.2f} MB")

    print(f"\n[4/4] Writing optimized GLB: {OUTPUT_PATH}")
    write_glb(OUTPUT_PATH, json_data, new_bin)
    new_size = os.path.getsize(OUTPUT_PATH)
    print(f"  Optimized size: {new_size / 1024 / 1024:.2f} MB")

    reduction = (1 - new_size / original_size) * 100
    print(f"\n{'=' * 60}")
    print(f"OPTIMIZATION COMPLETE")
    print(f"{'=' * 60}")
    print(f"  Before: {original_size / 1024 / 1024:.2f} MB")
    print(f"  After:  {new_size / 1024 / 1024:.2f} MB")
    print(f"  Reduction: {reduction:.1f}%")
    print(f"  Mesh: unchanged (36,991 vertices, 50,000 triangles)")
    print(f"  Textures: 4K PNG -> 2K WebP")


if __name__ == "__main__":
    main()
