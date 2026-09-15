import bcrypt from "bcryptjs";
import express, { type NextFunction, type Request, type Response } from "express";
import jwt from "jsonwebtoken";
import { createHash, randomUUID } from "node:crypto";
import { Pool } from "pg";
import { createClient } from "redis";

const app = express();
const port = Number(process.env.API_PORT ?? 3000);
const jwtSecret = process.env.JWT_SECRET ?? "local-development-secret";
const pool = new Pool({
  connectionString: process.env.DATABASE_URL ?? "postgres://chat:chat@localhost:5432/chat_system"
});
const redis = createClient({ url: process.env.REDIS_URL ?? "redis://localhost:6379" });
const chatServerRegistryKey = "chat:servers";

type AuthenticatedRequest = Request & { userId?: string };

function issueToken(userId: string): string {
  return jwt.sign({ sub: userId }, jwtSecret, { expiresIn: "7d" });
}

function directConversationId(firstUserId: string, secondUserId: string): string {
  const participants = [firstUserId, secondUserId].sort();
  const digest = createHash("sha256").update(`direct:${participants.join(":")}`).digest("hex");
  return `${digest.slice(0, 8)}-${digest.slice(8, 12)}-4${digest.slice(13, 16)}-${digest.slice(16, 20)}-${digest.slice(20, 32)}`;
}

function requireAuth(request: AuthenticatedRequest, response: Response, next: NextFunction): void {
  const authorization = request.header("authorization");
  const token = authorization?.startsWith("Bearer ") ? authorization.slice(7) : undefined;

  if (!token) {
    response.status(401).json({ error: "missing bearer token" });
    return;
  }

  try {
    const payload = jwt.verify(token, jwtSecret);
    if (typeof payload === "string" || typeof payload.sub !== "string") {
      response.status(401).json({ error: "invalid token" });
      return;
    }
    request.userId = payload.sub;
    next();
  } catch {
    response.status(401).json({ error: "invalid token" });
  }
}

function bodyString(request: Request, field: string): string | undefined {
  const value = request.body?.[field];
  return typeof value === "string" ? value.trim() : undefined;
}

interface ChatServerRecord {
  serviceId: string;
  host: string;
  port: number;
  wsUrl: string;
}

async function findChatServer(): Promise<ChatServerRecord | undefined> {
  if (!redis.isOpen) {
    await redis.connect();
  }
  const serviceIds = await redis.sMembers(chatServerRegistryKey);
  const activeServers: ChatServerRecord[] = [];
  for (const serviceId of serviceIds) {
    const record = await redis.get(`chat:server:${serviceId}`);
    if (record) {
      activeServers.push(JSON.parse(record) as ChatServerRecord);
    } else {
      await redis.sRem(chatServerRegistryKey, serviceId);
    }
  }
  return activeServers[Math.floor(Math.random() * activeServers.length)];
}

async function authResponse(user: Record<string, unknown>): Promise<Record<string, unknown>> {
  const chatServer = await findChatServer();
  if (!chatServer) {
    throw new Error("no chat servers are available");
  }
  return { user, token: issueToken(String(user.user_id)), chatServer };
}

app.use((request, response, next) => {
  response.setHeader("Access-Control-Allow-Origin", request.header("origin") ?? "*");
  response.setHeader("Access-Control-Allow-Headers", "Content-Type, Authorization");
  response.setHeader("Access-Control-Allow-Methods", "GET, POST, OPTIONS");
  if (request.method === "OPTIONS") {
    response.sendStatus(204);
    return;
  }
  next();
});
app.use(express.json({ limit: "256kb" }));

app.get("/health", (_request, response) => {
  response.json({ service: "api-service", status: "ok" });
});

app.post("/auth/signup", async (request, response, next) => {
  const email = bodyString(request, "email")?.toLowerCase();
  const password = bodyString(request, "password");
  const displayName = bodyString(request, "displayName");

  if (!email || !password || !displayName || password.length < 8) {
    response.status(400).json({ error: "email, displayName, and a password of at least 8 characters are required" });
    return;
  }

  try {
    const userId = randomUUID();
    const passwordHash = await bcrypt.hash(password, 12);
    const result = await pool.query(
      `INSERT INTO users (user_id, email, password_hash, display_name)
       VALUES ($1, $2, $3, $4)
       RETURNING user_id, email, display_name, created_at`,
      [userId, email, passwordHash, displayName]
    );
    response.status(201).json(await authResponse(result.rows[0]));
  } catch (error: unknown) {
    if (isPostgresError(error, "23505")) {
      response.status(409).json({ error: "email is already registered" });
      return;
    }
    if (error instanceof Error && error.message === "no chat servers are available") {
      response.status(503).json({ error: error.message });
      return;
    }
    next(error);
  }
});

app.post("/auth/login", async (request, response, next) => {
  const email = bodyString(request, "email")?.toLowerCase();
  const password = bodyString(request, "password");
  if (!email || !password) {
    response.status(400).json({ error: "email and password are required" });
    return;
  }

  try {
    const result = await pool.query(
      "SELECT user_id, email, password_hash, display_name, created_at FROM users WHERE email = $1",
      [email]
    );
    const user = result.rows[0];
    if (!user || !(await bcrypt.compare(password, user.password_hash))) {
      response.status(401).json({ error: "invalid email or password" });
      return;
    }
    delete user.password_hash;
    response.json(await authResponse(user));
  } catch (error) {
    if (error instanceof Error && error.message === "no chat servers are available") {
      response.status(503).json({ error: error.message });
      return;
    }
    next(error);
  }
});

app.get("/users/me", requireAuth, async (request: AuthenticatedRequest, response, next) => {
  try {
    const result = await pool.query(
      "SELECT user_id, email, display_name, created_at FROM users WHERE user_id = $1",
      [request.userId]
    );
    if (!result.rows[0]) {
      response.status(404).json({ error: "user not found" });
      return;
    }
    response.json({ user: result.rows[0] });
  } catch (error) {
    next(error);
  }
});

app.get("/users/find", requireAuth, async (request: AuthenticatedRequest, response, next) => {
  const email = typeof request.query.email === "string" ? request.query.email.trim().toLowerCase() : "";
  if (!email) {
    response.status(400).json({ error: "email is required" });
    return;
  }
  try {
    const result = await pool.query(
      "SELECT user_id, email, display_name, created_at FROM users WHERE email = $1 AND user_id <> $2",
      [email, request.userId]
    );
    if (!result.rows[0]) {
      response.status(404).json({ error: "user not found" });
      return;
    }
    response.json({ user: result.rows[0] });
  } catch (error) {
    next(error);
  }
});

app.get("/conversations", requireAuth, async (request: AuthenticatedRequest, response, next) => {
  try {
    const result = await pool.query(
      `WITH direct AS (
         SELECT DISTINCT ON (conversation_id)
           conversation_id AS id, 'direct' AS type,
           CASE WHEN sender_id = $1 THEN recipient_id ELSE sender_id END AS other_user_id,
           body AS last_message, created_at AS last_message_at
         FROM direct_messages
         WHERE sender_id = $1 OR recipient_id = $1
         ORDER BY conversation_id, created_at DESC
       ), group_chats AS (
         SELECT g.group_id AS id, 'group' AS type, NULL::uuid AS other_user_id,
                latest.body AS last_message, latest.created_at AS last_message_at,
                g.name
         FROM groups g
         JOIN group_members gm ON gm.group_id = g.group_id AND gm.user_id = $1
         LEFT JOIN LATERAL (
           SELECT body, created_at FROM group_messages WHERE group_id = g.group_id ORDER BY message_id DESC LIMIT 1
         ) latest ON true
       )
       SELECT d.id, d.type, u.user_id, u.display_name, u.email, d.last_message, d.last_message_at,
              0::int AS unread_count
       FROM direct d JOIN users u ON u.user_id = d.other_user_id
       UNION ALL
       SELECT id, type, NULL::uuid, name, NULL::text, last_message, last_message_at, 0::int
       FROM group_chats
       ORDER BY last_message_at DESC NULLS LAST`,
      [request.userId]
    );
    response.json({ conversations: result.rows });
  } catch (error) {
    next(error);
  }
});

app.get("/conversations/:conversationId/messages", requireAuth, async (request: AuthenticatedRequest, response, next) => {
  try {
    const direct = await pool.query(
      `SELECT dm.conversation_id, dm.message_id, dm.sender_id, dm.recipient_id, sender.display_name AS sender_name, dm.body, dm.created_at,
              'direct' AS type
       FROM direct_messages dm JOIN users sender ON sender.user_id = dm.sender_id
       WHERE dm.conversation_id = $1 AND (dm.sender_id = $2 OR dm.recipient_id = $2)
       ORDER BY dm.message_id ASC`,
      [request.params.conversationId, request.userId]
    );
    if (direct.rows.length > 0) {
      response.json({ messages: direct.rows });
      return;
    }
    const group = await pool.query(
      `SELECT gm.group_id, gm.message_id, gm.sender_id, sender.display_name AS sender_name, gm.body, gm.created_at, 'group' AS type
       FROM group_messages gm JOIN users sender ON sender.user_id = gm.sender_id
       JOIN group_members member ON member.group_id = gm.group_id
       WHERE gm.group_id = $1 AND member.user_id = $2 ORDER BY gm.message_id ASC`,
      [request.params.conversationId, request.userId]
    );
    if (group.rows.length === 0) {
      response.status(404).json({ error: "conversation not found" });
      return;
    }
    response.json({ messages: group.rows });
  } catch (error) {
    next(error);
  }
});

app.post("/groups", requireAuth, async (request: AuthenticatedRequest, response, next) => {
  const name = bodyString(request, "name");
  if (!name) {
    response.status(400).json({ error: "name is required" });
    return;
  }

  const client = await pool.connect();
  try {
    await client.query("BEGIN");
    const groupId = randomUUID();
    await client.query("INSERT INTO groups (group_id, name, created_by) VALUES ($1, $2, $3)", [groupId, name, request.userId]);
    await client.query("INSERT INTO group_members (group_id, user_id) VALUES ($1, $2)", [groupId, request.userId]);
    await client.query("COMMIT");
    response.status(201).json({ group: { group_id: groupId, name, created_by: request.userId } });
  } catch (error) {
    await client.query("ROLLBACK");
    next(error);
  } finally {
    client.release();
  }
});

app.post("/groups/:groupId/members", requireAuth, async (request: AuthenticatedRequest, response, next) => {
  const memberId = bodyString(request, "userId");
  if (!memberId) {
    response.status(400).json({ error: "userId is required" });
    return;
  }

  const client = await pool.connect();
  try {
    await client.query("BEGIN");
    const group = await client.query("SELECT group_id, created_by FROM groups WHERE group_id = $1 FOR UPDATE", [request.params.groupId]);
    if (!group.rows[0]) {
      await client.query("ROLLBACK");
      response.status(404).json({ error: "group not found" });
      return;
    }
    if (group.rows[0].created_by !== request.userId) {
      await client.query("ROLLBACK");
      response.status(403).json({ error: "only the group creator can manage membership" });
      return;
    }
    const membership = await client.query("SELECT 1 FROM group_members WHERE group_id = $1 AND user_id = $2", [request.params.groupId, memberId]);
    if (membership.rows[0]) {
      await client.query("ROLLBACK");
      response.status(409).json({ error: "user is already a member" });
      return;
    }
    const count = await client.query("SELECT count(*)::int AS count FROM group_members WHERE group_id = $1", [request.params.groupId]);
    if (count.rows[0].count >= 100) {
      await client.query("ROLLBACK");
      response.status(409).json({ error: "groups are limited to 100 members" });
      return;
    }
    await client.query("INSERT INTO group_members (group_id, user_id) VALUES ($1, $2)", [request.params.groupId, memberId]);
    await client.query("COMMIT");
    response.status(201).json({ groupId: request.params.groupId, userId: memberId });
  } catch (error) {
    await client.query("ROLLBACK");
    if (isPostgresError(error, "23503")) {
      response.status(404).json({ error: "user or group not found" });
      return;
    }
    next(error);
  } finally {
    client.release();
  }
});

app.get("/", async (_request, response) => {
  response.json({ message: "Welcome to the API service!" });
});

app.get("/groups/:groupId", requireAuth, async (request, response, next) => {
  try {
    const result = await pool.query(
      `SELECT g.group_id, g.name, g.created_by, g.created_at,
              COALESCE(json_agg(gm.user_id) FILTER (WHERE gm.user_id IS NOT NULL), '[]') AS member_ids
       FROM groups g LEFT JOIN group_members gm ON gm.group_id = g.group_id
       WHERE g.group_id = $1 GROUP BY g.group_id`,
      [request.params.groupId]
    );
    if (!result.rows[0]) {
      response.status(404).json({ error: "group not found" });
      return;
    }
    response.json({ group: result.rows[0] });
  } catch (error) {
    next(error);
  }
});

function isPostgresError(error: unknown, code: string): boolean {
  return typeof error === "object" && error !== null && "code" in error && error.code === code;
}

app.use((error: unknown, _request: Request, response: Response, _next: NextFunction) => {
  console.error(error);
  response.status(500).json({ error: "internal server error" });
});

app.listen(port, () => {
  console.log(`API service listening on http://localhost:${port}`);
});
