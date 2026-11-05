
import {
  webSqliteStore,
} from "@open-e2ee/signal-protocol-sdk/local/store/web-sqlite";

const DATABASE_PREFIX = "grus-signal-v1";

let storagePromise = null;
let activeStorageKey = null;

function getStorageKey(userId, deviceId) {
  if (
    typeof userId !== "string" ||
    !userId.trim()
  ) {
    throw new Error("A valid GRUS user ID is required.");
  }

  if (
    !Number.isInteger(deviceId) ||
    deviceId < 1 ||
    deviceId > 5
  ) {
    throw new Error("Invalid GRUS device ID.");
  }

  const safeUserId = userId.trim().replace(/[^a-zA-Z0-9_-]/g, "_");

  return `${DATABASE_PREFIX}-${safeUserId}-device-${deviceId}`;
}

export async function initializeSignalStorage({
  userId,
  deviceId,
  existingStorage = null,
}) {
  const storageKey = getStorageKey(userId, deviceId);

  if (storagePromise) {
    if (activeStorageKey !== storageKey) {
      throw new Error(
        "Another GRUS Signal account/device is already active."
      );
    }

    return storagePromise;
  }

  activeStorageKey = storageKey;

  storagePromise = (async () => {
    const storage = existingStorage ?? await webSqliteStore({
      name: storageKey,
      encryptionAtRest: true,
    });

    if (
      existingStorage &&
      storage.storeIdentity &&
      storage.storeIdentity !== storageKey
    ) {
      throw new Error(
        "Existing storage belongs to a different database."
      );
    }

    return storage;
  })().catch((error) => {
    storagePromise = null;
    activeStorageKey = null;
    throw error;
  });

  return storagePromise;
}

export async function closeSignalStorage() {
  if (!storagePromise) return;

  const pendingStorage = storagePromise;

  try {
    const storage = await pendingStorage;
    await storage.close();
  } finally {
    storagePromise = null;
    activeStorageKey = null;
  }
}
