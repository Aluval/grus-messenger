from flask import Flask
from flask_socketio import SocketIO, emit

app = Flask(__name__)
socketio = SocketIO(app, cors_allowed_origins="*")

@socketio.on("connect")
def connected(auth):
    print("TEST CLIENT CONNECTED")

@socketio.on("ping_test")
def ping_test(data):
    emit("pong_test", {"message": "WebSocket working"})

if __name__ == "__main__":
    socketio.run(
        app,
        host="127.0.0.1",
        port=5001,
        debug=False,
        use_reloader=False
    )
