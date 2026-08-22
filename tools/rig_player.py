#!/usr/bin/env python3
"""
rig_player.py — Player Model Rigging + Animation Pipeline
==========================================================
Usage (run inside Blender):
    blender --background --python tools/rig_player.py

Input:  assets/models/player_optimized.glb  (optimized textures, no skin/anim)
Output: assets/models/player_rigged.glb     (skin + skeleton + 6 animations)

Steps:
  1. Load optimized GLB, apply node transforms so mesh is Y-up
  2. Scale to target height (~1.8 units), center X/Z, feet at Y=0
  3. Compute humanoid skeleton positions from mesh bbox
  4. Create armature with 17 humanoid bones
  5. Parent mesh to armature with automatic weights
  6. Generate 6 keyframe animations (Idle, Run, Cast, Dodge, Hit, Death)
  7. Export as GLB with skin + animations
"""

import bpy
import bmesh
import math
import os
import sys
from mathutils import Vector, Quaternion, Matrix

# ---- Configuration ----
SCRIPT_DIR = os.path.dirname(os.path.abspath(__file__))
PROJECT_DIR = os.path.dirname(SCRIPT_DIR)
INPUT_PATH = os.path.join(PROJECT_DIR, "assets", "models", "player_optimized.glb")
OUTPUT_PATH = os.path.join(PROJECT_DIR, "assets", "models", "player_rigged.glb")

TARGET_HEIGHT = 1.8  # Target world height in game units

# Bone hierarchy: (name, parent_name)
BONE_HIERARCHY = [
    ("Hips", None),
    ("Spine", "Hips"),
    ("Chest", "Spine"),
    ("Neck", "Chest"),
    ("Head", "Neck"),
    ("UpperArm_L", "Chest"),
    ("LowerArm_L", "UpperArm_L"),
    ("Hand_L", "LowerArm_L"),
    ("UpperArm_R", "Chest"),
    ("LowerArm_R", "UpperArm_R"),
    ("Hand_R", "LowerArm_R"),
    ("UpperLeg_L", "Hips"),
    ("LowerLeg_L", "UpperLeg_L"),
    ("Foot_L", "LowerLeg_L"),
    ("UpperLeg_R", "Hips"),
    ("LowerLeg_R", "UpperLeg_R"),
    ("Foot_R", "LowerLeg_R"),
]


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
    imported = [o for o in bpy.context.scene.objects if o.type == 'MESH']
    if not imported:
        raise RuntimeError("No mesh found in GLB")
    mesh_obj = imported[0]
    print(f"  Loaded mesh: {mesh_obj.name}, verts={len(mesh_obj.data.vertices)}, faces={len(mesh_obj.data.polygons)}")
    return mesh_obj


def apply_node_transforms(mesh_obj):
    """Apply node transforms, then detect and fix orientation.
    The Hunyuan model may be Z-up; Blender is Y-up."""
    bpy.context.view_layer.objects.active = mesh_obj
    mesh_obj.select_set(True)
    bpy.ops.object.transform_apply(location=True, rotation=True, scale=True)

    # Check which axis is "up" — the longest axis after apply should be height
    bbox_min, bbox_max = get_mesh_bbox(mesh_obj)
    dx = bbox_max.x - bbox_min.x
    dy = bbox_max.y - bbox_min.y
    dz = bbox_max.z - bbox_min.z
    print(f"  After apply: X={dx:.3f}, Y={dy:.3f}, Z={dz:.3f}")

    # If Z is the tallest axis, rotate -90° around X to make Z-up into Y-up
    if dz > dy and dz > dx:
        print(f"  Model is Z-up (Z={dz:.3f}), rotating -90° X to make Y-up")
        mesh_obj.rotation_euler = (0, 0, 0)
        mesh_obj.rotation_mode = 'AXIS_ANGLE'
        mesh_obj.rotation_axis_angle = (1, 0, 0, 0)
        # Use matrix rotation
        mesh_obj.matrix_world = Matrix.Rotation(-math.pi / 2, 4, 'X') @ mesh_obj.matrix_world
        bpy.ops.object.transform_apply(location=True, rotation=True, scale=True)
        bbox_min2, bbox_max2 = get_mesh_bbox(mesh_obj)
        print(f"  After rotation: X={bbox_max2.x-bbox_min2.x:.3f}, Y={bbox_max2.y-bbox_min2.y:.3f}, Z={bbox_max2.z-bbox_min2.z:.3f}")

    print("  Applied node transforms to mesh data")


def get_mesh_bbox(mesh_obj):
    """Get world-space bounding box."""
    bbox_min = Vector((float('inf'),) * 3)
    bbox_max = Vector((float('-inf'),) * 3)
    for corner in mesh_obj.bound_box:
        world_corner = mesh_obj.matrix_world @ Vector(corner)
        for i in range(3):
            if world_corner[i] < bbox_min[i]:
                bbox_min[i] = world_corner[i]
            if world_corner[i] > bbox_max[i]:
                bbox_max[i] = world_corner[i]
    return bbox_min, bbox_max


def normalize_model(mesh_obj):
    """Scale model to target height, center X/Z, feet at Y=0."""
    bbox_min, bbox_max = get_mesh_bbox(mesh_obj)
    actual_height = bbox_max.y - bbox_min.y
    if actual_height < 0.01:
        actual_height = bbox_max.z - bbox_min.z
    scale = TARGET_HEIGHT / actual_height
    print(f"  Original height: {actual_height:.3f}, target: {TARGET_HEIGHT}, scale: {scale:.4f}")

    mesh_obj.scale = (scale, scale, scale)
    bpy.context.view_layer.objects.active = mesh_obj
    bpy.ops.object.transform_apply(location=False, rotation=False, scale=True)

    # Recompute bbox after scale
    bpy.context.view_layer.update()
    bbox_min, bbox_max = get_mesh_bbox(mesh_obj)

    # Center X/Z, feet at Y=0
    offset_x = -(bbox_min.x + bbox_max.x) * 0.5
    offset_z = -(bbox_min.z + bbox_max.z) * 0.5
    offset_y = -bbox_min.y

    mesh_obj.location.x += offset_x
    mesh_obj.location.y += offset_y
    mesh_obj.location.z += offset_z
    bpy.ops.object.transform_apply(location=True, rotation=False, scale=False)
    bpy.context.view_layer.update()

    # Verify
    bbox_min2, bbox_max2 = get_mesh_bbox(mesh_obj)
    print(f"  After normalize: min={bbox_min2}, max={bbox_max2}, height={bbox_max2.y - bbox_min2.y:.3f}")

    return bbox_min2, bbox_max2


def compute_skeleton_positions(bbox_min, bbox_max):
    """Compute bone positions based on mesh bbox. Model is Y-up, feet at Y=0."""
    height = bbox_max.y - bbox_min.y  # Should be ~1.8 after normalize
    feet_y = bbox_min.y  # Should be 0
    center_x = (bbox_min.x + bbox_max.x) * 0.5
    center_z = (bbox_min.z + bbox_max.z) * 0.5
    width = bbox_max.x - bbox_min.x
    depth = bbox_max.z - bbox_min.z

    print(f"  Skeleton: height={height:.3f}, width={width:.3f}, depth={depth:.3f}")

    h = height
    base_y = feet_y
    positions = {}

    # Lower body
    positions["Hips"] = Vector((center_x, base_y + h * 0.48, center_z))
    hip_width = min(width * 0.25, 0.12)
    positions["UpperLeg_L"] = Vector((center_x + hip_width, base_y + h * 0.43, center_z))
    positions["UpperLeg_R"] = Vector((center_x - hip_width, base_y + h * 0.43, center_z))
    positions["LowerLeg_L"] = Vector((center_x + hip_width, base_y + h * 0.23, center_z))
    positions["LowerLeg_R"] = Vector((center_x - hip_width, base_y + h * 0.23, center_z))
    positions["Foot_L"] = Vector((center_x + hip_width, base_y + h * 0.02, center_z + depth * 0.08))
    positions["Foot_R"] = Vector((center_x - hip_width, base_y + h * 0.02, center_z + depth * 0.08))

    # Spine
    positions["Spine"] = Vector((center_x, base_y + h * 0.58, center_z))
    positions["Chest"] = Vector((center_x, base_y + h * 0.72, center_z))

    # Neck & Head
    positions["Neck"] = Vector((center_x, base_y + h * 0.84, center_z))
    positions["Head"] = Vector((center_x, base_y + h * 0.92, center_z))

    # Arms — shoulders at chest level, arms hang down
    shoulder_y = base_y + h * 0.76
    shoulder_x = min(width * 0.42, 0.22)
    arm_length = h * 0.14
    forearm_length = h * 0.13

    positions["UpperArm_L"] = Vector((center_x + shoulder_x, shoulder_y, center_z))
    positions["LowerArm_L"] = Vector((center_x + shoulder_x, shoulder_y - arm_length, center_z))
    positions["Hand_L"] = Vector((center_x + shoulder_x, shoulder_y - arm_length - forearm_length, center_z))

    positions["UpperArm_R"] = Vector((center_x - shoulder_x, shoulder_y, center_z))
    positions["LowerArm_R"] = Vector((center_x - shoulder_x, shoulder_y - arm_length, center_z))
    positions["Hand_R"] = Vector((center_x - shoulder_x, shoulder_y - arm_length - forearm_length, center_z))

    return positions, height


def create_armature(positions, height):
    """Create armature with humanoid bone hierarchy."""
    arm_data = bpy.data.armatures.new("PlayerArmature")
    arm_obj = bpy.data.objects.new("PlayerArmature", arm_data)
    bpy.context.collection.objects.link(arm_obj)
    bpy.context.view_layer.objects.active = arm_obj
    bpy.ops.object.mode_set(mode='EDIT')

    for name, parent_name in BONE_HIERARCHY:
        bone = arm_data.edit_bones.new(name)
        bone.head = positions[name]

        # Find children to determine tail
        children = [c for c, p in BONE_HIERARCHY if p == name]
        if children:
            bone.tail = positions[children[0]]
        else:
            # End bones: extend in natural direction
            if name == "Head":
                bone.tail = positions[name] + Vector((0, height * 0.06, 0))
            elif "Hand" in name:
                bone.tail = positions[name] + Vector((0, -0.04, 0))
            elif "Foot" in name:
                bone.tail = positions[name] + Vector((0, 0, 0.06))
            else:
                bone.tail = positions[name] + Vector((0, -0.03, 0))

        if parent_name:
            bone.parent = arm_data.edit_bones[parent_name]

    bpy.ops.object.mode_set(mode='OBJECT')
    return arm_obj


def rig_mesh_to_armature(mesh_obj, arm_obj):
    """Parent mesh to armature, then assign weights manually using nearest-bone strategy.
    The Hunyuan mesh has 1000+ disconnected components, so Blender's ARMATURE_AUTO
    (heat diffusion) fails. We use bone proximity weighting instead."""
    # First parent with empty groups
    bpy.ops.object.select_all(action='DESELECT')
    mesh_obj.select_set(True)
    arm_obj.select_set(True)
    bpy.context.view_layer.objects.active = arm_obj
    bpy.ops.object.parent_set(type='ARMATURE')

    # Now assign weights manually using nearest bone
    bpy.context.view_layer.objects.active = mesh_obj
    bpy.ops.object.mode_set(mode='WEIGHT_PAINT')
    bpy.ops.object.mode_set(mode='OBJECT')

    # Get bone world positions
    bone_positions = {}
    for bone in arm_obj.data.bones:
        head_world = arm_obj.matrix_world @ bone.head_local
        tail_world = arm_obj.matrix_world @ bone.tail_local
        bone_positions[bone.name] = (head_world, tail_world)

    # Get mesh vertices in world space
    mesh = mesh_obj.data
    mw = mesh_obj.matrix_world

    # Create vertex groups for all bones
    for bone_name in bone_positions:
        if bone_name not in mesh_obj.vertex_groups:
            mesh_obj.vertex_groups.new(name=bone_name)

    # For each vertex, find nearest bone segment and assign weight
    # Use a blend of 2 nearest bones for smoother deformation
    print("  Computing nearest-bone weights for 36991 vertices...")
    batch_size = 5000
    for start in range(0, len(mesh.vertices), batch_size):
        end = min(start + batch_size, len(mesh.vertices))
        for vi in range(start, end):
            v = mw @ mesh.vertices[vi].co
            # Compute distance to each bone segment
            distances = []
            for bone_name, (head, tail) in bone_positions.items():
                d = point_to_segment_dist(v, head, tail)
                distances.append((d, bone_name))
            distances.sort(key=lambda x: x[0])

            # Assign weights: nearest bone gets 0.7, second gets 0.3
            if len(distances) >= 2:
                d0, b0 = distances[0]
                d1, b1 = distances[1]
                # Weight by inverse distance
                w0 = 1.0 / (d0 + 0.001)
                w1 = 1.0 / (d1 + 0.001)
                total = w0 + w1
                w0 /= total
                w1 /= total
                mesh_obj.vertex_groups[b0].add([vi], w0, 'REPLACE')
                mesh_obj.vertex_groups[b1].add([vi], w1, 'REPLACE')
            else:
                d0, b0 = distances[0]
                mesh_obj.vertex_groups[b0].add([vi], 1.0, 'REPLACE')

        if end % 10000 == 0 or end == len(mesh.vertices):
            print(f"    {end}/{len(mesh.vertices)} vertices weighted")

    print("  Nearest-bone weights assigned")


def point_to_segment_dist(p, a, b):
    """Distance from point p to segment a-b."""
    ab = b - a
    ap = p - a
    t = ap.dot(ab) / (ab.dot(ab) + 1e-8)
    t = max(0, min(1, t))
    closest = a + ab * t
    return (p - closest).length


# ---- Animation Helpers ----

def set_bone_keyframe(arm_obj, bone_name, frame, location=None, rotation_quat=None):
    """Set a keyframe on a pose bone."""
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


def Q(axis, angle):
    return Quaternion(axis, angle)


def clear_pose(arm_obj):
    for bone in arm_obj.pose.bones:
        bone.location = (0, 0, 0)
        bone.rotation_mode = 'QUATERNION'
        bone.rotation_quaternion = Quaternion((1, 0, 0, 0))
        bone.scale = (1, 1, 1)


def create_action(arm_obj, name, end_frame):
    action = bpy.data.actions.new(name)
    action.use_frame_range = True
    action.frame_start = 0
    action.frame_end = end_frame
    if arm_obj.animation_data is None:
        arm_obj.animation_data_create()
    arm_obj.animation_data.action = action
    return action


# ---- Animation Definitions ----

def anim_idle(arm, h):
    """Idle: breathing, slight weight shift, 3 sec loop at 24fps = 72 frames."""
    frames = [0, 18, 36, 54, 72]
    for f in frames:
        t = f / 72.0
        breath = math.sin(t * math.pi * 2) * 0.01
        set_bone_keyframe(arm, "Spine", f, location=Vector((0, breath, 0)),
                          rotation_quat=Q((1, 0, 0), breath * 0.2))
        set_bone_keyframe(arm, "Chest", f, rotation_quat=Q((1, 0, 0), breath * 0.15))
        set_bone_keyframe(arm, "Head", f, rotation_quat=Q((1, 0, 0), math.sin(t * math.pi * 2 + 0.5) * 0.02))
        arm_sway = math.sin(t * math.pi * 2) * 0.02
        set_bone_keyframe(arm, "UpperArm_L", f, rotation_quat=Q((0, 0, 1), 0.08 + arm_sway))
        set_bone_keyframe(arm, "UpperArm_R", f, rotation_quat=Q((0, 0, 1), -0.08 - arm_sway))
    # Ensure loop: frame 0 == frame 72
    for bn in ["Spine", "Chest", "Head", "UpperArm_L", "UpperArm_R"]:
        pb = arm.pose.bones[bn]
        pb.keyframe_insert(data_path="location", frame=0)
        pb.keyframe_insert(data_path="rotation_quaternion", frame=0)
        pb.keyframe_insert(data_path="location", frame=72)
        pb.keyframe_insert(data_path="rotation_quaternion", frame=72)


def anim_run(arm, h):
    """Run: light jog, 0.9 sec loop at 24fps = 22 frames."""
    frames = [0, 6, 11, 16, 22]
    for f in frames:
        t = f / 22.0
        cycle = t * math.pi * 2
        leg_swing = 0.4
        set_bone_keyframe(arm, "UpperLeg_L", f, rotation_quat=Q((1, 0, 0), math.sin(cycle) * leg_swing))
        set_bone_keyframe(arm, "UpperLeg_R", f, rotation_quat=Q((1, 0, 0), math.sin(cycle + math.pi) * leg_swing))
        set_bone_keyframe(arm, "LowerLeg_L", f, rotation_quat=Q((1, 0, 0), -max(0, math.sin(cycle + 1.0)) * 0.5))
        set_bone_keyframe(arm, "LowerLeg_R", f, rotation_quat=Q((1, 0, 0), -max(0, math.sin(cycle + 1.0 + math.pi)) * 0.5))
        arm_swing = 0.35
        set_bone_keyframe(arm, "UpperArm_L", f, rotation_quat=Q((1, 0, 0), math.sin(cycle + math.pi) * arm_swing))
        set_bone_keyframe(arm, "UpperArm_R", f, rotation_quat=Q((1, 0, 0), math.sin(cycle) * arm_swing))
        bob = math.sin(cycle * 2) * 0.015
        set_bone_keyframe(arm, "Spine", f, location=Vector((0, bob, 0)), rotation_quat=Q((1, 0, 0), 0.08))
        set_bone_keyframe(arm, "Hips", f, location=Vector((0, bob * 0.5, 0)))


def anim_cast(arm, h):
    """Cast: raise wand → release at 55% → recover, 0.9 sec = 22 frames."""
    # Frame 0: neutral, 8: raise, 12: release (~55%), 18: recover, 22: neutral
    kf = {
        0: {"UpperArm_R": Q((0, 0, 1), -0.1), "LowerArm_R": Q((1, 0, 0), 0),
            "Chest": Q((0, 1, 0), 0), "Spine": Q((1, 0, 0), 0)},
        8: {"UpperArm_R": Q((0, 0, 1), -0.6), "LowerArm_R": Q((1, 0, 0), -0.3),
            "Chest": Q((0, 1, 0), 0.1), "Spine": Q((1, 0, 0), -0.05)},
        12: {"UpperArm_R": Q((0, 0, 1), -0.8), "LowerArm_R": Q((1, 0, 0), -0.5),
             "Chest": Q((0, 1, 0), 0.15), "Spine": Q((1, 0, 0), 0.05)},
        18: {"UpperArm_R": Q((0, 0, 1), -0.4), "LowerArm_R": Q((1, 0, 0), -0.2),
            "Chest": Q((0, 1, 0), 0.05), "Spine": Q((1, 0, 0), 0)},
        22: {"UpperArm_R": Q((0, 0, 1), -0.1), "LowerArm_R": Q((1, 0, 0), 0),
            "Chest": Q((0, 1, 0), 0), "Spine": Q((1, 0, 0), 0)},
    }
    for frame, bones in kf.items():
        for bone_name, rot in bones.items():
            set_bone_keyframe(arm, bone_name, frame, rotation_quat=rot)


def anim_dodge(arm, h):
    """Dodge: quick crouch/sidestep, 0.55 sec = 13 frames."""
    kf = {
        0: {"Spine": (Q((1, 0, 0), 0), Vector((0, 0, 0))),
            "Hips": Vector((0, 0, 0)),
            "UpperLeg_L": Q((1, 0, 0), 0), "UpperLeg_R": Q((1, 0, 0), 0),
            "LowerLeg_L": Q((1, 0, 0), 0), "LowerLeg_R": Q((1, 0, 0), 0)},
        4: {"Spine": (Q((1, 0, 0), 0.3), Vector((0, -0.08, 0))),
            "Hips": Vector((0, -0.12, 0)),
            "UpperLeg_L": Q((1, 0, 0), 0.4), "UpperLeg_R": Q((1, 0, 0), 0.4),
            "LowerLeg_L": Q((1, 0, 0), -0.5), "LowerLeg_R": Q((1, 0, 0), -0.5)},
        8: {"Spine": (Q((1, 0, 0), 0.35), Vector((0, -0.1, 0))),
            "Hips": Vector((0, -0.15, 0)),
            "UpperLeg_L": Q((1, 0, 0), 0.45), "UpperLeg_R": Q((1, 0, 0), 0.45),
            "LowerLeg_L": Q((1, 0, 0), -0.55), "LowerLeg_R": Q((1, 0, 0), -0.55)},
        13: {"Spine": (Q((1, 0, 0), 0), Vector((0, 0, 0))),
             "Hips": Vector((0, 0, 0)),
             "UpperLeg_L": Q((1, 0, 0), 0), "UpperLeg_R": Q((1, 0, 0), 0),
             "LowerLeg_L": Q((1, 0, 0), 0), "LowerLeg_R": Q((1, 0, 0), 0)},
    }
    for frame, bones in kf.items():
        for bone_name, data in bones.items():
            if isinstance(data, tuple):
                set_bone_keyframe(arm, bone_name, frame, rotation_quat=data[0], location=data[1])
            elif isinstance(data, Vector):
                set_bone_keyframe(arm, bone_name, frame, location=data)
            else:
                set_bone_keyframe(arm, bone_name, frame, rotation_quat=data)


def anim_hit(arm, h):
    """Hit: slight backward recoil, 0.3 sec = 7 frames."""
    kf = {
        0: {"Spine": Q((1, 0, 0), 0), "Chest": Q((1, 0, 0), 0), "Head": Q((1, 0, 0), 0),
            "UpperArm_L": Q((0, 0, 1), 0.08), "UpperArm_R": Q((0, 0, 1), -0.08)},
        3: {"Spine": Q((1, 0, 0), -0.12), "Chest": Q((1, 0, 0), -0.08), "Head": Q((1, 0, 0), -0.08),
            "UpperArm_L": Q((0, 0, 1), 0.2), "UpperArm_R": Q((0, 0, 1), -0.2)},
        7: {"Spine": Q((1, 0, 0), 0), "Chest": Q((1, 0, 0), 0), "Head": Q((1, 0, 0), 0),
            "UpperArm_L": Q((0, 0, 1), 0.08), "UpperArm_R": Q((0, 0, 1), -0.08)},
    }
    for frame, bones in kf.items():
        for bone_name, rot in bones.items():
            set_bone_keyframe(arm, bone_name, frame, rotation_quat=rot)


def anim_death(arm, h):
    """Death: collapse forward/down, 1.8 sec = 43 frames."""
    kf = {
        0: {"Spine": (Q((1, 0, 0), 0), Vector((0, 0, 0))),
            "Chest": Q((1, 0, 0), 0),
            "Hips": Vector((0, 0, 0)),
            "UpperLeg_L": Q((1, 0, 0), 0), "UpperLeg_R": Q((1, 0, 0), 0),
            "LowerLeg_L": Q((1, 0, 0), 0), "LowerLeg_R": Q((1, 0, 0), 0),
            "Head": Q((1, 0, 0), 0),
            "UpperArm_L": Q((0, 0, 1), 0.08), "UpperArm_R": Q((0, 0, 1), -0.08)},
        12: {"Spine": (Q((1, 0, 0), 0.3), Vector((0, -0.04, 0))),
             "Chest": Q((1, 0, 0), 0.2),
             "Hips": Vector((0, -0.08, 0)),
             "UpperLeg_L": Q((1, 0, 0), 0.25), "UpperLeg_R": Q((1, 0, 0), 0.25),
             "LowerLeg_L": Q((1, 0, 0), -0.25), "LowerLeg_R": Q((1, 0, 0), -0.25),
             "Head": Q((1, 0, 0), 0.2),
             "UpperArm_L": Q((0, 0, 1), 0.25), "UpperArm_R": Q((0, 0, 1), -0.25)},
        25: {"Spine": (Q((1, 0, 0), 0.8), Vector((0, -0.15, 0))),
             "Chest": Q((1, 0, 0), 0.5),
             "Hips": Vector((0, -0.3, 0)),
             "UpperLeg_L": Q((1, 0, 0), 0.45), "UpperLeg_R": Q((1, 0, 0), 0.45),
             "LowerLeg_L": Q((1, 0, 0), -0.45), "LowerLeg_R": Q((1, 0, 0), -0.45),
             "Head": Q((1, 0, 0), 0.4),
             "UpperArm_L": Q((0, 0, 1), 0.4), "UpperArm_R": Q((0, 0, 1), -0.4)},
        43: {"Spine": (Q((1, 0, 0), 1.2), Vector((0, -0.35, 0))),
             "Chest": Q((1, 0, 0), 0.7),
             "Hips": Vector((0, -0.5, 0)),
             "UpperLeg_L": Q((1, 0, 0), 0.55), "UpperLeg_R": Q((1, 0, 0), 0.55),
             "LowerLeg_L": Q((1, 0, 0), -0.65), "LowerLeg_R": Q((1, 0, 0), -0.65),
             "Head": Q((1, 0, 0), 0.5),
             "UpperArm_L": Q((0, 0, 1), 0.5), "UpperArm_R": Q((0, 0, 1), -0.5)},
    }
    for frame, bones in kf.items():
        for bone_name, data in bones.items():
            if isinstance(data, tuple):
                set_bone_keyframe(arm, bone_name, frame, rotation_quat=data[0], location=data[1])
            elif isinstance(data, Vector):
                set_bone_keyframe(arm, bone_name, frame, location=data)
            else:
                set_bone_keyframe(arm, bone_name, frame, rotation_quat=data)


def export_glb(arm_obj, mesh_obj, output_path):
    """Export as GLB with skin and animations."""
    bpy.ops.object.select_all(action='DESELECT')
    arm_obj.select_set(True)
    mesh_obj.select_set(True)
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
    print("Player Model Rigging + Animation Pipeline")
    print("=" * 60)

    # 1. Clear scene
    print("\n[1/8] Clearing scene...")
    clear_scene()

    # 2. Load optimized GLB
    print(f"\n[2/8] Loading: {INPUT_PATH}")
    mesh_obj = load_glb(INPUT_PATH)

    # 3. Apply node transforms and normalize
    print(f"\n[3/8] Applying transforms...")
    apply_node_transforms(mesh_obj)

    print(f"\n[4/8] Normalizing scale and position...")
    bbox_min, bbox_max = normalize_model(mesh_obj)

    # 4. Create skeleton
    print(f"\n[5/8] Creating humanoid skeleton...")
    positions, height = compute_skeleton_positions(bbox_min, bbox_max)
    arm_obj = create_armature(positions, height)
    print(f"  Created {len(arm_obj.data.bones)} bones")

    # 5. Weapon detection (skip — model is fragmented, weapon fused)
    print(f"\n[6/8] Weapon: fused with body (AI-generated mesh, no separable components)")

    # 6. Rig mesh
    print(f"\n[7/8] Rigging mesh to armature (automatic weights)...")
    rig_mesh_to_armature(mesh_obj, arm_obj)

    # 7. Generate animations
    print(f"\n[7b/8] Generating animations...")
    bpy.context.view_layer.objects.active = arm_obj
    bpy.ops.object.mode_set(mode='POSE')

    anims = [
        ("Idle", 72, anim_idle),
        ("Run", 22, anim_run),
        ("Cast", 22, anim_cast),
        ("Dodge", 13, anim_dodge),
        ("Hit", 7, anim_hit),
        ("Death", 43, anim_death),
    ]

    for name, duration, func in anims:
        print(f"  Creating {name} ({duration} frames, {duration/24:.2f}s)...")
        clear_pose(arm_obj)
        create_action(arm_obj, name, duration)
        func(arm_obj, height)

    bpy.ops.object.mode_set(mode='OBJECT')

    # Set Idle as default
    if arm_obj.animation_data:
        arm_obj.animation_data.action = bpy.data.actions.get("Idle")

    # 8. Export
    print(f"\n[8/8] Exporting GLB...")
    export_glb(arm_obj, mesh_obj, OUTPUT_PATH)

    export_size = os.path.getsize(OUTPUT_PATH)
    print(f"\n{'=' * 60}")
    print(f"RIGGING + ANIMATION COMPLETE")
    print(f"{'=' * 60}")
    print(f"  Output: {OUTPUT_PATH}")
    print(f"  Size: {export_size / 1024 / 1024:.2f} MB")
    print(f"  Target height: {TARGET_HEIGHT} units")
    print(f"  Bones: {len(BONE_HIERARCHY)}")
    print(f"  Animations: 6 (Idle, Run, Cast, Dodge, Hit, Death)")
    print(f"  Weapon: fused (no separation)")


if __name__ == "__main__":
    main()
