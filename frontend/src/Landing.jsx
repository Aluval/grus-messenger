import { ArrowRight, LockKeyhole, ShieldCheck, Zap, Menu, X } from "lucide-react";
import { useState } from "react";
import "./Landing.css";

export default function Landing({ onSignIn, onSignUp }) {
  const [menuOpen, setMenuOpen] = useState(false);

  function closeMenu(action) {
    setMenuOpen(false);
    action();
  }

  return (
    <main className="landing-page">
      <nav className="landing-nav">
        <a className="brand" href="#home" aria-label="GRUS home">
          <span className="brand-mark">G</span>
          <span>GRUS<span className="brand-period">.</span></span>
        </a>

        <button
          className="mobile-menu-button"
          onClick={() => setMenuOpen(!menuOpen)}
          aria-label="Toggle navigation"
        >
          {menuOpen ? <X size={22} /> : <Menu size={22} />}
        </button>

        <div className={`nav-links ${menuOpen ? "nav-open" : ""}`}>
          <a href="#features" onClick={() => setMenuOpen(false)}>Features</a>
          <a href="#privacy" onClick={() => setMenuOpen(false)}>Privacy</a>
          <button className="nav-signin" onClick={() => closeMenu(onSignIn)}>
            Sign in
          </button>
          <button className="nav-signup" onClick={() => closeMenu(onSignUp)}>
            Get started <ArrowRight size={16} />
          </button>
        </div>
      </nav>

      <section className="hero-section" id="home">
        <div className="hero-glow" />
        <div className="hero-content">
          <div className="announcement">
            <span className="announcement-dot" />
            A more private way to connect
            <ArrowRight size={14} />
          </div>

          <h1>
            Your conversations.
            <br />
            <span>Your space.</span>
          </h1>

          <p className="hero-description">
            Connect with the people who matter. GRUS is being built around
            privacy, simplicity, and real-time communication.
          </p>

          <div className="hero-actions">
            <button className="primary-cta" onClick={onSignUp}>
              Create your account <ArrowRight size={18} />
            </button>
            <button className="secondary-cta" onClick={onSignIn}>
              Sign in
            </button>
          </div>

          <div className="hero-note">
            <LockKeyhole size={15} />
            <span>Built with privacy as a priority</span>
          </div>
        </div>

        <div className="hero-visual" aria-label="GRUS messaging preview">
          <div className="visual-orbit orbit-one" />
          <div className="visual-orbit orbit-two" />
          <div className="visual-card">
            <div className="visual-card-top">
              <div className="visual-brand">
                <span className="brand-mark small-mark">G</span>
                <span>GRUS</span>
              </div>
              <span className="online-indicator">? Online</span>
            </div>

            <div className="preview-contact">
              <div className="preview-avatar">A</div>
              <div>
                <strong>Alex Morgan</strong>
                <span>Active now</span>
              </div>
              <ShieldCheck className="preview-shield" size={20} />
            </div>

            <div className="preview-divider" />

            <div className="preview-date">TODAY</div>
            <div className="preview-message received-message">
              Hey! How's your day going?
              <span>10:42 AM</span>
            </div>
            <div className="preview-message sent-message">
              Pretty good. Working on something new.
              <span>10:43 AM <span className="read-mark">??</span></span>
            </div>
            <div className="preview-message received-message">
              That sounds exciting!
              <span>10:44 AM</span>
            </div>

            <div className="preview-input">
              <span>Write a message...</span>
              <span className="preview-send"><ArrowRight size={16} /></span>
            </div>
            <div className="preview-encryption">
              <LockKeyhole size={12} />
              Private conversations matter.
            </div>
          </div>
          <div className="floating-badge">
            <ShieldCheck size={17} />
            <span>Privacy first</span>
          </div>
        </div>
      </section>

      <section className="trust-strip" id="privacy">
        <span>DESIGNED AROUND WHAT MATTERS</span>
        <div><LockKeyhole size={16} /> Privacy-minded</div>
        <div><Zap size={16} /> Real-time messaging</div>
        <div><ShieldCheck size={16} /> Security-focused</div>
      </section>

      <section className="features-section" id="features">
        <div className="section-heading">
          <span className="eyebrow">THE GRUS EXPERIENCE</span>
          <h2>Less noise. More connection.</h2>
          <p>Thoughtful communication starts with a better experience.</p>
        </div>

        <div className="feature-grid">
          <article className="feature-card">
            <div className="feature-icon"><LockKeyhole size={22} /></div>
            <h3>Privacy comes first</h3>
            <p>Privacy is a core design goal. Our end-to-end encryption journey is being built carefully and transparently.</p>
          </article>
          <article className="feature-card">
            <div className="feature-icon"><Zap size={22} /></div>
            <h3>Conversations in real time</h3>
            <p>Send and receive messages with a responsive, straightforward chat experience.</p>
          </article>
          <article className="feature-card">
            <div className="feature-icon"><ShieldCheck size={22} /></div>
            <h3>Built with intention</h3>
            <p>A focused messaging experience designed to keep communication simple and clear.</p>
          </article>
        </div>
      </section>

      <section className="closing-section">
        <div>
          <span className="eyebrow">YOUR SPACE TO CONNECT</span>
          <h2>Make room for better conversations.</h2>
          <p>Start your GRUS account and explore a simpler way to message.</p>
        </div>
        <button className="primary-cta" onClick={onSignUp}>
          Get started <ArrowRight size={18} />
        </button>
      </section>

      <footer className="landing-footer">
        <a className="brand footer-brand" href="#home">
          <span className="brand-mark">G</span>
          <span>GRUS<span className="brand-period">.</span></span>
        </a>
        <span>Private by design. Connected in real time.</span>
        <span>Â© {new Date().getFullYear()} GRUS</span>
      </footer>
    </main>
  );
}

