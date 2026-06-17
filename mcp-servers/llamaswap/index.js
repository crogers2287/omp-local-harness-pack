#!/usr/bin/env node
import { Server } from '@modelcontextprotocol/sdk/server/index.js';
import { StdioServerTransport } from '@modelcontextprotocol/sdk/server/stdio.js';
import {
  CallToolRequestSchema,
  ListToolsRequestSchema,
} from '@modelcontextprotocol/sdk/types.js';
import axios from 'axios';

const LLAMASWAP_URL = process.env.LLAMASWAP_URL || 'http://localhost:9069';
const DEFAULT_MODEL = process.env.DEFAULT_MODEL || 'local-primary';

class LlamaSwapServer {
  constructor() {
    this.server = new Server(
      { name: 'mcp-llamaswap', version: '1.0.0' },
      { capabilities: { tools: {} } }
    );

    this.setupHandlers();
    this.axiosClient = axios.create({
      baseURL: LLAMASWAP_URL,
      timeout: 120000,
      headers: { 'Content-Type': 'application/json' },
    });
  }

  setupHandlers() {
    this.server.setRequestHandler(ListToolsRequestSchema, async () => ({
      tools: [
        {
          name: 'chat',
          description: 'Chat with a llama-swap model',
          inputSchema: {
            type: 'object',
            properties: {
              message: { type: 'string', description: 'The message to send to the model' },
              model: { type: 'string', description: `Model to use; default ${DEFAULT_MODEL}`, default: DEFAULT_MODEL },
              temperature: { type: 'number', description: 'Temperature for generation', default: 1.2 },
              max_tokens: { type: 'number', description: 'Maximum tokens to generate', default: 1000 },
            },
            required: ['message'],
          },
        },
        {
          name: 'list_models',
          description: 'List available models in llama-swap',
          inputSchema: { type: 'object', properties: {} },
        },
      ],
    }));

    this.server.setRequestHandler(CallToolRequestSchema, async (request) => {
      const { name, arguments: args } = request.params;
      switch (name) {
        case 'chat':
          return this.handleChat(args ?? {});
        case 'list_models':
          return this.handleListModels();
        default:
          throw new Error(`Unknown tool: ${name}`);
      }
    });
  }

  async handleChat(args) {
    try {
      const response = await this.axiosClient.post('/v1/chat/completions', {
        model: args.model || DEFAULT_MODEL,
        messages: [{ role: 'user', content: args.message }],
        temperature: args.temperature || 1.2,
        max_tokens: args.max_tokens || 1000,
        stream: false,
      });
      const content = response.data.choices?.[0]?.message?.content ?? '';
      return { content: [{ type: 'text', text: content }] };
    } catch (error) {
      const message = error instanceof Error ? error.message : String(error);
      console.error('Error calling llama-swap:', message);
      throw new Error(`Failed to chat with model: ${message}`);
    }
  }

  async handleListModels() {
    try {
      const response = await this.axiosClient.get('/v1/models');
      const models = (response.data.data ?? []).map((model) => model.id).join(', ');
      return { content: [{ type: 'text', text: `Available models: ${models}` }] };
    } catch (error) {
      const message = error instanceof Error ? error.message : String(error);
      console.error('Error listing models:', message);
      throw new Error(`Failed to list models: ${message}`);
    }
  }

  async run() {
    const transport = new StdioServerTransport();
    await this.server.connect(transport);
    console.error('LlamaSwap MCP Server running');
  }
}

const server = new LlamaSwapServer();
server.run().catch((error) => {
  console.error(error);
  process.exit(1);
});
