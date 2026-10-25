import { afterEach, describe, expect, it, vi } from "vitest";
import { ApiError, checkHealth, streamMessage } from "./client";

function sseResponse(chunks: string[], status = 200): Response {
    const encoder = new TextEncoder();
    const body = new ReadableStream<Uint8Array>({
        start(controller) {
            for (const chunk of chunks) {
                controller.enqueue(encoder.encode(chunk));
            }
            controller.close();
        },
    });

    return new Response(body, {
        status,
        headers: { "Content-Type": "text/event-stream" },
    });
}

const turn = {
    user_message: {
        id: "m1",
        conversation_id: "c1",
        role: "user",
        content: "Hi",
        created_at: "2026-01-01T00:00:00Z",
    },
    assistant_message: {
        id: "m2",
        conversation_id: "c1",
        role: "assistant",
        content: "Hello there",
        created_at: "2026-01-01T00:00:01Z",
    },
};

describe("streamMessage", () => {
    afterEach(() => {
        vi.unstubAllGlobals();
    });

    it("emits tokens across split chunks and resolves with the saved turn", async () => {
        const done = `event: done\ndata: ${JSON.stringify(turn)}\n\n`;

        vi.stubGlobal(
            "fetch",
            vi.fn().mockResolvedValue(
                sseResponse([
                    'event: token\ndata: {"text": "Hel',
                    'lo"}\n\nevent: token\ndata: {"text": " there"}\n',
                    "\n",
                    done.slice(0, 20),
                    done.slice(20),
                ]),
            ),
        );

        const tokens: string[] = [];
        const result = await streamMessage("token-1", "c1", "Hi", (text) =>
            tokens.push(text),
        );

        expect(tokens).toEqual(["Hello", " there"]);
        expect(result).toEqual(turn);
        expect(fetch).toHaveBeenCalledWith(
            expect.stringMatching(/\/conversations\/c1\/messages\/stream$/),
            expect.objectContaining({
                method: "POST",
                body: JSON.stringify({ content: "Hi" }),
            }),
        );
    });

    it("reports tool calls and keeps streaming until done", async () => {
        const done = `event: done\ndata: ${JSON.stringify(turn)}\n\n`;

        vi.stubGlobal(
            "fetch",
            vi.fn().mockResolvedValue(
                sseResponse([
                    'event: token\ndata: {"text": "Let me check."}\n\n',
                    'event: tool\ndata: {"name": "web_search", "query": "news"}\n\n',
                    'event: token\ndata: {"text": "Hello there"}\n\n',
                    done,
                ]),
            ),
        );

        const events: string[] = [];
        const result = await streamMessage(
            "token-1",
            "c1",
            "Hi",
            (text) => events.push(`token:${text}`),
            (call) => events.push(`tool:${call.name}:${call.query}`),
        );

        expect(events).toEqual([
            "token:Let me check.",
            "tool:web_search:news",
            "token:Hello there",
        ]);
        expect(result).toEqual(turn);
    });

    it("rejects with the detail from an error event", async () => {
        vi.stubGlobal(
            "fetch",
            vi.fn().mockResolvedValue(
                sseResponse([
                    'event: token\ndata: {"text": "Partial"}\n\n',
                    'event: error\ndata: {"detail": "Model unavailable"}\n\n',
                ]),
            ),
        );

        await expect(
            streamMessage("token-1", "c1", "Hi", () => {}),
        ).rejects.toEqual(new ApiError("Model unavailable", 502));
    });

    it("rejects when the stream ends without a done event", async () => {
        vi.stubGlobal(
            "fetch",
            vi.fn().mockResolvedValue(
                sseResponse(['event: token\ndata: {"text": "Cut off"}\n\n']),
            ),
        );

        await expect(
            streamMessage("token-1", "c1", "Hi", () => {}),
        ).rejects.toThrow("The response ended unexpectedly.");
    });

    it("rejects with the HTTP error detail before streaming starts", async () => {
        vi.stubGlobal(
            "fetch",
            vi.fn().mockResolvedValue(
                new Response(JSON.stringify({ detail: "Conversation not found." }), {
                    status: 404,
                    headers: { "Content-Type": "application/json" },
                }),
            ),
        );

        await expect(
            streamMessage("token-1", "c1", "Hi", () => {}),
        ).rejects.toMatchObject({
            message: "Conversation not found.",
            status: 404,
        });
    });
});

describe("checkHealth", () => {
    afterEach(() => {
        vi.unstubAllGlobals();
    });

    it("calls the root readiness endpoint, outside /api/v1", async () => {
        vi.stubGlobal(
            "fetch",
            vi.fn().mockResolvedValue(new Response("{}", { status: 200 })),
        );

        await checkHealth();

        expect(fetch).toHaveBeenCalledWith(
            expect.stringMatching(/:\/\/[^/]+\/health\/ready$/),
            expect.objectContaining({ cache: "no-store" }),
        );
    });

    it.each([
        [200, "online"],
        [503, "degraded"],
        [500, "degraded"],
    ])("maps HTTP %i to %s", async (status, expected) => {
        vi.stubGlobal(
            "fetch",
            vi.fn().mockResolvedValue(new Response("{}", { status })),
        );

        await expect(checkHealth()).resolves.toBe(expected);
    });

    it("reports offline when the request fails", async () => {
        vi.stubGlobal(
            "fetch",
            vi.fn().mockRejectedValue(new TypeError("Failed to fetch")),
        );

        await expect(checkHealth()).resolves.toBe("offline");
    });
});

