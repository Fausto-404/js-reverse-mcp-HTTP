/**
 * @license
 * Copyright 2025 Google LLC
 * SPDX-License-Identifier: Apache-2.0
 */

import {createServer} from 'node:http';
import {randomUUID} from 'node:crypto';
import {resolve} from 'node:path';
import process from 'node:process';

import {Client} from '@modelcontextprotocol/sdk/client/index.js';
import {StdioClientTransport} from '@modelcontextprotocol/sdk/client/stdio.js';
import {Server} from '@modelcontextprotocol/sdk/server/index.js';
import {StreamableHTTPServerTransport} from '@modelcontextprotocol/sdk/server/streamableHttp.js';
import {
  CallToolRequestSchema,
  GetPromptRequestSchema,
  ListPromptsRequestSchema,
  ListResourceTemplatesRequestSchema,
  ListResourcesRequestSchema,
  ListToolsRequestSchema,
  ReadResourceRequestSchema,
} from '@modelcontextprotocol/sdk/types.js';
import yargs from 'yargs';
import {hideBin} from 'yargs/helpers';

const argv = yargs(hideBin(process.argv))
  .scriptName('js-reverse-mcp-http-bridge')
  .parserConfiguration({'populate--': true})
  .option('host', {
    type: 'string',
    default: '127.0.0.1',
    describe: 'Host to bind the HTTP MCP bridge',
  })
  .option('port', {
    type: 'number',
    default: 8787,
    describe: 'Port to bind the HTTP MCP bridge',
  })
  .option('server-path', {
    type: 'string',
    default: 'build/src/index.js',
    describe: 'Path to the stdio MCP server entrypoint',
  })
  .option('stdio-command', {
    type: 'string',
    default: process.execPath,
    describe: 'Executable used to start the stdio MCP server',
  })
  .help()
  .parseSync();

const passthroughArgs = Array.isArray(argv['--'])
  ? argv['--'].map(String)
  : [];
const serverPath = resolve(String(argv['server-path']));
const stdioCommand = String(argv['stdio-command']);
const stdioArgs = [serverPath, ...passthroughArgs];

const clientTransport = new StdioClientTransport({
  command: stdioCommand,
  args: stdioArgs,
  cwd: process.cwd(),
});
const client = new Client({
  name: 'js-reverse-http-bridge',
  version: '1.0.0',
});
await client.connect(clientTransport);

const server = new Server(
  {
    name: 'js-reverse-http-bridge',
    version: '1.0.0',
  },
  {capabilities: client.getServerCapabilities() ?? {tools: {}}},
);

server.setRequestHandler(ListToolsRequestSchema, async request => {
  return client.listTools(request.params);
});
server.setRequestHandler(CallToolRequestSchema, async request => {
  return client.callTool(request.params);
});
server.setRequestHandler(ListResourcesRequestSchema, async request => {
  return client.listResources(request.params);
});
server.setRequestHandler(ReadResourceRequestSchema, async request => {
  return client.readResource(request.params);
});
server.setRequestHandler(ListResourceTemplatesRequestSchema, async request => {
  return client.listResourceTemplates(request.params);
});
server.setRequestHandler(ListPromptsRequestSchema, async request => {
  return client.listPrompts(request.params);
});
server.setRequestHandler(GetPromptRequestSchema, async request => {
  return client.getPrompt(request.params);
});

const httpTransport = new StreamableHTTPServerTransport({
  sessionIdGenerator: () => randomUUID(),
  enableJsonResponse: true,
});
await server.connect(httpTransport);

const host = String(argv.host);
const port = Number(argv.port);

const httpServer = createServer((req, res) => {
  const url = new URL(req.url ?? '/', `http://${req.headers.host ?? 'localhost'}`);
  if (url.pathname !== '/mcp') {
    res.writeHead(404).end();
    return;
  }
  httpTransport.handleRequest(req, res).catch(error => {
    console.error('HTTP bridge error:', error);
    if (!res.headersSent) {
      res.writeHead(500);
    }
    res.end();
  });
});

httpServer.listen(port, host, () => {
  console.log(`MCP HTTP bridge listening on http://${host}:${port}/mcp`);
  console.log(`Proxying stdio MCP: ${stdioCommand} ${stdioArgs.join(' ')}`);
});

const shutdown = async () => {
  await clientTransport.close();
  httpServer.close();
};

process.on('SIGINT', () => {
  shutdown().finally(() => process.exit(0));
});
process.on('SIGTERM', () => {
  shutdown().finally(() => process.exit(0));
});
