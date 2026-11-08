/**
 * The `user_messages` and `handover` tools: the person's own messages over a time
 * range, and a handover pack (their recent messages, how the session ended, and a
 * model's reading of their goals, instructions, decisions and open questions).
 *
 * The server builds both (polychat `routes/memtree_handover.py`); this module turns its
 * JSON into the tool's text and its arguments into the query string. Why: a new agent
 * taking over a long session needs what the person asked for, decided and corrected, and
 * the tree mixes those with every tool result (polychat
 * reports/2026-11-08_memtree_orchestrator_handover.md).
 */
import { formatTime } from "./memtree-times.js";
import { ToolInputError } from "./memtree-tools.js";
/** Days of messages a pack covers by default, and at most (the server's bounds). */
export const HANDOVER_DEFAULT_DAYS = 3;
export const HANDOVER_MAX_DAYS = 60;
export const USER_MESSAGES_MAX_LIMIT = 200;
/** `user_messages` arguments as the server's query string; throws on bad input. */
export function userMessagesQuery(args) {
    const params = new URLSearchParams();
    for (const key of ["since", "until", "cursor"])
        setString("user_messages", params, args, key, key);
    setString("user_messages", params, args, "query", "q");
    if (args.limit !== undefined && args.limit !== null) {
        const limit = integer(args.limit);
        if (limit === undefined || limit < 1) {
            throw new ToolInputError(`user_messages: limit must be 1 to ${USER_MESSAGES_MAX_LIMIT}`);
        }
        params.set("limit", String(Math.min(limit, USER_MESSAGES_MAX_LIMIT)));
    }
    for (const flag of ["full", "context"]) {
        if (args[flag] === undefined || args[flag] === null)
            continue;
        if (typeof args[flag] !== "boolean")
            throw new ToolInputError(`user_messages: ${flag} must be true or false`);
        if (args[flag])
            params.set(flag, "true");
    }
    return params;
}
/** `handover` arguments as the server's query string; throws on bad input. */
export function handoverQuery(args) {
    const params = new URLSearchParams();
    setString("handover", params, args, "since", "since");
    setString("handover", params, args, "until", "until");
    if (args.days !== undefined && args.days !== null) {
        const days = integer(args.days);
        if (days === undefined || days < 1 || days > HANDOVER_MAX_DAYS) {
            throw new ToolInputError(`handover: days must be 1 to ${HANDOVER_MAX_DAYS}`);
        }
        params.set("days", String(days));
    }
    return params;
}
/** The user_messages answer as text. */
export function formatUserMessages(body, args, tree) {
    const page = (body ?? {});
    const messages = Array.isArray(page.messages) ? page.messages : [];
    const where = windowText(page.window);
    if (!messages.length) {
        const none = `No messages from the person${where}${args.query ? ` with ${JSON.stringify(args.query)}` : ""}.`;
        const notes = pageNotes(page, args);
        return notes.length ? `${none}\n[${notes.join("; ")}]` : none;
    }
    const out = [
        `The person's own messages${where}: ${messages.length} of ${page.total ?? messages.length}, oldest first ` +
            "(typed, commands, words sent mid-turn, board messages; tool results and other agents' messages left out).",
    ];
    for (const m of messages)
        out.push("", ...messageLines(m));
    out.push("", ...footer(page, args, tree));
    return out.join("\n");
}
/** The handover pack as text: how it ended, the model's lists, then the messages. */
export function formatHandover(body, tree) {
    const pack = (body ?? {});
    const out = [
        `Handover pack${tree ? ` for ${tree}` : " for this session"}${windowText(pack.window)}.`,
    ];
    out.push(...endingLines(pack.ending));
    if (pack.llm === "ok") {
        out.push("", "Goals, instructions, decisions and open questions below are a model's reading of the " +
            "person's messages: check one against the messages it cites (n) before acting on it.");
        out.push(...listLines("Goals", pack.goals, (i) => i.text));
        out.push(...listLines("Standing instructions", pack.instructions, (i) => i.text));
        out.push(...listLines("Decisions (newest first)", pack.decisions, (i) => `${i.decision}${i.reason ? ` (why: ${i.reason})` : ""}`));
        out.push(...listLines("Open questions", pack.open_questions, (i) => `${i.question}${i.context ? ` (${i.context})` : ""}`));
    }
    else {
        out.push("", `(No model summary this time: ${llmNote(pack.llm)}. The messages below are the person's own words.)`);
    }
    const messages = Array.isArray(pack.messages) ? pack.messages : [];
    out.push("", `The person's messages in the window (${messages.length} of ${pack.messages_total ?? messages.length}, ` +
        "oldest first; each with the agent's words it answered):");
    for (const m of messages)
        out.push("", ...messageLines(m));
    const cursor = pack.messages_cursor;
    if (typeof cursor === "string" && cursor) {
        out.push("", `[older messages in the window: user_messages {${treeArg(tree)}"cursor": ${JSON.stringify(cursor)}${sinceArg(pack.window)}, "context": true}]`);
    }
    out.push("", readHint(tree));
    const newest = pack.newest?.note;
    if (newest)
        out.push(`(${newest})`);
    return out.join("\n");
}
// --- helpers -----------------------------------------------------------------
function setString(tool, params, args, key, param) {
    const value = args[key];
    if (value === undefined || value === null)
        return;
    if (typeof value !== "string")
        throw new ToolInputError(`${tool}: ${key} must be a string`);
    if (value.trim())
        params.set(param, value.trim());
}
/** An integer given as a number or a numeric string; undefined for anything else. */
function integer(value) {
    if (typeof value === "number")
        return Number.isInteger(value) ? value : undefined;
    if (typeof value === "string" && /^\s*-?\d+\s*$/.test(value))
        return Number(value);
    return undefined;
}
function messageLines(m) {
    const at = m.at ? formatTime(m.at) ?? m.at : m.approx ? `~${formatTime(m.approx[0]) ?? m.approx[0]}` : "time unknown";
    const board = m.board?.title ? ` (${m.board.title})` : "";
    const cut = m.shortened ? ` · shortened from ${m.chars ?? "?"} chars` : "";
    const head = `[n ${m.n} · ${at} · ${m.kind ?? "typed"}${board} · ${readRef(m.read)}${cut}]`;
    const lines = [head];
    if (m.reply_to)
        lines.push(`↳ answering: ${m.reply_to.replace(/\s+/g, " ").trim()}`);
    lines.push(m.text ?? "");
    return lines;
}
function readRef(read) {
    if (!read)
        return "?";
    if (typeof read.tail === "number")
        return `tail ${read.tail}`;
    const more = read.continues ? ` + block ${read.continues.block} lines ${read.continues.start}-${read.continues.end}` : "";
    return `block ${read.block} lines ${read.start}-${read.end}${more}`;
}
function footer(page, args, tree) {
    const notes = [];
    if (page.next_cursor) {
        const rest = ["since", "until", "query", "limit", "full", "context"]
            .filter((k) => args[k] !== undefined && args[k] !== null && args[k] !== "" && args[k] !== false)
            .map((k) => `, ${JSON.stringify(k)}: ${JSON.stringify(args[k])}`).join("");
        notes.push(`older: user_messages {${treeArg(tree)}"cursor": ${JSON.stringify(page.next_cursor)}${rest}}`);
    }
    notes.push(...pageNotes(page, args));
    const out = notes.length ? [`[${notes.join("; ")}]`] : [];
    out.push(readHint(tree));
    return out;
}
function pageNotes(page, _args) {
    const notes = [];
    if (page.untimed)
        notes.push(`${page.untimed} older message(s) have no recorded time and are only listed without since/until`);
    if (page.newest?.note)
        notes.push(page.newest.note);
    return notes;
}
function readHint(tree) {
    return `Context of one message: read_lines {${treeArg(tree)}"block": B, "start": S, "end": E} for "block B lines S-E", ` +
        `read_lines {${treeArg(tree)}"tail": true, "start": N, "end": N} for "tail N".`;
}
function endingLines(ending) {
    if (!ending || typeof ending !== "object" || !Object.keys(ending).length)
        return [];
    const at = typeof ending.at === "string" ? ` (newest message ${formatTime(ending.at) ?? ending.at})` : "";
    const out = ["", `How it ended${at}:`];
    if (typeof ending.summary === "string")
        out.push(ending.summary);
    const last = ending.last_message;
    if (last?.text) {
        const when = last.at ? ` at ${formatTime(last.at) ?? last.at}` : "";
        out.push(`The person's last message (n ${last.n}${when}): ${last.text}`);
    }
    if (Array.isArray(ending.tools_after) && ending.tools_after.length) {
        out.push(`Then the agent ran: ${countRuns(ending.tools_after)}`);
    }
    if (typeof ending.last_words === "string")
        out.push(`The agent's last words: ${ending.last_words}`);
    return out;
}
function countRuns(tools) {
    const runs = [];
    for (let i = 0; i < tools.length;) {
        let j = i;
        while (j < tools.length && tools[j] === tools[i])
            j++;
        runs.push(j - i > 1 ? `${tools[i]} ×${j - i}` : tools[i]);
        i = j;
    }
    return runs.join(", ");
}
function listLines(title, raw, text) {
    const items = Array.isArray(raw) ? raw : [];
    if (!items.length)
        return ["", `${title}: none found.`];
    const out = ["", `${title}:`];
    for (const item of items) {
        const refs = Array.isArray(item.refs) && item.refs.length ? ` (n ${item.refs.join(", ")})` : "";
        out.push(`- ${text(item) ?? ""}${refs}`);
    }
    return out;
}
function llmNote(status) {
    switch (status) {
        case "off": return "the summary is switched off on this server";
        case "rate_limited": return "too many packs this hour; try again later";
        default: return "the summary model failed; try again in a minute";
    }
}
function windowText(window) {
    if (!window || (!window.since && !window.until))
        return "";
    const from = window.since ? formatTime(window.since) ?? window.since : "the start";
    const to = window.until ? formatTime(window.until) ?? window.until : "now";
    return ` from ${from} to ${to}`;
}
function sinceArg(window) {
    const w = window;
    return [w?.since ? `, "since": ${JSON.stringify(w.since)}` : "", w?.until ? `, "until": ${JSON.stringify(w.until)}` : ""].join("");
}
function treeArg(tree) {
    return tree ? `"tree": ${JSON.stringify(tree)}, ` : "";
}
//# sourceMappingURL=memtree-handover.js.map