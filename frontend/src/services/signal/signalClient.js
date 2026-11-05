
import {
  createSignalProtocolClient,
} from "@open-e2ee/signal-protocol-sdk/client";

import {
  initializeSignalStorage,
  closeSignalStorage,
} from "./signalStorage";

import {
  createGrusSignalRelay,
} from "./signalRelay";

let clientPromise = null;
let activeIdentity = null;
let activeStorageReference = null;


export async function initializeSignalClient({
  userId,
  deviceId,
  existingStorage = null,
}) {
  if (
    typeof userId !== "string" ||
    !userId.trim() ||
    !Number.isInteger(deviceId) ||
    deviceId < 1 ||
    deviceId > 5
  ) {
    throw new Error("Invalid GRUS account or device.");
  }

  const normalizedUserId = userId.trim();
  const identityKey = `${normalizedUserId}:${deviceId}`;

  if (clientPromise) {
    if (activeIdentity !== identityKey) {
      throw new Error(
        "A different GRUS Signal account/device is already active."
      );
    }

    return clientPromise;
  }

  activeIdentity = identityKey;

  clientPromise = (async () => {
    const storage = await initializeSignalStorage({
      userId: normalizedUserId,
      deviceId,
      existingStorage,
    });

    activeStorageReference = storage;

    try {
      const relay = createGrusSignalRelay({
        userId: normalizedUserId,
        deviceId,
      });

      const client = await createSignalProtocolClient({
        identity: {
          userId: normalizedUserId,
          deviceId,
        },
        adapters: {
          storage,
          relay,
        },
      });

      if (import.meta.env.DEV) {
        window.__GRUS_SIGNAL_STORAGE_TEST__ = storage;
      }

      return client;
    } catch (error) {
      await closeSignalStorage();
      throw error;
    }
  })();

  try {
    return await clientPromise;
  } catch (error) {
    clientPromise = null;
    activeIdentity = null;
    activeStorageReference = null;
    throw error;
  }
}


export async function stopSignalClient() {
  if (!clientPromise) return;

  const pendingClient = clientPromise;

  try {
    const client = await pendingClient;
    await client.stop();
  } finally {
    clientPromise = null;
    activeIdentity = null;
    activeStorageReference = null;
    await closeSignalStorage();
  }
}
