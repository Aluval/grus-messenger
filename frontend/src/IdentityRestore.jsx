
import { useState } from "react";
import {
  LockKeyhole,
  ShieldCheck,
  Eye,
  EyeOff,
} from "lucide-react";

import { restoreIdentityFromRecovery } from "./services/crypto";
import { apiRequest } from "./services/api";

const DB_NAME = "grus_identity";
const STORE_NAME = "identities";

function openIdentityDB() {
  return new Promise((resolve, reject) => {
    const request = indexedDB.open(DB_NAME, 2);

    request.onupgradeneeded = () => {
      const db = request.result;

      if (!db.objectStoreNames.contains(STORE_NAME)) {
        db.createObjectStore(STORE_NAME, {
          keyPath: "userId",
        });
      }
    };

    request.onsuccess = () => resolve(request.result);
    request.onerror = () => reject(request.error);
  });
}

// Save the restored identity without overwriting an existing identity.
async function saveRestoredIdentity(userId, identity, backup) {
  const db = await openIdentityDB();

  return new Promise((resolve, reject) => {
    const transaction = db.transaction(
      STORE_NAME,
      "readwrite"
    );

    const store = transaction.objectStore(STORE_NAME);
    const key = String(userId);
    const request = store.get(key);

    request.onsuccess = () => {
      if (request.result) {
        transaction.abort();
        return;
      }

      store.add({
        userId: key,
        privateKey: identity.privateKey,
        publicKey: identity.publicKey,
        recoveryBackup: backup,
        recoverySetupPending: false,
        restoredAt: new Date().toISOString(),
      });
    };

    transaction.oncomplete = () => {
      db.close();
      resolve();
    };

    transaction.onerror = () => {
      const error = transaction.error;
      db.close();
      reject(error);
    };

    transaction.onabort = () => {
      const error = transaction.error;
      db.close();
      reject(
        error || new Error("A local identity already exists.")
      );
    };
  });
}

function arrayBufferToBase64(buffer) {
  const bytes = new Uint8Array(buffer);
  let binary = "";

  for (const byte of bytes) {
    binary += String.fromCharCode(byte);
  }

  return btoa(binary);
}

export default function IdentityRestore({
  user,
  token,
  onComplete,
}) {
  const [recoveryPassword, setRecoveryPassword] = useState("");
  const [showPassword, setShowPassword] = useState(false);
  const [loading, setLoading] = useState(false);
  const [error, setError] = useState("");
  const [notice, setNotice] = useState("");

  async function handleRestore(event) {
    event.preventDefault();

    setError("");
    setNotice("");

    if (
      recoveryPassword.length < 12 ||
      recoveryPassword.length > 128
    ) {
      setError(
        "Enter your recovery password (12–128 characters)."
      );
      return;
    }

    if (!user?.id || !token) {
      setError(
        "Your GRUS session is invalid. Please sign in again."
      );
      return;
    }

    setLoading(true);

    try {
      // 1. Retrieve the account's encrypted backup.
      const response = await apiRequest(
        "/api/auth/recovery",
        { token }
      );

      const backup = response?.recovery_backup;

      if (!backup || response.version !== 2) {
        throw new Error(
          "GRUS recovery backup is missing or unsupported."
        );
      }

      // 2. Verify the server backup's public key.
      if (
        !response.public_key ||
        backup.publicKey !== response.public_key
      ) {
        throw new Error(
          "Recovery backup public key does not match the server record."
        );
      }

      // 3. Decrypt the identity on this device.
      const identity = await restoreIdentityFromRecovery(
        backup,
        recoveryPassword
      );

      // 4. Verify the restored public key.
      const restoredPublicKey = await crypto.subtle.exportKey(
        "spki",
        identity.publicKey
      );

      const restoredPublicKeyBase64 =
        arrayBufferToBase64(restoredPublicKey);

      if (
        restoredPublicKeyBase64 !== response.public_key
      ) {
        throw new Error(
          "Restored identity does not match the server public key."
        );
      }

      // 5. Save the identity locally without overwriting anything.
      await saveRestoredIdentity(
        user.id,
        identity,
        backup
      );

      setRecoveryPassword("");
      setNotice(
        "GRUS identity restored successfully on this device."
      );

      onComplete?.();

    } catch (err) {
      console.error(
        "GRUS identity restoration failed:",
        err?.name,
        err?.message
      );

      setError(
        err.message ||
        "Identity restoration failed. Please try again."
      );

    } finally {
      setLoading(false);
    }
  }

  return (
    <main className="auth-screen">
      <section className="auth-form-panel">
        <div className="auth-form-card">

          <div className="auth-heading">
            <span className="auth-eyebrow">
              <ShieldCheck size={15} />
              GRUS IDENTITY RESTORATION
            </span>

            <h2>Restore your identity</h2>

            <p>
              Enter the recovery password you created
              on your previous device.
            </p>
          </div>

          <form
            className="premium-auth-form"
            onSubmit={handleRestore}
          >
            <label className="auth-field">
              <span>Recovery password</span>

              <div className="auth-input-wrap">
                <LockKeyhole size={18} />

                <input
                  type={showPassword ? "text" : "password"}
                  value={recoveryPassword}
                  onChange={(event) =>
                    setRecoveryPassword(event.target.value)
                  }
                  placeholder="Enter your recovery password"
                  minLength={12}
                  maxLength={128}
                  autoComplete="current-password"
                  required
                  disabled={loading}
                />

                <button
                  className="password-toggle"
                  type="button"
                  onClick={() =>
                    setShowPassword((previous) => !previous)
                  }
                  aria-label="Toggle password visibility"
                  disabled={loading}
                >
                  {showPassword
                    ? <EyeOff size={18} />
                    : <Eye size={18} />}
                </button>
              </div>
            </label>

            <div className="auth-security-note">
              Your recovery password is processed on this device.
              It is not sent to the GRUS server.
            </div>

            <button
              className="auth-submit"
              type="submit"
              disabled={loading}
            >
              {loading
                ? "Restoring identity..."
                : "Restore GRUS identity"}
            </button>
          </form>

          {error && (
            <div className="auth-feedback" role="alert">
              {error}
            </div>
          )}

          {notice && (
            <div className="auth-feedback" role="status">
              {notice}
            </div>
          )}

        </div>
      </section>
    </main>
  ); 
}
