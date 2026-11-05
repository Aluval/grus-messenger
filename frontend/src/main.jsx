
import { StrictMode } from "react";
import { createRoot } from "react-dom/client";
import "./index.css";
import App from "./App.jsx";
import SignalTest from "./SignalTest.jsx";

const isSignalTest =
  window.location.pathname === "/signal-test";

createRoot(document.getElementById("root")).render(
  <StrictMode>
    {isSignalTest ? <SignalTest /> : <App />}
  </StrictMode>
);
