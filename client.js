import TelegramBot from "node-telegram-bot-api";
import { Client as McpClient } from "@modelcontextprotocol/sdk/client/index.js";
import { StdioClientTransport } from "@modelcontextprotocol/sdk/client/stdio.js";
import {
  ListToolsResultSchema,
  CallToolResultSchema,
} from "@modelcontextprotocol/sdk/types.js";
import OpenAI from "openai";
import "dotenv/config";
import path from "path";
import { fileURLToPath } from "url";

// ----------------- ENV SETUP -----------------

const TELEGRAM_BOT_TOKEN = process.env.TELEGRAM_BOT_TOKEN;
if (!TELEGRAM_BOT_TOKEN) {
  console.error("TELEGRAM_BOT_TOKEN is required");
  process.exit(1);
}

const openai = new OpenAI({
  apiKey: process.env.DEEPSEEK_API_KEY,
  baseURL: process.env.DEEPSEEK_BASE_URL || "https://api.deepseek.com",
});

const MODEL = process.env.DEEPSEEK_MODEL || "deepseek-chat";

if (!process.env.TURSO_DATABASE_URL || !process.env.TURSO_AUTH_TOKEN) {
  console.error("TURSO_DATABASE_URL and TURSO_AUTH_TOKEN are required");
  process.exit(1);
}

// ----------------- PATH TO MCP SERVER -----------------

const __filename = fileURLToPath(import.meta.url);
const __dirname = path.dirname(__filename);

// Adjust if your server filename is different
const serverPath = path.join(__dirname, "server.js");

// ----------------- SESSION STORAGE (PER CHAT) -----------------

/**
 * sessions: Map<chatId, messages[]>
 * Each messages[] is an OpenAI-style chat history:
 * [ {role, content, ...}, ... ]
 */
const sessions = new Map();

function trimMessages(messages, maxTurns = 12) {
  // Keep system + last N turns
  if (!messages || messages.length === 0) return messages;

  const system = messages[0];
  const rest = messages.slice(1);

  // Rough cap: user+assistant(+tool) messages
  const maxMessages = maxTurns * 4; // user + assistant + tool stuff
  if (rest.length > maxMessages) {
    return [system, ...rest.slice(rest.length - maxMessages)];
  }
  return messages;
}

// ----------------- MCP HELPERS -----------------

async function createMcpClient() {
  const transport = new StdioClientTransport({
    command: "node",
    args: [serverPath],
    // env: inherits by default; parent has TURSO_* set
  });

  const client = new McpClient({
    name: "turso-mcp-telegram-client",
    version: "1.0.0",
  });

  await client.connect(transport);
  console.log("[mcp] connected");
  return client;
}

function mcpToolsToOpenAITools(mcpTools) {
  return mcpTools.map((tool) => ({
    type: "function",
    function: {
      name: tool.name,
      description: tool.description || "",
      parameters: tool.inputSchema || {
        type: "object",
        properties: {},
      },
    },
  }));
}

async function callMcpTool(mcpClient, toolCall) {
  const fn = toolCall.function;
  const name = fn.name;
  const args = fn.arguments ? JSON.parse(fn.arguments) : {};

  console.log("[mcp] calling tool:", name, "args:", args);

  const result = await mcpClient.request(
    {
      method: "tools/call",
      params: {
        name,
        arguments: args,
      },
    },
    CallToolResultSchema
  );

  // Most tools return content[0].text with JSON-encoded data
  const content = result.content?.[0]?.text ?? JSON.stringify(result, null, 2);
  console.log("[mcp] tool result:", content);
  return content;
}

// ----------------- AGENT CORE (LLM + MCP) -----------------

async function runAgentForText(chatId, userText) {
  const mcp = await createMcpClient();

  try {
    // 1) Get tools from MCP server
    const toolsResult = await mcp.request(
      { method: "tools/list" },
      ListToolsResultSchema
    );
    const mcpTools = toolsResult.tools || [];
    console.log("[mcp] tools:", mcpTools.map((t) => t.name));

    const tools = mcpToolsToOpenAITools(mcpTools);

    // 2) Load or initialize session messages for this chat
    let messages = sessions.get(chatId);
    if (!messages) {
      messages = [
        {
          role: "system",
          content:
            "You are a personal expense assistant talking to a Turso SQL database via MCP tools.\n" +
            "- Use tools like insert_into_<table> and execute_sql to read/write data.\n" +
            "- Maintain conversation context across this chat and continue previous threads.\n" +
            "- All money values are ALWAYS interpreted as INR, even if the user doesn't specify the currency.\n" +
            "- When showing totals, balances, summaries, or individual amounts, always mention INR explicitly.\n" +
            "- Do not convert currency; simply assume INR.\n" +
            "- If the user asks something unrelated to expenses or the database, answer normally without tools." + 
            "- If the user provides a number without currency, you MUST assume it is an amount in INR.\n",
      }];
    }

    // Add current user message
    messages.push({
      role: "user",
      content: userText,
    });

    // 3) First LLM call (may or may not request tools)
    const first = await openai.chat.completions.create({
      model: MODEL,
      messages,
      tools,
      tool_choice: "auto",
    });

    let msg = first.choices[0].message;

    // No tool calls: just answer directly
    if (!msg.tool_calls || msg.tool_calls.length === 0) {
      const reply = msg.content || "I don't have a response.";
      messages.push({
        role: "assistant",
        content: reply,
      });

      sessions.set(chatId, trimMessages(messages));
      return reply;
    }

    // 4) Handle one or more tool calls
    for (const toolCall of msg.tool_calls) {
      const toolResultContent = await callMcpTool(mcp, toolCall);

      // Assistant "performing tool call"
      messages.push({
        role: "assistant",
        content: "",
        tool_calls: [toolCall],
      });

      // Tool result
      messages.push({
        role: "tool",
        name: toolCall.function.name,
        tool_call_id: toolCall.id,
        content: toolResultContent,
      });
    }

    // 5) Second LLM call, now with tool results in context
    const second = await openai.chat.completions.create({
      model: MODEL,
      messages,
    });

    const finalMsg = second.choices[0].message;
    const reply = finalMsg.content || "Done.";

    messages.push({
      role: "assistant",
      content: reply,
    });

    sessions.set(chatId, trimMessages(messages));
    return reply;
  } finally {
    try {
      await mcp.close();
    } catch (e) {
      console.warn("[mcp] close error:", e);
    }
  }
}

// ----------------- TELEGRAM BOT WIRING -----------------

const bot = new TelegramBot(TELEGRAM_BOT_TOKEN, { polling: true });

bot.on("message", async (msg) => {
  const chatId = msg.chat.id;
  const text = msg.text || "";

  console.log(`[tg] ${chatId}: ${text}`);

  // Simple command to reset context
  if (text.trim().toLowerCase() === "/reset") {
    sessions.delete(chatId);
    await bot.sendMessage(chatId, "Context cleared for this chat ✅");
    return;
  }

  await bot.sendMessage(chatId, "Got it, thinking… 🤔");

  try {
    const answer = await runAgentForText(chatId, text);
    await bot.sendMessage(chatId, answer);
  } catch (err) {
    console.error("[agent] error:", err);
    await bot.sendMessage(
      chatId,
      "Something went wrong talking to the database: " + String(err)
    );
  }
});

console.log("[tg] Telegram bot started");
