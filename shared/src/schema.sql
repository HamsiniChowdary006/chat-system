-- Chat history is modeled as a KV access pattern: conversation_id is the partition key
-- and message_id is the ordered local sequence within that conversation.

CREATE TABLE IF NOT EXISTS users (
  user_id UUID PRIMARY KEY,
  email TEXT NOT NULL UNIQUE,
  password_hash TEXT NOT NULL,
  display_name TEXT NOT NULL,
  created_at TIMESTAMPTZ NOT NULL DEFAULT now()
);

CREATE TABLE IF NOT EXISTS direct_conversations (
  conversation_id UUID PRIMARY KEY,
  next_message_id BIGINT NOT NULL DEFAULT 1
);

CREATE TABLE IF NOT EXISTS direct_messages (
  conversation_id UUID NOT NULL,
  message_id BIGINT NOT NULL,
  sender_id UUID NOT NULL REFERENCES users(user_id),
  recipient_id UUID NOT NULL REFERENCES users(user_id),
  body TEXT NOT NULL CHECK (char_length(body) <= 100000),
  created_at TIMESTAMPTZ NOT NULL DEFAULT now(),
  PRIMARY KEY (conversation_id, message_id)
);

CREATE TABLE IF NOT EXISTS groups (
  group_id UUID PRIMARY KEY,
  name TEXT NOT NULL,
  created_by UUID NOT NULL REFERENCES users(user_id),
  created_at TIMESTAMPTZ NOT NULL DEFAULT now()
);

CREATE TABLE IF NOT EXISTS group_members (
  group_id UUID NOT NULL REFERENCES groups(group_id),
  user_id UUID NOT NULL REFERENCES users(user_id),
  joined_at TIMESTAMPTZ NOT NULL DEFAULT now(),
  PRIMARY KEY (group_id, user_id)
);

CREATE TABLE IF NOT EXISTS group_message_sequences (
  group_id UUID PRIMARY KEY REFERENCES groups(group_id),
  next_message_id BIGINT NOT NULL DEFAULT 1
);

CREATE TABLE IF NOT EXISTS group_messages (
  group_id UUID NOT NULL REFERENCES groups(group_id),
  message_id BIGINT NOT NULL,
  sender_id UUID NOT NULL REFERENCES users(user_id),
  body TEXT NOT NULL CHECK (char_length(body) <= 100000),
  created_at TIMESTAMPTZ NOT NULL DEFAULT now(),
  PRIMARY KEY (group_id, message_id)
);

-- The inbox is deliberately per recipient. Each device can advance its own cursor
-- while reading the recipient's fanout queue.
CREATE TABLE IF NOT EXISTS sync_inbox (
  user_id UUID NOT NULL REFERENCES users(user_id),
  conversation_id UUID NOT NULL,
  message_id BIGINT NOT NULL,
  enqueued_at TIMESTAMPTZ NOT NULL DEFAULT now(),
  PRIMARY KEY (user_id, conversation_id, message_id)
);

CREATE TABLE IF NOT EXISTS device_sync_cursors (
  user_id UUID NOT NULL REFERENCES users(user_id),
  device_id TEXT NOT NULL,
  conversation_id UUID NOT NULL,
  cur_max_message_id BIGINT NOT NULL DEFAULT 0,
  updated_at TIMESTAMPTZ NOT NULL DEFAULT now(),
  PRIMARY KEY (user_id, device_id, conversation_id)
);
