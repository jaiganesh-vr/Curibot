
const API_BASE_URL = (
    import.meta.env.VITE_API_BASE_URL ??
    "http://localhost:8000/api/v1"
).replace(/\/+$/, "");

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

        throw new ApiError(message, response.status);
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
