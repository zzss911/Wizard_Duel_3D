import * as THREE from 'three';

/**
 * SkeletonUtils — minimal clone() for deep-copying a THREE.Object3D
 * (including SkinnedMesh skeletons).
 *
 * Based on three.js SkeletonUtils.clone, stripped to what VoidWitchBoss needs.
 */

function clone(source) {
  const sourceLookup = new Map();
  const cloneLookup = new WeakMap();

  const cloneObj = (obj) => {
    const cloned = obj.clone(false);
    cloneLookup.set(obj, cloned);
    return cloned;
  };

  // Parallel traversal: build source→clone mapping
  const parallelTraverse = (a, b, callback) => {
    const o = [a];
    const p = [b];
    while (o.length > 0) {
      const aa = o.pop();
      const bb = p.pop();
      callback(aa, bb);
      for (let i = 0; i < aa.children.length; i++) {
        o.push(aa.children[i]);
        p.push(bb.children[i]);
      }
    }
  };

  const cloned = source.clone(true);

  parallelTraverse(source, cloned, (sourceNode, clonedNode) => {
    sourceLookup.set(clonedNode, sourceNode);
  });

  // Fix SkinnedMesh bone references
  cloned.traverse((node) => {
    if (!node.isSkinnedMesh) return;

    const clonedMesh = node;
    const sourceMesh = sourceLookup.get(node);
    if (!sourceMesh || !sourceMesh.skeleton) return;

    const sourceBones = sourceMesh.skeleton.bones;
    const clonedBones = [];

    for (let i = 0; i < sourceBones.length; i++) {
      const b = sourceBones[i];
      let cloneData = cloneLookup.get(b);
      if (cloneData === undefined) {
        cloneData = cloneObj(b);
        cloneLookup.set(b, cloneData);
      }
      clonedBones.push(cloneData);
    }

    clonedMesh.skeleton = new THREE.Skeleton(clonedBones, sourceMesh.skeleton.boneInverses);
    clonedMesh.bindMatrix = sourceMesh.bindMatrix.clone();
    clonedMesh.bindMatrixInverse = sourceMesh.bindMatrixInverse.clone();
  });

  return cloned;
}

export { clone };
