#!/usr/bin/env bun
import { readMcpSendServerEnv, runMcpSendServer } from "./mcp-send-server.ts";

await runMcpSendServer(readMcpSendServerEnv(Bun.env));
