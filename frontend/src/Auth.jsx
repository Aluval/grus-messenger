import { useState } from "react";
import {
  ArrowLeft,
  ArrowRight,
  Eye,
  EyeOff,
  LockKeyhole,
  Mail,
  ShieldCheck,
  UserRound,
} from "lucide-react";
import "./Auth.css";

export default function Auth({
  mode,
  setMode,
  username,
  setUsername,
  email,
  setEmail,
  password,
  setPassword,
  message,
  loading,
  onSubmit,
  onBack,
  onForgotPassword,
}) {
  const [showPassword, setShowPassword] = useState(false);

  const isRegister = mode === "register";

  return (
    <main className="auth-screen">
      <button className="auth-back" type="button" onClick={onBack}>
        <ArrowLeft size={17} />
        Back to GRUS
      </button>

      <section className="auth-layout">
        <aside className="auth-showcase">
          <a className="auth-brand" href="#" onClick={(event) => {
            event.preventDefault();
            onBack();
          }}>
            <span className="auth-brand-mark">G</span>
            <span>GRUS<span className="auth-brand-dot">.</span></span>
          </a>

          <div className="auth-showcase-content">
            <span className="auth-eyebrow">
              <ShieldCheck size={15} />
              A SPACE THAT FEELS YOURS
            </span>

            <h1>
              Conversations
              <br />
              without the
              <br />
              <span>unnecessary noise.</span>
            </h1>

            <p>
              Connect with people who matter. Enjoy a focused messaging
              experience designed with privacy in mind.
            </p>

            <div className="auth-promise">
              <LockKeyhole size={18} />
              <span>Privacy-minded communication, built with intention.</span>
            </div>
          </div>

          <span className="auth-showcase-footer">
            Private by design. Connected in real time.
          </span>
        </aside>

        <section className="auth-form-panel">
          <div className="auth-form-card">
            <div className="auth-mobile-brand">
              <span className="auth-brand-mark">G</span>
              <strong>GRUS<span className="auth-brand-dot">.</span></strong>
            </div>

            <div className="auth-heading">
              <span className="auth-eyebrow">
                {isRegister ? "JOIN THE COMMUNITY" : "WELCOME TO GRUS"}
              </span>
              <h2>{isRegister ? "Create your account" : "Welcome back"}</h2>
              <p>
                {isRegister
                  ? "Create an account to start connecting."
                  : "Enter your details to access your conversations."}
              </p>
            </div>

            <form className="premium-auth-form" onSubmit={onSubmit}>
              {isRegister && (
                <label className="auth-field">
                  <span>Username</span>
                  <div className="auth-input-wrap">
                    <UserRound size={18} />
                    <input
                      type="text"
                      placeholder="Choose a username"
                      value={username}
                      onChange={(event) => setUsername(event.target.value)}
                      minLength={3}
                      maxLength={20}
                      autoComplete="username"
                      required
                    />
                  </div>
                  <small>3–20 characters: letters, numbers or underscores.</small>
                </label>
              )}

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

              <label className="auth-field">
                <span>Password</span>
                <div className="auth-input-wrap">
                  <LockKeyhole size={18} />
                  <input
  type={showPassword ? "text" : "password"}
  placeholder="Enter your password"
  value={password}
  onChange={(event) => setPassword(event.target.value)}
  minLength={isRegister ? 8 : undefined}
  maxLength={72}
  pattern={
    isRegister
      ? "(?=.*[A-Z])(?=.*[a-z])(?=.*[0-9])(?=.*[^A-Za-z0-9]).{8,72}"
      : undefined
  }
  title="Use 8–72 characters, including uppercase, lowercase, a number and a special character."
  autoComplete={isRegister ? "new-password" : "current-password"}
  required
/>
                  <button
                    className="password-toggle"
                    type="button"
                    onClick={() => setShowPassword((previous) => !previous)}
                    aria-label={showPassword ? "Hide password" : "Show password"}
                  >
                    {showPassword ? <EyeOff size={18} /> : <Eye size={18} />}
                  </button>
                </div>
                {isRegister && (
  <small>
    8–72 characters: uppercase, lowercase, number and special character required.
  </small>
)}
              </label>

              {!isRegister && (
                <div className="auth-forgot-row">
                  <button
                    type="button"
                    onClick={onForgotPassword}
                  >
                  Forgot password?
                </button>
                </div>
              )}

              <button
                className="auth-submit"
                type="submit"
                disabled={loading}
              >
                {loading
                  ? "Please wait..."
                  : isRegister
                    ? "Create account"
                    : "Sign in"}
                {!loading && <ArrowRight size={18} />}
              </button>
            </form>

            {message && (
              <div className="auth-feedback" role="status">
                {message}
              </div>
            )}

            <div className="auth-switch">
              {isRegister ? "Already have an account?" : "New to GRUS?"}
              <button
                type="button"
                onClick={() => {
                  setMode(isRegister ? "login" : "register");
                  setPassword("");
                }}
              >
                {isRegister ? "Sign in" : "Create account"}
              </button>
            </div>

            <div className="auth-security-note">
              <LockKeyhole size={13} />
              Your account credentials are sent securely to the GRUS server
              over your local development connection.
            </div>
          </div>
        </section>
      </section>
    </main>
  );
}
