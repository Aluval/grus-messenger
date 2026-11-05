import { useEffect, useState } from "react";
import { io } from "socket.io-client";

export default function SocketTest() {
  const [status, setStatus] = useState("Connecting...");

  useEffect(() => {
    const socket = io("http://127.0.0.1:5001", {
      transports: ["websocket"],
    });

    socket.on("connect", () => {
      setStatus("CONNECTED: " + socket.id);
      socket.emit("ping_test", {});
    });

    socket.on("pong_test", (data) => {
      setStatus("CONNECTED — " + data.message);
    });

    socket.on("connect_error", (error) => {
      setStatus("CONNECTION ERROR: " + error.message);
    });

    return () => socket.disconnect();
  }, []);

  return <h2>GRUS WebSocket Test: {status}</h2>;
}
