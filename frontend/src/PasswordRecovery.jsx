
import { useState } from "react";
import { ArrowLeft, LockKeyhole, Mail, ShieldCheck } from "lucide-react";
import { apiRequest } from "./services/api";
import "./Auth.css";

function validatePassword(password) {
  if (password.length < 8 || password.length > 72) {
    return "Password must be between 8 and 72 characters.";
  }

  if (new TextEncoder().encode(password).length > 72) {
    return "Password must not exceed 72 UTF-8 bytes.";
  }

  if (!/[A-Z]/.test(password)) {
    return "Add at least one uppercase letter.";
  }

  if (!/[a-z]/.test(password)) {
    return "Add at least one lowercase letter.";
  }

  if (!/[0-9]/.test(password)) {
    return "Add at least one number.";
  }

  if (!/[^A-Za-z0-9]/.test(password)) {
    return "Add at least one special character.";
  }

  return "";
}

export default function PasswordRecovery({ onBack, initialToken = "" }) {
  const [email, setEmail] = useState("");
  const [password, setPassword] = useState("");
  const [confirmPassword, setConfirmPassword] = useState("");
  const [status, setStatus] = useState("");
  const [error, setError] = useState("");
  const [loading, setLoading] = useState(false);

  const isReset = Boolean(initialToken);

  async function handleForgot(event) {
    event.preventDefault();
    setLoading(true);
    setError("");
    setStatus("");

    try {
      const data = await apiRequest("/api/auth/forgot-password", {
        method: "POST",
        body: { email },
      });

      setStatus(
        data.message ||
          "If an account exists, reset instructions will be sent."
      );
    } catch (err) {
      setError(err.message || "Unable to request a reset link.");
    } finally {
      setLoading(false);
    }
  }

  async function handleReset(event) {
    event.preventDefault();
    setError("");
    setStatus("");

    const passwordError = validatePassword(password);

    if (passwordError) {
      setError(passwordError);
      return;
    }

    if (password !== confirmPassword) {
      setError("Passwords do not match.");
      return;
    }

    setLoading(true);

    try {
      const data = await apiRequest("/api/auth/reset-password", {
        method: "POST",
        body: {
          token: initialToken,
          password,
        },
      });

      setStatus(
        data.message ||
          "Password updated successfully. You can now sign in."
      );
      setPassword("");
      setConfirmPassword("");
    } catch (err) {
      setError(err.message || "Unable to reset password.");
    } finally {
      setLoading(false);
    }
  }

  return (
    <main className="auth-screen">
      <button className="auth-back" type="button" onClick={onBack}>
        <ArrowLeft size={17} />
        Back to sign in
      </button>

      <section className="auth-layout">
        <aside className="auth-showcase">
          <div className="auth-brand">
            <span className="auth-brand-mark">G</span>
            <span>GRUS<span className="auth-brand-dot">.</span></span>
          </div>

          <div className="auth-showcase-content">
            <span className="auth-eyebrow">
              <ShieldCheck size={15} />
              ACCOUNT SECURITY
            </span>
            <h1>
              Your account.
              <br />
              <span>Your control.</span>
            </h1>
            <p>
              Recover access to your GRUS account with a secure
              email-based password reset.
            </p>
          </div>

          <span className="auth-showcase-footer">
            Private by design. Connected in real time.
          </span>
        </aside>

        <section className="auth-form-panel">
          <div className="auth-form-card">
            <div className="auth-heading">
              <span className="auth-eyebrow">
                {isReset ? "CREATE A NEW PASSWORD" : "ACCOUNT RECOVERY"}
              </span>

              <h2>
                {isReset ? "Reset your password" : "Forgot password?"}
              </h2>

              <p>
                {isReset
                  ? "Choose a new password for your GRUS account."
                  : "Enter your registered email address to receive a reset link."}
              </p>
            </div>

            <form
              className="premium-auth-form"
              onSubmit={isReset ? handleReset : handleForgot}
            >
              {!isReset ? (
                <label className="auth-field">
                  <span>Email address</span>
                  <div className="auth-input-wrap">
                    <Mail size={18} />
                    <input
                      type="email"
                      placeholder="you@example.com"
                      value={email}
                      onChange={(event) => setEmail(event.target.value)}
                      autoComplete="email"
                      required
                    />
                  </div>
                </label>
              ) : (
                <>
                  <label className="auth-field">
                    <span>New password</span>
                    <div className="auth-input-wrap">
                      <LockKeyhole size={18} />
                      <input
                        type="password"
                        value={password}
                        onChange={(event) => setPassword(event.target.value)}
                        minLength={8}
                        maxLength={72}
                        autoComplete="new-password"
                        placeholder="Create a strong password"
                        required
                      />
                    </div>
                    <small>
                      8–72 characters: uppercase, lowercase, number and
                      special character required.
                    </small>
                  </label>

                  <label className="auth-field">
                    <span>Confirm new password</span>
                    <div className="auth-input-wrap">
                      <LockKeyhole size={18} />
                      <input
                        type="password"
                        value={confirmPassword}
                        onChange={(event) =>
                          setConfirmPassword(event.target.value)
                        }
                        minLength={8}
                        maxLength={72}
                        autoComplete="new-password"
                        placeholder="Enter the password again"
                        required
                      />
                    </div>
                  </label>
                </>
              )}

              <button className="auth-submit" type="submit" disabled={loading}>
                {loading
                  ? "Please wait..."
                  : isReset
                    ? "Update password"
                    : "Send reset link"}
              </button>
            </form>

            {status && (
              <div className="auth-feedback" role="status">
                {status}
              </div>
            )}

            {error && (
              <div className="auth-feedback" role="alert">
                {error}
              </div>
            )}

            {status && isReset && (
              <button
                className="auth-submit"
                type="button"
                onClick={onBack}
              >
                Return to sign in
              </button>
            )}
          </div>
        </section>
      </section>
    </main>
  );
}
