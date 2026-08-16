#!/usr/bin/env bash
set -Eeuo pipefail

TEST_PLATFORM=${TEST_PLATFORM:-linux/amd64}
case "$TEST_PLATFORM" in
  linux/amd64) EXPECTED_HA_ARCH=amd64 ;;
  linux/arm64) EXPECTED_HA_ARCH=aarch64 ;;
  *) echo "unsupported TEST_PLATFORM: ${TEST_PLATFORM}" >&2; exit 64 ;;
esac
HA_ARCH=${HA_ARCH:-$EXPECTED_HA_ARCH}
[[ $HA_ARCH == "$EXPECTED_HA_ARCH" ]] || exit 64
export TEST_PLATFORM HA_ARCH

IMAGE=${1:-antigravity-for-home-assistant:test}
EXPECTED_VERSION=$(sed -n \
  's/^ARG ANTIGRAVITY_VERSION=//p' antigravity_home_assistant/Dockerfile)

fail() {
  printf 'telegram shared-context smoke: %s\n' "$*" >&2
  exit 1
}

docker image inspect "${IMAGE}" >/dev/null 2>&1 \
  || fail "image not found: ${IMAGE}"
[[ "${EXPECTED_VERSION}" =~ ^[0-9]+\.[0-9]+\.[0-9]+$ ]] \
  || fail 'Dockerfile Antigravity version pin is invalid'

docker run --rm --platform "$TEST_PLATFORM" --network none \
  --env EXPECTED_VERSION="${EXPECTED_VERSION}" \
  --entrypoint /bin/bash "${IMAGE}" -ceu '
    [[ "$(/usr/local/libexec/antigravity-real --version)" == "${EXPECTED_VERSION}" ]]

    for obsolete in \
      /usr/local/bin/ha-telegram-login \
      /usr/local/libexec/ha-telegram-home-bootstrap \
      /usr/local/libexec/ha-telegram-worker \
      /usr/local/lib/antigravity-ha/telegram-plugin.sh \
      /etc/antigravity/telegram-settings.json \
      /usr/local/share/antigravity-ha/telegram-workspace \
      /usr/local/share/antigravity-ha/plugins/home-assistant/agents/ha-telegram; do
      [[ ! -e "${obsolete}" ]]
    done

    install -d -m 0700 \
      /data/home/.gemini/antigravity-cli \
      /data/home/.gemini/config/rules \
      /data/home/.gemini/config/plugins/user-global-marker \
      /data/home/.gemini/config/plugins/home-assistant \
      /config/.agents
    install -m 0600 /etc/antigravity/settings.json \
      /data/home/.gemini/antigravity-cli/settings.json
    cp -a /usr/local/share/antigravity-ha/plugins/home-assistant/. \
      /data/home/.gemini/config/plugins/home-assistant/

    printf "%s\n" "shared global rule marker" \
      > /data/home/.gemini/config/rules/shared-context.md
    printf "%s\n" "shared global plugin marker" \
      > /data/home/.gemini/config/plugins/user-global-marker/marker.txt
    printf "%s\n" "shared native OAuth/config marker" \
      > /data/home/.gemini/antigravity-cli/oauth-context.marker
    printf "%s\n" "shared /config workspace marker" \
      > /config/.agents/shared-context.marker

    printf "%s\n" \
      "import { writeFileSync } from \"node:fs\";" \
      "writeFileSync(\"/tmp/shared-global-mcp-launched\", process.env.HOME + \"\\n\", { mode: 0o600 });" \
      "process.stdin.resume();" \
      > /tmp/shared-global-mcp.mjs
    chmod 0600 /tmp/shared-global-mcp.mjs
    printf "%s\n" \
      "{\"mcpServers\":{\"shared_global_marker\":{\"command\":\"/usr/bin/node\",\"args\":[\"/tmp/shared-global-mcp.mjs\"]}}}" \
      > /data/home/.gemini/config/mcp_config.json

    cd /config
    set +e
    printf "load shared global context\n" | \
      ANTIGRAVITY_HA_CHANNEL=telegram \
      HA_TELEGRAM_USER_ID=123456789 \
      HA_TELEGRAM_CHAT_ID=-100123456789 \
      timeout 12s /usr/local/bin/antigravity \
        --output-format stream-json \
        --print-timeout 5s \
        --sandbox \
        >/tmp/shared-native.out 2>/tmp/shared-native.err
    native_status=$?
    set -e
    for _ in $(seq 1 50); do
      [[ -f /tmp/shared-global-mcp-launched ]] && break
      sleep 0.1
    done
    [[ -f /tmp/shared-global-mcp-launched ]] \
      || { printf "shared Antigravity did not load the global MCP (status %s)\n" \
        "${native_status}" >&2; exit 1; }
    grep -Fxq /data/home /tmp/shared-global-mcp-launched

    cp /usr/local/libexec/antigravity-real /tmp/antigravity-real.native
    printf "%s\n" \
      "#!/bin/bash -p" \
      "set -Eeuo pipefail" \
      "[[ \"\${HOME:-}\" == /data/home ]]" \
      "[[ \"\$(pwd -P)\" == /config ]]" \
      "[[ \"\${ANTIGRAVITY_HA_CHANNEL:-}\" == telegram ]]" \
      "[[ \"\${HA_TELEGRAM_USER_ID:-}\" == 123456789 ]]" \
      "[[ \"\${HA_TELEGRAM_CHAT_ID:-}\" == -100123456789 ]]" \
      "[[ ! -v SUPERVISOR_TOKEN && ! -v NODE_OPTIONS && ! -v NODE_PATH ]]" \
      "grep -Fxq \"shared global rule marker\" /data/home/.gemini/config/rules/shared-context.md" \
      "grep -Fxq \"shared global plugin marker\" /data/home/.gemini/config/plugins/user-global-marker/marker.txt" \
      "grep -Fq \"shared_global_marker\" /data/home/.gemini/config/mcp_config.json" \
      "grep -Fxq \"shared native OAuth/config marker\" /data/home/.gemini/antigravity-cli/oauth-context.marker" \
      "grep -Fxq \"shared /config workspace marker\" /config/.agents/shared-context.marker" \
      "touch /data/home/.gemini/config/rules/telegram-wrote-rule.marker" \
      "touch /data/home/.gemini/config/plugins/user-global-marker/telegram-wrote-plugin.marker" \
      "printf \"%s\\n\" \"\$@\" > /tmp/shared-launcher-args" \
      > /usr/local/libexec/antigravity-real
    chmod 0755 /usr/local/libexec/antigravity-real

    SUPERVISOR_TOKEN=must-not-cross \
      NODE_OPTIONS=must-not-cross \
      NODE_PATH=/must-not-cross \
      ANTIGRAVITY_HA_CHANNEL=telegram \
      HA_TELEGRAM_USER_ID=123456789 \
      HA_TELEGRAM_CHAT_ID=-100123456789 \
      /usr/local/bin/antigravity --version
    [[ -f /data/home/.gemini/config/rules/telegram-wrote-rule.marker ]]
    [[ -f /data/home/.gemini/config/plugins/user-global-marker/telegram-wrote-plugin.marker ]]
    grep -Fxq -- --sandbox /tmp/shared-launcher-args

    set +e
    ANTIGRAVITY_HA_CHANNEL=telegram \
      HA_TELEGRAM_USER_ID=invalid \
      HA_TELEGRAM_CHAT_ID=-100123456789 \
      /usr/local/bin/antigravity --version \
      >/tmp/invalid-binding.out 2>/tmp/invalid-binding.err
    invalid_status=$?
    set -e
    [[ "${invalid_status}" == 78 ]]
    grep -Fq "invalid Telegram requester binding" /tmp/invalid-binding.err

    install -m 0755 /tmp/antigravity-real.native \
      /usr/local/libexec/antigravity-real
  '

docker run --rm --platform "$TEST_PLATFORM" --network none \
  --tmpfs /data:rw,nosuid,nodev,noexec,mode=0755 \
  --tmpfs /run:rw,nosuid,nodev,noexec,mode=0755 \
  --entrypoint /bin/bash "${IMAGE}" -ceu '
    install -d -m 0700 \
      /data/home/.gemini/antigravity-cli \
      /data/home/.gemini/config/plugins/home-assistant \
      /config/.agents
    cp -a /usr/local/share/antigravity-ha/plugins/home-assistant/. \
      /data/home/.gemini/config/plugins/home-assistant/

    shared_settings=$(mktemp)
    jq ".modelProvider = \"gemini\" | .toolPermission = \"always-proceed\"" \
      /etc/antigravity/settings.json > "${shared_settings}"
    install -m 0600 "${shared_settings}" \
      /data/home/.gemini/antigravity-cli/settings.json

    mock_log=$(mktemp)
    first_stdout=$(mktemp)
    first_stderr=$(mktemp)
    second_stdout=$(mktemp)
    second_stderr=$(mktemp)
    mock_pid=
    cleanup_mock() {
      if [[ -n "${mock_pid}" ]] && kill -0 "${mock_pid}" 2>/dev/null; then
        kill "${mock_pid}" 2>/dev/null || true
        wait "${mock_pid}" 2>/dev/null || true
      fi
    }
    trap cleanup_mock EXIT

    /usr/bin/node - > "${mock_log}" 2>&1 <<\NODE &
const http = require("node:http");

function sendJson(response, status, value) {
  const body = JSON.stringify(value);
  response.writeHead(status, {
    "content-type": "application/json",
    "content-length": Buffer.byteLength(body),
  });
  response.end(body);
}

function hasFinishResultSchema(value, depth = 0) {
  if (depth > 16 || value === null || typeof value !== "object") return false;
  if (Array.isArray(value)) {
    return value.some((item) => hasFinishResultSchema(item, depth + 1));
  }
  const properties = value.properties;
  if (properties !== null && typeof properties === "object" &&
      !Array.isArray(properties) &&
      Object.prototype.hasOwnProperty.call(properties, "response") &&
      Object.prototype.hasOwnProperty.call(properties, "proposal_ids")) {
    return true;
  }
  return Object.values(value).some((item) =>
    item !== null && typeof item === "object" &&
    hasFinishResultSchema(item, depth + 1));
}

function advertisesFinishFunction(value) {
  if (value === null || typeof value !== "object" || Array.isArray(value) ||
      !Array.isArray(value.tools)) return false;
  return value.tools.some((tool) => {
    if (tool === null || typeof tool !== "object" || Array.isArray(tool)) return false;
    const declarations = tool.functionDeclarations ?? tool.function_declarations;
    if (!Array.isArray(declarations)) return false;
    return declarations.some((declaration) => {
      if (declaration === null || typeof declaration !== "object" ||
          Array.isArray(declaration) || declaration.name !== "finish") return false;
      const schema = declaration.parametersJsonSchema ??
        declaration.parameters_json_schema ?? declaration.parameters;
      return hasFinishResultSchema(schema);
    });
  });
}

const server = http.createServer((request, response) => {
  let body = "";
  request.setEncoding("utf8");
  request.on("data", (chunk) => {
    body += chunk;
  });
  request.on("end", () => {
    if (request.method !== "POST") {
      sendJson(response, 200, {});
      return;
    }

    let parsedRequest;
    let flattened = "";
    try {
      parsedRequest = JSON.parse(body);
      flattened = JSON.stringify(parsedRequest);
    } catch {
      sendJson(response, 400, { error: "invalid synthetic request" });
      return;
    }
    const pathname = new URL(request.url, "http://127.0.0.1").pathname;
    const finishFunctionAdvertised = advertisesFinishFunction(parsedRequest);
    process.stdout.write(`${JSON.stringify({
      kind: "request",
      pathname,
      first_stdin_sentinel: flattened.includes("TELEGRAM_NATIVE_FIRST_SENTINEL"),
      second_stdin_sentinel: flattened.includes("TELEGRAM_NATIVE_SECOND_SENTINEL"),
      output_format_literal: flattened.includes("--output-format"),
      finish_function_advertised: finishFunctionAdvertised,
    })}\n`);

    if (pathname.includes("countTokens")) {
      sendJson(response, 200, { totalTokens: 1 });
      return;
    }
    const part = finishFunctionAdvertised
      ? {
          functionCall: {
            name: "finish",
            args: { response: "MOCK_RESPONSE_OK", proposal_ids: [] },
          },
        }
      : { text: "MOCK_MANAGED_OK" };
    const event = {
      candidates: [{
        content: { parts: [part], role: "model" },
        finishReason: "STOP",
        index: 0,
      }],
      usageMetadata: {
        promptTokenCount: 1,
        candidatesTokenCount: 1,
        totalTokenCount: 2,
      },
      modelVersion: "synthetic-model",
    };
    const payload = `data: ${JSON.stringify(event)}\n\n`;
    response.writeHead(200, {
      "content-type": "text/event-stream",
      "content-length": Buffer.byteLength(payload),
    });
    response.end(payload);
  });
});

server.listen(18787, "127.0.0.1", () => {
  process.stdout.write(`${JSON.stringify({ kind: "ready" })}\n`);
});
for (const signal of ["SIGINT", "SIGTERM"]) {
  process.on(signal, () => server.close(() => process.exit(0)));
}
NODE
    mock_pid=$!

    for _ in $(seq 1 100); do
      grep -Fq "\"kind\":\"ready\"" "${mock_log}" && break
      kill -0 "${mock_pid}" 2>/dev/null \
        || { printf "synthetic Gemini endpoint stopped during startup\n" >&2; exit 1; }
      sleep 0.05
    done
    grep -Fq "\"kind\":\"ready\"" "${mock_log}"

    cd /config
    printf "%s\n" "TELEGRAM_NATIVE_FIRST_SENTINEL" | /usr/bin/env -i \
      AGY_CLI_DISABLE_AUTO_UPDATE=true \
      ANTIGRAVITY_HA_CHANNEL=telegram \
      GEMINI_API_KEY=synthetic-telegram-canary \
      GOOGLE_GEMINI_BASE_URL=http://127.0.0.1:18787 \
      HOME=/data/home \
      HA_TELEGRAM_USER_ID=123456789 \
      HA_TELEGRAM_CHAT_ID=-100123456789 \
      LANG=C.UTF-8 \
      LC_ALL=C.UTF-8 \
      PATH=/usr/local/sbin:/usr/local/bin:/usr/sbin:/usr/bin:/sbin:/bin \
      TERM=dumb \
      NO_COLOR=1 \
      timeout 20s /usr/local/libexec/antigravity-real \
        --output-format stream-json \
        --print-timeout 10s \
        --json-schema /usr/local/share/antigravity-ha/telegram-result-schema.json \
        --sandbox \
        > "${first_stdout}" 2> "${first_stderr}"

    first_request_count=$(jq -s \
      "[.[] | select(.kind == \"request\" and .first_stdin_sentinel == true)] | length" \
      "${mock_log}")
    first_finish_count=$(jq -s \
      "[.[] | select(.kind == \"request\" and .first_stdin_sentinel == true and .finish_function_advertised == true)] | length" \
      "${mock_log}")
    if [[ "${first_finish_count}" -lt 1 ]]; then
      printf "synthetic Gemini finish declaration was not detected (requests=%s finish=%s)\n" \
        "${first_request_count}" "${first_finish_count}" >&2
      exit 1
    fi
    conversation_id=$(
      NATIVE_STREAM_PATH="${first_stdout}" /usr/bin/node --input-type=module - <<\NODE
import { readFileSync } from "node:fs";
import { parseStreamResult } from "/usr/local/share/antigravity-ha/telegram-bridge.mjs";

const stream = readFileSync(process.env.NATIVE_STREAM_PATH);
const events = stream.toString("utf8").trim().split("\n").map(JSON.parse);
const terminal = events.find((event) => event.event === "result");
if (terminal?.result?.num_turns !== 1) {
  throw new Error(`native first turn count was not one (num_turns=${JSON.stringify(terminal?.result?.num_turns ?? null)})`);
}
JSON.parse(terminal.result.response);
const parsed = parseStreamResult(stream);
process.stdout.write(parsed.conversationId);
NODE
    )
    [[ "${conversation_id}" =~ ^[A-Za-z0-9._:-]{1,256}$ ]]

    printf "%s\n" "TELEGRAM_NATIVE_SECOND_SENTINEL" | /usr/bin/env -i \
      AGY_CLI_DISABLE_AUTO_UPDATE=true \
      ANTIGRAVITY_HA_CHANNEL=telegram \
      GEMINI_API_KEY=synthetic-telegram-canary \
      GOOGLE_GEMINI_BASE_URL=http://127.0.0.1:18787 \
      HOME=/data/home \
      HA_TELEGRAM_USER_ID=123456789 \
      HA_TELEGRAM_CHAT_ID=-100123456789 \
      LANG=C.UTF-8 \
      LC_ALL=C.UTF-8 \
      PATH=/usr/local/sbin:/usr/local/bin:/usr/sbin:/usr/bin:/sbin:/bin \
      TERM=dumb \
      NO_COLOR=1 \
      timeout 20s /usr/local/libexec/antigravity-real \
        --output-format stream-json \
        --print-timeout 10s \
        --json-schema /usr/local/share/antigravity-ha/telegram-result-schema.json \
        --conversation "${conversation_id}" \
        --sandbox \
        > "${second_stdout}" 2> "${second_stderr}"

    FIRST_STREAM_PATH="${first_stdout}" \
      SECOND_STREAM_PATH="${second_stdout}" \
      EXPECTED_CONVERSATION_ID="${conversation_id}" \
      /usr/bin/node --input-type=module - <<\NODE
import { readFileSync } from "node:fs";
import { parseStreamResult } from "/usr/local/share/antigravity-ha/telegram-bridge.mjs";

const first = parseStreamResult(readFileSync(process.env.FIRST_STREAM_PATH));
const second = parseStreamResult(readFileSync(process.env.SECOND_STREAM_PATH));
const terminalTurns = [];
for (const path of [process.env.FIRST_STREAM_PATH, process.env.SECOND_STREAM_PATH]) {
  const events = readFileSync(path, "utf8").trim().split("\n").map(JSON.parse);
  const terminal = events.find((event) => event.event === "result");
  terminalTurns.push(terminal?.result?.num_turns);
  const agentResponses = events.filter((event) =>
    event.event === "step_update" &&
    event.step_update?.step_type === "agent_response");
  const finishes = events.filter((event) =>
    event.event === "step_update" &&
    event.step_update?.step_type === "finish");
  if (agentResponses.length !== 1 || finishes.length !== 1) {
    throw new Error("native invocation did not emit exactly one response and finish step");
  }
  const document = JSON.parse(terminal.result.response);
  if (document.response !== "MOCK_RESPONSE_OK" ||
      !Array.isArray(document.proposal_ids) || document.proposal_ids.length !== 0) {
    throw new Error("native finish contract returned an invalid terminal document");
  }
}
// Antigravity 1.1.11 reports num_turns cumulatively for a resumed
// conversation. A one-turn first invocation followed by a one-turn resume is
// therefore reported as 1 then 2, while each stream above still contains one
// agent_response and one finish step.
if (terminalTurns[0] !== 1 || terminalTurns[1] !== terminalTurns[0] + 1) {
  throw new Error(`native cumulative turn count did not advance once (${JSON.stringify(terminalTurns)})`);
}
if (first.conversationId !== process.env.EXPECTED_CONVERSATION_ID ||
    second.conversationId !== process.env.EXPECTED_CONVERSATION_ID) {
  throw new Error("native conversation resume changed the conversation identifier");
}
if (first.response !== "MOCK_RESPONSE_OK" || second.response !== "MOCK_RESPONSE_OK") {
  throw new Error("native stream parser did not return both synthetic responses");
}
NODE

    kill "${mock_pid}" 2>/dev/null || true
    wait "${mock_pid}" 2>/dev/null || true
    mock_pid=
    [[ ! -s "${first_stderr}" ]]
    [[ ! -s "${second_stderr}" ]]
    jq -s -e "
      ([.[] | select(.kind == \"request\")] | length) > 1 and
      any(.[]; .kind == \"request\" and .first_stdin_sentinel == true) and
      any(.[]; .kind == \"request\" and .second_stdin_sentinel == true) and
      any(.[]; .kind == \"request\" and .finish_function_advertised == true) and
      all(.[]; .kind != \"request\" or .output_format_literal == false)
    " "${mock_log}" >/dev/null
  ' || fail 'native 1.1.11 shared HOME stdin stream-json resume canary failed'

printf 'telegram shared-context smoke passed for Antigravity %s\n' \
  "${EXPECTED_VERSION}"
