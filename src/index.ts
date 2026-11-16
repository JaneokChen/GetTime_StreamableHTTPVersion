import { McpServer } from "@modelcontextprotocol/server";
import { WebStandardStreamableHTTPServerTransport } from "@modelcontextprotocol/server";
import { z } from "zod";
import http from "http";
import { Readable, pipeline } from "stream";
import { parse } from "url";

// 创建 HTTP 服务器提供资源
const PORT = 3001;
const SERVER_INFO = {
  name: "mcp-streamable_server",
  version: "1.0.0",
  capabilities: ["tools", "resources", "prompts"],
};

// 创建 MCP 服务器（每个请求需要一个独立的实例）
function createMcpServer() {
  const server = new McpServer({
    name: "mcp-streamable-server",
    version: "1.0.0",
  });

  // 定义获取时间工具参数的 Schema
  const schema = z.object({
    format: z
      .enum(["iso", "utc", "full"])
      .optional()
      .describe("时间格式：iso = ISO 格式，utc = UTC 时间，full = 完整日期时间"),
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

  // 注册资源示例
  server.registerResource(
    "server-info",
    `http://localhost:${PORT}/server_info.json`,
    {
      description: "服务器信息资源",
      mimeType: "application/json",
    },
    async () => {
      return {
        contents: [
          {
            uri: `http://localhost:${PORT}/server_info.json`,
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
      // 2. 配置对象（包含描述和参数 Schema）
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

const resourceServer = http.createServer((req, res) => {
  if (req.url === "/server-info.json") {
    res.writeHead(200, {
      "Content-Type": "application/json",
    });
    res.end(JSON.stringify(SERVER_INFO, null, 2));
  } else {
    res.writeHead(404);
    res.end("Not Found");
  }
});

resourceServer.listen(PORT, () => {
  console.log(`Resource server listening on http://localhost:${PORT}`);
});

// 将 Node.js 的 req 转换成 Web 标准的 Request
function toWebRequest(req: http.IncomingMessage): Request {
  const headers = new Headers();
  for (const [key, value] of Object.entries(req.headers)) {
    if (value === undefined) continue;
    headers.set(key, Array.isArray(value) ? value.join(", ") : value);
  }

  const url = `http://${req.headers.host ?? "localhost"}${req.url ?? "/"}`;
  return new Request(url, { method: req.method ?? "GET", headers });
}

// 将 Web 标准的 Response 写回 Node.js 的 res
function writeWebResponse(res: http.ServerResponse, response: Response) {
  res.writeHead(response.status, Object.fromEntries(response.headers));

  if (response.body) {
    pipeline(Readable.fromWeb(response.body as any), res, () => {
      // 客户端断开或响应结束时关闭，忽略错误
    });
  } else {
    res.end();
  }
}

// 创建 HTTP 服务器用于 MCP 通信
const mcpServer = http.createServer((req, res) => {
  // 允许 MCP Inspector 等浏览器客户端跨域访问
  res.setHeader("Access-Control-Allow-Origin", req.headers.origin ?? "*");
  res.setHeader("Access-Control-Allow-Methods", "GET, POST, DELETE, OPTIONS");
  res.setHeader(
    "Access-Control-Allow-Headers",
    "Content-Type, Accept, Mcp-Session-Id, MCP-Protocol-Version, Last-Event-ID",
  );
  res.setHeader("Access-Control-Expose-Headers", "Mcp-Session-Id");
  res.setHeader("Vary", "Origin");

  if (req.method === "OPTIONS") {
    res.writeHead(204);
    res.end();
    return;
  }

  // 解析 URL
  const parsedUrl = parse(req.url ?? "/", true);

  if (parsedUrl.pathname !== "/mcp") {
    res.writeHead(404, { "content-type": "application/json" });
    res.end(JSON.stringify({ error: "Not Found" }));
    return;
  }

  // 收集请求体数据
  let body = "";
  req.on("data", (chunk) => {
    body += chunk.toString();
  });

  req.on("end", async () => {
    try {
      const requestData = body ? JSON.parse(body) : undefined;

      // 每个请求使用独立的 server + transport（SDK 要求一个 server 只连接一个 transport）
      const server = createMcpServer();
      const transport = new WebStandardStreamableHTTPServerTransport({
        sessionIdGenerator: undefined,
        enableJsonResponse: true,
      });

      res.on("close", () => {
        transport.close();
      });

      await server.connect(transport);

      // Web 标准 transport 需要 Web Request，直接传 Node 的 req 会导致请求一直挂起
      const response = await transport.handleRequest(toWebRequest(req), {
        parsedBody: requestData,
      });

      writeWebResponse(res, response);
    } catch (error) {
      console.log("Error processing request:", error);
      if (!res.headersSent) {
        res.writeHead(500, { "content-type": "application/json" });
        res.end(JSON.stringify({ error: "Internal Server Error" }));
      } else {
        res.end();
      }
    }
  });
});

const MCP_PORT = 3002;
mcpServer.listen(MCP_PORT, () => {
  console.log(`MCP server listening on http://localhost:${MCP_PORT}/mcp`);
});
