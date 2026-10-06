import { createHash } from "node:crypto";
/**
 * What Claude Code says about a request in its billing header, for telling
 * the main conversation apart from Claude Code's side requests (the auto-mode
 * security monitor, recaps, titles, …).
 *
 * Claude Code puts `x-anthropic-billing-header: cc_version=…; cc_entrypoint=…;
 * …` as the first system text block. Observed on 2.1.281: the main thread's
 * requests carry `cc_turn_origin=human;` and `cc_prompt_id=…;`, while the
 * security monitor's request carries neither.
 *
 * The request log (2026-09-24, 112 requests) showed a header without a turn
 * origin also on recaps and on background-notification turns, which carry
 * the full tool list and must keep MemTree. Only the security monitor sends
 * zero tools, so ``isClaudeCodeSideRequest`` requires all three.
 */
const BILLING_HEADER_PREFIX = "x-anthropic-billing-header:";
/** Characters of system prompt kept for auditing a suspected side request. */
export const SYSTEM_HEAD_CHARS = 120;
export function describeClaudeCodeRequest(body) {
    const texts = systemTexts(body);
    let fields;
    const rest = [];
    for (const text of texts) {
        if (!fields && text.startsWith(BILLING_HEADER_PREFIX)) {
            const parsed = parseHeader(text.slice(BILLING_HEADER_PREFIX.length));
            fields = parsed.fields;
            if (parsed.rest.trim())
                rest.push(parsed.rest);
        }
        else {
            rest.push(text);
        }
    }
    const tools = Array.isArray(body?.tools) ? body.tools.length : 0;
    const info = {
        billingHeader: fields !== undefined,
        promptId: fields?.cc_prompt_id !== undefined,
        tools,
        suspectedSideRequest: fields !== undefined && fields.cc_turn_origin === undefined,
    };
    if (fields?.cc_version)
        info.ccVersion = fields.cc_version;
    if (fields?.cc_entrypoint)
        info.entrypoint = fields.cc_entrypoint;
    if (fields?.cc_turn_origin)
        info.turnOrigin = fields.cc_turn_origin;
    if (info.suspectedSideRequest) {
        const head = oneLine(rest.join(" ")).slice(0, SYSTEM_HEAD_CHARS);
        if (head)
            info.systemHead = head;
        const messages = Array.isArray(body?.messages) ? body.messages : [];
        info.messageCount = messages.length;
        const lastUser = [...messages].reverse().find((m) => m?.role === "user");
        if (lastUser) {
            const text = oneLine(messageText(lastUser).replace(/<system-reminder>[\s\S]*?<\/system-reminder>/g, " ")).slice(0, SYSTEM_HEAD_CHARS);
            info.lastUserHead = text || `[${lastUserPartTypes(lastUser)}]`;
        }
    }
    return info;
}
/** A short, non-reversible tag grouping requests of one session in the log. */
export function sessionTag(sessionId) {
    return sessionId ? createHash("sha256").update(sessionId).digest("hex").slice(0, 8) : undefined;
}
function lastUserPartTypes(message) {
    const content = message?.content;
    if (!Array.isArray(content))
        return typeof content;
    return [...new Set(content.map((p) => p?.type ?? typeof p))].join(",");
}
/** Text of the top-level `system` value, then of leading `role: system` messages. */
function systemTexts(body) {
    const out = [];
    const add = (value) => {
        if (typeof value === "string")
            out.push(value);
        else if (Array.isArray(value)) {
            for (const item of value) {
                if (typeof item === "string")
                    out.push(item);
                else if (item && typeof item === "object" && typeof item.text === "string")
                    out.push(item.text);
            }
        }
    };
    add(body?.system);
    const messages = Array.isArray(body?.messages) ? body.messages : [];
    for (const message of messages) {
        if (message?.role !== "system")
            break;
        add(message.content);
    }
    return out;
}
/** `key=value;` pairs from the start of the header; whatever follows is prompt text. */
function parseHeader(text) {
    const fields = {};
    const pair = /^\s*([a-z_]+)=([^;\n]*);/;
    let remaining = text;
    for (let match = pair.exec(remaining); match; match = pair.exec(remaining)) {
        fields[match[1]] = match[2].trim();
        remaining = remaining.slice(match[0].length);
    }
    return { fields, rest: remaining };
}
function oneLine(text) {
    return text.replace(/\s+/g, " ").trim();
}
/**
 * Claude Code's own side request (the auto-mode security monitor): a billing
 * header, no turn origin, and no tools. The proxy forwards these untouched
 * and never involves MemTree or the main thread's route state.
 */
export function isClaudeCodeSideRequest(info) {
    return info.billingHeader && info.turnOrigin === undefined && info.tools === 0;
}
const TRANSCRIPT_OPEN = "<transcript>";
const TRANSCRIPT_CLOSE = "</transcript>";
const SAMPLE_CHARS = 80;
export function inspectMonitorTranscript(body) {
    const shape = { ok: false, lines: 0, userLines: 0, toolLines: 0, metaLines: 0 };
    const messages = Array.isArray(body?.messages) ? body.messages : [];
    const text = messages
        .filter((m) => m?.role === "user")
        .map((m) => messageText(m))
        .find((t) => t.includes(TRANSCRIPT_OPEN));
    if (text === undefined)
        return { ...shape, reason: "no-transcript" };
    const start = text.indexOf(TRANSCRIPT_OPEN) + TRANSCRIPT_OPEN.length;
    const end = text.indexOf(TRANSCRIPT_CLOSE, start);
    if (end < 0)
        return { ...shape, reason: "unclosed" };
    const lines = text.slice(start, end).split("\n");
    for (let i = 0; i < lines.length; i++) {
        const line = lines[i].trim();
        if (!line)
            continue;
        let parsed;
        try {
            parsed = JSON.parse(line);
        }
        catch {
            parsed = undefined;
        }
        const keys = parsed && typeof parsed === "object" && !Array.isArray(parsed) ? Object.keys(parsed) : [];
        if (keys.length !== 1) {
            return { ...shape, reason: "bad-line", badLine: i + 1, sample: oneLine(line).slice(0, SAMPLE_CHARS) };
        }
        shape.lines++;
        if (keys[0] === "user")
            shape.userLines++;
        else if (keys[0] === "meta")
            shape.metaLines++;
        else
            shape.toolLines++;
    }
    if (shape.lines === 0)
        return { ...shape, reason: "empty" };
    return { ...shape, ok: true };
}
function messageText(message) {
    const content = message?.content;
    if (typeof content === "string")
        return content;
    if (!Array.isArray(content))
        return "";
    return content
        .map((p) => (typeof p === "string" ? p : p?.type === "text" && typeof p.text === "string" ? p.text : ""))
        .join("");
}
const META_VALUE = /^[\x20-\x7e]{1,128}$/;
export function memtreeClientMeta(input) {
    const candidate = {
        project_dir: input.project?.project_dir,
        git_repo: input.project?.git_repo,
        git_branch: input.project?.git_branch,
        git_commit: input.project?.git_commit,
        claude_code_version: input.info?.ccVersion,
        entrypoint: input.info?.entrypoint,
        turn_origin: input.info?.turnOrigin,
        lane: input.lane,
        agent_id: input.agentId,
        parent_agent_id: input.parentAgentId,
        requested_model: input.model,
    };
    const meta = {};
    for (const [key, value] of Object.entries(candidate)) {
        if (typeof value === "string" && META_VALUE.test(value))
            meta[key] = value;
    }
    return meta;
}
//# sourceMappingURL=cc-request.js.map