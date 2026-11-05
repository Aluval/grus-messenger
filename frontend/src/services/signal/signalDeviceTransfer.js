import {
  generateTransferKeyPair,
  generateTransferQRCode,
  verifyTransferQRCode,
  deriveTransferKeys,
  encryptBackup,
  decryptBackup,
  createDeviceBackup,
  validateBackup,
  wipeTransferKeys,
} from "@open-e2ee/signal-protocol-sdk/device";

import {
  generateRegistrationId,
} from "@open-e2ee/signal-protocol-sdk/keys";

import {
  webSqliteStore,
  resetWebSqliteStore,
} from "@open-e2ee/signal-protocol-sdk/local/store/web-sqlite";


const DATABASE_PREFIX = "grus-signal-v1";


function getDeviceDatabaseOptions(userId, deviceId) {
  if (typeof userId !== "string" || !userId.trim()) {
    throw new Error("Invalid GRUS user ID.");
  }

  if (!Number.isInteger(deviceId) || deviceId < 2 || deviceId > 5) {
    throw new Error("Linked device ID must be between 2 and 5.");
  }

  const safeUserId = userId.trim().replace(/[^a-zA-Z0-9_-]/g, "_");

  return {
    name: `${DATABASE_PREFIX}-${safeUserId}-device-${deviceId}`,
    encryptionAtRest: true,
  };
}


/**
 * Create a transfer session.
 * Both devices must create their own session and exchange QR codes.
 */
export async function createDeviceTransferSession() {
  const keyPair = await generateTransferKeyPair();

  try {
    const qrCode = await generateTransferQRCode(keyPair, {});

    return {
      keyPair,
      qrCode,
      encryptionKey: null,
      authenticationKey: null,
      peer: null,
    };
  } catch (error) {
    wipeTransferKeys(keyPair);
    throw error;
  }
}


/**
 * Verify the other device's QR code and derive shared transfer keys.
 */
export async function connectTransferPeer(session, peerQRCode) {
  if (!session?.keyPair) {
    throw new Error("Transfer session is not initialized.");
  }

  const peer = await verifyTransferQRCode(peerQRCode);

  const keys = await deriveTransferKeys(
    session.keyPair.privateKey,
    peer.publicKey
  );

  session.encryptionKey = keys.encryptionKey;
  session.authenticationKey = keys.authenticationKey;
  session.peer = peer;

  return {
    connected: true,
    peerDeviceType: peer.deviceType ?? "unknown",
    encryptionReady: true,
  };
}


/**
 * Generate a matching pairing confirmation code
 * on both devices using the derived authentication key.
 */
export async function generatePairingConfirmationCode(session) {
  if (
    !(session?.authenticationKey instanceof Uint8Array) ||
    !session.keyPair?.publicKey ||
    !session.peer?.publicKey
  ) {
    throw new Error("Both devices must complete ECDH pairing first.");
  }

  const publicKeys = [
    session.keyPair.publicKey,
    session.peer.publicKey,
  ].sort();

  const input = new TextEncoder().encode(
    `GRUS-PAIR-v1|${publicKeys[0]}|${publicKeys[1]}`
  );

  const combined = new Uint8Array(
    session.authenticationKey.length + input.length
  );

  combined.set(session.authenticationKey);
  combined.set(input, session.authenticationKey.length);

  const digest = await crypto.subtle.digest("SHA-256", combined);

  combined.fill(0);

  const bytes = new Uint8Array(digest);

  const number =
    (((bytes[0] << 16) | (bytes[1] << 8) | bytes[2]) % 1000000);

  return String(number).padStart(6, "0");
}


/**
 * Encode binary data as Base64.
 */
function transferBytesToBase64(bytes) {
  let binary = "";

  for (let i = 0; i < bytes.length; i += 0x8000) {
    binary += String.fromCharCode(
      ...bytes.subarray(i, i + 0x8000)
    );
  }

  return btoa(binary);
}

/**
 * Decode Base64 into binary data.
 */
function transferBase64ToBytes(value) {
  const binary = atob(value);
  const bytes = new Uint8Array(binary.length);

  for (let i = 0; i < binary.length; i++) {
    bytes[i] = binary.charCodeAt(i);
  }

  return bytes;
}

/**
 * Bind encrypted credentials to both devices' public keys.
 */
function getTransferCredentialAAD(session) {
  const publicKeys = [
    session.keyPair.publicKey,
    session.peer.publicKey,
  ].sort();

  return new TextEncoder().encode(
    `GRUS-TRANSFER-CREDENTIALS-v1|${publicKeys[0]}|${publicKeys[1]}`
  );
}

/**
 * Device 1:
 * Generate a second QR containing encrypted backend credentials.
 * The transfer secret is NEVER included as readable QR text.
 */
export async function createTransferInvitationQRCode(
  session,
  { transferId, transferSecret }
) {
  if (
    !(session?.encryptionKey instanceof Uint8Array) ||
    !session.keyPair?.publicKey ||
    !session.peer?.publicKey
  ) {
    throw new Error("Both devices must complete ECDH pairing first.");
  }

  if (
    typeof transferId !== "string" ||
    !transferId.trim() ||
    typeof transferSecret !== "string" ||
    !transferSecret.trim()
  ) {
    throw new Error("Invalid backend transfer credentials.");
  }

  const aesKey = await crypto.subtle.importKey(
    "raw",
    session.encryptionKey,
    { name: "AES-GCM" },
    false,
    ["encrypt"]
  );

  const iv = crypto.getRandomValues(new Uint8Array(12));

  const credentials = new TextEncoder().encode(
    JSON.stringify({
      transferId,
      transferSecret,
    })
  );

  const ciphertext = await crypto.subtle.encrypt(
    {
      name: "AES-GCM",
      iv,
      additionalData: getTransferCredentialAAD(session),
      tagLength: 128,
    },
    aesKey,
    credentials
  );

  const baseQRCode = await generateTransferQRCode(
    session.keyPair,
    {}
  );

  const qrPayload = JSON.parse(baseQRCode);

  return JSON.stringify({
    ...qrPayload,
    transferEnvelope: {
      version: 1,
      iv: transferBytesToBase64(iv),
      ciphertext: transferBytesToBase64(
        new Uint8Array(ciphertext)
      ),
    },
  });
}

/**
 * Device 2:
 * Verify the second QR and decrypt its backend credentials.
 *
 * Requires an already paired session and matching peer public key.
 */
export async function readTransferInvitation(
  qrCodeData,
  session
) {
  if (
    !(session?.encryptionKey instanceof Uint8Array) ||
    !session.keyPair?.publicKey ||
    !session.peer?.publicKey
  ) {
    throw new Error("Complete device pairing before reading credentials.");
  }

  let invitation;

  try {
    invitation = JSON.parse(qrCodeData);
  } catch {
    throw new Error("Invalid transfer invitation QR.");
  }

  const verified = await verifyTransferQRCode(qrCodeData);

  // Prevent accepting an invitation from a different pairing.
  if (verified.publicKey !== session.peer.publicKey) {
    throw new Error("Transfer invitation belongs to another device.");
  }

  const envelope = invitation.transferEnvelope;

  if (
    envelope?.version !== 1 ||
    typeof envelope.iv !== "string" ||
    typeof envelope.ciphertext !== "string"
  ) {
    throw new Error("Invalid encrypted transfer invitation.");
  }

  const iv = transferBase64ToBytes(envelope.iv);
  const ciphertext = transferBase64ToBytes(envelope.ciphertext);

  if (iv.length !== 12 || ciphertext.length < 16) {
    throw new Error("Invalid transfer credential envelope.");
  }

  const aesKey = await crypto.subtle.importKey(
    "raw",
    session.encryptionKey,
    { name: "AES-GCM" },
    false,
    ["decrypt"]
  );

  let plaintext;

  try {
    plaintext = await crypto.subtle.decrypt(
      {
        name: "AES-GCM",
        iv,
        additionalData: getTransferCredentialAAD(session),
        tagLength: 128,
      },
      aesKey,
      ciphertext
    );
  } catch {
    throw new Error(
      "Transfer invitation authentication failed. Check device pairing."
    );
  }

  let credentials;

  try {
    credentials = JSON.parse(
      new TextDecoder().decode(plaintext)
    );
  } catch {
    throw new Error("Decrypted transfer credentials are invalid.");
  }

  if (
    typeof credentials.transferId !== "string" ||
    !credentials.transferId.trim() ||
    typeof credentials.transferSecret !== "string" ||
    !credentials.transferSecret.trim()
  ) {
    throw new Error("Transfer credentials are incomplete.");
  }

  return {
    peer: verified,
    transferId: credentials.transferId,
    transferSecret: credentials.transferSecret,
  };
}


/**
 * Create an encrypted backup of the account identity.
 * The old device's registration ID is deliberately excluded.
 */
export async function createEncryptedIdentityBackup({
  storage,
  session,
  deviceInfo = {},
}) {
  if (!storage || !session?.encryptionKey) {
    throw new Error("Storage or transfer encryption key is missing.");
  }

  const originalBackup = await createDeviceBackup(
    storage,
    deviceInfo
  );

  const backup = {
    version: originalBackup.version,
    timestamp: originalBackup.timestamp,
    deviceInfo: originalBackup.deviceInfo ?? {},
    identityKey: {
      dhKey: {
        publicKey: originalBackup.identityKey.dhKey.publicKey,
        privateKey: originalBackup.identityKey.dhKey.privateKey,
      },
      signingKey: {
        publicKey: originalBackup.identityKey.signingKey.publicKey,
        privateKey: originalBackup.identityKey.signingKey.privateKey,
      },
    },
  };

  validateBackup(backup);

  return encryptBackup(backup, session.encryptionKey);
}


/**
 * Decrypt and validate the backup received by the linked device.
 */
export async function decryptIdentityBackup({
  encryptedBackup,
  session,
}) {
  if (!encryptedBackup || !session?.encryptionKey) {
    throw new Error("Encrypted backup or transfer key is missing.");
  }

  const backup = await decryptBackup(
    encryptedBackup,
    session.encryptionKey
  );

  validateBackup(backup);

  if (
    !backup.identityKey?.dhKey?.privateKey ||
    !backup.identityKey?.dhKey?.publicKey ||
    !backup.identityKey?.signingKey?.privateKey ||
    !backup.identityKey?.signingKey?.publicKey
  ) {
    throw new Error("The identity backup is incomplete.");
  }

  return backup;
}


/**
 * Open Device 2's own local database for identity import.
 * Do not initialize the Device 2 Signal client before this step.
 */
export async function openLinkedDeviceStagingStore({
  userId,
  deviceId,
}) {
  const options = getDeviceDatabaseOptions(userId, deviceId);

  const store = await webSqliteStore(options);

  try {
    if (await store.hasIdentityKey("aci")) {
      throw new Error(
        "Device already has an ACI identity. Refusing to overwrite it."
      );
    }

    return {
      store,
      options,
      deviceId,
    };
  } catch (error) {
    await store.close();
    throw error;
  }
}

export async function openLinkedDeviceStagingStoreForVerification({
  userId,
  deviceId,
}) {
  const options = getDeviceDatabaseOptions(userId, deviceId);
  const store = await webSqliteStore(options);

  return {
    store,
    options,
    deviceId,
    readOnlyVerification: true,
  };
}

export async function restoreLinkedDeviceIdentity({
  backup,
  stagingStore,
}) {
  if (!backup || !stagingStore) {
    throw new Error("Backup and staging store are required.");
  }

  validateBackup(backup);

  // Accept either the staging wrapper or the actual SQLite store.
  const store = stagingStore.store ?? stagingStore;

  if (await store.hasIdentityKey("aci")) {
    throw new Error("An ACI identity already exists on this device.");
  }

  const registrationId = await generateRegistrationId();

  const identityKey = {
    dhKey: backup.identityKey.dhKey,
    signingKey: backup.identityKey.signingKey,
    registrationId,
  };

  await store.storeIdentityKey(identityKey, "aci");
  await store.setLocalRegistrationId(registrationId, "aci");

  const restored = await store.getIdentityKey("aci");
  const restoredRegistrationId =
    await store.getLocalRegistrationId("aci");

    if (
    !restored ||
    restoredRegistrationId !== registrationId ||
    restored.registrationId !== registrationId ||
    restored.dhKey.publicKey !== identityKey.dhKey.publicKey ||
    restored.dhKey.privateKey !== identityKey.dhKey.privateKey ||
    restored.signingKey.publicKey !== identityKey.signingKey.publicKey ||
    restored.signingKey.privateKey !== identityKey.signingKey.privateKey
  ) {
    throw new Error("Restored identity verification failed.");
  }

  return {
    status: "complete",
    registrationId,
    identityVerified: true,
  };
}

export async function verifyLinkedDeviceIdentity({
  stagingStore,
  expectedBackup,
}) {
  if (!stagingStore || !expectedBackup) {
    throw new Error("Staging store and expected backup are required.");
  }

  const store = stagingStore.store ?? stagingStore;

  const hasIdentity = await store.hasIdentityKey("aci");

  if (!hasIdentity) {
    return {
      verified: false,
      reason: "ACI identity not found.",
    };
  }

  const identity = await store.getIdentityKey("aci");
  const registrationId = await store.getLocalRegistrationId("aci");

  const verified =
    Boolean(identity) &&
    Number.isInteger(registrationId) &&
    registrationId >= 1 &&
    registrationId <= 16383 &&
    identity.dhKey.publicKey === expectedBackup.identityKey.dhKey.publicKey &&
    identity.dhKey.privateKey === expectedBackup.identityKey.dhKey.privateKey &&
    identity.signingKey.publicKey === expectedBackup.identityKey.signingKey.publicKey &&
    identity.signingKey.privateKey === expectedBackup.identityKey.signingKey.privateKey &&
    identity.registrationId === registrationId;

  return {
    verified,
    identityPresent: Boolean(identity),
    registrationIdValid:
      Number.isInteger(registrationId) &&
      registrationId >= 1 &&
      registrationId <= 16383,
    publicKeysMatch: verified,
  };
}


/**
 * Close Device 2's staging store.
 * Call this after successful identity verification.
 */
export async function closeLinkedDeviceStagingStore(staging) {
  if (!staging?.store) return;

  await staging.store.close();
}


/**
 * Discard Device 2's database after a failed transfer.
 * This resets only the specified linked-device database.
 */
export async function discardLinkedDeviceStagingStore(staging) {
  if (!staging?.options) return;

  if (staging.store) {
    await staging.store.close();
  }

  const emptyStore = await resetWebSqliteStore(staging.options);
  await emptyStore.close();
}


/**
 * Destroy temporary transfer key references.
 */
export function destroyDeviceTransferSession(session) {
  if (!session) return;

  if (session.encryptionKey instanceof Uint8Array) {
    session.encryptionKey.fill(0);
  }

  if (session.authenticationKey instanceof Uint8Array) {
    session.authenticationKey.fill(0);
  }

  if (session.keyPair) {
    wipeTransferKeys(session.keyPair);
  }

  session.encryptionKey = null;
  session.authenticationKey = null;
  session.keyPair = null;
  session.peer = null;
  session.qrCode = null;
}