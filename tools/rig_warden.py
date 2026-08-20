"""
Warden Boss Auto-Rig Script for Blender 4.x
============================================
Usage:
  blender --background --python tools/rig_warden.py -- --input assets/models/warden.glb --output assets/models/warden_rigged.glb

This script:
  1. Imports the GLB
  2. Inspects world transform / bounding box (does NOT hardcode 90° rotation)
  3. Separates weapon (staff) from body via loose parts / bounding box analysis
  4. Creates a humanoid armature sized to the BODY bbox (not total bbox)
  5. Auto-weights body mesh; rigid-binds weapon to Hand_R bone
  6. Creates 6 animations (Idle, Cast, Slam, Hit, Death, PhaseChange) with proper vector keyframes
  7. Exports as warden_rigged.glb with export_animation_mode='ACTIONS'
"""

import bpy
import bmesh
import math
import sys
import os
import json
import struct
import argparse
from mathutils import Vector, Matrix


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
    for col in list(bpy.data.collections):
        bpy.data.collections.remove(col)
    for mesh in list(bpy.data.meshes):
        bpy.data.meshes.remove(mesh)
    for mat in list(bpy.data.materials):
        bpy.data.materials.remove(mat)
    for img in list(bpy.data.images):
        bpy.data.images.remove(img)
    for arm in list(bpy.data.armatures):
        bpy.data.armatures.remove(arm)
    for act in list(bpy.data.actions):
        bpy.data.actions.remove(act)


# ─── Step 2: Import GLB ───
def import_glb(filepath):
    bpy.ops.import_scene.gltf(filepath=filepath)
    imported = list(bpy.context.selected_objects)
    if not imported:
        raise RuntimeError("No objects imported from GLB")

    mesh_objs = [o for o in imported if o.type == 'MESH']
    if not mesh_objs:
        raise RuntimeError("No mesh objects found in imported GLB")

    print(f"  Imported {len(mesh_objs)} mesh object(s):")
    for m in mesh_objs:
        print(f"    {m.name}: {len(m.data.vertices)} verts, {len(m.data.polygons)} faces")
    return mesh_objs


# ─── Step 3: Inspect transform (no hardcoded rotation) ───
def inspect_transform(mesh_objs):
    """Inspect the imported GLB transform. Apply transforms if needed."""

    # Get the root collection's parent (the GLTF root empty)
    root_parents = set()
    for obj in mesh_objs:
        if obj.parent:
            root_parents.add(obj.parent)
        else:
            root_parents.add(obj)

    for rp in root_parents:
        print(f"  Root '{rp.name}': loc={tuple(round(v,3) for v in rp.location)} "
              f"rot={tuple(round(v,3) for v in rp.rotation_euler)} "
              f"scale={tuple(round(v,3) for v in rp.scale)}")

    # Compute world-space bounding box across ALL meshes
    all_corners = []
    for obj in mesh_objs:
        for corner in obj.bound_box:
            all_corners.append(obj.matrix_world @ Vector(corner))

    min_x = min(v.x for v in all_corners)
    max_x = max(v.x for v in all_corners)
    min_y = min(v.y for v in all_corners)
    max_y = max(v.y for v in all_corners)
    min_z = min(v.z for v in all_corners)
    max_z = max(v.z for v in all_corners)

    height = max_z - min_z
    width = max_x - min_x
    depth = max_y - min_y

    print(f"  Raw bounds: X[{min_x:.3f}, {max_x:.3f}] Y[{min_y:.3f}, {max_y:.3f}] Z[{min_z:.3f}, {max_z:.3f}]")
    print(f"  Height={height:.3f} Width={width:.3f} Depth={depth:.3f}")

    # Determine orientation:
    # For a humanoid model standing upright, the longest axis should be "up".
    # If Z is the longest → model is Z-up (standard glTF)
    # If Y is the longest → model is lying on its side (Y-up needing rotation)
    axes = {'X': width, 'Y': depth, 'Z': height}
    longest = max(axes, key=axes.get)

    needs_rotation = False
    if longest == 'Y' and depth > height * 1.5:
        # Model is lying on its side — rotate 90° around X to make Z the up axis
        print(f"  Model appears Y-up (depth={depth:.3f} > height={height:.3f}), rotating 90° X")
        needs_rotation = True
        for obj in mesh_objs:
            obj.rotation_euler = (0, 0, 0)  # Clear and re-apply on parent
        # Rotate all root parents
        for rp in root_parents:
            rp.rotation_euler = (math.radians(90), 0, 0)
        bpy.context.view_layer.update()
    elif longest == 'X' and width > height * 1.5:
        print(f"  Model appears X-up, rotating 90° Y")
        needs_rotation = True
        for rp in root_parents:
            rp.rotation_euler = (0, math.radians(90), 0)
        bpy.context.view_layer.update()
    else:
        print(f"  Model appears correctly Z-up (height={height:.3f}), no rotation needed")
        needs_rotation = False

    # Apply all transforms (bake rotation/scale into mesh data)
    bpy.ops.object.select_all(action='DESELECT')
    for obj in mesh_objs:
        obj.select_set(True)
    for rp in root_parents:
        if rp.type == 'EMPTY':
            rp.select_set(True)
    if bpy.context.selected_objects:
        bpy.context.view_layer.objects.active = bpy.context.selected_objects[0]
        bpy.ops.object.transform_apply(location=True, rotation=True, scale=True)

    # Recompute bounds after apply
    all_corners = []
    for obj in mesh_objs:
        for corner in obj.bound_box:
            all_corners.append(obj.matrix_world @ Vector(corner))

    min_x = min(v.x for v in all_corners)
    max_x = max(v.x for v in all_corners)
    min_y = min(v.y for v in all_corners)
    max_y = max(v.y for v in all_corners)
    min_z = min(v.z for v in all_corners)
    max_z = max(v.z for v in all_corners)

    height = max_z - min_z
    width = max_x - min_x
    depth = max_y - min_y

    # Center model: X/Y centered on origin, feet at Z=0
    for obj in mesh_objs:
        obj.location.x += -(min_x + max_x) / 2
        obj.location.y += -(min_y + max_y) / 2
        obj.location.z += -min_z
    bpy.context.view_layer.update()

    print(f"  Normalized bounds: X[{min_x:.3f}, {max_x:.3f}] Y[{min_y:.3f}, {max_y:.3f}] Z[{min_z:.3f}, {max_z:.3f}]")
    print(f"  Final: Height={height:.3f} Width={width:.3f} Depth={depth:.3f}")

    return {
        'height': height,
        'width': width,
        'depth': depth,
    }


# ─── Step 3b: Separate weapon from body ───
def separate_weapon(mesh_objs):
    """
    Try to identify and separate the weapon (staff) from the body mesh.

    Strategy:
    1. If multiple mesh objects exist, assume largest=body, rest=weapon
    2. If single mesh, use bmesh to find connected components (single pass)
    3. Identify weapon by elongation heuristic
    4. Split into separate mesh objects
    5. Return (body_obj, weapon_obj_or_None)
    """
    if len(mesh_objs) > 1:
        sorted_objs = sorted(mesh_objs, key=lambda o: len(o.data.vertices), reverse=True)
        body_obj = sorted_objs[0]
        weapon_objs = sorted_objs[1:]
        print(f"  Multiple meshes found: body='{body_obj.name}' ({len(body_obj.data.vertices)} verts)")
        for wo in weapon_objs:
            print(f"    weapon candidate: '{wo.name}' ({len(wo.data.vertices)} verts)")

        if len(weapon_objs) > 1:
            bpy.ops.object.select_all(action='DESELECT')
            for wo in weapon_objs:
                wo.select_set(True)
            bpy.context.view_layer.objects.active = weapon_objs[0]
            bpy.ops.object.join()
            weapon_obj = bpy.context.active_object
        else:
            weapon_obj = weapon_objs[0]

        return body_obj, weapon_obj

    # Single mesh — try to split by connected components
    mesh_obj = mesh_objs[0]

    # Single pass: use bmesh to find components and tag faces
    bm = bmesh.new()
    bm.from_mesh(mesh_obj.data)
    bm.faces.ensure_lookup_table()

    visited = set()
    components = []  # list of (set of face indices, set of vert indices)

    for face in bm.faces:
        if face.index in visited:
            continue
        queue = [face]
        comp_faces = set()
        comp_verts = set()
        while queue:
            f = queue.pop()
            if f.index in visited:
                continue
            visited.add(f.index)
            comp_faces.add(f.index)
            for v in f.verts:
                comp_verts.add(v.index)
            for edge in f.edges:
                for linked_face in edge.link_faces:
                    if linked_face.index not in visited:
                        queue.append(linked_face)
        components.append((comp_faces, comp_verts))

    print(f"  Found {len(components)} connected component(s) in mesh '{mesh_obj.name}'")

    # Find body = largest component
    components.sort(key=lambda c: len(c[0]), reverse=True)
    body_faces, body_verts = components[0]

    # Identify weapon among remaining components
    weapon_comp = None
    for i, (comp_faces, comp_verts) in enumerate(components[1:], 1):
        # Get vertex coordinates from bmesh (still open)
        bm.verts.ensure_lookup_table()
        coords = [bm.verts[vi].co for vi in comp_verts if vi < len(bm.verts)]
        if not coords:
            continue

        min_c = Vector((min(c.x for c in coords), min(c.y for c in coords), min(c.z for c in coords)))
        max_c = Vector((max(c.x for c in coords), max(c.y for c in coords), max(c.z for c in coords)))
        dim = max_c - min_c

        longest_dim = max(dim.x, dim.y, dim.z)
        shortest_dim = min(dim.x, dim.y, dim.z)

        # Weapon heuristic: elongated (length > 3x thickness) and relatively small
        if longest_dim > shortest_dim * 3 and len(comp_faces) < len(body_faces) * 0.3:
            weapon_comp = (comp_faces, comp_verts)
            print(f"    Component {i} identified as weapon (elongated: {longest_dim:.3f} vs {shortest_dim:.3f}, {len(comp_faces)} faces)")
            break

    if weapon_comp is None:
        print("  WARNING: Could not identify weapon component. All geometry treated as body.")
        bm.to_mesh(mesh_obj.data)
        bm.free()
        return mesh_obj, None

    # Tag weapon faces for separation
    weapon_face_set = weapon_comp[0]
    for f in bm.faces:
        f.select = f.index in weapon_face_set

    # Write back to mesh
    bm.to_mesh(mesh_obj.data)
    bm.free()
    mesh_obj.data.update()

    # Enter edit mode and separate selected (weapon) faces
    bpy.context.view_layer.objects.active = mesh_obj
    bpy.ops.object.mode_set(mode='EDIT')
    bpy.ops.mesh.separate(type='SELECTED')
    bpy.ops.object.mode_set(mode='OBJECT')

    # Find the two resulting objects
    all_objs = [o for o in bpy.data.objects if o.type == 'MESH']
    weapon_obj = None
    for o in all_objs:
        if o != mesh_obj and len(o.data.vertices) < len(mesh_obj.data.vertices):
            weapon_obj = o
            break

    if weapon_obj:
        weapon_obj.name = "Weapon"
        mesh_obj.name = "Body"
        print(f"  Separated: body='{mesh_obj.name}' ({len(mesh_obj.data.vertices)} verts) "
              f"weapon='{weapon_obj.name}' ({len(weapon_obj.data.vertices)} verts)")
    else:
        print("  WARNING: Weapon separation produced no separate object.")

    return mesh_obj, weapon_obj


# ─── Step 4: Compute body-only bounding box ───
def get_body_bbox(body_obj):
    """Get bounding box of the body mesh only (excluding weapon)."""
    corners = [body_obj.matrix_world @ Vector(c) for c in body_obj.bound_box]
    min_x = min(v.x for v in corners)
    max_x = max(v.x for v in corners)
    min_y = min(v.y for v in corners)
    max_y = max(v.y for v in corners)
    min_z = min(v.z for v in corners)
    max_z = max(v.z for v in corners)

    height = max_z - min_z
    width = max_x - min_x
    depth = max_y - min_y

    print(f"  Body-only bbox: H={height:.3f} W={width:.3f} D={depth:.3f}")
    return {'height': height, 'width': width, 'depth': depth,
            'min_z': min_z, 'max_z': max_z,
            'min_x': min_x, 'max_x': max_x}


# ─── Step 5: Create humanoid armature ───
def create_armature(dims):
    """Create a humanoid armature sized to body dimensions."""
    h = dims['height']
    w = dims['width']

    bpy.ops.object.armature_add(enter_editmode=True, location=(0, 0, 0))
    armature = bpy.context.object
    armature.name = "WardenArmature"

    # Remove default bone
    edit_bones = armature.data.edit_bones
    for bone in list(edit_bones):
        edit_bones.remove(bone)

    # Bone Z-positions (proportional to height, feet at Z=0)
    z_hips = h * 0.48
    z_spine = h * 0.58
    z_chest = h * 0.72
    z_neck = h * 0.82
    z_head_top = h * 0.98
    z_shoulder = h * 0.80
    z_elbow = h * 0.62
    z_wrist = h * 0.48
    z_knee = h * 0.26
    z_ankle = h * 0.06

    # Arm span: use body width, NOT total width (weapon excluded)
    # Arms extend to ~85% of half-width
    arm_span = w * 0.42

    bones_def = [
        ("Root",        (0, 0, 0),           (0, 0, z_hips * 0.3),    None),
        ("Hips",        (0, 0, z_hips),      (0, 0, z_hips + 0.01),   "Root"),
        ("Spine",       (0, 0, z_hips),      (0, 0, z_spine),         "Hips"),
        ("Chest",       (0, 0, z_spine),     (0, 0, z_chest),         "Spine"),
        ("Neck",        (0, 0, z_chest),     (0, 0, z_neck),          "Chest"),
        ("Head",        (0, 0, z_neck),      (0, 0, z_head_top),      "Neck"),

        # Left arm (+X side)
        ("Shoulder_L",  (0, 0, z_shoulder),  (arm_span * 0.4, 0, z_shoulder), "Chest"),
        ("Arm_L",       (arm_span * 0.4, 0, z_shoulder), (arm_span * 0.7, 0, z_elbow), "Shoulder_L"),
        ("Forearm_L",   (arm_span * 0.7, 0, z_elbow),    (arm_span * 0.9, 0, z_wrist), "Arm_L"),
        ("Hand_L",      (arm_span * 0.9, 0, z_wrist),    (arm_span, 0, z_wrist - 0.05 * h), "Forearm_L"),

        # Right arm (-X side)
        ("Shoulder_R",  (0, 0, z_shoulder),  (-arm_span * 0.4, 0, z_shoulder), "Chest"),
        ("Arm_R",       (-arm_span * 0.4, 0, z_shoulder), (-arm_span * 0.7, 0, z_elbow), "Shoulder_R"),
        ("Forearm_R",   (-arm_span * 0.7, 0, z_elbow),    (-arm_span * 0.9, 0, z_wrist), "Arm_R"),
        ("Hand_R",      (-arm_span * 0.9, 0, z_wrist),    (-arm_span, 0, z_wrist - 0.05 * h), "Forearm_R"),

        # Weapon bone (child of right hand)
        ("Weapon_R",    (-arm_span, 0, z_wrist), (-arm_span, 0, z_wrist - 0.3 * h), "Hand_R"),

        # Legs
        ("Thigh_L",     (w * 0.1, 0, z_hips), (w * 0.1, 0, z_knee),  "Hips"),
        ("Shin_L",      (w * 0.1, 0, z_knee), (w * 0.1, 0, z_ankle),  "Thigh_L"),
        ("Foot_L",      (w * 0.1, 0, z_ankle), (w * 0.1, 0.1 * h, 0), "Shin_L"),
        ("Thigh_R",     (-w * 0.1, 0, z_hips), (-w * 0.1, 0, z_knee), "Hips"),
        ("Shin_R",      (-w * 0.1, 0, z_knee), (-w * 0.1, 0, z_ankle), "Thigh_R"),
        ("Foot_R",      (-w * 0.1, 0, z_ankle), (-w * 0.1, 0.1 * h, 0), "Shin_R"),
    ]

    created = {}
    for name, head, tail, parent_name in bones_def:
        bone = edit_bones.new(name)
        bone.head = head
        bone.tail = tail
        if parent_name and parent_name in created:
            bone.parent = created[parent_name]
            bone.use_connect = False
        created[name] = bone

    bpy.ops.object.mode_set(mode='OBJECT')
    return armature


# ─── Step 6: Parent body mesh with auto weights ───
def parent_body_auto_weights(body_obj, armature):
    """Parent body mesh to armature with automatic weights."""
    bpy.ops.object.select_all(action='DESELECT')
    body_obj.select_set(True)
    armature.select_set(True)
    bpy.context.view_layer.objects.active = armature

    try:
        bpy.ops.object.parent_set(type='ARMATURE_AUTO')
        print("  Auto weights applied to body")
    except RuntimeError as e:
        print(f"  WARNING: Auto-weight failed: {e}")
        print("  Falling back to ARMATURE (envelope)")
        bpy.ops.object.parent_set(type='ARMATURE')

    # Verify: ensure the body mesh has an armature modifier
    has_armature_mod = any(m.type == 'ARMATURE' for m in body_obj.modifiers)
    if not has_armature_mod:
        print("  WARNING: Body has no armature modifier, adding one manually")
        mod = body_obj.modifiers.new(name="Armature", type='ARMATURE')
        mod.object = armature
    else:
        # Ensure the armature modifier points to the correct armature
        for m in body_obj.modifiers:
            if m.type == 'ARMATURE':
                m.object = armature

    # Ensure body is parented to armature (critical for glTF skin export)
    body_obj.parent = armature

    # Ensure vertex groups exist
    if len(body_obj.vertex_groups) == 0:
        print("  WARNING: Body has no vertex groups after auto-weight!")
        print("  Creating basic vertex groups for all bones...")
        for bone in armature.data.bones:
            body_obj.vertex_groups.new(name=bone.name)
        root_vg = body_obj.vertex_groups.get("Root")
        if root_vg:
            all_verts = list(range(len(body_obj.data.vertices)))
            root_vg.add(all_verts, 1.0, 'REPLACE')
    else:
        print(f"  Body has {len(body_obj.vertex_groups)} vertex groups")


# ─── Step 6b: Rigid-bind weapon to Hand_R ───
def parent_weapon_rigid(weapon_obj, armature):
    """Rigid-bind weapon to Hand_R bone (no automatic weights)."""
    if not weapon_obj:
        return

    bpy.ops.object.select_all(action='DESELECT')
    weapon_obj.select_set(True)
    armature.select_set(True)
    bpy.context.view_layer.objects.active = armature

    # Parent with bone relation (empty groups, then assign all to Hand_R)
    bpy.ops.object.parent_set(type='ARMATURE')

    # Clear all vertex groups and create one for Hand_R
    weapon_obj.vertex_groups.clear()
    vg = weapon_obj.vertex_groups.new(name="Hand_R")

    # Assign all vertices to Hand_R with weight 1.0
    all_verts = list(range(len(weapon_obj.data.vertices)))
    vg.add(all_verts, 1.0, 'REPLACE')

    print(f"  Weapon rigid-bound to Hand_R bone ({len(all_verts)} verts)")


# ─── Step 7: Create animations ───
def create_animations(armature, dims):
    """Create 6 animations using proper whole-vector keyframe assignment."""
    h = dims['height']
    bpy.context.view_layer.objects.active = armature

    # Animation definitions: (name, duration_frames, is_loop, keyframes)
    # Each keyframe: (bone_name, attribute, frame, value_tuple)
    # value_tuple is a full 3-element vector (x, y, z)
    anim_defs = {
        'Idle': {
            'duration': 60,
            'loop': True,
            'keyframes': [
                # Breathing: chest scale
                ('Chest', 'scale', 1,  (1.0, 1.0, 1.02)),
                ('Chest', 'scale', 30, (1.0, 1.0, 0.98)),
                ('Chest', 'scale', 60, (1.0, 1.0, 1.02)),
                # Head slight bob
                ('Head', 'location', 1,  (0.0, 0.0, 0.01 * h)),
                ('Head', 'location', 30, (0.0, 0.0, -0.01 * h)),
                ('Head', 'location', 60, (0.0, 0.0, 0.01 * h)),
            ],
        },
        'Cast': {
            'duration': 30,
            'loop': False,
            'keyframes': [
                # Arms raise forward (Y rotation)
                ('Arm_L', 'rotation_euler', 1,  (0.0, -0.3, 0.0)),
                ('Arm_R', 'rotation_euler', 1,  (0.0, 0.3, 0.0)),
                ('Arm_L', 'rotation_euler', 15, (0.0, -0.6, 0.0)),
                ('Arm_R', 'rotation_euler', 15, (0.0, 0.6, 0.0)),
                ('Arm_L', 'rotation_euler', 30, (0.0, -0.4, 0.0)),
                ('Arm_R', 'rotation_euler', 30, (0.0, 0.4, 0.0)),
                # Chest puffs
                ('Chest', 'scale', 1,  (1.0, 1.0, 1.0)),
                ('Chest', 'scale', 15, (1.0, 1.0, 1.05)),
                ('Chest', 'scale', 30, (1.0, 1.0, 1.0)),
            ],
        },
        'Slam': {
            'duration': 35,
            'loop': False,
            'keyframes': [
                # Arms swing up then down
                ('Arm_L', 'rotation_euler', 1,  (0.0, 0.5, 0.0)),
                ('Arm_R', 'rotation_euler', 1,  (0.0, -0.5, 0.0)),
                ('Arm_L', 'rotation_euler', 15, (0.0, 0.8, 0.0)),
                ('Arm_R', 'rotation_euler', 15, (0.0, -0.8, 0.0)),
                ('Arm_L', 'rotation_euler', 25, (0.0, -0.5, 0.0)),
                ('Arm_R', 'rotation_euler', 25, (0.0, 0.5, 0.0)),
                ('Arm_L', 'rotation_euler', 35, (0.0, -0.2, 0.0)),
                ('Arm_R', 'rotation_euler', 35, (0.0, 0.2, 0.0)),
                # Body dips
                ('Root', 'location', 1,  (0.0, 0.0, 0.0)),
                ('Root', 'location', 25, (0.0, 0.0, -0.1 * h)),
                ('Root', 'location', 35, (0.0, 0.0, 0.0)),
            ],
        },
        'Hit': {
            'duration': 15,
            'loop': False,
            'keyframes': [
                # Backward lean then recover
                ('Chest', 'rotation_euler', 1,  (0.3, 0.0, 0.0)),
                ('Head', 'rotation_euler', 1,  (0.4, 0.0, 0.0)),
                ('Chest', 'rotation_euler', 8,  (0.15, 0.0, 0.0)),
                ('Head', 'rotation_euler', 8,  (0.2, 0.0, 0.0)),
                ('Chest', 'rotation_euler', 15, (0.0, 0.0, 0.0)),
                ('Head', 'rotation_euler', 15, (0.0, 0.0, 0.0)),
            ],
        },
        'Death': {
            'duration': 80,
            'loop': False,
            'keyframes': [
                # Fall forward and sink
                ('Root', 'rotation_euler', 1,  (0.0, 0.0, 0.0)),
                ('Root', 'rotation_euler', 40, (0.6, 0.0, 0.0)),
                ('Root', 'rotation_euler', 80, (1.2, 0.0, 0.0)),
                ('Root', 'location', 1,  (0.0, 0.0, 0.0)),
                ('Root', 'location', 80, (0.0, 0.0, -0.5 * h)),
                ('Head', 'rotation_euler', 1,  (0.0, 0.0, 0.0)),
                ('Head', 'rotation_euler', 80, (0.3, 0.0, 0.0)),
                # Arms drop limp
                ('Arm_L', 'rotation_euler', 1,  (0.0, 0.0, 0.0)),
                ('Arm_R', 'rotation_euler', 1,  (0.0, 0.0, 0.0)),
                ('Arm_L', 'rotation_euler', 80, (0.0, 0.3, 0.0)),
                ('Arm_R', 'rotation_euler', 80, (0.0, -0.3, 0.0)),
            ],
        },
        'PhaseChange': {
            'duration': 60,
            'loop': False,
            'keyframes': [
                # Arms spread wide
                ('Arm_L', 'rotation_euler', 1,  (0.0, 0.0, 0.5)),
                ('Arm_R', 'rotation_euler', 1,  (0.0, 0.0, -0.5)),
                ('Arm_L', 'rotation_euler', 30, (0.0, 0.0, 1.0)),
                ('Arm_R', 'rotation_euler', 30, (0.0, 0.0, -1.0)),
                ('Arm_L', 'rotation_euler', 60, (0.0, 0.0, 0.5)),
                ('Arm_R', 'rotation_euler', 60, (0.0, 0.0, -0.5)),
                # Chest puffs
                ('Chest', 'scale', 1,  (1.0, 1.0, 1.0)),
                ('Chest', 'scale', 30, (1.05, 1.05, 1.08)),
                ('Chest', 'scale', 60, (1.0, 1.0, 1.0)),
                # Slight rise
                ('Root', 'location', 1,  (0.0, 0.0, 0.0)),
                ('Root', 'location', 30, (0.0, 0.0, 0.05 * h)),
                ('Root', 'location', 60, (0.0, 0.0, 0.0)),
            ],
        },
    }

    for anim_name, config in anim_defs.items():
        action = bpy.data.actions.new(name=anim_name)
        action.use_cyclic = config['loop']

        # Enter pose mode, reset to rest
        bpy.ops.object.mode_set(mode='POSE')
        for bone in armature.pose.bones:
            bone.location = (0, 0, 0)
            bone.rotation_euler = (0, 0, 0)
            bone.scale = (1, 1, 1)

        # Insert keyframes using whole-vector assignment
        for bone_name, attr, frame, value in config['keyframes']:
            bone = armature.pose.bones.get(bone_name)
            if not bone:
                print(f"  WARNING: bone '{bone_name}' not found, skipping keyframe")
                continue

            # Assign the entire vector at once
            setattr(bone, attr, value)
            bone.keyframe_insert(data_path=attr, frame=frame)

        bpy.ops.object.mode_set(mode='OBJECT')

        # Assign action to armature's animation data temporarily
        if armature.animation_data is None:
            armature.animation_data_create()
        armature.animation_data.action = action

        # Create NLA track and strip so the action is exported by glTF ACTIONS mode
        track = armature.animation_data.nla_tracks.new()
        track.name = anim_name
        # strips.new() requires name and start_frame parameters
        num_frames = config['duration']
        strip = track.strips.new(name=anim_name, start=1, action=action)
        strip.action_frame_start = 1
        strip.action_frame_end = num_frames
        strip.frame_end = num_frames

    # Clear active action so the rest pose is exported as the default
    armature.animation_data.action = None

    # Remove any auto-generated default actions (e.g. "WardenArmatureAction")
    expected_names = {'Idle', 'Cast', 'Slam', 'Hit', 'Death', 'PhaseChange'}
    for act in list(bpy.data.actions):
        if act.name not in expected_names:
            print(f"  Removing auto-generated action: '{act.name}'")
            bpy.data.actions.remove(act)

    # Set the armature to rest position
    bpy.ops.object.mode_set(mode='POSE')
    for bone in armature.pose.bones:
        bone.location = (0, 0, 0)
        bone.rotation_euler = (0, 0, 0)
        bone.scale = (1, 1, 1)
    bpy.ops.object.mode_set(mode='OBJECT')


# ─── Step 8: Export GLB ───
def export_glb(filepath, armature, body_obj, weapon_obj):
    """Export GLB, ensuring both meshes reference the armature's skin."""

    # Ensure both mesh objects are parented to the armature
    for obj in [body_obj, weapon_obj]:
        if obj.parent != armature:
            obj.parent = armature
        has_arm_mod = any(m.type == 'ARMATURE' for m in obj.modifiers)
        if not has_arm_mod:
            mod = obj.modifiers.new(name="Armature", type='ARMATURE')
            mod.object = armature
        else:
            for m in obj.modifiers:
                if m.type == 'ARMATURE':
                    m.object = armature

    # Deselect all, select body+weapon+armature
    bpy.ops.object.select_all(action='DESELECT')
    body_obj.select_set(True)
    weapon_obj.select_set(True)
    armature.select_set(True)
    bpy.context.view_layer.objects.active = armature

    bpy.ops.export_scene.gltf(
        filepath=filepath,
        export_format='GLB',
        export_apply=True,
        export_animations=True,
        export_animation_mode='ACTIONS',
        export_skins=True,
        export_morph=False,
        export_yup=True,
        export_extras=False,
        use_selection=True,
    )


# ─── Post-process: Fix missing skin assignment ───
def fix_skin_assignment(filepath):
    """
    Post-process the exported GLB to fix missing skin assignment on Body node.
    The Blender glTF exporter sometimes fails to assign skin=0 to mesh nodes
    that have JOINTS_0/WEIGHTS_0 attributes but no direct skin reference.
    """
    import struct

    with open(filepath, 'rb') as f:
        header = f.read(12)
        magic, version, total_len = struct.unpack('<4sII', header)

        # Read JSON chunk
        json_len = struct.unpack('<I', f.read(4))[0]
        json_type = f.read(4)
        json_bytes = f.read(json_len)

        # Read binary chunk
        bin_len = struct.unpack('<I', f.read(4))[0]
        bin_type = f.read(4)
        bin_data = f.read(bin_len)

    j = json.loads(json_bytes.decode('utf-8'))

    skins = j.get('skins', [])
    if not skins:
        print("  WARNING: No skins in GLB, cannot fix")
        return

    skin_idx = 0  # first skin
    fixed = 0
    for node in j.get('nodes', []):
        if node.get('mesh') is not None and node.get('skin') is None:
            # Check if this mesh has JOINTS_0/WEIGHTS_0
            mesh_idx = node['mesh']
            meshes = j.get('meshes', [])
            if mesh_idx < len(meshes):
                prims = meshes[mesh_idx].get('primitives', [])
                for p in prims:
                    attrs = p.get('attributes', {})
                    if 'JOINTS_0' in attrs and 'WEIGHTS_0' in attrs:
                        node['skin'] = skin_idx
                        fixed += 1
                        break

    if fixed > 0:
        print(f"  Fixed skin assignment on {fixed} node(s)")

    # Write back
    new_json = json.dumps(j, separators=(',', ':')).encode('utf-8')
    # Pad JSON to 4-byte boundary
    while len(new_json) % 4 != 0:
        new_json += b'\x20'

    # Pad binary to 4-byte boundary
    while len(bin_data) % 4 != 0:
        bin_data += b'\x00'

    new_total = 12 + 8 + len(new_json) + 8 + len(bin_data)

    with open(filepath, 'wb') as f:
        f.write(struct.pack('<4sII', b'glTF', 2, new_total))
        f.write(struct.pack('<I4s', len(new_json), b'JSON'))
        f.write(new_json)
        f.write(struct.pack('<I4s', len(bin_data), b'BIN\x00'))
        f.write(bin_data)


# ─── Main ───
def main():
    args = parse_args()
    print(f"\n{'='*60}")
    print(f"Warden Boss Auto-Rig Script")
    print(f"Input:  {args.input}")
    print(f"Output: {args.output}")
    print(f"{'='*60}\n")

    # Step 1: Clean
    print("[1/8] Cleaning scene...")
    clean_scene()

    # Step 2: Import GLB
    print("[2/8] Importing GLB...")
    mesh_objs = import_glb(args.input)
    total_verts = sum(len(o.data.vertices) for o in mesh_objs)
    print(f"  Total: {total_verts} vertices across {len(mesh_objs)} mesh(es)")

    # Step 3: Inspect and normalize transform (no hardcoded rotation)
    print("[3/8] Inspecting transform...")
    dims = inspect_transform(mesh_objs)

    # Step 4: Separate weapon from body
    print("[4/8] Separating weapon from body...")
    body_obj, weapon_obj = separate_weapon(mesh_objs)
    body_dims = get_body_bbox(body_obj)

    # Step 5: Create armature sized to BODY bbox
    print("[5/8] Creating humanoid armature (body-sized)...")
    armature = create_armature(body_dims)
    bone_count = len(armature.data.bones)
    print(f"  Created armature with {bone_count} bones")

    # Step 6: Parent body with auto weights
    print("[6/8] Parenting body mesh with auto weights...")
    parent_body_auto_weights(body_obj, armature)

    # Step 6b: Rigid-bind weapon
    if weapon_obj:
        print("[6b] Rigid-binding weapon to Hand_R...")
        parent_weapon_rigid(weapon_obj, armature)
    else:
        print("[6b] No weapon to bind (single mesh)")

    # Step 7: Create animations
    print("[7/8] Creating animations...")
    create_animations(armature, body_dims)
    print("  Created: Idle, Cast, Slam, Hit, Death, PhaseChange")

    # Verify actions exist
    action_names = [a.name for a in bpy.data.actions]
    print(f"  Actions in scene: {action_names}")
    expected = ['Idle', 'Cast', 'Slam', 'Hit', 'Death', 'PhaseChange']
    missing = [a for a in expected if a not in action_names]
    if missing:
        print(f"  ERROR: Missing actions: {missing}")
    else:
        print("  All 6 actions present.")

    # Step 8: Export
    print("[8/8] Exporting GLB...")
    export_glb(args.output, armature, body_obj, weapon_obj)

    # Post-process: fix missing skin assignment on Body node
    fix_skin_assignment(args.output)

    file_size = os.path.getsize(args.output) / (1024 * 1024)
    print(f"  Exported: {args.output} ({file_size:.1f} MB)")

    print(f"\n{'='*60}")
    print("DONE! warden_rigged.glb is ready.")
    print(f"{'='*60}\n")


if __name__ == "__main__":
    main()
