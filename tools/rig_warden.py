"""
Warden Boss Auto-Rig Script for Blender 4.x
============================================
Usage:
  blender --background --python tools/rig_warden.py -- --input assets/models/warden.glb --output assets/models/warden_rigged.glb

Or run from Blender's Scripting tab:
  1. Open this file in the Scripting tab
  2. Click "Run Script"
  3. The rigged GLB will be saved to assets/models/warden_rigged.glb

This script:
  1. Imports the GLB
  2. Standardizes scale/rotation (root rotation reset)
  3. Creates a humanoid armature matching the model's proportions
  4. Auto-weights the mesh to the armature
  5. Creates 6 placeholder animations (Idle, Cast, Slam, Hit, Death, PhaseChange)
  6. Exports as warden_rigged.glb with all materials/textures preserved
"""

import bpy
import bmesh
import math
import sys
import os
import argparse

# ─── Parse arguments ───
def parse_args():
    argv = sys.argv
    if "--" in argv:
        argv = argv[argv.index("--") + 1:]
    else:
        argv = []
    parser = argparse.ArgumentParser(description="Auto-rig Warden GLB")
    parser.add_argument("--input", default="assets/models/warden.glb", help="Input GLB path")
    parser.add_argument("--output", default="assets/models/warden_rigged.glb", help="Output GLB path")
    return parser.parse_args(argv)

# ─── Step 1: Clean scene ───
def clean_scene():
    bpy.ops.object.select_all(action='SELECT')
    bpy.ops.object.delete(use_global=False)
    for col in bpy.data.collections:
        bpy.data.collections.remove(col)
    for mesh in bpy.data.meshes:
        bpy.data.meshes.remove(mesh)
    for mat in bpy.data.materials:
        bpy.data.materials.remove(mat)
    for img in bpy.data.images:
        bpy.data.images.remove(img)

# ─── Step 2: Import GLB ───
def import_glb(filepath):
    bpy.ops.import_scene.gltf(filepath=filepath)
    imported = bpy.context.selected_objects
    if not imported:
        raise RuntimeError("No objects imported from GLB")
    # Find the mesh object
    mesh_obj = None
    for obj in imported:
        if obj.type == 'MESH':
            mesh_obj = obj
            break
    if not mesh_obj:
        raise RuntimeError("No mesh found in imported GLB")
    return mesh_obj

# ─── Step 3: Standardize transform ───
def standardize_transform(mesh_obj):
    # The GLB has a 90° X rotation from Blender's export. Reset it.
    mesh_obj.rotation_euler = (0, 0, 0)
    mesh_obj.location = (0, 0, 0)
    mesh_obj.scale = (1, 1, 1)
    bpy.context.view_layer.update()

    # Get bounding box in world space
    bbox = [mesh_obj.matrix_world @ mathutils_vec(corner) for corner in mesh_obj.bound_box]
    min_x = min(v[0] for v in bbox)
    max_x = max(v[0] for v in bbox)
    min_y = min(v[1] for v in bbox)
    max_y = max(v[1] for v in bbox)
    min_z = min(v[2] for v in bbox)
    max_z = max(v[2] for v in bbox)

    height = max_z - min_z
    width = max_x - min_x
    depth = max_y - min_y

    print(f"  Model bounds: X[{min_x:.3f}, {max_x:.3f}] Y[{min_y:.3f}, {max_y:.3f}] Z[{min_z:.3f}, {max_z:.3f}]")
    print(f"  Height={height:.3f} Width={width:.3f} Depth={depth:.3f}")

    # Center the model on origin (X, Y), keep feet at Z=0
    mesh_obj.location = (-(min_x + max_x) / 2, -(min_y + max_y) / 2, -min_z)
    bpy.context.view_layer.update()

    return {
        'height': height,
        'width': width,
        'depth': depth,
        'min_z': min_z,
    }

def mathutils_vec(v):
    from mathutils import Vector
    return Vector(v)

# ─── Step 4: Create humanoid armature ───
def create_armature(dims):
    """Create a humanoid armature scaled to the model's proportions."""
    h = dims['height']
    w = dims['width']

    # Proportional bone positions (relative to model height)
    # Standard humanoid: hips at ~48%, spine at ~55%, chest at ~70%, neck at ~82%, head at ~92%
    # Arms: shoulder at ~80%, elbow at ~65%, wrist at ~52%
    # Legs: hip at ~48%, knee at ~26%, ankle at ~5%

    bpy.ops.object.armature_add(enter_editmode=True, location=(0, 0, 0))
    armature = bpy.context.object
    armature.name = "WardenArmature"

    # Remove default bone
    edit_bones = armature.data.edit_bones
    for bone in list(edit_bones):
        edit_bones.remove(bone)

    # Bone positions (Z-up, model is centered at origin, feet at Z=0)
    z_hips = h * 0.48
    z_spine = h * 0.58
    z_chest = h * 0.72
    z_neck = h * 0.82
    z_head = h * 0.88
    z_head_top = h * 0.98
    z_shoulder = h * 0.80
    z_elbow = h * 0.62
    z_wrist = h * 0.48
    z_knee = h * 0.26
    z_ankle = h * 0.06

    arm_span = w * 0.45  # half-width for arms

    # Root
    root = edit_bones.new("Root")
    root.head = (0, 0, 0)
    root.tail = (0, 0, z_hips * 0.3)

    # Hips
    hips = edit_bones.new("Hips")
    hips.head = (0, 0, z_hips)
    hips.tail = (0, 0, z_hips + 0.01)
    hips.parent = root
    hips.use_connect = False

    # Spine
    spine = edit_bones.new("Spine")
    spine.head = (0, 0, z_hips)
    spine.tail = (0, 0, z_spine)
    spine.parent = hips
    spine.use_connect = False

    # Chest
    chest = edit_bones.new("Chest")
    chest.head = (0, 0, z_spine)
    chest.tail = (0, 0, z_chest)
    chest.parent = spine
    chest.use_connect = True

    # Neck
    neck = edit_bones.new("Neck")
    neck.head = (0, 0, z_chest)
    neck.tail = (0, 0, z_neck)
    neck.parent = chest
    neck.use_connect = False

    # Head
    head = edit_bones.new("Head")
    head.head = (0, 0, z_neck)
    head.tail = (0, 0, z_head_top)
    head.parent = neck
    head.use_connect = True

    # Left arm (character's left = +X side)
    l_shoulder = edit_bones.new("Shoulder_L")
    l_shoulder.head = (0, 0, z_shoulder)
    l_shoulder.tail = (arm_span * 0.4, 0, z_shoulder)
    l_shoulder.parent = chest
    l_shoulder.use_connect = False

    l_arm = edit_bones.new("Arm_L")
    l_arm.head = (arm_span * 0.4, 0, z_shoulder)
    l_arm.tail = (arm_span * 0.7, 0, z_elbow)
    l_arm.parent = l_shoulder
    l_arm.use_connect = True

    l_forearm = edit_bones.new("Forearm_L")
    l_forearm.head = (arm_span * 0.7, 0, z_elbow)
    l_forearm.tail = (arm_span * 0.9, 0, z_wrist)
    l_forearm.parent = l_arm
    l_forearm.use_connect = True

    l_hand = edit_bones.new("Hand_L")
    l_hand.head = (arm_span * 0.9, 0, z_wrist)
    l_hand.tail = (arm_span, 0, z_wrist - 0.05 * h)
    l_hand.parent = l_forearm
    l_hand.use_connect = True

    # Right arm (character's right = -X side)
    r_shoulder = edit_bones.new("Shoulder_R")
    r_shoulder.head = (0, 0, z_shoulder)
    r_shoulder.tail = (-arm_span * 0.4, 0, z_shoulder)
    r_shoulder.parent = chest
    r_shoulder.use_connect = False

    r_arm = edit_bones.new("Arm_R")
    r_arm.head = (-arm_span * 0.4, 0, z_shoulder)
    r_arm.tail = (-arm_span * 0.7, 0, z_elbow)
    r_arm.parent = r_shoulder
    r_arm.use_connect = True

    r_forearm = edit_bones.new("Forearm_R")
    r_forearm.head = (-arm_span * 0.7, 0, z_elbow)
    r_forearm.tail = (-arm_span * 0.9, 0, z_wrist)
    r_forearm.parent = r_arm
    r_forearm.use_connect = True

    r_hand = edit_bones.new("Hand_R")
    r_hand.head = (-arm_span * 0.9, 0, z_wrist)
    r_hand.tail = (-arm_span, 0, z_wrist - 0.05 * h)
    r_hand.parent = r_forearm
    r_hand.use_connect = True

    # Weapon bone (child of right hand — for staff attachment)
    weapon = edit_bones.new("Weapon_R")
    weapon.head = (-arm_span, 0, z_wrist)
    weapon.tail = (-arm_span, 0, z_wrist - 0.3 * h)
    weapon.parent = r_hand
    weapon.use_connect = False

    # Left leg
    l_thigh = edit_bones.new("Thigh_L")
    l_thigh.head = (w * 0.1, 0, z_hips)
    l_thigh.tail = (w * 0.1, 0, z_knee)
    l_thigh.parent = hips
    l_thigh.use_connect = False

    l_shin = edit_bones.new("Shin_L")
    l_shin.head = (w * 0.1, 0, z_knee)
    l_shin.tail = (w * 0.1, 0, z_ankle)
    l_shin.parent = l_thigh
    l_shin.use_connect = True

    l_foot = edit_bones.new("Foot_L")
    l_foot.head = (w * 0.1, 0, z_ankle)
    l_foot.tail = (w * 0.1, 0.1 * h, 0)
    l_foot.parent = l_shin
    l_foot.use_connect = True

    # Right leg
    r_thigh = edit_bones.new("Thigh_R")
    r_thigh.head = (-w * 0.1, 0, z_hips)
    r_thigh.tail = (-w * 0.1, 0, z_knee)
    r_thigh.parent = hips
    r_thigh.use_connect = False

    r_shin = edit_bones.new("Shin_R")
    r_shin.head = (-w * 0.1, 0, z_knee)
    r_shin.tail = (-w * 0.1, 0, z_ankle)
    r_shin.parent = r_thigh
    r_shin.use_connect = True

    r_foot = edit_bones.new("Foot_R")
    r_foot.head = (-w * 0.1, 0, z_ankle)
    r_foot.tail = (-w * 0.1, 0.1 * h, 0)
    r_foot.parent = r_shin
    r_foot.use_connect = True

    bpy.ops.object.mode_set(mode='OBJECT')
    return armature

# ─── Step 5: Parent mesh to armature with auto weights ───
def parent_with_auto_weights(mesh_obj, armature):
    # Deselect all
    bpy.ops.object.select_all(action='DESELECT')
    # Select mesh first, then armature (armature = active)
    mesh_obj.select_set(True)
    armature.select_set(True)
    bpy.context.view_layer.objects.active = armature
    # Parent with automatic weights
    bpy.ops.object.parent_set(type='ARMATURE_AUTO')

# ─── Step 6: Create placeholder animations ───
def create_animations(armature, dims):
    """Create 6 placeholder animations as NLA tracks."""
    h = dims['height']
    bpy.context.view_layer.objects.active = armature

    animations = {
        'Idle': {'duration': 60, 'loop': True},
        'Cast': {'duration': 30, 'loop': False},
        'Slam': {'duration': 35, 'loop': False},
        'Hit': {'duration': 15, 'loop': False},
        'Death': {'duration': 80, 'loop': False},
        'PhaseChange': {'duration': 60, 'loop': False},
    }

    action_data = {
        'Idle': [
            # Subtle breathing: chest scales up/down
            ('Chest', 'scale', 1, [1, 1, 1.02], [1, 1, 0.98]),
            # Head slight bob
            ('Head', 'location', 1, [0, 0, 0.01 * h], [0, 0, -0.01 * h]),
        ],
        'Cast': [
            # Arms raise slightly forward
            ('Arm_L', 'rotation_euler', 0, [0, -0.3, 0], [0, -0.6, 0]),
            ('Arm_R', 'rotation_euler', 0, [0, 0.3, 0], [0, 0.6, 0]),
            # Chest puffs up
            ('Chest', 'scale', 1, [1, 1, 1], [1, 1, 1.05]),
        ],
        'Slam': [
            # Arms swing down
            ('Arm_L', 'rotation_euler', 0, [0, 0.5, 0], [0, -0.3, 0]),
            ('Arm_R', 'rotation_euler', 0, [0, -0.5, 0], [0, 0.3, 0]),
            # Whole body dips
            ('Root', 'location', 2, [0, 0, 0], [0, 0, -0.1 * h]),
        ],
        'Hit': [
            # Brief backward lean
            ('Chest', 'rotation_euler', 0, [0.3, 0, 0], [0, 0, 0]),
            ('Head', 'rotation_euler', 0, [0.4, 0, 0], [0, 0, 0]),
        ],
        'Death': [
            # Fall forward and sink
            ('Root', 'rotation_euler', 0, [0, 0, 0], [0.6, 0, 0]),
            ('Root', 'location', 2, [0, 0, 0], [0, 0, -0.5 * h]),
            ('Head', 'rotation_euler', 0, [0, 0, 0], [0.3, 0, 0]),
        ],
        'PhaseChange': [
            # Arms spread wide, chest puffs
            ('Arm_L', 'rotation_euler', 0, [0, 0, 0.5], [0, 0, 1.0]),
            ('Arm_R', 'rotation_euler', 0, [0, 0, -0.5], [0, 0, -1.0]),
            ('Chest', 'scale', 1, [1, 1, 1], [1.05, 1.05, 1.08]),
            ('Root', 'location', 2, [0, 0, 0], [0, 0, 0.05 * h]),
        ],
    }

    for anim_name, config in animations.items():
        # Create new action
        action = bpy.data.actions.new(name=anim_name)
        action.use_cyclic = config['loop']

        # Set armature to rest pose
        bpy.ops.object.mode_set(mode='POSE')
        for bone in armature.pose.bones:
            bone.location = (0, 0, 0)
            bone.rotation_euler = (0, 0, 0)
            bone.scale = (1, 1, 1)

        # Insert keyframes
        bone_anim_data = action_data[anim_name]
        num_frames = config['duration']

        for bone_name, attr, axis, val_start, val_end in bone_anim_data:
            bone = armature.pose.bones.get(bone_name)
            if not bone:
                print(f"  Warning: bone '{bone_name}' not found, skipping")
                continue

            # Set start frame
            setattr(bone, attr, list(getattr(bone, attr)))
            getattr(bone, attr)[axis] = val_start
            bone.keyframe_insert(data_path=attr, frame=1)

            # Set mid/end frame
            getattr(bone, attr)[axis] = val_end
            bone.keyframe_insert(data_path=attr, frame=num_frames)

            # If looping, add return keyframe
            if config['loop']:
                getattr(bone, attr)[axis] = val_start
                bone.keyframe_insert(data_path=attr, frame=num_frames)

        bpy.ops.object.mode_set(mode='OBJECT')

        # Assign action to armature's animation data
        if armature.animation_data is None:
            armature.animation_data_create()
        armature.animation_data.action = action

        # Push to NLA track
        track = armature.animation_data.nla_tracks.new()
        track.name = anim_name
        strip = track.strips.new()
        strip.name = anim_name
        strip.action = action
        strip.action_frame_start = 1
        strip.action_frame_end = num_frames
        strip.frame_start = 1
        strip.frame_end = num_frames

    # Clear active action (so export doesn't double-bake)
    armature.animation_data.action = None

# ─── Step 7: Export GLB ───
def export_glb(filepath):
    bpy.ops.export_scene.gltf(
        filepath=filepath,
        export_format='GLB',
        export_apply=True,
        export_animations=True,
        export_animation_mode='ACTIONS',
        export_skins=True,
        export_morph=False,
        export_yup=True,
    )

# ─── Main ───
def main():
    args = parse_args()
    print(f"\n{'='*60}")
    print(f"Warden Boss Auto-Rig Script")
    print(f"Input:  {args.input}")
    print(f"Output: {args.output}")
    print(f"{'='*60}\n")

    # Step 1: Clean
    print("[1/7] Cleaning scene...")
    clean_scene()

    # Step 2: Import GLB
    print("[2/7] Importing GLB...")
    mesh_obj = import_glb(args.input)
    print(f"  Imported: {mesh_obj.name} ({len(mesh_obj.data.vertices)} verts)")

    # Step 3: Standardize transform
    print("[3/7] Standardizing transform...")
    dims = standardize_transform(mesh_obj)

    # Step 4: Create armature
    print("[4/7] Creating humanoid armature...")
    armature = create_armature(dims)
    bone_count = len(armature.data.bones)
    print(f"  Created armature with {bone_count} bones")

    # Step 5: Parent with auto weights
    print("[5/7] Parenting mesh with auto weights...")
    parent_with_auto_weights(mesh_obj, armature)
    print("  Auto weights applied")

    # Step 6: Create animations
    print("[6/7] Creating placeholder animations...")
    create_animations(armature, dims)
    print("  Created: Idle, Cast, Slam, Hit, Death, PhaseChange")

    # Step 7: Export
    print("[7/7] Exporting GLB...")
    export_glb(args.output)
    file_size = os.path.getsize(args.output) / (1024 * 1024)
    print(f"  Exported: {args.output} ({file_size:.1f} MB)")

    print(f"\n{'='*60}")
    print("DONE! warden_rigged.glb is ready.")
    print(f"Copy it to: assets/models/warden_rigged.glb")
    print(f"{'='*60}\n")

if __name__ == "__main__":
    main()
