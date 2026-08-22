#!/usr/bin/env python3
"""
animate_player.py — v0.3.0 Animation Upgrade
=============================================
Usage (run inside Blender):
    blender --background --python tools/animate_player.py

Input:  assets/models/player_rigged.glb  (v0.2.0: 6 animations incl. single Cast)
Output: assets/models/player_rigged_v03.glb  (8 animations: CastBasic/CastQ/CastE replace Cast)

What this does:
  1. Load the existing rigged GLB (preserves mesh, skin, materials, textures)
  2. Remove the old "Cast" action (may be named Cast_PlayerArmature)
  3. Create 3 new cast animations with distinct rhythms:
     - CastBasic: 0.67s, impact@50% — fast, snappy wand flick
     - CastQ:     1.04s, impact@64% — wind-up, powerful forward sweep
     - CastE:     0.83s, impact@55% — controlled, aimed point release
  4. Export as player_rigged_v03.glb (same mesh/skin/textures, new animation set)
"""

import bpy
import math
import os
import sys
from mathutils import Vector, Quaternion

SCRIPT_DIR = os.path.dirname(os.path.abspath(__file__))
PROJECT_DIR = os.path.dirname(SCRIPT_DIR)
INPUT_PATH = os.path.join(PROJECT_DIR, "assets", "models", "player_rigged.glb")
OUTPUT_PATH = os.path.join(PROJECT_DIR, "assets", "models", "player_rigged_v03.glb")

FPS = 24


def clear_scene():
    bpy.ops.object.select_all(action='SELECT')
    bpy.ops.object.delete(use_global=False)
    for block in list(bpy.data.meshes):
        bpy.data.meshes.remove(block)
    for block in list(bpy.data.materials):
        bpy.data.materials.remove(block)
    for block in list(bpy.data.images):
        bpy.data.images.remove(block)
    for block in list(bpy.data.armatures):
        bpy.data.armatures.remove(block)
    for block in list(bpy.data.actions):
        bpy.data.actions.remove(block)


def load_glb(path):
    bpy.ops.import_scene.gltf(filepath=path)
    # Find all objects
    arm_obj = None
    mesh_objs = []
    for o in bpy.context.scene.objects:
        if o.type == 'ARMATURE':
            arm_obj = o
        elif o.type == 'MESH':
            mesh_objs.append(o)
    if not arm_obj:
        raise RuntimeError("No armature found in GLB")
    print(f"  Loaded: armature={arm_obj.name}, meshes={[m.name for m in mesh_objs]}")
    print(f"  Bones: {len(arm_obj.data.bones)}")

    # List existing actions
    action_names = [a.name for a in bpy.data.actions]
    print(f"  Existing actions: {action_names}")
    return arm_obj, mesh_objs


# ---- Animation Helpers ----

def Q(axis, angle):
    return Quaternion(axis, angle)


def clear_pose(arm_obj):
    for bone in arm_obj.pose.bones:
        bone.location = (0, 0, 0)
        bone.rotation_mode = 'QUATERNION'
        bone.rotation_quaternion = Quaternion((1, 0, 0, 0))
        bone.scale = (1, 1, 1)


def set_bone_keyframe(arm_obj, bone_name, frame, location=None, rotation_quat=None):
    pbone = arm_obj.pose.bones.get(bone_name)
    if not pbone:
        return
    if location is not None:
        pbone.location = location
        pbone.keyframe_insert(data_path="location", frame=frame)
    if rotation_quat is not None:
        pbone.rotation_mode = 'QUATERNION'
        pbone.rotation_quaternion = rotation_quat
        pbone.keyframe_insert(data_path="rotation_quaternion", frame=frame)


def create_action(arm_obj, name, end_frame):
    action = bpy.data.actions.new(name)
    action.use_frame_range = True
    action.frame_start = 0
    action.frame_end = end_frame
    if arm_obj.animation_data is None:
        arm_obj.animation_data_create()
    arm_obj.animation_data.action = action
    return action


def delete_cast_actions():
    """Delete any action whose name starts with 'Cast' (handles Cast_PlayerArmature too)."""
    to_remove = []
    for a in bpy.data.actions:
        if a.name.startswith("Cast") and a.name not in ("CastBasic", "CastQ", "CastE"):
            to_remove.append(a.name)
    for name in to_remove:
        action = bpy.data.actions.get(name)
        if action:
            bpy.data.actions.remove(action)
            print(f"  Deleted action: {name}")


# ---- Cast Animations ----

def anim_cast_basic(arm, h):
    """CastBasic: fast wand flick, 0.67s = 16 frames, impact@50% (frame 8).
    Quick raise → wrist forward → release → fast recover."""
    kf = {
        0: {
            "UpperArm_R": Q((0, 0, 1), -0.1),
            "LowerArm_R": Q((1, 0, 0), 0),
            "Hand_R": Q((1, 0, 0), 0),
            "Chest": Q((0, 1, 0), 0),
            "Spine": Q((1, 0, 0), 0),
        },
        4: {
            "UpperArm_R": Q((0, 0, 1), -0.4),
            "LowerArm_R": Q((1, 0, 0), -0.2),
            "Hand_R": Q((1, 0, 0), 0.15),
            "Chest": Q((0, 1, 0), 0.06),
            "Spine": Q((1, 0, 0), -0.02),
        },
        8: {
            "UpperArm_R": Q((0, 0, 1), -0.55),
            "LowerArm_R": Q((1, 0, 0), -0.35),
            "Hand_R": Q((1, 0, 0), -0.2),
            "Chest": Q((0, 1, 0), 0.1),
            "Spine": Q((1, 0, 0), 0.03),
        },
        12: {
            "UpperArm_R": Q((0, 0, 1), -0.3),
            "LowerArm_R": Q((1, 0, 0), -0.15),
            "Hand_R": Q((1, 0, 0), 0.05),
            "Chest": Q((0, 1, 0), 0.04),
            "Spine": Q((1, 0, 0), 0),
        },
        16: {
            "UpperArm_R": Q((0, 0, 1), -0.1),
            "LowerArm_R": Q((1, 0, 0), 0),
            "Hand_R": Q((1, 0, 0), 0),
            "Chest": Q((0, 1, 0), 0),
            "Spine": Q((1, 0, 0), 0),
        },
    }
    for frame, bones in kf.items():
        for bone_name, rot in bones.items():
            set_bone_keyframe(arm, bone_name, frame, rotation_quat=rot)


def anim_cast_q(arm, h):
    """CastQ: powerful burst, 1.04s = 25 frames, impact@64% (frame 16).
    Wind-up: wand pulled back/side → strong forward sweep → big release → recover."""
    kf = {
        0: {
            "UpperArm_R": Q((0, 0, 1), -0.1),
            "LowerArm_R": Q((1, 0, 0), 0),
            "Hand_R": Q((1, 0, 0), 0),
            "UpperArm_L": Q((0, 0, 1), 0.08),
            "LowerArm_L": Q((1, 0, 0), 0),
            "Chest": Q((0, 1, 0), 0),
            "Spine": Q((1, 0, 0), 0),
        },
        6: {
            "UpperArm_R": Q((0, 1, 0), 0.3),
            "LowerArm_R": Q((1, 0, 0), -0.4),
            "Hand_R": Q((1, 0, 0), 0.2),
            "UpperArm_L": Q((0, 0, 1), 0.2),
            "LowerArm_L": Q((1, 0, 0), -0.3),
            "Chest": Q((0, 1, 0), -0.08),
            "Spine": Q((1, 0, 0), -0.06),
        },
        12: {
            "UpperArm_R": Q((0, 1, 0), 0.5),
            "LowerArm_R": Q((1, 0, 0), -0.6),
            "Hand_R": Q((1, 0, 0), 0.3),
            "UpperArm_L": Q((0, 0, 1), 0.35),
            "LowerArm_L": Q((1, 0, 0), -0.45),
            "Chest": Q((0, 1, 0), -0.12),
            "Spine": Q((1, 0, 0), -0.08),
        },
        16: {
            "UpperArm_R": Q((0, 0, 1), -0.7),
            "LowerArm_R": Q((1, 0, 0), -0.8),
            "Hand_R": Q((1, 0, 0), -0.3),
            "UpperArm_L": Q((0, 0, 1), 0.5),
            "LowerArm_L": Q((1, 0, 0), -0.6),
            "Chest": Q((0, 1, 0), 0.2),
            "Spine": Q((1, 0, 0), 0.08),
        },
        21: {
            "UpperArm_R": Q((0, 0, 1), -0.4),
            "LowerArm_R": Q((1, 0, 0), -0.4),
            "Hand_R": Q((1, 0, 0), -0.1),
            "UpperArm_L": Q((0, 0, 1), 0.25),
            "LowerArm_L": Q((1, 0, 0), -0.3),
            "Chest": Q((0, 1, 0), 0.08),
            "Spine": Q((1, 0, 0), 0.02),
        },
        25: {
            "UpperArm_R": Q((0, 0, 1), -0.1),
            "LowerArm_R": Q((1, 0, 0), 0),
            "Hand_R": Q((1, 0, 0), 0),
            "UpperArm_L": Q((0, 0, 1), 0.08),
            "LowerArm_L": Q((1, 0, 0), 0),
            "Chest": Q((0, 1, 0), 0),
            "Spine": Q((1, 0, 0), 0),
        },
    }
    for frame, bones in kf.items():
        for bone_name, rot in bones.items():
            set_bone_keyframe(arm, bone_name, frame, rotation_quat=rot)


def anim_cast_e(arm, h):
    """CastE: controlled point release, 0.83s = 20 frames, impact@55% (frame 11).
    Steady raise → brief hold → precise forward point → controlled release."""
    kf = {
        0: {
            "UpperArm_R": Q((0, 0, 1), -0.1),
            "LowerArm_R": Q((1, 0, 0), 0),
            "Hand_R": Q((1, 0, 0), 0),
            "Chest": Q((0, 1, 0), 0),
            "Spine": Q((1, 0, 0), 0),
            "Neck": Q((1, 0, 0), 0),
        },
        5: {
            "UpperArm_R": Q((0, 0, 1), -0.45),
            "LowerArm_R": Q((1, 0, 0), -0.3),
            "Hand_R": Q((1, 0, 0), 0.1),
            "Chest": Q((0, 1, 0), 0.08),
            "Spine": Q((1, 0, 0), -0.03),
            "Neck": Q((1, 0, 0), 0.04),
        },
        9: {
            "UpperArm_R": Q((0, 0, 1), -0.5),
            "LowerArm_R": Q((1, 0, 0), -0.35),
            "Hand_R": Q((1, 0, 0), 0.05),
            "Chest": Q((0, 1, 0), 0.1),
            "Spine": Q((1, 0, 0), -0.03),
            "Neck": Q((1, 0, 0), 0.06),
        },
        11: {
            "UpperArm_R": Q((0, 0, 1), -0.6),
            "LowerArm_R": Q((1, 0, 0), -0.45),
            "Hand_R": Q((1, 0, 0), -0.1),
            "Chest": Q((0, 1, 0), 0.12),
            "Spine": Q((1, 0, 0), 0.02),
            "Neck": Q((1, 0, 0), 0.04),
        },
        15: {
            "UpperArm_R": Q((0, 0, 1), -0.4),
            "LowerArm_R": Q((1, 0, 0), -0.25),
            "Hand_R": Q((1, 0, 0), 0.05),
            "Chest": Q((0, 1, 0), 0.06),
            "Spine": Q((1, 0, 0), 0),
            "Neck": Q((1, 0, 0), 0.02),
        },
        20: {
            "UpperArm_R": Q((0, 0, 1), -0.1),
            "LowerArm_R": Q((1, 0, 0), 0),
            "Hand_R": Q((1, 0, 0), 0),
            "Chest": Q((0, 1, 0), 0),
            "Spine": Q((1, 0, 0), 0),
            "Neck": Q((1, 0, 0), 0),
        },
    }
    for frame, bones in kf.items():
        for bone_name, rot in bones.items():
            set_bone_keyframe(arm, bone_name, frame, rotation_quat=rot)


def export_glb(arm_obj, mesh_objs, output_path):
    bpy.ops.object.select_all(action='DESELECT')
    arm_obj.select_set(True)
    for m in mesh_objs:
        m.select_set(True)
    bpy.context.view_layer.objects.active = arm_obj

    bpy.ops.export_scene.gltf(
        filepath=output_path,
        export_format='GLB',
        use_selection=True,
        export_apply=True,
        export_animations=True,
        export_animation_mode='ACTIONS',
        export_skins=True,
        export_morph=False,
        export_yup=False,
    )
    print(f"  Exported: {output_path}")


def main():
    print("=" * 60)
    print("v0.3.0 Animation Upgrade — CastBasic/CastQ/CastE")
    print("=" * 60)

    # 1. Clear scene
    print("\n[1/5] Clearing scene...")
    clear_scene()

    # 2. Load existing rigged GLB
    print(f"\n[2/5] Loading: {INPUT_PATH}")
    arm_obj, mesh_objs = load_glb(INPUT_PATH)

    # 3. Delete old "Cast" actions (may be Cast_PlayerArmature)
    print(f"\n[3/5] Removing old Cast actions...")
    delete_cast_actions()

    # 4. Create new cast animations
    print(f"\n[4/5] Generating new cast animations...")
    bpy.context.view_layer.objects.active = arm_obj
    bpy.ops.object.mode_set(mode='POSE')

    height = 1.8  # Standard height

    new_anims = [
        ("CastBasic", 16, anim_cast_basic),   # 0.67s, impact@50% (frame 8)
        ("CastQ", 25, anim_cast_q),            # 1.04s, impact@64% (frame 16)
        ("CastE", 20, anim_cast_e),            # 0.83s, impact@55% (frame 11)
    ]

    for name, duration, func in new_anims:
        print(f"  Creating {name} ({duration} frames, {duration/FPS:.2f}s)...")
        clear_pose(arm_obj)
        create_action(arm_obj, name, duration)
        func(arm_obj, height)

    bpy.ops.object.mode_set(mode='OBJECT')

    # List all actions in the file
    all_actions = [a.name for a in bpy.data.actions]
    print(f"\n  All actions: {all_actions}")

    # Set Idle as default action on armature
    idle_action = bpy.data.actions.get("Idle_PlayerArmature") or bpy.data.actions.get("Idle")
    if idle_action and arm_obj.animation_data:
        arm_obj.animation_data.action = idle_action

    # 5. Export
    print(f"\n[5/5] Exporting GLB...")
    export_glb(arm_obj, mesh_objs, OUTPUT_PATH)

    export_size = os.path.getsize(OUTPUT_PATH)
    print(f"\n{'=' * 60}")
    print(f"v0.3.0 ANIMATION UPGRADE COMPLETE")
    print(f"{'=' * 60}")
    print(f"  Output: {OUTPUT_PATH}")
    print(f"  Size: {export_size / 1024 / 1024:.2f} MB")
    print(f"  Meshes: {len(mesh_objs)}")
    print(f"  Animations: 8 (Idle, Run, CastBasic, CastQ, CastE, Dodge, Hit, Death)")
    print(f"  CastBasic: 16 frames / {16/FPS:.2f}s, impact@50%")
    print(f"  CastQ: 25 frames / {25/FPS:.2f}s, impact@64%")
    print(f"  CastE: 20 frames / {20/FPS:.2f}s, impact@55%")


if __name__ == "__main__":
    main()
