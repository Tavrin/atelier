export function disposeOwnedObject(object) {
  const failures = [];
  const dispose = (step, resource) => {
    try {
      resource?.dispose?.();
    } catch (error) {
      failures.push({ step, error });
    }
  };
  try {
    object?.traverse?.((node) => {
      if (node.geometry && node.userData?.ownGeometry) {
        dispose("geometry.dispose", node.geometry);
      }
      if (node.material && node.userData?.ownMaterial) {
        for (const material of Array.isArray(node.material) ? node.material : [node.material]) {
          dispose("material-map.dispose", material.map);
          dispose("material.dispose", material);
        }
      }
    });
  } catch (error) {
    failures.push({ step: "object.traverse", error });
  }
  if (failures.length > 0) {
    const error = new AggregateError(
      failures.map((failure) => failure.error),
      "Cozy Village owned resource cleanup failed",
    );
    error.name = "CozyVillageResourceCleanupError";
    error.failures = failures;
    throw error;
  }
}

export function createOwnedGroupRegistry(parent) {
  const groups = new Set();
  return {
    track(group) {
      groups.add(group);
      return group;
    },
    release(group) {
      if (!group || !groups.has(group)) return false;
      const failures = [];
      try {
        disposeOwnedObject(group);
      } catch (error) {
        failures.push(...(error.failures ?? [{ step: "owned-group.dispose", error }]));
      } finally {
        try {
          (group.parent ?? parent)?.remove?.(group);
        } catch (error) {
          failures.push({ step: "owned-group.remove", error });
        }
        groups.delete(group);
      }
      if (failures.length > 0) {
        const error = new AggregateError(
          failures.map((failure) => failure.error),
          "Cozy Village owned group cleanup failed",
        );
        error.name = "CozyVillageResourceCleanupError";
        error.failures = failures;
        throw error;
      }
      return true;
    },
    releaseAll() {
      const failures = [];
      for (const group of [...groups]) {
        try {
          this.release(group);
        } catch (error) {
          failures.push(...(error.failures ?? [{ step: "owned-group.release", error }]));
        }
      }
      if (failures.length > 0) {
        const error = new AggregateError(
          failures.map((failure) => failure.error),
          "Cozy Village owned group cleanup failed",
        );
        error.name = "CozyVillageResourceCleanupError";
        error.failures = failures;
        throw error;
      }
    },
    get size() {
      return groups.size;
    },
  };
}
