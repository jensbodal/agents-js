/**
 * Deterministic external ACP mock agent used by browser smoke coverage.
 *
 * Supports three prompt families:
 * - default prompt replies
 * - auth-required retry flow
 * - elicitation accept / decline / cancel flows
 */
process.stderr.write("[Mock] Script loaded\n");

const readline = require("node:readline");

const SESSION_ID = "mock-session-123";
const AUTH_METHOD_ID = "browser-auth";
const pendingElicitations = new Map();
let authenticated = false;
let lastAuthMethodId = null;
let nextRequestId = 10_000;
// Counts session/prompt requests this mock actually served (excludes the
// `__PROMPT_COUNT__` diagnostic probe). Used by gateway-executor-concurrent-e2e
// to regression-test the mutex-dedup contract.
let promptCount = 0;

const rl = readline.createInterface({
  input: process.stdin,
  terminal: false,
});

function write(payload) {
  process.stdout.write(`${JSON.stringify(payload)}\n`);
}

function reply(id, result) {
  write({
    jsonrpc: "2.0",
    id,
    result,
  });
}

function replyError(id, error) {
  write({
    jsonrpc: "2.0",
    id,
    error,
  });
}

function sendChunk(sessionId, text, delayMs) {
  setTimeout(() => {
    write({
      jsonrpc: "2.0",
      method: "session/update",
      params: {
        sessionId,
        update: {
          sessionUpdate: "agent_message_chunk",
          content: { type: "text", text },
        },
      },
    });
  }, delayMs);
}

function finishPrompt(promptRequestId, sessionId, parts) {
  const chunks = Array.isArray(parts) && parts.length > 0 ? parts : ["Mock ACP Agent!"];
  chunks.forEach((text, index) => {
    sendChunk(sessionId, text, 50 * (index + 1));
  });

  setTimeout(
    () => {
      reply(promptRequestId, { stopReason: "end_turn" });
    },
    50 * (chunks.length + 1),
  );
}

function getPromptText(request) {
  const prompt = Array.isArray(request?.params?.prompt) ? request.params.prompt : [];
  const textPart = prompt.find((part) => part && part.type === "text");
  return typeof textPart?.text === "string" ? textPart.text.trim() : "";
}

function createElicitationSchema() {
  return {
    title: "Need follow-up details",
    description: "Provide the extra details requested by the browser smoke fixture.",
    type: "object",
    properties: {
      topic: {
        type: "string",
        description: "Short topic name",
      },
      urgent: {
        type: "boolean",
        description: "Whether this requires urgent handling",
      },
      priority: {
        type: "integer",
        description: "Priority from 1 to 5",
      },
    },
    required: ["topic"],
  };
}

function sendElicitationPrompt(request, variant) {
  const elicitationId = nextRequestId++;
  pendingElicitations.set(String(elicitationId), {
    promptRequestId: request.id,
    sessionId: request.params?.sessionId || SESSION_ID,
    variant,
  });

  write({
    jsonrpc: "2.0",
    id: elicitationId,
    method: "elicitation/create",
    params: {
      sessionId: request.params?.sessionId || SESSION_ID,
      mode: "form",
      message: "Please confirm how the browser smoke fixture should continue.",
      requestedSchema: createElicitationSchema(),
    },
  });
}

function handleElicitationResponse(response) {
  const pending = pendingElicitations.get(String(response.id));
  if (!pending) {
    return;
  }
  pendingElicitations.delete(String(response.id));

  const action = response?.result?.action?.action;
  const content = response?.result?.action?.content ?? {};
  let text;

  if (action === "accept") {
    text =
      `Elicitation accepted for ${content.topic || "unspecified topic"}. ` +
      `Urgent=${String(content.urgent ?? false)}. Priority=${String(content.priority ?? 0)}.`;
  } else if (action === "decline") {
    text = "Elicitation declined by the browser smoke fixture.";
  } else if (action === "cancel") {
    text = "Elicitation cancelled by the browser smoke fixture.";
  } else {
    text = `Unexpected elicitation action: ${String(action)}`;
  }

  finishPrompt(pending.promptRequestId, pending.sessionId, [text]);
}

function handlePrompt(request) {
  const sessionId = request.params?.sessionId || SESSION_ID;
  const promptText = getPromptText(request);
  process.stderr.write(`[Mock] Handling session/prompt: ${promptText}\n`);

  // Opt-in env flag: exit non-zero immediately on session/prompt. Used by
  // dispatch crash-mid-prompt regression tests. Default (flag unset) is
  // byte-identical to pre-flag behavior.
  if (process.env.MOCK_ACP_CRASH_AFTER === "prompt") {
    process.stderr.write("[Mock] MOCK_ACP_CRASH_AFTER=prompt — exiting non-zero\n");
    process.exit(1);
  }

  // Opt-in env flag: delay the prompt response by the given number of ms
  // before dispatching the normal chunk-and-reply flow. Used by dispatch
  // SIGINT/teardown tests to keep the ephemeral controller busy long enough
  // to exercise the cleanup path.
  const rawDelay = process.env.MOCK_ACP_PROMPT_DELAY_MS;
  const promptDelayMs =
    typeof rawDelay === "string" && /^\d+$/.test(rawDelay) ? Number(rawDelay) : 0;

  // Diagnostic probe: report the current promptCount without incrementing or
  // treating this as a real turn. Used only by the concurrent-e2e mutex
  // regression test.
  if (promptText === "__PROMPT_COUNT__") {
    finishPrompt(request.id, sessionId, [`__PROMPT_COUNT__:${promptCount}`]);
    return;
  }

  // Diagnostic probe: echo the given tag back verbatim as the agent response.
  // Used by the two-distinct-contextIds regression test to assert each lane
  // receives its own response text without cross-talk. Still counts as a
  // real turn (increments promptCount via continueHandlePrompt).
  const echoMatch = promptText.match(/^__ECHO__:(.*)$/);
  if (echoMatch) {
    continueHandlePromptEcho(request, sessionId, echoMatch[1]);
    return;
  }

  // Diagnostic probe: hold the prompt open for <ms> before replying with
  // the echoed tag. Used by the parallelism regression test to assert
  // wall-clock overlap between two distinct-contextId prompts.
  // Counts as a real turn.
  const sleepMatch = promptText.match(/^__SLEEP_MS__:(\d+):(.*)$/);
  if (sleepMatch) {
    const delayMs = Number(sleepMatch[1]);
    const tag = sleepMatch[2];
    setTimeout(() => {
      continueHandlePromptEcho(request, sessionId, tag);
    }, delayMs);
    return;
  }

  if (promptDelayMs > 0) {
    setTimeout(() => continueHandlePrompt(request, sessionId, promptText), promptDelayMs);
    return;
  }

  continueHandlePrompt(request, sessionId, promptText);
}

function continueHandlePromptEcho(request, sessionId, tag) {
  promptCount++;
  finishPrompt(request.id, sessionId, [`__ECHO__:${tag}`]);
}

function continueHandlePrompt(request, sessionId, promptText) {
  promptCount++;

  if (/browser smoke auth/i.test(promptText) && !authenticated) {
    replyError(request.id, {
      code: -32001,
      message: "auth_required",
      data: { reason: "auth_required" },
    });
    return;
  }

  if (/browser smoke elicitation accept/i.test(promptText)) {
    sendElicitationPrompt(request, "accept");
    return;
  }

  if (/browser smoke elicitation decline/i.test(promptText)) {
    sendElicitationPrompt(request, "decline");
    return;
  }

  if (/browser smoke elicitation cancel/i.test(promptText)) {
    sendElicitationPrompt(request, "cancel");
    return;
  }

  if (/browser smoke auth/i.test(promptText)) {
    finishPrompt(request.id, sessionId, [
      "Authentication accepted via ",
      `${lastAuthMethodId || AUTH_METHOD_ID}.`,
    ]);
    return;
  }

  finishPrompt(request.id, sessionId, ["Hello from ", "Mock ACP Agent!"]);
}

function handleRequest(request) {
  if (request.method === "initialize") {
    process.stderr.write("[Mock] Handling initialize\n");
    reply(request.id, {
      protocolVersion: 1,
      agentCapabilities: {
        promptCapabilities: { image: true },
      },
      agentInfo: { name: "MockAgent", version: "1.0.0" },
      authMethods: [{ id: AUTH_METHOD_ID, name: "Browser auth" }],
    });
    return;
  }

  if (request.method === "session/new") {
    process.stderr.write("[Mock] Handling session/new\n");
    reply(request.id, { sessionId: SESSION_ID });
    return;
  }

  if (request.method === "authenticate") {
    lastAuthMethodId = request?.params?.methodId || AUTH_METHOD_ID;
    authenticated = true;
    process.stderr.write(`[Mock] Authenticated via ${lastAuthMethodId}\n`);
    reply(request.id, {});
    return;
  }

  if (request.method === "session/prompt") {
    handlePrompt(request);
    return;
  }

  process.stderr.write(`[Mock] Ignoring unsupported method: ${request.method}\n`);
}

rl.on("line", (line) => {
  process.stderr.write(`[Mock] Received: ${line}\n`);

  try {
    const message = JSON.parse(line);

    if (message && typeof message === "object" && "method" in message) {
      handleRequest(message);
      return;
    }

    if (message && typeof message === "object" && "id" in message && "result" in message) {
      handleElicitationResponse(message);
      return;
    }
  } catch (error) {
    process.stderr.write(`[Mock] Error: ${error.message}\n`);
  }
});
