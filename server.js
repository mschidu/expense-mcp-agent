import "dotenv/config";
import { Server } from "@modelcontextprotocol/sdk/server/index.js";
import { StdioServerTransport } from "@modelcontextprotocol/sdk/server/stdio.js";
import {
  CallToolRequestSchema,
  ListResourcesRequestSchema,
  ListToolsRequestSchema,
  ReadResourceRequestSchema,
} from "@modelcontextprotocol/sdk/types.js";
import { createClient } from "@libsql/client";
import dotenv from "dotenv";

dotenv.config();

const server = new Server(
  {
    name: "server",
    version: "1.0.0",
  },
  {
    capabilities: {
      resources: {},
      tools: {},
    },
  }
);

// ========================================================================
// === ENV SETUP + CONNECT TO TURSO ======================================
// ========================================================================

const databaseUrl = process.env.TURSO_DATABASE_URL;
const authToken = process.env.TURSO_AUTH_TOKEN;

if (!databaseUrl) {
  console.error("Error: TURSO_DATABASE_URL is required");
  process.exit(1);
}
if (!authToken) {
  console.error("Error: TURSO_AUTH_TOKEN is required");
  process.exit(1);
}

const db = createClient({
  url: databaseUrl,
  authToken,
});

// Generic URL used for schema reading resources
const resourceBaseUrl = new URL(databaseUrl);
resourceBaseUrl.protocol = "turso:";
resourceBaseUrl.password = "";
const SCHEMA_PATH = "schema";

// ========================================================================
// === HELPER FUNCTIONS ===================================================
// ========================================================================

// List all tables in Turso
async function getTables() {
  const result = await db.execute(
    "SELECT name FROM sqlite_master WHERE type='table' AND name NOT LIKE 'sqlite_%'"
  );
  return result.rows.map((r) => r.name);
}

// Get a table's columns
async function getColumns(table) {
  const result = await db.execute(`PRAGMA table_info(${table})`);
  return result.rows.map((row) => ({
    name: row.name,
    type: row.type,
    notNull: row.notnull === 1,
    isPrimaryKey: row.pk === 1,
    defaultValue: row.dflt_value,
  }));
}

// Map SQL type → JSON schema type
function mapSqlType(sqlType) {
  const t = (sqlType || "").toUpperCase();
  if (t.includes("INT")) return "integer";
  if (t.includes("REAL") || t.includes("FLOA") || t.includes("DOUB"))
    return "number";
  return "string"; // default
}

// ========================================================================
// === RESOURCES: LIST TABLES + SCHEMAS ==================================
// ========================================================================

server.setRequestHandler(ListResourcesRequestSchema, async () => {
  const tables = await getTables();

  return {
    resources: tables.map((table) => ({
      uri: new URL(`${table}/${SCHEMA_PATH}`, resourceBaseUrl).href,
      mimeType: "application/json",
      name: `${table} table schema`,
    })),
  };
});

server.setRequestHandler(ReadResourceRequestSchema, async (request) => {
  const url = new URL(request.params.uri);
  const parts = url.pathname.split("/");

  const schemaFlag = parts.pop();
  const table = parts.pop();

  if (schemaFlag !== SCHEMA_PATH)
    throw new Error("Invalid schema resource path");

  const columns = await getColumns(table);

  return {
    contents: [
      {
        uri: request.params.uri,
        mimeType: "application/json",
        text: JSON.stringify(columns, null, 2),
      },
    ],
  };
});

function toSafeJson(value) {
  if (typeof value === "bigint") {
    return value.toString(); // or Number(value) if you're sure it fits
  }
  if (Array.isArray(value)) {
    return value.map(toSafeJson);
  }
  if (value && typeof value === "object") {
    const out = {};
    for (const [k, v] of Object.entries(value)) {
      out[k] = toSafeJson(v);
    }
    return out;
  }
  return value;
}


// ========================================================================
// === TOOLS: LIST + CALL =================================================
// ========================================================================

server.setRequestHandler(ListToolsRequestSchema, async () => {
  const tools = [];

  // ==============================================================
  // 1) Generic SQL execution tool (FULL SQL allowed)
  // ==============================================================
  tools.push({
    name: "execute_sql",
    description:
      "Execute ANY SQL statement (SELECT / INSERT / UPDATE / DELETE / CREATE / DROP etc).",
    inputSchema: {
      type: "object",
      properties: {
        sql: { type: "string" },
        args: { type: "array", items: {} },
      },
      required: ["sql"],
    },
  });

  // ==============================================================
  // 2) Auto-generated insert_into_<table> tools
  // ==============================================================
  const tables = await getTables();

  for (const table of tables) {
    const columns = await getColumns(table);
    const insertable = columns.filter((c) => !c.isPrimaryKey);

    const properties = {};
    const required = [];

    for (const col of insertable) {
      properties[col.name] = {
        type: mapSqlType(col.type),
      };

      if (col.notNull && !col.defaultValue) {
        required.push(col.name);
      }
    }

    tools.push({
      name: `insert_into_${table}`,
      description: `Insert a new row into table '${table}'.`,
      inputSchema: {
        type: "object",
        properties,
        required,
      },
    });
  }

  return { tools };
});

// ========================================================================
// === TOOL EXECUTION =====================================================
// ========================================================================

server.setRequestHandler(CallToolRequestSchema, async (request) => {
  const { name, arguments: args } = request.params;

  // ==============================================================
  // 1) execute_sql tool
  // ==============================================================
if (name === "execute_sql") {
  const sql = args?.sql;
  const params = args?.args || [];

  if (!sql) throw new Error("Missing required field: sql");

  const result = await db.execute({ sql, args: params });

  const safeResult = toSafeJson({
    rows: result.rows,
    columns: result.columns,
    rowsAffected: result.rowsAffected,
    lastInsertRowid: result.lastInsertRowid,
  });

  return {
    content: [
      {
        type: "text",
        text: JSON.stringify(safeResult, null, 2),
      },
    ],
  };
}


  // ==============================================================
  // 2) insert_into_<table> tool
  // ==============================================================
if (name.startsWith("insert_into_")) {
  const table = name.replace("insert_into_", "");
  const columns = await getColumns(table);
  const insertable = columns.filter((c) => !c.isPrimaryKey);

  const colNames = [];
  const values = [];

  for (const col of insertable) {
    if (Object.prototype.hasOwnProperty.call(args, col.name)) {
      colNames.push(col.name);
      values.push(args[col.name]);
    }
  }

  const placeholders = colNames.map(() => "?").join(", ");
  const sql = `INSERT INTO ${table} (${colNames.join(
    ", "
  )}) VALUES (${placeholders})`;

  const result = await db.execute({ sql, args: values });

  const safeResult = toSafeJson({
    insertedInto: table,
    columns: colNames,
    values,
    rowsAffected: result.rowsAffected,
    lastInsertRowid: result.lastInsertRowid,
  });

  return {
    content: [
      {
        type: "text",
        text: JSON.stringify(safeResult, null, 2),
      },
    ],
  };
}
  throw new Error(`Unknown tool: ${name}`);
});

// ========================================================================
// === START SERVER =======================================================
// ========================================================================

async function start() {
  await server.connect(new StdioServerTransport());
  console.error("Turso MCP server is running on stdio (full SQL mode)");
}

start().catch((err) => {
  console.error("Fatal server error:", err);
});