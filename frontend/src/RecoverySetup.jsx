
import { useState } from "react";
import {
  LockKeyhole,
  ShieldCheck,
  Eye,
  EyeOff,
} from "lucide-react";

import {
  createIdentityWithRecovery,
  restoreIdentityFromRecovery,
} from "./services/crypto";

import { apiRequest } from "./services/api";

const DB_NAME = "grus_identity";
const STORE_NAME = "identities";

function openIdentityDB() {
  return new Promise((resolve, reject) => {
    const request = indexedDB.open(DB_NAME, 2);

    request.onupgradeneeded = () => {
      const db = request.result;

      if (!db.objectStoreNames.contains(STORE_NAME)) {
        db.createObjectStore(STORE_NAME, { keyPath: "userId" });
      }
    };

    request.onsuccess = () => resolve(request.result);
    request.onerror = () => reject(request.error);
  });
}

async function getLocalIdentity(userId) {
  const db = await openIdentityDB();

  return new Promise((resolve, reject) => {
    const transaction = db.transaction(STORE_NAME, "readonly");
    const request = transaction.objectStore(STORE_NAME).get(String(userId));

    request.onsuccess = () => resolve(request.result || null);
    request.onerror = () => reject(request.error);

    transaction.oncomplete = () => db.close();
    transaction.onerror = () => db.close();
  });
}

async function savePendingIdentity(userId, identity, backup) {
  const db = await openIdentityDB();

  return new Promise((resolve, reject) => {
    const transaction = db.transaction(STORE_NAME, "readwrite");

    // add() refuses to overwrite an existing user record.
    transaction.objectStore(STORE_NAME).add({
      userId: String(userId),
      privateKey: identity.privateKey,
      publicKey: identity.publicKey,
      recoveryBackup: backup,
      recoverySetupPending: true,
      savedAt: new Date().toISOString(),
    });

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
      reject(error);
    };
  });
}

async function markIdentityReady(userId) {
  const db = await openIdentityDB();

  return new Promise((resolve, reject) => {
    const transaction = db.transaction(STORE_NAME, "readwrite");
    const store = transaction.objectStore(STORE_NAME);
    const request = store.get(String(userId));

    request.onsuccess = () => {
      const record = request.result;

      if (!record) {
        transaction.abort();
        return;
      }

      record.recoverySetupPending = false;
      store.put(record);
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
      reject(error || new Error("Identity update failed."));
    };
  });
}

function sameBackup(first, second) {
  if (!first || !second) return false;

  const fields = [
    "version",
    "kdf",
    "iterations",
    "cipher",
    "salt",
    "iv",
    "publicKey",
    "encryptedPrivateKey",
  ];

  return fields.every((field) => first[field] === second[field]);
}

export default function RecoverySetup({ user, token, onComplete }) {
  const [recoveryPassword, setRecoveryPassword] = useState("");
  const [confirmPassword, setConfirmPassword] = useState("");
  const [showPassword, setShowPassword] = useState(false);
  const [loading, setLoading] = useState(false);
  const [error, setError] = useState("");
  const [notice, setNotice] = useState("");

  async function getServerBackup() {
    try {
      return await apiRequest("/api/auth/recovery", { token });
    } catch (err) {
      if (err.status === 404) return null;
      throw err;
    }
  }

  async function handleSetup(event) {
    event.preventDefault();
    setError("");
    setNotice("");

    if (recoveryPassword.length < 12) {
      setError("Recovery password must contain at least 12 characters.");
      return;
    }

    if (recoveryPassword.length > 128) {
      setError("Recovery password must not exceed 128 characters.");
      return;
    }

    if (recoveryPassword !== confirmPassword) {
      setError("Recovery passwords do not match.");
      return;
    }

    if (!user?.id || !token) {
      setError("Your GRUS session is invalid. Please sign in again.");
      return;
    }

    setLoading(true);

    try {
      // Always inspect the server before creating a new identity.
      const serverBackup = await getServerBackup();
      let localIdentity = await getLocalIdentity(user.id);

      if (serverBackup) {
        if (
          localIdentity &&
          sameBackup(
            localIdentity.recoveryBackup,
            serverBackup.recovery_backup
          )
        ) {
          // Previous upload may have succeeded even if the response was lost.
          if (localIdentity.recoverySetupPending) {
            await markIdentityReady(user.id);
          }

          setNotice("Your existing GRUS recovery backup is already saved.");
          setRecoveryPassword("");
          setConfirmPassword("");
          onComplete?.();
          return;
        }

        throw new Error(
          "A recovery backup already exists on this account. Do not create another identity. Use identity restoration instead."
        );
      }

      let identity;
      let backup;

      if (localIdentity) {
        if (!localIdentity.recoverySetupPending) {
          throw new Error(
            "A local GRUS identity already exists, but its server backup is missing. Contact support before changing identity keys."
          );
        }

        // Reuse the same pending backup after an interrupted upload.
        identity = await restoreIdentityFromRecovery(
          localIdentity.recoveryBackup,
          recoveryPassword
        );

        backup = localIdentity.recoveryBackup;
      } else {
        const created = await createIdentityWithRecovery(recoveryPassword);

        identity = created.identityKeyPair;
        backup = created.recoveryBackup;

        // Never overwrite an existing local identity.
        try {
          await savePendingIdentity(user.id, identity, backup);
        } catch (saveError) {
          throw new Error(
            "Could not safely save the new identity locally. No backup was uploaded. " +
            (saveError.message || "")
          );
        }
      }

      // Upload the encrypted backup only. Never upload the password.
      try {
        await apiRequest("/api/auth/recovery", {
          method: "POST",
          token,
          body: {
            recovery_backup: backup,
            public_key: backup.publicKey,
          },
        });
      } catch (uploadError) {
        if (uploadError.status === 409) {
          throw new Error(
            "A recovery backup already exists on the server. Your local identity was preserved. Please verify the existing backup before proceeding."
          );
        }

        throw uploadError;
      }

      await markIdentityReady(user.id);

      setRecoveryPassword("");
      setConfirmPassword("");

      setNotice("Your encrypted GRUS recovery backup was saved successfully.");
      onComplete?.();
    } catch (err) {
      setError(
        err.message || "Recovery setup failed. Your local identity was preserved."
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
              GRUS IDENTITY PROTECTION
            </span>

            <h2>Set up chat recovery</h2>

            <p>
              Create a separate recovery password to protect your
              encrypted identity backup.
            </p>
          </div>

          <form className="premium-auth-form" onSubmit={handleSetup}>
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
                  placeholder="Create a recovery password"
                  minLength={12}
                  maxLength={128}
                  autoComplete="new-password"
                  required
                />

                <button
                  className="password-toggle"
                  type="button"
                  onClick={() =>
                    setShowPassword((previous) => !previous)
                  }
                  aria-label="Toggle password visibility"
                >
                  {showPassword ? <EyeOff size={18} /> : <Eye size={18} />}
                </button>
              </div>

              <small>
                Use at least 12 characters. Do not reuse your login password.
              </small>
            </label>

            <label className="auth-field">
              <span>Confirm recovery password</span>

              <div className="auth-input-wrap">
                <LockKeyhole size={18} />

                <input
                  type={showPassword ? "text" : "password"}
                  value={confirmPassword}
                  onChange={(event) =>
                    setConfirmPassword(event.target.value)
                  }
                  placeholder="Confirm your recovery password"
                  minLength={12}
                  maxLength={128}
                  autoComplete="new-password"
                  required
                />
              </div>
            </label>

            <div className="auth-security-note">
              Your recovery password is never sent to the GRUS server.
              Losing it may make historical encrypted chats inaccessible.
            </div>

            <button
              className="auth-submit"
              type="submit"
              disabled={loading}
            >
              {loading ? "Creating secure backup..." : "Create recovery backup"}
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
