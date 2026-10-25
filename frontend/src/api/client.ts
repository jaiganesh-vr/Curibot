
const API_BASE_URL = (
    import.meta.env.VITE_API_BASE_URL ??
    "http://localhost:8000/api/v1"
).replace(/\/+$/, "");

// Health endpoints live at the server root, outside the /api/v1 prefix.
const HEALTH_URL = `${API_BASE_URL.replace(/\/api\/v1$/, "")}/health/ready`;
const HEALTH_TIMEOUT_MS = 5000;

export type HealthStatus = "online" | "degraded" | "offline";

export interface TokenResponse {
    access_token: string;
    token_type: "bearer";
}

export interface User {
    id: string;
    email: string;
    is_active: boolean;
    created_at: string;
}

export interface Conversation {
    id: string;
    title: string | null;
    created_at: string;
    updated_at: string;
}

export interface Message {
    id: string;
    conversation_id: string;
    role: string;
    content: string;
    created_at: string;
}

// A tool the assistant ran mid-reply, e.g. a web search.
export interface ToolCall {
    name: string;
    query: string;
}

export interface ChatTurn {
    user_message: Message;
    assistant_message: Message;
}

export class ApiError extends Error {
    public readonly status: number;

    constructor(message: string, status: number) {
        super(message);
        this.name = "ApiError";
        this.status = status;
    }
}

async function toApiError(response: Response): Promise<ApiError> {
    let message = `Request failed (${response.status})`;

    try {
        const body: { detail?: unknown } = await response.json();

        if (typeof body.detail === "string") {
            message = body.detail;
        } else if (body.detail !== undefined) {
            message = JSON.stringify(body.detail);
        }
    } catch {
        // Keep the default message if the response isn't JSON.
    }

    return new ApiError(message, response.status);
}

async function request<T>(
    path: string,
    options: RequestInit = {},
    token?: string,
): Promise<T> {
    const headers = new Headers(options.headers);

    headers.set("Accept", "application/json");

    if (options.body !== undefined) {
        headers.set("Content-Type", "application/json");
    }

    if (token) {
        headers.set("Authorization", `Bearer ${token}`);
    }

    const response = await fetch(`${API_BASE_URL}${path}`, {
        ...options,
        headers,
    });

    if (!response.ok) {
        throw await toApiError(response);
    }

    if (response.status === 204) {
        return undefined as T;
    }

    return (await response.json()) as T;
}

function post<T>(
    path: string,
    body: unknown,
    token?: string,
): Promise<T> {
    return request<T>(
        path,
        {
            method: "POST",
            body: JSON.stringify(body),
        },
        token,
    );
}

export function register(
    email: string,
    password: string,
): Promise<User> {
    return post<User>("/auth/register", { email, password });
}

export function login(
    email: string,
    password: string,
): Promise<TokenResponse> {
    return post<TokenResponse>("/auth/login", { email, password });
}

export function getMe(token: string): Promise<User> {
    return request<User>("/auth/me", {}, token);
}

export function createConversation(
    token: string,
    title?: string,
): Promise<Conversation> {
    return post<Conversation>(
        "/conversations",
        { title: title ?? null },
        token,
    );
}

export function listConversations(
    token: string,
): Promise<Conversation[]> {
    return request<Conversation[]>("/conversations", {}, token);
}

export function renameConversation(
    token: string,
    conversationId: string,
    title: string,
): Promise<Conversation> {
    return request<Conversation>(
        `/conversations/${encodeURIComponent(conversationId)}`,
        {
            method: "PATCH",
            body: JSON.stringify({ title }),
        },
        token,
    );
}

export function deleteConversation(
    token: string,
    conversationId: string,
): Promise<void> {
    return request<void>(
        `/conversations/${encodeURIComponent(conversationId)}`,
        { method: "DELETE" },
        token,
    );
}

// A lasting fact the assistant remembers about the user.
export interface Memory {
    id: string;
    content: string;
    created_at: string;
}

export function listMemories(token: string): Promise<Memory[]> {
    return request<Memory[]>("/memories", {}, token);
}

export function deleteMemory(token: string, memoryId: string): Promise<void> {
    return request<void>(
        `/memories/${encodeURIComponent(memoryId)}`,
        { method: "DELETE" },
        token,
    );
}

export function clearMemories(token: string): Promise<void> {
    return request<void>("/memories", { method: "DELETE" }, token);
}

export function sendMessage(
    token: string,
    conversationId: string,
    content: string,
): Promise<ChatTurn> {
    return post<ChatTurn>(
        `/conversations/${encodeURIComponent(conversationId)}/messages`,
        { content },
        token,
    );
}

export function listMessages(
    token: string,
    conversationId: string,
): Promise<Message[]> {
    return request<Message[]>(
        `/conversations/${encodeURIComponent(conversationId)}/messages`,
        {},
        token,
    );
}

/**
 * Send a message and stream the assistant reply.
 *
 * The backend responds with Server-Sent Events: "token" events carry pieces
 * of the reply, "tool" events report a tool the assistant is running (text
 * streamed before one is not part of the answer), then "done" carries the
 * saved turn or "error" a failure.
 * EventSource cannot POST or send an Authorization header, so the stream is
 * read and parsed from fetch directly.
 */
export async function streamMessage(
    token: string,
    conversationId: string,
    content: string,
    onToken: (text: string) => void,
    onToolCall?: (call: ToolCall) => void,
): Promise<ChatTurn> {
    const response = await fetch(
        `${API_BASE_URL}/conversations/${encodeURIComponent(conversationId)}/messages/stream`,
        {
            method: "POST",
            headers: {
                Accept: "text/event-stream",
                "Content-Type": "application/json",
                Authorization: `Bearer ${token}`,
            },
            body: JSON.stringify({ content }),
        },
    );

    if (!response.ok) {
        throw await toApiError(response);
    }

    if (!response.body) {
        throw new ApiError("Streaming is not supported by this browser.", 0);
    }

    const reader = response.body.getReader();
    const decoder = new TextDecoder();
    let buffer = "";

    for (;;) {
        const { done, value } = await reader.read();
        buffer += decoder.decode(value, { stream: !done });

        // Events are separated by a blank line; keep any partial event.
        const events = buffer.split("\n\n");
        buffer = done ? "" : (events.pop() ?? "");

        for (const rawEvent of events) {
            let eventName = "message";
            let data = "";

            for (const line of rawEvent.split("\n")) {
                if (line.startsWith("event: ")) {
                    eventName = line.slice("event: ".length);
                } else if (line.startsWith("data: ")) {
                    data += line.slice("data: ".length);
                }
            }

            if (!data) {
                continue;
            }

            const payload: unknown = JSON.parse(data);

            if (eventName === "token") {
                onToken((payload as { text: string }).text);
            } else if (eventName === "tool") {
                onToolCall?.(payload as ToolCall);
            } else if (eventName === "done") {
                await reader.cancel();
                return payload as ChatTurn;
            } else if (eventName === "error") {
                await reader.cancel();
                throw new ApiError((payload as { detail: string }).detail, 502);
            }
        }

        if (done) {
            throw new ApiError("The response ended unexpectedly.", 502);
        }
    }
}

/**
 * Check whether the API and its database are reachable.
 *
 * "degraded" means the API answered but reported a problem (the readiness
 * check returns 503 when the database is down); "offline" means no answer.
 */
export async function checkHealth(): Promise<HealthStatus> {
    try {
        const response = await fetch(HEALTH_URL, {
            cache: "no-store",
            signal: AbortSignal.timeout(HEALTH_TIMEOUT_MS),
        });

        return response.ok ? "online" : "degraded";
    } catch {
        return "offline";
    }
}
