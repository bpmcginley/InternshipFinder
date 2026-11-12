// Dormant composition only. Initialization, provider qualification and entry selection stay external.
import { createFollowCheckpointReservation } from "./follow-checkpoint-reservation.js";
import { createFollowCheckpointSnapshotReader } from "./follow-checkpoint-snapshot.js";
import { createFollowCheckpointStage } from "./follow-checkpoint-stage.js";
import { createFollowCheckpointPromotion } from "./follow-checkpoint-promotion.js";

const unavailable = () => ({ state: "unavailable" });
const closedMutation = async () => {
  throw new Error("Follow checkpoint runtime unavailable");
};

export function createFollowCheckpointRuntime(options = {}) {
  if (options?.enabled !== true)
    return {
      read: async () => unavailable(),
      reservePending: closedMutation,
      promote: closedMutation,
      reservations: createFollowCheckpointReservation(),
    };
  const { control, slots, codec, witness, maxBytes, maxHeaderBytes, maxControlBytes } = options;
  if (typeof control?.capture !== "function" || typeof witness !== "function")
    throw new TypeError("Invalid checkpoint runtime dependencies");
  const reservations = createFollowCheckpointReservation({
    enabled: true,
    control,
    slots,
    codec,
    witness,
  });
  const reader = (port) =>
    createFollowCheckpointSnapshotReader({
      capture: () => control.capture(),
      readWitness: () => port?.read(),
      slots,
      codec,
      maxBytes,
      maxHeaderBytes,
      maxControlBytes,
    });
  // Validate dependencies/bounds without calling storage or the witness supplier.
  reader(null);
  const read = async (limit) => {
    try {
      // Both witness checks in one paired read use the same provider object.
      return await reader(witness())(limit);
    } catch {
      return unavailable();
    }
  };
  const reservePending = createFollowCheckpointStage({
    codec,
    maxBytes,
    inspect: (digest) => reservations.inspectStageReservation(digest),
    read,
    reserve: (bytes) => reservations.reservePending(bytes),
    upload: (nonce) => reservations.uploadReserved(nonce),
    reconcile: (nonce) => reservations.reconcileReserved(nonce),
  });
  const promote = createFollowCheckpointPromotion({
    codec,
    maxBytes,
    capture: () => control.capture(),
    read,
    change: (action) => control.change(action),
  });
  return { read, reservePending, promote, reservations };
}
