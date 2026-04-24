import { Router, type IRouter } from "express";
import {
  CreateAnthropicConversationBody,
  DeleteAnthropicConversationParams,
  GetAnthropicConversationParams,
  GetAnthropicConversationResponse,
  ListAnthropicConversationsResponse,
  ListAnthropicMessagesParams,
  ListAnthropicMessagesResponse,
  SendAnthropicMessageBody,
  SendAnthropicMessageParams,
} from "@workspace/api-zod";
import { db } from "@workspace/db";
import {
  conversations,
  messages,
  agentMemoryShort,
} from "@workspace/db";
import { asc, desc, eq } from "drizzle-orm";
import { anthropic } from "@workspace/integrations-anthropic-ai";
import {
  SYSTEM_PROMPT,
  buildAgentContext,
  renderAgentContext,
} from "../lib/cassandra/agent";
import { logger } from "../lib/logger";

const router: IRouter = Router();

router.get("/anthropic/conversations", async (_req, res) => {
  const rows = await db
    .select()
    .from(conversations)
    .orderBy(desc(conversations.createdAt));
  res.json(
    ListAnthropicConversationsResponse.parse(
      rows.map((c) => ({
        id: c.id,
        title: c.title,
        createdAt: c.createdAt.toISOString(),
      })),
    ),
  );
});

router.post("/anthropic/conversations", async (req, res) => {
  const parsed = CreateAnthropicConversationBody.safeParse(req.body);
  if (!parsed.success) {
    res.status(400).json({ error: parsed.error.message });
    return;
  }
  const [row] = await db
    .insert(conversations)
    .values({ title: parsed.data.title })
    .returning();
  res.status(201).json({
    id: row.id,
    title: row.title,
    createdAt: row.createdAt.toISOString(),
  });
});

router.get("/anthropic/conversations/:id", async (req, res) => {
  const parsed = GetAnthropicConversationParams.safeParse(req.params);
  if (!parsed.success) {
    res.status(400).json({ error: parsed.error.message });
    return;
  }
  const [conv] = await db
    .select()
    .from(conversations)
    .where(eq(conversations.id, parsed.data.id))
    .limit(1);
  if (!conv) {
    res.status(404).json({ error: "Conversation not found" });
    return;
  }
  const msgRows = await db
    .select()
    .from(messages)
    .where(eq(messages.conversationId, conv.id))
    .orderBy(asc(messages.createdAt));
  res.json(
    GetAnthropicConversationResponse.parse({
      id: conv.id,
      title: conv.title,
      createdAt: conv.createdAt.toISOString(),
      messages: msgRows.map((m) => ({
        id: m.id,
        conversationId: m.conversationId,
        role: m.role,
        content: m.content,
        createdAt: m.createdAt.toISOString(),
      })),
    }),
  );
});

router.delete("/anthropic/conversations/:id", async (req, res) => {
  const parsed = DeleteAnthropicConversationParams.safeParse(req.params);
  if (!parsed.success) {
    res.status(400).json({ error: parsed.error.message });
    return;
  }
  const result = await db
    .delete(conversations)
    .where(eq(conversations.id, parsed.data.id))
    .returning({ id: conversations.id });
  if (result.length === 0) {
    res.status(404).json({ error: "Conversation not found" });
    return;
  }
  res.status(204).send();
});

router.get("/anthropic/conversations/:id/messages", async (req, res) => {
  const parsed = ListAnthropicMessagesParams.safeParse(req.params);
  if (!parsed.success) {
    res.status(400).json({ error: parsed.error.message });
    return;
  }
  const rows = await db
    .select()
    .from(messages)
    .where(eq(messages.conversationId, parsed.data.id))
    .orderBy(asc(messages.createdAt));
  res.json(
    ListAnthropicMessagesResponse.parse(
      rows.map((m) => ({
        id: m.id,
        conversationId: m.conversationId,
        role: m.role,
        content: m.content,
        createdAt: m.createdAt.toISOString(),
      })),
    ),
  );
});

router.post("/anthropic/conversations/:id/messages", async (req, res) => {
  const parsedParams = SendAnthropicMessageParams.safeParse(req.params);
  const parsedBody = SendAnthropicMessageBody.safeParse(req.body);
  if (!parsedParams.success) {
    res.status(400).json({ error: parsedParams.error.message });
    return;
  }
  if (!parsedBody.success) {
    res.status(400).json({ error: parsedBody.error.message });
    return;
  }
  const conversationId = parsedParams.data.id;
  const userContent = parsedBody.data.content;

  // Confirm the conversation exists.
  const [conv] = await db
    .select()
    .from(conversations)
    .where(eq(conversations.id, conversationId))
    .limit(1);
  if (!conv) {
    res.status(404).json({ error: "Conversation not found" });
    return;
  }

  // Persist user message.
  await db
    .insert(messages)
    .values({ conversationId, role: "user", content: userContent });

  // Load full message history for context.
  const history = await db
    .select()
    .from(messages)
    .where(eq(messages.conversationId, conversationId))
    .orderBy(asc(messages.createdAt));

  const ctx = await buildAgentContext();
  const contextBlock = renderAgentContext(ctx);

  res.setHeader("Content-Type", "text/event-stream");
  res.setHeader("Cache-Control", "no-cache");
  res.setHeader("Connection", "keep-alive");
  res.flushHeaders?.();

  let assistantText = "";
  try {
    const stream = anthropic.messages.stream({
      model: "claude-sonnet-4-6",
      max_tokens: 8192,
      system: `${SYSTEM_PROMPT}\n\n${contextBlock}`,
      messages: history.map((m) => ({
        role: m.role === "assistant" ? "assistant" : "user",
        content: m.content,
      })),
    });

    for await (const event of stream) {
      if (
        event.type === "content_block_delta" &&
        event.delta.type === "text_delta"
      ) {
        assistantText += event.delta.text;
        res.write(`data: ${JSON.stringify({ content: event.delta.text })}\n\n`);
      }
    }

    if (assistantText.length > 0) {
      await db.insert(messages).values({
        conversationId,
        role: "assistant",
        content: assistantText,
      });
    }

    // Persist a short summary as short-term memory after a meaningful turn.
    if (assistantText.length > 200) {
      await db.insert(agentMemoryShort).values({
        conversationId,
        summary: `Q: ${userContent.slice(0, 240)} | A: ${assistantText.slice(0, 240)}`,
        facts: [],
      });
    }

    res.write(`data: ${JSON.stringify({ done: true })}\n\n`);
    res.end();
  } catch (err) {
    logger.error({ err }, "anthropic stream failed");
    res.write(
      `data: ${JSON.stringify({
        error:
          err instanceof Error
            ? err.message
            : "Streaming failed; please try again.",
      })}\n\n`,
    );
    res.end();
  }
});

export default router;
