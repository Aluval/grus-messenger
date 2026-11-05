
import { io } from "socket.io-client";

const SOCKET_URL = "http://127.0.0.1:5000";

export function connectSocket(token) {
  return io(SOCKET_URL, {
    auth: { token },
    transports: ["websocket", "polling"],
    reconnection: true,
  });
}
