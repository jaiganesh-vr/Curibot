import { afterEach, describe, expect, it, vi } from "vitest";
import { ApiError, streamMessage } from "./client";

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
