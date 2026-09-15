# Distributed Chat System Prototype

A phased Node.js and TypeScript prototype based on the architecture in *System Design Interview*, Chapter 12, by Alex Xu.

## Phase 1: scaffold

The repository separates:

- `api-service/`: the future stateless HTTP API for identity, profiles, and groups.
- `chat-service/`: the future stateful raw WebSocket service for persistent client connections.
- `shared/`: cross-service types and the Postgres schema.
- `docker-compose.yml`: local Postgres and Redis infrastructure.

The schema keeps direct and group messages in separate tables. Message retrieval is keyed by conversation/group ID plus a local ordered `message_id`, and `sync_inbox` models the per-recipient fanout queue required for multi-device synchronization.

## Run infrastructure

```powershell
docker compose up -d
```

To run the complete project in Docker, start Docker Desktop, then run:

```powershell
$env:JWT_SECRET = "replace-with-a-local-secret"
docker compose up --build -d
docker compose ps
```

Open the production-style frontend at `http://localhost:5173`. The API is at `http://localhost:3000` and the WebSocket service is at `ws://localhost:4000`. To follow logs, use `docker compose logs -f api chat frontend`. Stop everything with `docker compose down`; add `-v` only when you intentionally want to delete the Postgres and Redis data volumes.

Install dependencies and typecheck:

```powershell
npm install
npm run typecheck
```

The service entry points are intentionally minimal until their implementation phases:

```powershell
npm run dev:api
npm run dev:chat
```

API health: `http://localhost:3000/health`

WebSocket endpoint: `ws://localhost:4000`

## Phase 3: service discovery and WebSocket lifecycle

The API service discovers an active chat instance from Redis during login and returns its `wsUrl` as `chatServer`. The chat service refreshes its registry record every five seconds with a 15-second TTL. Clients connect with the JWT as `ws://<chatServer>/...?token=<jwt>`; the chat service verifies it during the HTTP upgrade before accepting the socket.

Run both services in separate terminals after starting Docker Desktop:

```powershell
$env:JWT_SECRET = "local-development-secret"
npm run dev:chat
npm run dev:api
```

Login only succeeds once a registered chat service is available.

## Phase 4: one-to-one messaging

Send a direct message over the authenticated WebSocket:

```json
{"type":"send_message","recipientId":"<user-id>","body":"hello"}
```

The chat service creates a deterministic conversation ID from the two user IDs and increments a durable sequence scoped to that conversation in Postgres. It commits the direct message and the recipient's durable `sync_inbox` row in Postgres, then appends the message to `chat:inbox:<recipient-id>`. Online recipients receive it immediately; offline messages remain queued for the next connection. Multi-device cursors and replay semantics are added in Phase 7.

## Phase 5: presence

Clients send this frame periodically on each authenticated WebSocket:

```json
{"type":"heartbeat"}
```

Each heartbeat refreshes a 30-second Redis lease and returns `heartbeat_ack`. A five-second reaper publishes an `offline` event only after the lease expires. Online/offline events use Redis pub/sub and are sent to users with an established direct-chat relationship. Closing a socket does not immediately mark the user offline, which avoids presence flapping during reconnects.

## Phase 6: group messaging

Send a group message with the same authenticated WebSocket:

```json
{"type":"send_group_message","groupId":"<group-id>","body":"hello everyone"}
```

The sender must be a member. The chat service allocates a durable local sequence per group, persists the group message, and writes one `sync_inbox` row and one Redis inbox entry for every group member. Group creation and membership changes remain in the API service, which enforces the 100-member limit.

## Phase 7: multi-device synchronization

Connect each device with a stable device identifier:

```javascript
new WebSocket(`${chatServer.wsUrl}?token=${token}&deviceId=${deviceId}`);
```

On reconnect, the chat service sends `sync_begin`, replays every durable inbox message newer than that device's `cur_max_message_id`, advances the cursor per conversation, and sends `sync_complete`. Live delivery advances the cursor independently for every connected device, so one device receiving a message cannot hide it from another device that was offline.

## Phase 8: minimal test client

Open [test-client/index.html](test-client/index.html) directly in a browser, or serve the repository with any static file server. Start Postgres, Redis, the chat service, and the API service first. Sign up two users, copy the second user's ID into the recipient field, and connect both clients. The page exposes login, service-discovered WebSocket connection, automatic heartbeats, direct/group message frames, sync events, presence events, and the stable device ID used to test reconnect replay.

For a second device, open another tab and replace its device ID in browser local storage or use a separate browser profile. Stop one connection, send messages to its user, then reconnect it to observe `sync_begin`, replayed messages, and `sync_complete`.

## Phase 9: production frontend

The separate React app lives in `frontend/`; the internal protocol console remains under `test-client/`. Start it with `npm run dev:frontend`, then authenticate through its login screen. It consumes `/conversations`, `/conversations/:id/messages`, `/users/find?email=...`, the existing group endpoints, and the existing WebSocket message, heartbeat, presence, and synchronization frames.
