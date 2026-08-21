#!/usr/bin/env python3
"""
optimize_warden.py — Warden Boss GLB Texture Optimizer
=======================================================
Usage:
    python tools/optimize_warden.py

Reads:   assets/models/warden_rigged.glb (or warden_rigged_source.glb)
Writes:  assets/models/warden_rigged.glb (optimized, in-place)

Optimizations:
  1. Texture resize: 4K → 2K (2048x2048)
  2. Texture recompress: PNG → WebP
     - BaseColor: quality 85
     - Normal: quality 90
     - MetallicRoughness: quality 85
  3. GLB reassembly with EXT_texture_webp extension
  4. Validation: animation count, skin/joint count, mesh count

Requirements:
  pip install Pillow

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
INPUT_PATH = "assets/models/warden_rigged.glb"
BACKUP_PATH = "assets/models/warden_rigged_original.glb"
TARGET_SIZE = 2048  # Max texture dimension

WEBP_QUALITY = {
    "basecolor": 85,
    "normal": 90,
    "metallicroughness": 85,
}

def classify_texture(name):
    """Classify texture by name to determine WebP quality."""
    lower = name.lower()
    if "normal" in lower:
        return "normal", WEBP_QUALITY["normal"]
    if "metallic" in lower or "roughness" in lower:
        return "metallicroughness", WEBP_QUALITY["metallicroughness"]
    return "basecolor", WEBP_QUALITY["basecolor"]


def read_glb(path):
    """Read a GLB file and return (json_data, binary_data)."""
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
    """Write a GLB file from (json_data, binary_data)."""
    json_bytes = json.dumps(json_data, separators=(",", ":")).encode("utf-8")
    # Pad JSON to 4-byte alignment
    while len(json_bytes) % 4 != 0:
        json_bytes += b" "

    # Pad binary to 4-byte alignment
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
    """
    Resize textures to TARGET_SIZE and recompress as WebP.
    Returns (new_bin_data, bytes_saved).
    """
    buffer_views = json_data.get("bufferViews", [])
    images = json_data.get("images", [])
    accessors = json_data.get("accessors", [])
    textures = json_data.get("textures", [])

    # Track which bufferViews are images
    image_bv_indices = {img["bufferView"] for img in images}

    # Extract and process each image
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

        # Determine texture type
        img_name = img.get("name", f"image_{i}")
        tex_type, quality = classify_texture(img_name)

        # Resize if larger than target
        w, h = pil_img.size
        if max(w, h) > TARGET_SIZE:
            pil_img = pil_img.resize(
                (TARGET_SIZE, TARGET_SIZE), Image.LANCZOS
            )
            print(f"  Image {i} ({img_name}): {w}x{h} -> {TARGET_SIZE}x{TARGET_SIZE}")

        # Convert to RGB if needed (WebP doesn't support some modes)
        if pil_img.mode not in ("RGB", "RGBA"):
            pil_img = pil_img.convert("RGB")

        # Compress as WebP
        out_buf = io.BytesIO()
        pil_img.save(out_buf, format="WEBP", quality=quality, method=6)
        new_bytes = out_buf.getvalue()
        new_total += len(new_bytes)

        new_images_data.append({
            "index": i,
            "name": img_name,
            "type": tex_type,
            "old_size": length,
            "new_size": len(new_bytes),
            "old_resolution": (w, h),
            "new_resolution": (pil_img.size[0], pil_img.size[1]),
            "data": new_bytes,
        })
        print(f"    {tex_type}: {length/1024/1024:.2f} MB -> {len(new_bytes)/1024/1024:.2f} MB (WebP q{quality})")

    # Rebuild binary buffer: non-image bufferViews stay in place,
    # image bufferViews get replaced with new data
    # Strategy: build a new binary buffer from scratch

    # Collect all non-image bufferViews in order
    non_image_bvs = []
    image_bvs = {}

    for bv_i, bv in enumerate(buffer_views):
        if bv_i in image_bv_indices:
            # Mark for replacement
            old_offset = bv.get("byteOffset", 0)
            old_length = bv["byteLength"]
            image_bvs[bv_i] = {"old_offset": old_offset, "old_length": old_length}
        else:
            non_image_bvs.append((bv_i, bv))

    # Build new binary: keep non-image data, append new image data at end
    new_bin = bytearray()

    # First, copy all non-image bufferView data in their original order
    bv_new_offsets = {}

    # Sort by original offset to maintain order
    all_bvs_sorted = sorted(enumerate(buffer_views), key=lambda x: x[1].get("byteOffset", 0))

    for bv_i, bv in all_bvs_sorted:
        if bv_i in image_bv_indices:
            # Will be appended later
            continue
        old_offset = bv.get("byteOffset", 0)
        old_length = bv["byteLength"]
        # Align to 4 bytes
        while len(new_bin) % 4 != 0:
            new_bin.append(0)
        bv_new_offsets[bv_i] = len(new_bin)
        new_bin.extend(bin_data[old_offset:old_offset + old_length])

    # Now append image data
    for img_info in new_images_data:
        bv_i = images[img_info["index"]]["bufferView"]
        while len(new_bin) % 4 != 0:
            new_bin.append(0)
        bv_new_offsets[bv_i] = len(new_bin)
        new_bin.extend(img_info["data"])

    # Update bufferViews with new offsets and lengths
    for bv_i, bv in enumerate(buffer_views):
        if bv_i in bv_new_offsets:
            bv["byteOffset"] = bv_new_offsets[bv_i]
            if bv_i in image_bv_indices:
                # Update length for images
                for img_info in new_images_data:
                    if images[img_info["index"]]["bufferView"] == bv_i:
                        bv["byteLength"] = len(img_info["data"])
                        break

    # Update images to use WebP mimeType
    for img_info in new_images_data:
        images[img_info["index"]]["mimeType"] = "image/webp"

    # Add EXT_texture_webp extension if not present
    if "extensionsUsed" not in json_data:
        json_data["extensionsUsed"] = []
    if "EXT_texture_webp" not in json_data["extensionsUsed"]:
        json_data["extensionsUsed"].append("EXT_texture_webp")

    # Add extension to each texture that uses an image
    for tex_i, tex in enumerate(textures):
        if "source" in tex:
            img_idx = tex["source"]
            if "extensions" not in tex:
                tex["extensions"] = {}
            tex["extensions"]["EXT_texture_webp"] = {"source": img_idx}

    # Update buffer byteLength
    json_data["buffers"][0]["byteLength"] = len(new_bin)

    bytes_saved = old_total - new_total
    return new_bin, bytes_saved, old_total, new_total


def validate_glb(json_data, bin_data):
    """Validate that the GLB has all required components."""
    issues = []

    meshes = json_data.get("meshes", [])
    if len(meshes) != 2:
        issues.append(f"Mesh count: expected 2, got {len(meshes)}")

    skins = json_data.get("skins", [])
    if len(skins) != 1:
        issues.append(f"Skin count: expected 1, got {len(skins)}")
    elif len(skins[0].get("joints", [])) != 22:
        issues.append(f"Joint count: expected 22, got {len(skins[0].get('joints', []))}")

    anims = json_data.get("animations", [])
    expected_anims = {"Cast", "Death", "Hit", "Idle", "PhaseChange", "Slam"}
    actual_anims = {a["name"] for a in anims}
    if actual_anims != expected_anims:
        issues.append(f"Animations mismatch: expected {expected_anims}, got {actual_anims}")

    images = json_data.get("images", [])
    if len(images) != 3:
        issues.append(f"Image count: expected 3, got {len(images)}")

    return issues


def main():
    print("=" * 60)
    print("Warden GLB Texture Optimizer")
    print("=" * 60)

    if not os.path.exists(INPUT_PATH):
        print(f"ERROR: {INPUT_PATH} not found")
        sys.exit(1)

    # Read original file
    original_size = os.path.getsize(INPUT_PATH)
    print(f"\n[1/5] Reading: {INPUT_PATH}")
    print(f"  Original size: {original_size / 1024 / 1024:.2f} MB")

    json_data, bin_data, _ = read_glb(INPUT_PATH)

    # Validate before optimization
    print(f"\n[2/5] Pre-optimization validation:")
    issues = validate_glb(json_data, bin_data)
    if issues:
        print("  WARNING: " + "; ".join(issues))
    else:
        print("  OK: 2 meshes, 1 skin (22 joints), 6 animations, 3 textures")

    # Backup original
    print(f"\n[3/5] Backing up original to: {BACKUP_PATH}")
    import shutil
    shutil.copy2(INPUT_PATH, BACKUP_PATH)
    backup_size = os.path.getsize(BACKUP_PATH)
    print(f"  Backup size: {backup_size / 1024 / 1024:.2f} MB")

    # Optimize textures
    print(f"\n[4/5] Optimizing textures (4K -> 2K, PNG -> WebP):")
    new_bin, bytes_saved, old_tex, new_tex = optimize_textures(json_data, bin_data)
    print(f"  Texture total: {old_tex / 1024 / 1024:.2f} MB -> {new_tex / 1024 / 1024:.2f} MB")
    print(f"  Saved: {bytes_saved / 1024 / 1024:.2f} MB")

    # Write optimized GLB
    print(f"\n[5/5] Writing optimized GLB: {INPUT_PATH}")
    write_glb(INPUT_PATH, json_data, new_bin)
    new_size = os.path.getsize(INPUT_PATH)
    print(f"  Optimized size: {new_size / 1024 / 1024:.2f} MB")

    # Validate after optimization
    print(f"\n--- Post-optimization validation ---")
    json_data2, bin_data2, _ = read_glb(INPUT_PATH)
    issues2 = validate_glb(json_data2, bin_data2)
    if issues2:
        print("  VALIDATION FAILED: " + "; ".join(issues2))
        print("  Restoring backup...")
        shutil.copy2(BACKUP_PATH, INPUT_PATH)
        sys.exit(1)
    else:
        print("  OK: 2 meshes, 1 skin (22 joints), 6 animations, 3 textures (WebP)")

    # Summary
    reduction = (1 - new_size / original_size) * 100
    print(f"\n{'=' * 60}")
    print(f"OPTIMIZATION COMPLETE")
    print(f"{'=' * 60}")
    print(f"  Before: {original_size / 1024 / 1024:.2f} MB")
    print(f"  After:  {new_size / 1024 / 1024:.2f} MB")
    print(f"  Reduction: {reduction:.1f}%")
    print(f"  Texture: 4K PNG -> 2K WebP")
    print(f"  Mesh: unchanged (50,008 triangles)")
    print(f"  Animations: 6 (unchanged)")
    print(f"  Skin: 1 (22 joints, unchanged)")
    print(f"  Backup: {BACKUP_PATH}")


if __name__ == "__main__":
    main()
