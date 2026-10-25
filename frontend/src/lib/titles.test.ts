import { describe, expect, it } from "vitest";
import { deriveTitle } from "./titles";

// The same cases as test_derive_title in the backend, so the title shown
// immediately always matches the one the server saves.
describe("deriveTitle", () => {
    it.each([
        ["Hello", "Hello"],
        ["  Plan a   trip\nto Japan\t", "Plan a trip to Japan"],
        ["x".repeat(80), "x".repeat(49) + "…"],
        [
            "Can you explain how transformers work in large language models?",
            "Can you explain how transformers work in large…",
        ],
        [
            "Compare Python, JavaScript, and Rust for building a web backend",
            "Compare Python, JavaScript, and Rust for…",
        ],
        ["a".repeat(50), "a".repeat(50)],
        ["   \n\t ", null],
    ])("derives %j as %j", (content, expected) => {
        expect(deriveTitle(content)).toBe(expected);
    });
});
