
// GRUS - Encrypted Recovery Foundation v2
// Browser-native Web Crypto API.
// Authenticates the public key as AES-GCM additional authenticated data.
// This is not a complete E2EE messaging protocol.

const PBKDF2_ITERATIONS = 600000;
const RECOVERY_VERSION = 2;
const RECOVERY_AAD = new TextEncoder().encode("GRUS-RECOVERY-V2");

function ensureCryptoAvailable() {
  if (!globalThis.crypto?.subtle) {
    throw new Error("Web Crypto API is unavailable. Use localhost or HTTPS.");
  }
}

function toBase64(buffer) {
  const bytes = new Uint8Array(buffer);
  let binary = "";

  for (let i = 0; i < bytes.length; i++) {
    binary += String.fromCharCode(bytes[i]);
  }

  return btoa(binary);
}

function fromBase64(value) {
  if (typeof value !== "string" || !/^[A-Za-z0-9+/]*={0,2}$/.test(value)) {
    throw new Error("Invalid recovery backup encoding.");
  }

  const binary = atob(value);
  const bytes = new Uint8Array(binary.length);

  for (let i = 0; i < binary.length; i++) {
    bytes[i] = binary.charCodeAt(i);
  }

  return bytes;
}

function concatenateBytes(first, second) {
  const result = new Uint8Array(first.length + second.length);
  result.set(first, 0);
  result.set(second, first.length);
  return result;
}

function validateRecoveryPassword(password) {
  if (typeof password !== "string" || password.length < 12) {
    throw new Error("Recovery password must contain at least 12 characters.");
  }
}

async function deriveRecoveryKey(password, salt) {
  const passwordBytes = new TextEncoder().encode(password);

  const passwordKey = await crypto.subtle.importKey(
    "raw",
    passwordBytes,
    "PBKDF2",
    false,
    ["deriveKey"]
  );

  return crypto.subtle.deriveKey(
    {
      name: "PBKDF2",
      salt,
      iterations: PBKDF2_ITERATIONS,
      hash: "SHA-256",
    },
    passwordKey,
    {
      name: "AES-GCM",
      length: 256,
    },
    false,
    ["encrypt", "decrypt"]
  );
}

export async function generateIdentityKeyPair() {
  ensureCryptoAvailable();

  return crypto.subtle.generateKey(
    { name: "ECDH", namedCurve: "P-256" },
    false,
    ["deriveBits"]
  );
}

export async function exportPublicKey(publicKey) {
  ensureCryptoAvailable();
  return crypto.subtle.exportKey("spki", publicKey);
}


export async function getIdentityFingerprint(publicKey) {
  ensureCryptoAvailable();

  const publicKeyData = await exportPublicKey(publicKey);

  const fingerprint = await crypto.subtle.digest(
    "SHA-256",
    publicKeyData
  );

  return Array.from(new Uint8Array(fingerprint))
    .map((byte) => byte.toString(16).padStart(2, "0"))
    .join("")
    .toUpperCase()
    .match(/.{1,4}/g)
    .join(" ");
}


export async function importPublicKey(publicKeyData) {
  ensureCryptoAvailable();

  return crypto.subtle.importKey(
    "spki",
    publicKeyData,
    { name: "ECDH", namedCurve: "P-256" },
    true,
    []
  );
}


// GRUS messaging encryption — prototype v1
const MESSAGE_ENCRYPTION_VERSION = 1;
const MESSAGE_KEY_INFO = new TextEncoder().encode(
  "GRUS-MESSAGE-KEY-V1"
);

function getMessageAAD(conversationId) {
  if (
    typeof conversationId !== "string" ||
    !conversationId.trim() ||
    conversationId.length > 128
  ) {
    throw new Error("Invalid conversation ID.");
  }

  return new TextEncoder().encode(
    `GRUS-MESSAGE-V1:${conversationId}`
  );
}

// Both participants derive the same AES key from their ECDH key pairs.
export async function deriveConversationKey(
  privateKey,
  peerPublicKey,
  conversationId
) {
  ensureCryptoAvailable();

  if (
    !privateKey ||
    privateKey.type !== "private" ||
    privateKey.algorithm.name !== "ECDH" ||
    !peerPublicKey ||
    peerPublicKey.type !== "public" ||
    peerPublicKey.algorithm.name !== "ECDH"
  ) {
    throw new Error("Invalid identity key pair.");
  }

  const sharedSecret = await crypto.subtle.deriveBits(
    {
      name: "ECDH",
      public: peerPublicKey,
    },
    privateKey,
    256
  );

  try {
    const hkdfKey = await crypto.subtle.importKey(
      "raw",
      sharedSecret,
      "HKDF",
      false,
      ["deriveKey"]
    );

    return await crypto.subtle.deriveKey(
      {
        name: "HKDF",
        hash: "SHA-256",
        salt: new Uint8Array(32),
        info: concatenateBytes(
          MESSAGE_KEY_INFO,
          getMessageAAD(conversationId)
        ),
      },
      hkdfKey,
      {
        name: "AES-GCM",
        length: 256,
      },
      false,
      ["encrypt", "decrypt"]
    );
  } finally {
    new Uint8Array(sharedSecret).fill(0);
  }
}

// Encrypt a message in the sender's browser.
export async function encryptMessage(
  plaintext,
  conversationKey,
  conversationId
) {
  ensureCryptoAvailable();

  if (
    typeof plaintext !== "string" ||
    !plaintext.trim() ||
    plaintext.length > 5000
  ) {
    throw new Error("Message must contain 1–5000 characters.");
  }

  if (
    !conversationKey ||
    conversationKey.algorithm.name !== "AES-GCM"
  ) {
    throw new Error("Invalid conversation encryption key.");
  }

  const iv = crypto.getRandomValues(new Uint8Array(12));
  const additionalData = getMessageAAD(conversationId);
  const encodedMessage = new TextEncoder().encode(plaintext);

  const ciphertext = await crypto.subtle.encrypt(
    {
      name: "AES-GCM",
      iv,
      additionalData,
      tagLength: 128,
    },
    conversationKey,
    encodedMessage
  );

  return JSON.stringify({
    version: MESSAGE_ENCRYPTION_VERSION,
    algorithm: "AES-256-GCM",
    iv: toBase64(iv),
    ciphertext: toBase64(ciphertext),
  });
}

// GRUS encrypted image attachment support.
// Uses the existing conversation AES-256-GCM key.
// Does not modify the text-message encryption format.

const IMAGE_ENCRYPTION_VERSION = 1;

function getImageAAD(conversationId) {
  if (
    typeof conversationId !== "string" ||
    !conversationId.trim() ||
    conversationId.length > 128
  ) {
    throw new Error("Invalid conversation ID.");
  }

  return new TextEncoder().encode(
    `GRUS-IMAGE-V1:${conversationId}`
  );
}

export async function encryptImage(
  imageFile,
  conversationKey,
  conversationId
) {
  ensureCryptoAvailable();

  if (!(imageFile instanceof Blob) || imageFile.size === 0) {
    throw new Error("Invalid or empty image.");
  }

  if (imageFile.size > 5 * 1024 * 1024) {
    throw new Error("Image must be 5 MB or smaller.");
  }

  if (
    !conversationKey ||
    conversationKey.algorithm.name !== "AES-GCM"
  ) {
    throw new Error("Invalid conversation encryption key.");
  }

  const allowedTypes = [
    "image/jpeg",
    "image/png",
    "image/webp",
  ];

  if (!allowedTypes.includes(imageFile.type)) {
    throw new Error("Only JPEG, PNG and WebP images are supported.");
  }

  const iv = crypto.getRandomValues(new Uint8Array(12));
  const plaintext = await imageFile.arrayBuffer();

  const ciphertext = await crypto.subtle.encrypt(
    {
      name: "AES-GCM",
      iv,
      additionalData: getImageAAD(conversationId),
      tagLength: 128,
    },
    conversationKey,
    plaintext
  );

  return {
    version: IMAGE_ENCRYPTION_VERSION,
    algorithm: "AES-256-GCM",
    iv: toBase64(iv),
    ciphertext,
    originalType: imageFile.type,
    originalSize: imageFile.size,
  };
}

export async function decryptImage(
  encryptedData,
  conversationKey,
  conversationId
) {
  ensureCryptoAvailable();

  if (
    !encryptedData ||
    encryptedData.version !== IMAGE_ENCRYPTION_VERSION ||
    encryptedData.algorithm !== "AES-256-GCM"
  ) {
    throw new Error("Unsupported encrypted image format.");
  }

  if (
    !conversationKey ||
    conversationKey.algorithm.name !== "AES-GCM"
  ) {
    throw new Error("Invalid conversation encryption key.");
  }

  const iv = fromBase64(encryptedData.iv);

  if (iv.length !== 12) {
    throw new Error("Invalid encrypted image IV.");
  }

  try {
    return await crypto.subtle.decrypt(
      {
        name: "AES-GCM",
        iv,
        additionalData: getImageAAD(conversationId),
        tagLength: 128,
      },
      conversationKey,
      encryptedData.ciphertext
    );
  } catch {
    throw new Error("Image decryption failed.");
  }
}

// Decrypt a received message in the recipient's browser.
export async function decryptMessage(
  encryptedPayload,
  conversationKey,
  conversationId
) {
  ensureCryptoAvailable();

  if (
    !conversationKey ||
    conversationKey.algorithm.name !== "AES-GCM"
  ) {
    throw new Error("Invalid conversation encryption key.");
  }

  let payload;

  try {
    payload = JSON.parse(encryptedPayload);
  } catch {
    throw new Error("Invalid encrypted message format.");
  }

  if (
    !payload ||
    payload.version !== MESSAGE_ENCRYPTION_VERSION ||
    payload.algorithm !== "AES-256-GCM"
  ) {
    throw new Error("Unsupported encrypted message format.");
  }

  const iv = fromBase64(payload.iv);
  const ciphertext = fromBase64(payload.ciphertext);

  if (iv.length !== 12 || ciphertext.length < 17) {
    throw new Error("Invalid encrypted message data.");
  }

  try {
    const plaintext = await crypto.subtle.decrypt(
      {
        name: "AES-GCM",
        iv,
        additionalData: getMessageAAD(conversationId),
        tagLength: 128,
      },
      conversationKey,
      ciphertext
    );

    return new TextDecoder("utf-8", { fatal: true }).decode(plaintext);
  } catch {
    throw new Error(
      "Message decryption failed. Key, conversation or message may be invalid."
    );
  }
}


// Create an identity and its password-protected recovery backup.
export async function createIdentityWithRecovery(recoveryPassword) {
  ensureCryptoAvailable();
  validateRecoveryPassword(recoveryPassword);

  // This temporary pair is extractable only so its private key
  // can be encrypted into the recovery backup.
  const temporaryKeyPair = await crypto.subtle.generateKey(
    { name: "ECDH", namedCurve: "P-256" },
    true,
    ["deriveBits"]
  );

  const privateKeyData = await crypto.subtle.exportKey(
    "pkcs8",
    temporaryKeyPair.privateKey
  );

  const publicKeyData = await crypto.subtle.exportKey(
    "spki",
    temporaryKeyPair.publicKey
  );

  const salt = crypto.getRandomValues(new Uint8Array(16));
  const iv = crypto.getRandomValues(new Uint8Array(12));

  const recoveryKey = await deriveRecoveryKey(recoveryPassword, salt);

  // Bind the public key to the encrypted private key.
  // Any change to the public key causes AES-GCM authentication to fail.
  const authenticatedData = concatenateBytes(
    RECOVERY_AAD,
    new Uint8Array(publicKeyData)
  );

  const encryptedPrivateKey = await crypto.subtle.encrypt(
    {
      name: "AES-GCM",
      iv,
      additionalData: authenticatedData,
      tagLength: 128,
    },
    recoveryKey,
    privateKeyData
  );

  // Import the working private key as non-exportable.
  const privateKey = await crypto.subtle.importKey(
    "pkcs8",
    privateKeyData,
    { name: "ECDH", namedCurve: "P-256" },
    false,
    ["deriveBits"]
  );

  const publicKey = await crypto.subtle.importKey(
    "spki",
    publicKeyData,
    { name: "ECDH", namedCurve: "P-256" },
    true,
    []
  );

  // Clear the temporary exported private-key bytes from this buffer.
  new Uint8Array(privateKeyData).fill(0);

  return {
    identityKeyPair: { privateKey, publicKey },
    recoveryBackup: {
      version: RECOVERY_VERSION,
      kdf: "PBKDF2-SHA-256",
      iterations: PBKDF2_ITERATIONS,
      cipher: "AES-256-GCM",
      salt: toBase64(salt),
      iv: toBase64(iv),
      publicKey: toBase64(publicKeyData),
      encryptedPrivateKey: toBase64(encryptedPrivateKey),
    },
  };
}

// Restore an identity from its encrypted recovery backup.
export async function restoreIdentityFromRecovery(
  recoveryBackup,
  recoveryPassword
) {
  ensureCryptoAvailable();
  validateRecoveryPassword(recoveryPassword);

  if (
    !recoveryBackup ||
    recoveryBackup.version !== RECOVERY_VERSION ||
    recoveryBackup.kdf !== "PBKDF2-SHA-256" ||
    recoveryBackup.cipher !== "AES-256-GCM" ||
    recoveryBackup.iterations !== PBKDF2_ITERATIONS
  ) {
    throw new Error("Unsupported or invalid GRUS recovery backup.");
  }

  const salt = fromBase64(recoveryBackup.salt);
  const iv = fromBase64(recoveryBackup.iv);
  const encryptedPrivateKey = fromBase64(
    recoveryBackup.encryptedPrivateKey
  );
  const publicKeyData = fromBase64(recoveryBackup.publicKey);

  if (
    salt.length !== 16 ||
    iv.length !== 12 ||
    encryptedPrivateKey.length < 17 ||
    publicKeyData.length === 0
  ) {
    throw new Error("Invalid recovery backup format.");
  }

  const recoveryKey = await deriveRecoveryKey(recoveryPassword, salt);

  const authenticatedData = concatenateBytes(
    RECOVERY_AAD,
    publicKeyData
  );

  let privateKeyData;

  try {
    privateKeyData = await crypto.subtle.decrypt(
      {
        name: "AES-GCM",
        iv,
        additionalData: authenticatedData,
        tagLength: 128,
      },
      recoveryKey,
      encryptedPrivateKey
    );
    } catch (error) {
    if (error?.name === "OperationError") {
      throw new Error(
        "GRUS could not decrypt this backup. The recovery password or backup encryption data may not match."
      );
    }

    throw error;
  }

  try {
    const privateKey = await crypto.subtle.importKey(
      "pkcs8",
      privateKeyData,
      { name: "ECDH", namedCurve: "P-256" },
      false,
      ["deriveBits"]
    );

    const publicKey = await crypto.subtle.importKey(
      "spki",
      publicKeyData,
      { name: "ECDH", namedCurve: "P-256" },
      true,
      []
    );

    return { privateKey, publicKey };
  } catch {
    throw new Error("Recovery backup contains invalid key material.");
  } finally {
    if (privateKeyData) {
      new Uint8Array(privateKeyData).fill(0);
    }
  }
}

export async function testRecoveryPassword(backup, password) {
  try {
    const identity = await restoreIdentityFromRecovery(
      backup,
      password
    );

    const restoredPublicKey = await exportPublicKey(
      identity.publicKey
    );

    const bytes = new Uint8Array(restoredPublicKey);
    let binary = "";

    for (const byte of bytes) {
      binary += String.fromCharCode(byte);
    }

    return {
      decrypted: true,
      publicKeyMatches: btoa(binary) === backup.publicKey,
    };
  } catch (error) {
    return {
      decrypted: false,
      error: error.message,
    };
  }
}

export async function changeRecoveryPasswordBackup(
  recoveryBackup,
  oldPassword,
  newPassword
) {
  ensureCryptoAvailable();
  validateRecoveryPassword(oldPassword);
  validateRecoveryPassword(newPassword);

  if (oldPassword === newPassword) {
    throw new Error("Choose a different new recovery password.");
  }

  if (
    !recoveryBackup ||
    recoveryBackup.version !== RECOVERY_VERSION ||
    recoveryBackup.kdf !== "PBKDF2-SHA-256" ||
    recoveryBackup.cipher !== "AES-256-GCM" ||
    recoveryBackup.iterations !== PBKDF2_ITERATIONS
  ) {
    throw new Error("Unsupported or invalid recovery backup.");
  }

  const oldSalt = fromBase64(recoveryBackup.salt);
  const oldIv = fromBase64(recoveryBackup.iv);
  const oldCiphertext = fromBase64(
    recoveryBackup.encryptedPrivateKey
  );
  const publicKeyData = fromBase64(recoveryBackup.publicKey);

  if (
    oldSalt.length !== 16 ||
    oldIv.length !== 12 ||
    oldCiphertext.length < 17 ||
    publicKeyData.length === 0
  ) {
    throw new Error("Invalid recovery backup data.");
  }

  const authenticatedData = concatenateBytes(
    RECOVERY_AAD,
    publicKeyData
  );

  let privateKeyData;

  try {
    // Decrypt the existing backup using the old password.
    const oldRecoveryKey = await deriveRecoveryKey(
      oldPassword,
      oldSalt
    );

    try {
      privateKeyData = await crypto.subtle.decrypt(
        {
          name: "AES-GCM",
          iv: oldIv,
          additionalData: authenticatedData,
          tagLength: 128,
        },
        oldRecoveryKey,
        oldCiphertext
      );
    } catch {
      throw new Error(
        "The existing recovery password is incorrect, or the backup cannot be decrypted."
      );
    }

    // Validate that the recovered bytes are a usable ECDH private key.
    await crypto.subtle.importKey(
      "pkcs8",
      privateKeyData,
      { name: "ECDH", namedCurve: "P-256" },
      false,
      ["deriveBits"]
    );

    // Encrypt the SAME private-key bytes with the new password.
    const newSalt = crypto.getRandomValues(new Uint8Array(16));
    const newIv = crypto.getRandomValues(new Uint8Array(12));

    const newRecoveryKey = await deriveRecoveryKey(
      newPassword,
      newSalt
    );

    const newCiphertext = await crypto.subtle.encrypt(
      {
        name: "AES-GCM",
        iv: newIv,
        additionalData: authenticatedData,
        tagLength: 128,
      },
      newRecoveryKey,
      privateKeyData
    );

    const newBackup = {
      version: RECOVERY_VERSION,
      kdf: "PBKDF2-SHA-256",
      iterations: PBKDF2_ITERATIONS,
      cipher: "AES-256-GCM",
      salt: toBase64(newSalt),
      iv: toBase64(newIv),
      publicKey: recoveryBackup.publicKey,
      encryptedPrivateKey: toBase64(newCiphertext),
    };

    // Verify the new backup before allowing it to be saved.
    const verificationKey = await deriveRecoveryKey(
      newPassword,
      newSalt
    );

    const verificationBytes = await crypto.subtle.decrypt(
      {
        name: "AES-GCM",
        iv: newIv,
        additionalData: authenticatedData,
        tagLength: 128,
      },
      verificationKey,
      newCiphertext
    );

    const originalBytes = new Uint8Array(privateKeyData);
    const verifiedBytes = new Uint8Array(verificationBytes);

    const matches =
      originalBytes.length === verifiedBytes.length &&
      originalBytes.every(
        (byte, index) => byte === verifiedBytes[index]
      );

    verifiedBytes.fill(0);

    if (!matches) {
      throw new Error(
        "New recovery backup verification failed. Nothing was saved."
      );
    }

    return newBackup;
  } finally {
    if (privateKeyData) {
      new Uint8Array(privateKeyData).fill(0);
    }
  }
}
