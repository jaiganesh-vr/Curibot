import { act, cleanup, render } from "@testing-library/react";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import "@testing-library/jest-dom/vitest";
import StreamingReply from "./StreamingReply";

const LONG_REPLY = Array.from({ length: 40 }, (_, i) => `word${i}`).join(" ");

// Each frame needs its own act() so React renders and schedules the next one.
function advanceFrames(count: number) {
    for (let frame = 0; frame < count; frame += 1) {
        act(() => {
            vi.advanceTimersToNextFrame();
        });
    }
}

function visibleText(container: HTMLElement): string {
    return container.querySelector(".message-markdown")?.textContent ?? "";
}

describe("StreamingReply", () => {
    beforeEach(() => {
        vi.useFakeTimers({
            toFake: ["requestAnimationFrame", "cancelAnimationFrame"],
        });
    });

    afterEach(() => {
        cleanup();
        vi.useRealTimers();
        vi.unstubAllGlobals();
    });

    it("shows Thinking before any text arrives", () => {
        const { getByText } = render(
            <StreamingReply
                text=""
                complete={false}
                onRevealed={() => {}}
                onGrow={() => {}}
            />,
        );

        expect(getByText("Thinking...")).toBeTruthy();
    });

    it("reveals a burst of text gradually, ending on word boundaries", () => {
        const { container } = render(
            <StreamingReply
                text={LONG_REPLY}
                complete={false}
                onRevealed={() => {}}
                onGrow={() => {}}
            />,
        );

        advanceFrames(1);

        const afterOneFrame = visibleText(container);
        expect(afterOneFrame.length).toBeGreaterThan(0);
        expect(afterOneFrame.length).toBeLessThan(LONG_REPLY.length);
        expect(LONG_REPLY.startsWith(afterOneFrame)).toBe(true);
        expect(LONG_REPLY[afterOneFrame.length]).toBe(" ");

        advanceFrames(200);

        expect(visibleText(container)).toBe(LONG_REPLY);
    });

    it("calls onRevealed once, only after the complete reply is shown", () => {
        const onRevealed = vi.fn();
        const { rerender } = render(
            <StreamingReply
                text={LONG_REPLY}
                complete={false}
                onRevealed={onRevealed}
                onGrow={() => {}}
            />,
        );

        advanceFrames(200);
        expect(onRevealed).not.toHaveBeenCalled();

        rerender(
            <StreamingReply
                text={LONG_REPLY}
                complete
                onRevealed={onRevealed}
                onGrow={() => {}}
            />,
        );
        rerender(
            <StreamingReply
                text={LONG_REPLY}
                complete
                onRevealed={onRevealed}
                onGrow={() => {}}
            />,
        );

        expect(onRevealed).toHaveBeenCalledTimes(1);
    });

    it("shows text immediately when the user prefers reduced motion", () => {
        vi.stubGlobal(
            "matchMedia",
            vi.fn().mockReturnValue({ matches: true }),
        );

        const { container } = render(
            <StreamingReply
                text={LONG_REPLY}
                complete={false}
                onRevealed={() => {}}
                onGrow={() => {}}
            />,
        );

        expect(visibleText(container)).toBe(LONG_REPLY);
    });
});
