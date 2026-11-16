import {
  McpServer,
  WebStandardStreamableHTTPServerTransport,
} from "@modelcontextprotocol/server";
import { z } from "zod";
import http from "http";

const RESOURCE_PORT = 3001;
const MCP_PORT = 3002;

const SERVER_INFO = {
  name: "mcp-streamable-server",
  version: "1.0.0",
  capabilities: ["tools", "resources", "prompts"],
};

/* -------------------------------------------------------------------------- */
/* 资源服务器（3001）：提供 server-info.json                                     */
/* -------------------------------------------------------------------------- */
const resourceServer = http.createServer((req, res) => {
  if (req.url === "/server-info.json") {
    res.writeHead(200, { "Content-Type": "application/json" });
    res.end(JSON.stringify(SERVER_INFO, null, 2));
  } else {
    res.writeHead(404, { "Content-Type": "application/json" });
    res.end(JSON.stringify({ error: "Not Found" }));
  }
});

resourceServer.listen(RESOURCE_PORT, () => {
  console.log(`Resource server listening on http://localhost:${RESOURCE_PORT}`);
});

/* -------------------------------------------------------------------------- */
/* MCP 服务器工厂                                                             */
/*                                                                             */
/* SDK v2 中 `Server.connect()` 只能调用一次（第二次会抛 ALREADY_CONNECTED）， */
/* 而无状态的 Streamable HTTP 要求“每个请求一个 transport”，                    */
/* 因此必须每个请求都新建一份 McpServer + transport。                          */
/* -------------------------------------------------------------------------- */
function createMcpServer(): McpServer {
  const server = new McpServer({
    name: SERVER_INFO.name,
    version: SERVER_INFO.version,
  });

  // 定义获取时间工具参数的 Schema
  const schema = z.object({
    format: z
      .enum(["iso", "utc", "full"])
      .optional()
      .describe(
        "时间格式：iso = ISO 格式，utc = UTC 时间，full = 完整日期时间",
      ),
  });

  // 注册工具
  server.registerTool(
    "get-time",
    {
      description:
        "获取当前时间，支持多种格式和本地化设置。format 参数控制时间显示格式",
      inputSchema: schema.shape,
    },
    async (tool) => {
      const { format } = tool || {};

      let timeString;

      if (format === "iso") {
        timeString = new Date().toISOString();
      } else if (format === "utc") {
        timeString = new Date().toUTCString();
      } else if (format === "full") {
        timeString = new Date().toLocaleString("zh-CN");
      } else {
        timeString = new Date().toString();
      }

      return {
        content: [{ type: "text", text: timeString }],
      };
    },
  );

  // 注册资源示例（uri 必须和资源服务器实际暴露的路径一致）
  server.registerResource(
    "server-info",
    `http://localhost:${RESOURCE_PORT}/server-info.json`,
    {
      description: "服务器信息资源",
      mimeType: "application/json",
    },
    async () => {
      return {
        contents: [
          {
            uri: `http://localhost:${RESOURCE_PORT}/server-info.json`,
            mimeType: "application/json",
            text: JSON.stringify(SERVER_INFO, null, 2),
          },
        ],
      };
    },
  );

  // 注册提示词
  server.registerPrompt(
    "time-query",
    {
      description:
        "帮助用户查询时间的助手提示，接收参数 question，返回用户提问的结构化结果",
      argsSchema: z.object({
        question: z.string().describe("用户关于时间的问题"),
      }).shape,
    },
    async ({ question }) => {
      return {
        messages: [
          {
            role: "user",
            content: {
              type: "text",
              text: `用户询问: ${
                question || "当前时间是？"
              }\n助手回答: 当前时间是 ${new Date().toString()}`,
            },
          },
        ],
      };
    },
  );

  return server;
}

/* -------------------------------------------------------------------------- */
/* Node.js <-> Web Standard 的桥接                                             */
/*                                                                             */
/* SDK v2 的 `transport.handleRequest()` 接收 Web 标准的 `Request`，返回 Web    */
/* 标准的 `Response`（v1 的 Node 风格签名 handleRequest(req, res, body) 已被  */
/* 移除），所以必须自己把 node:http 的 IncomingMessage / ServerResponse 转换。  */
/* -------------------------------------------------------------------------- */
async function toWebRequest(req: http.IncomingMessage): Promise<Request> {
  const headers = new Headers();
  for (const [key, value] of Object.entries(req.headers)) {
    if (value === undefined) continue;
    if (Array.isArray(value)) {
      for (const v of value) headers.append(key, v);
    } else {
      headers.set(key, value);
    }
  }

  const method = req.method ?? "GET";
  let body: Buffer | undefined;
  if (method !== "GET" && method !== "HEAD") {
    const chunks: Buffer[] = [];
    for await (const chunk of req) {
      chunks.push(chunk as Buffer);
    }
    body = Buffer.concat(chunks);
  }

  const url = new URL(
    req.url ?? "/",
    `http://${req.headers.host ?? `localhost:${MCP_PORT}`}`,
  );

  return new Request(url, {
    method,
    headers,
    body: body && body.length > 0 ? body : undefined,
  } as RequestInit);
}

async function sendWebResponse(
  res: http.ServerResponse,
  response: Response,
): Promise<void> {
  res.statusCode = response.status;
  response.headers.forEach((value, key) => {
    res.setHeader(key, value);
  });

  if (!response.body) {
    res.end();
    return;
  }

  // SSE 等流式响应：先把响应头发出去，客户端才能认为连接已建立
  res.flushHeaders();

  const reader = response.body.getReader();
  try {
    for (;;) {
      const { done, value } = await reader.read();
      if (done) break;
      if (!value) continue;
      if (!res.write(Buffer.from(value))) {
        await new Promise<void>((resolve) =>
          res.once("drain", () => resolve()),
        );
      }
    }
  } finally {
    res.end();
  }
}

/* -------------------------------------------------------------------------- */
/* MCP HTTP 服务器（3002）                                                     */
/* -------------------------------------------------------------------------- */
const mcpServer = http.createServer(async (req, res) => {
  const url = new URL(
    req.url ?? "/",
    `http://${req.headers.host ?? `localhost:${MCP_PORT}`}`,
  );

  // POST / GET / DELETE 都要交给 transport 处理（GET 用于 SSE 通知流，
  // DELETE 用于关闭会话）；只有路径不对才返回 404。
  if (url.pathname !== "/mcp") {
    res.writeHead(404, { "Content-Type": "application/json" });
    res.end(JSON.stringify({ error: "Not Found" }));
    return;
  }

  try {
    const request = await toWebRequest(req);

    // 无状态模式：每个请求一套新的 server + transport
    const server = createMcpServer();
    const transport = new WebStandardStreamableHTTPServerTransport({
      sessionIdGenerator: undefined,
      enableJsonResponse: true,
    });

    res.on("close", () => {
      transport.close().catch(() => {});
    });

    await server.connect(transport);

    const response = await transport.handleRequest(request);
    await sendWebResponse(res, response);
  } catch (error) {
    console.error("Error processing request:", error);
    if (!res.headersSent) {
      res.writeHead(500, { "Content-Type": "application/json" });
      res.end(JSON.stringify({ error: "Internal Server Error" }));
    } else {
      res.end();
    }
  }
});

mcpServer.listen(MCP_PORT, () => {
  console.log(`MCP server listening on http://localhost:${MCP_PORT}/mcp`);
});
