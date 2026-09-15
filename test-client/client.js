const state = {
  apiUrl: "http://localhost:3000",
  token: null,
  user: null,
  chatServer: null,
  socket: null,
  deviceId: localStorage.getItem("chat-device-id") || crypto.randomUUID(),
  heartbeatTimer: null
};

const $ = (id) => document.getElementById(id);
$("device-id").textContent = state.deviceId;
localStorage.setItem("chat-device-id", state.deviceId);

function log(event, data) {
  const line = `${new Date().toLocaleTimeString()}  ${event}${data ? `  ${JSON.stringify(data)}` : ""}`;
  $("event-log").textContent = `${line}\n${$("event-log").textContent}`.slice(0, 12000);
}

function setConnection(connected) {
  $("connection-dot").classList.toggle("online", connected);
  $("connection-label").textContent = connected ? "Connected" : "Disconnected";
  $("connect").disabled = !state.token || connected;
  $("disconnect").disabled = !connected;
  $("send").disabled = !connected;
}

function showUser() {
  $("user-label").textContent = state.user ? `${state.user.display_name} · ${state.user.user_id}` : "No account";
}

function addMessage(message, kind = "received") {
  const empty = $("messages").querySelector(".empty");
  if (empty) empty.remove();
  const item = document.createElement("article");
  item.className = `message ${kind}`;
  const scope = message.groupId ? `group ${message.groupId}` : `direct ${message.conversationId}`;
  item.innerHTML = `<div class="message-meta"><strong>${kind === "sent" ? "You" : "Message"}</strong><span>${scope} · #${message.messageId}</span></div><p></p>`;
  item.querySelector("p").textContent = message.body;
  $("messages").append(item);
  $("messages").scrollTop = $("messages").scrollHeight;
}

function updatePresence(event) {
  const list = $("presence-list");
  const empty = list.querySelector(".empty");
  if (empty) empty.remove();
  let row = list.querySelector(`[data-user-id="${event.userId}"]`);
  if (!row) {
    row = document.createElement("div");
    row.dataset.userId = event.userId;
    row.className = "presence-row";
    row.innerHTML = '<span class="dot"></span><span class="presence-user"></span><span class="presence-status"></span>';
    list.append(row);
  }
  row.querySelector(".dot").classList.toggle("online", event.status === "online");
  row.querySelector(".presence-user").textContent = event.userId;
  row.querySelector(".presence-status").textContent = event.status;
}

async function api(path, options = {}) {
  const response = await fetch(`${state.apiUrl}${path}`, {
    ...options,
    headers: { "Content-Type": "application/json", ...(options.headers || {}) }
  });
  const data = await response.json().catch(() => ({}));
  if (!response.ok) throw new Error(data.error || `HTTP ${response.status}`);
  return data;
}

async function authenticate(path) {
  state.apiUrl = $("api-url").value.replace(/\/$/, "");
  const payload = { email: $("email").value, password: $("password").value };
  if (path.endsWith("signup")) payload.displayName = $("display-name").value;
  const data = await api(path, { method: "POST", body: JSON.stringify(payload) });
  state.token = data.token;
  state.user = data.user;
  state.chatServer = data.chatServer || null;
  showUser();
  $("connect").disabled = false;
  $("sync-label").textContent = state.chatServer ? "Ready to connect" : "Logged in";
  log(path, { userId: state.user.user_id, chatServer: state.chatServer });
}

function connect() {
  if (!state.chatServer) {
    log("connect skipped", { reason: "login response did not include a chat server" });
    return;
  }
  const url = `${state.chatServer.wsUrl}?token=${encodeURIComponent(state.token)}&deviceId=${encodeURIComponent(state.deviceId)}`;
  state.socket = new WebSocket(url);
  state.socket.addEventListener("open", () => {
    setConnection(true);
    state.heartbeatTimer = setInterval(() => state.socket?.send(JSON.stringify({ type: "heartbeat" })), 10000);
    state.socket.send(JSON.stringify({ type: "heartbeat" }));
    log("socket open", { deviceId: state.deviceId });
  });
  state.socket.addEventListener("message", ({ data }) => {
    const event = JSON.parse(data);
    log(event.type, event.type === "message" ? { messageId: event.messageId } : event);
    if (event.type === "message") addMessage(event);
    if (event.type === "presence") updatePresence(event);
    if (event.type === "sync_begin") $("sync-label").textContent = `Syncing ${event.messageCount} messages`;
    if (event.type === "sync_complete") $("sync-label").textContent = "Synced";
  });
  state.socket.addEventListener("close", () => {
    clearInterval(state.heartbeatTimer);
    state.heartbeatTimer = null;
    state.socket = null;
    setConnection(false);
    log("socket closed");
  });
  state.socket.addEventListener("error", () => log("socket error"));
}

$("signup").addEventListener("click", () => authenticate("/auth/signup").catch((error) => log("error", error.message)));
$("login").addEventListener("click", () => authenticate("/auth/login").catch((error) => log("error", error.message)));
$("connect").addEventListener("click", connect);
$("disconnect").addEventListener("click", () => state.socket?.close());
$("clear-log").addEventListener("click", () => { $("event-log").textContent = ""; });
$("message-kind").addEventListener("change", () => { $("target-id").placeholder = $("message-kind").value === "group" ? "Group ID" : "Recipient user ID"; });
$("message-form").addEventListener("submit", (event) => {
  event.preventDefault();
  const isGroup = $("message-kind").value === "group";
  const payload = isGroup
    ? { type: "send_group_message", groupId: $("target-id").value, body: $("message-body").value }
    : { type: "send_message", recipientId: $("target-id").value, body: $("message-body").value };
  state.socket.send(JSON.stringify(payload));
  addMessage({ ...payload, messageId: "pending", conversationId: isGroup ? payload.groupId : "outgoing" }, "sent");
  $("message-body").value = "";
});
