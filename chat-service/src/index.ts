import { createServer, type IncomingMessage } from "node:http";
import { createHash, randomUUID } from "node:crypto";
import jwt from "jsonwebtoken";
import { Pool } from "pg";
import { createClient } from "redis";
import { WebSocket, WebSocketServer } from "ws";

const port = Number(process.env.CHAT_PORT ?? 4000);
const host = process.env.CHAT_PUBLIC_HOST ?? "localhost";
const serviceId = process.env.CHAT_SERVICE_ID ?? randomUUID();
const jwtSecret = process.env.JWT_SECRET ?? "local-development-secret";
const redis = createClient({ url: process.env.REDIS_URL ?? "redis://localhost:6379" });
const presenceSubscriber = redis.duplicate();
const pool = new Pool({
  connectionString: process.env.DATABASE_URL ?? "postgres://chat:chat@localhost:5432/chat_system"
});
const httpServer = createServer();
const webSocketServer = new WebSocketServer({ noServer: true });
const connections = new Map<string, Set<WebSocket>>();
const drainingUsers = new Set<string>();
const deviceIds = new WeakMap<WebSocket, string>();
const presenceTimeoutMs = 30_000;

interface ChatServerRecord {
  serviceId: string;
  host: string;
  port: number;
  wsUrl: string;
}

interface DirectMessageEnvelope {
  type: "message";
  conversationId: string;
  messageId: number;
  senderId: string;
  recipientId: string;
  body: string;
  createdAt: string;
}

interface GroupMessageEnvelope {
  type: "message";
  groupId: string;
  conversationId: string;
  messageId: number;
  senderId: string;
  body: string;
  createdAt: string;
}

function conversationIdFor(firstUserId: string, secondUserId: string): string {
  const participants = [firstUserId, secondUserId].sort();
  const digest = createHash("sha256").update(`direct:${participants.join(":")}`).digest("hex");
  return `${digest.slice(0, 8)}-${digest.slice(8, 12)}-4${digest.slice(13, 16)}-${digest.slice(16, 20)}-${digest.slice(20, 32)}`;
}

function bodyString(value: unknown): string | undefined {
  return typeof value === "string" ? value : undefined;
}

function isPostgresError(error: unknown, code: string): boolean {
  return typeof error === "object" && error !== null && "code" in error && error.code === code;
}

interface PresenceEvent {
  userId: string;
  status: "online" | "offline";
  lastSeen: string;
}

async function publishPresence(event: PresenceEvent): Promise<void> {
  await redis.publish("presence:events", JSON.stringify(event));
}

async function fanoutPresence(event: PresenceEvent): Promise<void> {
  const contacts = await pool.query(
    `SELECT DISTINCT CASE WHEN sender_id = $1 THEN recipient_id ELSE sender_id END AS user_id
     FROM direct_messages
     WHERE sender_id = $1 OR recipient_id = $1`,
    [event.userId]
  );
  const notification = JSON.stringify({ type: "presence", ...event });
  for (const contact of contacts.rows) {
    const contactConnections = connections.get(contact.user_id) ?? new Set<WebSocket>();
    for (const socket of contactConnections) {
      if (socket.readyState === WebSocket.OPEN) {
        socket.send(notification);
      }
    }
  }
}

async function recordHeartbeat(userId: string): Promise<void> {
  const key = `presence:user:${userId}`;
  const wasPresent = await redis.exists(key);
  const now = Date.now();
  await redis.multi()
    .zAdd("presence:users", { score: now, value: userId })
    .set(key, JSON.stringify({ userId, lastSeen: new Date(now).toISOString() }), { EX: presenceTimeoutMs / 1000 })
    .exec();
  if (!wasPresent) {
    await publishPresence({ userId, status: "online", lastSeen: new Date(now).toISOString() });
  }
}

async function reapExpiredPresence(): Promise<void> {
  const cutoff = Date.now() - presenceTimeoutMs;
  const expiredUsers = await redis.zRangeByScore("presence:users", 0, cutoff);
  for (const userId of expiredUsers) {
    const score = await redis.zScore("presence:users", userId);
    if (score === null || score > cutoff) {
      continue;
    }
    const removed = await redis.zRem("presence:users", userId);
    if (removed === 1) {
      await redis.del(`presence:user:${userId}`);
      await publishPresence({ userId, status: "offline", lastSeen: new Date(score).toISOString() });
    }
  }
}

async function startPresence(): Promise<void> {
  await presenceSubscriber.connect();
  await presenceSubscriber.subscribe("presence:events", (serializedEvent) => {
    void fanoutPresence(JSON.parse(serializedEvent) as PresenceEvent);
  });
  setInterval(() => {
    void reapExpiredPresence();
  }, 5000).unref();
}

async function enqueueDirectMessage(senderId: string, recipientId: string, body: string): Promise<DirectMessageEnvelope> {
  if (body.length === 0 || body.length > 100000) {
    throw new Error("message body must contain between 1 and 100000 characters");
  }
  if (senderId === recipientId) {
    throw new Error("cannot send a direct message to yourself");
  }

  const conversationId = conversationIdFor(senderId, recipientId);
  const createdAt = new Date().toISOString();
  const client = await pool.connect();
  try {
    await client.query("BEGIN");
    await client.query(
      "INSERT INTO direct_conversations (conversation_id) VALUES ($1) ON CONFLICT (conversation_id) DO NOTHING",
      [conversationId]
    );
    const sequence = await client.query(
      "SELECT next_message_id FROM direct_conversations WHERE conversation_id = $1 FOR UPDATE",
      [conversationId]
    );
    const messageId = Number(sequence.rows[0].next_message_id);
    await client.query(
      "UPDATE direct_conversations SET next_message_id = next_message_id + 1 WHERE conversation_id = $1",
      [conversationId]
    );
    const message: DirectMessageEnvelope = { type: "message", conversationId, messageId, senderId, recipientId, body, createdAt };
    await client.query(
      `INSERT INTO direct_messages (conversation_id, message_id, sender_id, recipient_id, body, created_at)
       VALUES ($1, $2, $3, $4, $5, $6)`,
      [conversationId, messageId, senderId, recipientId, body, createdAt]
    );
    await client.query(
      `INSERT INTO sync_inbox (user_id, conversation_id, message_id)
       VALUES ($1, $2, $3)`,
      [recipientId, conversationId, messageId]
    );
    await client.query("COMMIT");
    await redis.rPush(`chat:inbox:${recipientId}`, JSON.stringify(message));
    return message;
  } catch (error) {
    await client.query("ROLLBACK");
    throw error;
  } finally {
    client.release();
  }

}

async function enqueueGroupMessage(senderId: string, groupId: string, body: string): Promise<GroupMessageEnvelope> {
  if (body.length === 0 || body.length > 100000) {
    throw new Error("message body must contain between 1 and 100000 characters");
  }

  const createdAt = new Date().toISOString();
  const client = await pool.connect();
  try {
    await client.query("BEGIN");
    const membership = await client.query(
      "SELECT 1 FROM group_members WHERE group_id = $1 AND user_id = $2",
      [groupId, senderId]
    );
    if (!membership.rows[0]) {
      await client.query("ROLLBACK");
      throw new Error("sender is not a member of this group");
    }
    await client.query(
      "INSERT INTO group_message_sequences (group_id) VALUES ($1) ON CONFLICT (group_id) DO NOTHING",
      [groupId]
    );
    const sequence = await client.query(
      "SELECT next_message_id FROM group_message_sequences WHERE group_id = $1 FOR UPDATE",
      [groupId]
    );
    const messageId = Number(sequence.rows[0].next_message_id);
    await client.query(
      "UPDATE group_message_sequences SET next_message_id = next_message_id + 1 WHERE group_id = $1",
      [groupId]
    );
    const message: GroupMessageEnvelope = {
      type: "message",
      groupId,
      conversationId: groupId,
      messageId,
      senderId,
      body,
      createdAt
    };
    const members = await client.query("SELECT user_id FROM group_members WHERE group_id = $1", [groupId]);
    await client.query(
      `INSERT INTO group_messages (group_id, message_id, sender_id, body, created_at)
       VALUES ($1, $2, $3, $4, $5)`,
      [groupId, messageId, senderId, body, createdAt]
    );
    for (const member of members.rows) {
      await client.query(
        "INSERT INTO sync_inbox (user_id, conversation_id, message_id) VALUES ($1, $2, $3)",
        [member.user_id, groupId, messageId]
      );
    }
    await client.query("COMMIT");
    for (const member of members.rows) {
      await redis.rPush(`chat:inbox:${member.user_id}`, JSON.stringify(message));
    }
    return message;
  } catch (error) {
    await client.query("ROLLBACK");
    throw error;
  } finally {
    client.release();
  }
}

async function drainInbox(userId: string): Promise<void> {
  const userConnections = connections.get(userId);
  if (!userConnections || userConnections.size === 0 || drainingUsers.has(userId)) {
    return;
  }
  drainingUsers.add(userId);
  try {
    while (connections.get(userId)?.size) {
      const serialized = await redis.lIndex(`chat:inbox:${userId}`, 0);
      if (!serialized) {
        return;
      }
      const activeConnections = connections.get(userId) ?? new Set<WebSocket>();
      const message = JSON.parse(serialized) as { conversationId: string; messageId: number };
      const sentDevices: Array<Promise<unknown>> = [];
      for (const socket of activeConnections) {
        if (socket.readyState === WebSocket.OPEN) {
          socket.send(serialized);
          const deviceId = deviceIds.get(socket);
          if (deviceId) {
            sentDevices.push(updateDeviceCursor(userId, deviceId, message.conversationId, message.messageId));
          }
        }
      }
      await Promise.all(sentDevices);
      await redis.lPop(`chat:inbox:${userId}`);
    }
  } finally {
    drainingUsers.delete(userId);
  }
}

async function updateDeviceCursor(userId: string, deviceId: string, conversationId: string, messageId: number): Promise<void> {
  await pool.query(
    `INSERT INTO device_sync_cursors (user_id, device_id, conversation_id, cur_max_message_id)
     VALUES ($1, $2, $3, $4)
     ON CONFLICT (user_id, device_id, conversation_id) DO UPDATE
     SET cur_max_message_id = GREATEST(device_sync_cursors.cur_max_message_id, EXCLUDED.cur_max_message_id),
         updated_at = now()`,
    [userId, deviceId, conversationId, messageId]
  );
}

async function syncDevice(socket: WebSocket, userId: string, deviceId: string): Promise<void> {
  const result = await pool.query(
    `WITH inbox_messages AS (
       SELECT i.user_id, i.conversation_id, i.message_id, 'direct' AS message_kind,
              dm.sender_id, dm.recipient_id, NULL::uuid AS group_id, dm.body, dm.created_at
       FROM sync_inbox i JOIN direct_messages dm
         ON dm.conversation_id = i.conversation_id AND dm.message_id = i.message_id
       WHERE i.user_id = $1
       UNION ALL
       SELECT i.user_id, i.conversation_id, i.message_id, 'group' AS message_kind,
              gm.sender_id, NULL::uuid AS recipient_id, gm.group_id, gm.body, gm.created_at
       FROM sync_inbox i JOIN group_messages gm
         ON gm.group_id = i.conversation_id AND gm.message_id = i.message_id
       WHERE i.user_id = $1
     )
     SELECT m.* FROM inbox_messages m
     LEFT JOIN device_sync_cursors c
       ON c.user_id = m.user_id AND c.device_id = $2 AND c.conversation_id = m.conversation_id
     WHERE c.cur_max_message_id IS NULL OR m.message_id > c.cur_max_message_id
     ORDER BY m.conversation_id, m.message_id`,
    [userId, deviceId]
  );
  socket.send(JSON.stringify({ type: "sync_begin", deviceId, messageCount: result.rows.length }));
  for (const row of result.rows) {
    const message = row.message_kind === "group"
      ? { type: "message", groupId: row.group_id, conversationId: row.conversation_id, messageId: row.message_id, senderId: row.sender_id, body: row.body, createdAt: row.created_at }
      : { type: "message", conversationId: row.conversation_id, messageId: row.message_id, senderId: row.sender_id, recipientId: row.recipient_id, body: row.body, createdAt: row.created_at };
    socket.send(JSON.stringify(message));
    await updateDeviceCursor(userId, deviceId, row.conversation_id, Number(row.message_id));
  }
  socket.send(JSON.stringify({ type: "sync_complete", deviceId, messageCount: result.rows.length }));
}

async function handleClientMessage(socket: WebSocket, userId: string, rawMessage: Buffer): Promise<void> {
  let request: unknown;
  try {
    request = JSON.parse(rawMessage.toString());
  } catch {
    socket.send(JSON.stringify({ type: "error", error: "message must be valid JSON" }));
    return;
  }
  if (typeof request !== "object" || request === null || !("type" in request)) {
    socket.send(JSON.stringify({ type: "error", error: "unsupported message type" }));
    return;
  }
  if (request.type === "heartbeat") {
    try {
      await recordHeartbeat(userId);
      socket.send(JSON.stringify({ type: "heartbeat_ack", at: new Date().toISOString() }));
    } catch (error) {
      console.error("Unable to record heartbeat", error);
      socket.send(JSON.stringify({ type: "error", error: "heartbeat could not be recorded" }));
    }
    return;
  }
  if (request.type === "send_group_message") {
    const groupRequest = request as { groupId?: unknown; body?: unknown };
    const groupId = bodyString(groupRequest.groupId);
    const body = bodyString(groupRequest.body);
    if (!groupId || body === undefined) {
      socket.send(JSON.stringify({ type: "error", error: "groupId and body are required" }));
      return;
    }
    try {
      const message = await enqueueGroupMessage(userId, groupId, body);
      socket.send(JSON.stringify({ type: "message_accepted", message }));
      const members = await pool.query("SELECT user_id FROM group_members WHERE group_id = $1", [groupId]);
      for (const member of members.rows) {
        await drainInbox(member.user_id);
      }
    } catch (error) {
      if (error instanceof Error && (error.message.startsWith("message body") || error.message.includes("not a member"))) {
        socket.send(JSON.stringify({ type: "error", error: error.message }));
        return;
      }
      console.error("Unable to persist group message", error);
      socket.send(JSON.stringify({ type: "error", error: "group message could not be persisted" }));
    }
    return;
  }
  if (request.type !== "send_message") {
    socket.send(JSON.stringify({ type: "error", error: "unsupported message type" }));
    return;
  }
  const messageRequest = request as { recipientId?: unknown; body?: unknown };
  const recipientId = bodyString(messageRequest.recipientId);
  const body = bodyString(messageRequest.body);
  if (!recipientId || body === undefined) {
    socket.send(JSON.stringify({ type: "error", error: "recipientId and body are required" }));
    return;
  }

  try {
    const message = await enqueueDirectMessage(userId, recipientId, body);
    socket.send(JSON.stringify({ type: "message_accepted", message }));
    await drainInbox(recipientId);
  } catch (error) {
    if (error instanceof Error && (error.message.startsWith("message body") || error.message.includes("yourself"))) {
      socket.send(JSON.stringify({ type: "error", error: error.message }));
      return;
    }
    if (isPostgresError(error, "23503")) {
      socket.send(JSON.stringify({ type: "error", error: "recipient does not exist" }));
      return;
    }
    console.error("Unable to persist direct message", error);
    socket.send(JSON.stringify({ type: "error", error: "message could not be persisted" }));
  }
}

function authenticateUpgrade(request: IncomingMessage): { userId: string; deviceId: string } | undefined {
  const requestUrl = new URL(request.url ?? "/", `http://${request.headers.host ?? "localhost"}`);
  const token = requestUrl.searchParams.get("token");
  if (!token) {
    return undefined;
  }
  try {
    const payload = jwt.verify(token, jwtSecret);
    if (typeof payload === "string" || typeof payload.sub !== "string") {
      return undefined;
    }
    return { userId: payload.sub, deviceId: requestUrl.searchParams.get("deviceId") ?? randomUUID() };
  } catch {
    return undefined;
  }
}

async function registerService(): Promise<void> {
  await redis.connect();
  await startPresence();
  const record: ChatServerRecord = { serviceId, host, port, wsUrl: `ws://${host}:${port}` };
  const key = `chat:server:${serviceId}`;
  await redis.sAdd("chat:servers", serviceId);
  await redis.set(key, JSON.stringify(record), { EX: 15 });
  setInterval(() => {
    void redis.set(key, JSON.stringify(record), { EX: 15 });
  }, 5000).unref();
  console.log(`Registered ${record.wsUrl} as ${serviceId}`);
}

httpServer.on("upgrade", (request, socket, head) => {
  const authentication = authenticateUpgrade(request);
  if (!authentication) {
    socket.write("HTTP/1.1 401 Unauthorized\r\nConnection: close\r\n\r\n");
    socket.destroy();
    return;
  }

  webSocketServer.handleUpgrade(request, socket, head, (client) => {
    webSocketServer.emit("connection", client, request, authentication.userId, authentication.deviceId);
  });
});

webSocketServer.on("connection", (socket: WebSocket, _request: IncomingMessage, userId: string, deviceId: string) => {
  const userConnections = connections.get(userId) ?? new Set<WebSocket>();
  userConnections.add(socket);
  connections.set(userId, userConnections);
  deviceIds.set(socket, deviceId);

  socket.send(JSON.stringify({ type: "connected", service: "chat-service", userId, deviceId }));
  void syncDevice(socket, userId, deviceId).then(() => drainInbox(userId)).catch((error) => {
    console.error("Unable to synchronize device", error);
    socket.send(JSON.stringify({ type: "error", error: "device synchronization failed" }));
  });
  socket.on("message", (rawMessage) => {
    void handleClientMessage(socket, userId, rawMessage as Buffer);
  });
  socket.on("close", () => {
    userConnections.delete(socket);
    if (userConnections.size === 0) {
      connections.delete(userId);
    }
  });
});

httpServer.listen(port, async () => {
  try {
    await registerService();
    console.log(`Chat service listening on ws://localhost:${port}`);
  } catch (error) {
    console.error("Unable to register chat service with Redis", error);
    process.exitCode = 1;
    httpServer.close();
  }
});
