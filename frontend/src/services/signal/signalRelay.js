
/**
 * GRUS-owned Signal Protocol relay adapter.
 *
 * Uses authenticated GRUS Flask API and Socket.IO notifications.
 * Private keys remain in the SDK's local encrypted storage.
 *
  * NOTE:
 * Prekey inventory and identity retrieval are implemented.
 * Identity rotation and device-management endpoints remain pending.
 * Group messaging is deferred for the 1:1 milestone.
 */

import { apiRequest } from "../api";
import { connectSocket } from "../socket";

const POLL_INTERVAL_MS = 4000;

function getToken() {
  const token = sessionStorage.getItem("grus_token");
  if (!token) throw new Error("GRUS session expired. Please log in again.");
  return token;
}

function request(path, options = {}) {
  return apiRequest(path, { token: getToken(), ...options });
}

function toBase64(value) {
  if (typeof value === "string") {
    // SDK Ciphertext is already a Base64 string.
    return value;
  }

  if (value instanceof Uint8Array) {
    let binary = "";
    for (const byte of value) {
      binary += String.fromCharCode(byte);
    }
    return btoa(binary);
  }

  throw new TypeError("Unsupported Signal ciphertext format");
}

function fromBase64(value) {
  if (typeof value !== "string") {
    throw new TypeError("Relay ciphertext must be a Base64 string");
  }

  // Preserve the SDK's Base64 representation.
  return value;
}

function unsupported(method, endpoint) {
  throw new Error(
    `GRUS relay: ${method} is not available yet. Backend endpoint required: ${endpoint}`
  );
}

function normalizeEnvelope(item) {
  return {
    ...item,
    ciphertext: fromBase64(item.ciphertext),
  };
}

export function createGrusSignalRelay({
  userId,
  deviceId,
  pollIntervalMs = POLL_INTERVAL_MS,
} = {}) {
  if (!userId || typeof userId !== "string") {
    throw new Error("A valid authenticated GRUS userId is required.");
  }

  if (!Number.isInteger(deviceId) || deviceId < 1 || deviceId > 5) {
    throw new Error("A registered GRUS deviceId from 1 to 5 is required.");
  }

  let state = {
    state: "stopped",
    since: Date.now(),
  };

  const stateListeners = new Set();

  function setState(nextState, reason) {
    state = {
      state: nextState,
      since: Date.now(),
      ...(reason ? { reason } : {}),
    };

    for (const listener of stateListeners) {
      listener(state);
    }
  }

  const relay = {
    get relayConnectionState() {
      return state;
    },

    subscribeRelayConnectionState(listener) {
      stateListeners.add(listener);
      return () => stateListeners.delete(listener);
    },

    async send(envelope) {
      if (envelope.senderUserId !== userId) {
        throw new Error("Sender user does not match authenticated GRUS user.");
      }

      if (envelope.senderDeviceId !== deviceId) {
        throw new Error("Sender device does not match this GRUS relay.");
      }

        if (Array.isArray(envelope.declaredDeviceIds)) {
    throw new Error(
      "GRUS relay does not yet support declared device-set validation."
    );
  }

      if (envelope.deliveryClass === "ephemeral") {
        throw new Error(
          "Ephemeral delivery is disabled until GRUS supports non-persistent envelopes."
        );
      }

      const payload = {
        ...envelope,
        ciphertext: toBase64(envelope.ciphertext),
      };

      const result = await request("/api/signal/envelopes", {
        method: "POST",
        body: payload,
      });

      return {
        messageId: result.messageId,
        serverTimestamp: result.serverTimestamp,
        ...(typeof result.duplicate === "boolean"
          ? { duplicate: result.duplicate }
          : {}),
        ...(typeof result.expiresAt === "number"
          ? { expiresAt: result.expiresAt }
          : {}),
      };
    },

    subscribe(
      subscriberUserId,
      subscriberDeviceId,
      onEnvelope,
      options = {}
    ) {
      if (
        subscriberUserId !== userId ||
        subscriberDeviceId !== deviceId
      ) {
        throw new Error("Subscription user/device does not match this relay.");
      }

      if (typeof onEnvelope !== "function") {
        throw new TypeError("subscribe requires an onEnvelope callback.");
      }

      let stopped = false;
      let pulling = false;
      let timer = null;

      const inFlight = new Set();
      const socket = connectSocket(getToken());

      setState("connecting");

      async function pullMailbox() {
        if (stopped || pulling) return;

        pulling = true;

        try {
          const result = await request(
            `/api/signal/envelopes?device_id=${deviceId}`
          );

          const envelopes = Array.isArray(result.envelopes)
            ? result.envelopes
            : [];

          if (envelopes.length) {
            options.onBatchStart?.();
          }

          for (const rawEnvelope of envelopes) {
            if (stopped || inFlight.has(rawEnvelope.id)) continue;

            inFlight.add(rawEnvelope.id);

            try {
              await onEnvelope(normalizeEnvelope(rawEnvelope));
              await relay.markDelivered(rawEnvelope.id);
            } catch (error) {
              console.error(
                "GRUS Signal envelope processing failed:",
                error
              );
            } finally {
              inFlight.delete(rawEnvelope.id);
            }
          }

          if (envelopes.length) {
            options.onBatchEnd?.();
          }

          if (!stopped) setState("connected");
        } catch (error) {
          if (!stopped) setState("reconnecting", "error");

          console.error("GRUS mailbox pull failed:", error);
        } finally {
          pulling = false;
        }
      }

      socket.on("connect", () => {
        if (!stopped) {
          setState("connected");
          void pullMailbox();
        }
      });

      socket.on("disconnect", () => {
        if (!stopped) setState("reconnecting", "closed");
      });

      socket.on("connect_error", () => {
        if (!stopped) setState("reconnecting", "error");
      });

      socket.on("signal_envelope_available", (event) => {
        if (event?.device_id === deviceId) {
          void pullMailbox();
        }
      });

      timer = window.setInterval(
        () => void pullMailbox(),
        pollIntervalMs
      );

      void pullMailbox();

      return () => {
        stopped = true;

        if (timer !== null) {
          window.clearInterval(timer);
        }

        socket.removeAllListeners();
        socket.disconnect();

        setState("stopped");
      };
    },

    async markDelivered(envelopeId) {
      await request(
        `/api/signal/envelopes/${encodeURIComponent(envelopeId)}/ack`,
        {
          method: "POST",
          body: { device_id: deviceId },
        }
      );
    },

    async getDevices(targetUserId) {
  if (typeof targetUserId !== "string" || !targetUserId) {
    throw new Error("Invalid target user ID.");
  }

  const result = await request(
    `/api/signal/devices/${encodeURIComponent(targetUserId)}`
  );

  if (!Array.isArray(result.devices)) {
    throw new Error("Invalid GRUS device discovery response.");
  }

  return result.devices.map((item) => ({
    deviceId: item.deviceId,
    deviceType: item.deviceType ?? "web",
    registered: Boolean(item.registered),
    linked: Boolean(item.linked),
    enabled: Boolean(item.enabled),
    ...(typeof item.createdAt === "number"
      ? { createdAt: item.createdAt }
      : {}),
    ...(typeof item.lastSeenAt === "number"
      ? { lastSeenAt: item.lastSeenAt }
      : {}),
    ...(typeof item.linkedAt === "number"
      ? { linkedAt: item.linkedAt }
      : {}),
  }));
},

    async registerDevice(targetUserId, device) {
      if (targetUserId !== userId) {
        throw new Error("Cannot register a device for another user.");
      }

      if (device?.deviceId === deviceId) {
        return deviceId;
      }

      throw new Error(
        "Register the device through the GRUS device-registration flow first."
      );
    },

    async removeDevice(targetUserId, targetDeviceId) {
  if (targetUserId !== userId) {
    throw new Error("Cannot remove a device from another GRUS account.");
  }

  if (
    !Number.isInteger(targetDeviceId) ||
    targetDeviceId < 1 ||
    targetDeviceId > 5
  ) {
    throw new Error("Invalid GRUS device ID.");
  }

  if (targetDeviceId === deviceId) {
    throw new Error(
      "The active device cannot remove itself. Use the account device-management flow."
    );
  }

  await request(
    `/api/signal/devices/${targetDeviceId}`,
    {
      method: "DELETE",
    }
  );
},

    async provisionIdentityKey(input) {
      if (
        input.userId !== userId ||
        input.deviceId !== deviceId
      ) {
        throw new Error("Identity provisioning user/device mismatch.");
      }

      await request("/api/signal/identity", {
        method: "POST",
        body: {
          device_id: deviceId,
          identity: input.identity,
          registration_id: input.registrationId,
          identity_type: input.identityType ?? "aci",
        },
      });
    },

    async rotateIdentityKey(input) {
  if (
    input.userId !== userId ||
    input.deviceId !== deviceId
  ) {
    throw new Error("Identity rotation user/device mismatch.");
  }

  if (
    !(input.expectedCurrentCommitment instanceof Uint8Array) ||
    input.expectedCurrentCommitment.length !== 32
  ) {
    throw new Error("Invalid current identity commitment.");
  }

  await request("/api/signal/identity/rotate", {
    method: "POST",
    body: {
      device_id: deviceId,
      identity: input.identity,
      registration_id: input.registrationId,
      identity_type: input.identityType ?? "aci",
      expected_current_commitment: toBase64(
        input.expectedCurrentCommitment
      ),
    },
  });
},

    async getIdentityKey(targetUserId, identityType = "aci") {
  if (!["aci", "pni"].includes(identityType)) {
    throw new Error("Invalid Signal identity type.");
  }

  const result = await request(
    `/api/signal/identity/${encodeURIComponent(targetUserId)}?identity_type=${encodeURIComponent(identityType)}`
  );

  if (result.identity === null) {
    return null;
  }

  if (
    result.identity?.version !== 1 ||
    typeof result.identity.x25519PublicKey !== "string" ||
    typeof result.identity.ed25519PublicKey !== "string"
  ) {
    throw new Error("Invalid GRUS composite identity response.");
  }

  return result.identity;
},

    async uploadPreKeys(
      targetUserId,
      targetDeviceId,
      keys,
      identityType = "aci"
    ) {
      if (
        targetUserId !== userId ||
        targetDeviceId !== deviceId
      ) {
        throw new Error("Cannot upload prekeys for another device.");
      }

      await request("/api/signal/prekeys", {
        method: "POST",
        body: {
          device_id: deviceId,
          identity_type: identityType,
          keys,
        },
      });
    },

    async fetchPreKeyBundle(
      targetUserId,
      targetDeviceId,
      _fetcherUserId,
      identityType = "aci"
    ) {
      try {
        return await request(
          `/api/signal/prekeys/${encodeURIComponent(targetUserId)}/${targetDeviceId}?identity_type=${encodeURIComponent(identityType)}`
        );
      } catch (error) {
        if (error.status === 404) return null;
        throw error;
      }
    },

    async getPreKeyCount(
      targetUserId,
      targetDeviceId,
      type,
      identityType = "aci"
    ) {
      const inventory = await relay.getPreKeyInventory(
        targetUserId,
        targetDeviceId,
        identityType
      );

      return type === "ec"
        ? inventory.ecOneTimePreKeyCount
        : inventory.kemOneTimePreKeyCount;
    },

    
    async getPreKeyInventory(
      targetUserId,
      targetDeviceId,
      identityType = "aci"
    ) {
      if (!["aci", "pni"].includes(identityType)) {
        throw new Error("Invalid Signal identity type.");
      }

      if (
        typeof targetUserId !== "string" ||
        !targetUserId ||
        !Number.isInteger(targetDeviceId) ||
        targetDeviceId < 1 ||
        targetDeviceId > 5
      ) {
        throw new Error("Invalid target user or device.");
      }

      const result = await request(
        `/api/signal/prekeys/${encodeURIComponent(targetUserId)}/${targetDeviceId}/inventory?identity_type=${encodeURIComponent(identityType)}`
      );

      if (
        !result ||
        !Number.isInteger(result.ecOneTimePreKeyCount) ||
        !Number.isInteger(result.kemOneTimePreKeyCount)
      ) {
        throw new Error("Invalid GRUS prekey inventory response.");
      }

      return {
        ecSignedPreKey: result.ecSignedPreKey ?? null,
        kemLastResortPreKey: result.kemLastResortPreKey ?? null,
        ecOneTimePreKeyCount: result.ecOneTimePreKeyCount,
        kemOneTimePreKeyCount: result.kemOneTimePreKeyCount,
      };
    },

    async getEcSignedPreKeyMetadata(
      targetUserId,
      targetDeviceId,
      identityType = "aci"
    ) {
      const inventory = await relay.getPreKeyInventory(
        targetUserId,
        targetDeviceId,
        identityType
      );

      return inventory.ecSignedPreKey;
    },

    async getKemLastResortPreKeyMetadata(
      targetUserId,
      targetDeviceId,
      identityType = "aci"
    ) {
      const inventory = await relay.getPreKeyInventory(
        targetUserId,
        targetDeviceId,
        identityType
      );

      return inventory.kemLastResortPreKey;
    },


    
    async clearStaleKemPreKeys(
      targetUserId,
      targetDeviceId,
      identityType = "aci"
    ) {
      if (
        targetUserId !== userId ||
        targetDeviceId !== deviceId
      ) {
        throw new Error(
          "Cannot clear KEM prekeys for another GRUS device."
        );
      }

      if (!["aci", "pni"].includes(identityType)) {
        throw new Error("Invalid Signal identity type.");
      }

      const result = await request(
        "/api/signal/prekeys/clear-stale-kem",
        {
          method: "DELETE",
          body: {
            device_id: deviceId,
            identity_type: identityType,
          },
        }
      );

      if (
        !result ||
        !Number.isInteger(result.cleared) ||
        result.cleared < 0
      ) {
        throw new Error("Invalid KEM cleanup response.");
      }

      return {
        cleared: result.cleared,
      };
    },


    async publishPlannedPreKeys(
      targetUserId,
      targetDeviceId,
      plan,
      identityType = "aci"
    ) {
      const inventory = await relay.getPreKeyInventory(
        targetUserId,
        targetDeviceId,
        identityType
      );

      const uploads = await plan(inventory);

      if (Array.isArray(uploads) && uploads.length) {
        await relay.uploadPreKeys(
          targetUserId,
          targetDeviceId,
          uploads,
          identityType
        );
      }
    },

    async getActiveDevices(targetUserId) {
      const devices = await relay.getDevices(targetUserId);

      return devices
        .filter((item) => item.enabled)
        .map((item) => ({
          userId: targetUserId,
          deviceId: item.deviceId,
        }));
    },

    
    // Device-to-device encrypted identity transfer

    async createDeviceTransfer(targetDeviceId) {
      if (
        !Number.isInteger(targetDeviceId) ||
        targetDeviceId < 2 ||
        targetDeviceId > 5 ||
        targetDeviceId === deviceId
      ) {
        throw new Error("Invalid target device for transfer.");
      }

      return request("/api/signal/device-transfers", {
        method: "POST",
        body: {
          source_device_id: deviceId,
          target_device_id: targetDeviceId,
        },
      });
    },

    async uploadDeviceTransferBackup({
      transferId,
      transferSecret,
      encryptedBackup,
    }) {
      if (
        typeof transferId !== "string" ||
        !transferId ||
        typeof transferSecret !== "string" ||
        !transferSecret ||
        !encryptedBackup ||
        typeof encryptedBackup !== "object"
      ) {
        throw new Error("Invalid device transfer upload.");
      }

      return request(
        `/api/signal/device-transfers/${encodeURIComponent(transferId)}/backup`,
        {
          method: "POST",
          headers: {
            "X-GRUS-Transfer-Secret": transferSecret,
          },
          body: {
            source_device_id: deviceId,
            encrypted_backup: encryptedBackup,
          },
        }
      );
    },

    async retrieveDeviceTransferBackup({
      transferId,
      transferSecret,
    }) {
      if (
        typeof transferId !== "string" ||
        !transferId ||
        typeof transferSecret !== "string" ||
        !transferSecret
      ) {
        throw new Error("Invalid device transfer credentials.");
      }

      return request(
        `/api/signal/device-transfers/${encodeURIComponent(transferId)}`,
        {
          method: "GET",
          headers: {
            "X-GRUS-Transfer-Secret": transferSecret,
          },
        }
      );
    },

    async completeDeviceTransfer({
      transferId,
      transferSecret,
      targetDeviceId,
    }) {
      if (
        typeof transferId !== "string" ||
        !transferId ||
        typeof transferSecret !== "string" ||
        !transferSecret ||
        !Number.isInteger(targetDeviceId) ||
        targetDeviceId < 2 ||
        targetDeviceId > 5
      ) {
        throw new Error("Invalid device transfer completion request.");
      }

      return request(
        `/api/signal/device-transfers/${encodeURIComponent(transferId)}/complete`,
        {
          method: "POST",
          headers: {
            "X-GRUS-Transfer-Secret": transferSecret,
          },
          body: {
            target_device_id: targetDeviceId,
          },
        }
      );
    },


    // Group messaging is deferred until the 1:1 E2EE flow is verified.
    async createGroupState() {
      return unsupported(
        "createGroupState",
        "GRUS Group System API (not implemented)"
      );
    },

    async getGroupState() {
      return unsupported(
        "getGroupState",
        "GRUS Group System API (not implemented)"
      );
    },

    async getGroupJoinInfo() {
      return unsupported(
        "getGroupJoinInfo",
        "GRUS Group System API (not implemented)"
      );
    },

    async getGroupChanges() {
      return unsupported(
        "getGroupChanges",
        "GRUS Group System API (not implemented)"
      );
    },

    async submitGroupChange() {
      return unsupported(
        "submitGroupChange",
        "GRUS Group System API (not implemented)"
      );
    },

    async issueAuthCredential() {
      return unsupported(
        "issueAuthCredential",
        "GRUS Group System API (not implemented)"
      );
    },
  };

  return relay;
}

