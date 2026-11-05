import { io } from "socket.io-client";
import { API_URL } from "./api";

export function connectSocket(token) {
  return io(API_URL, {
    auth: { token },
    transports: ["websocket", "polling"],
    reconnection: true,
  });
}
