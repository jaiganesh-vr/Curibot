import { cleanup, render, screen, waitFor, within } from "@testing-library/react";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import "@testing-library/jest-dom/vitest";
import userEvent from "@testing-library/user-event";
import {
    createConversation,
    getMe,
    listConversations,
    listMessages,
    login,
    register,
    sendMessage,
} from "./api/client";
import App from "./App";

vi.mock("./api/client", () => ({
    ApiError: class ApiError extends Error {
        status: number;

        constructor(message: string, status: number) {
            super(message);
            this.status = status;
        }
    },
    createConversation: vi.fn(),
    getMe: vi.fn(),
    listConversations: vi.fn(),
    listMessages: vi.fn(),
    login: vi.fn(),
    register: vi.fn(),
    sendMessage: vi.fn(),
}));

describe("App authentication screen", () => {
    beforeEach(() => {
        sessionStorage.clear();
    });

    afterEach(() => {
        cleanup();
        vi.clearAllMocks();
    });

    it("renders the sign-in screen when no session token exists", () => {
        render(<App />);

        expect(
            screen.getByRole("heading", { name: "Welcome back" }),
        ).toBeTruthy();

        expect(
            screen.getByRole("textbox", { name: "Email address" }),
        ).toBeTruthy();

        expect(
            screen.getByLabelText("Password").getAttribute("type"),
        ).toBe("password");

        const submitButton = document.querySelector(
            ".auth-form button[type='submit']",
        );

        expect(submitButton).toBeTruthy();
        expect(submitButton?.textContent?.trim()).toBe("Sign in");

        expect(
            screen.getByRole("button", { name: "Register" }),
        ).toBeTruthy();
    });

    it("switches to registration mode when Register is clicked", async () => {
        const user = userEvent.setup();

        render(<App />);

        await user.click(screen.getByRole("button", { name: "Register" }));

        expect(
            screen.getByRole("heading", { name: "Create your account" }),
        ).toBeTruthy();

        expect(
            screen.getByText("Create an account to get started."),
        ).toBeTruthy();

        expect(
            screen.getByRole("button", { name: "Create account" }),
        ).toBeTruthy();
    });

    it("logs in and opens the authenticated workspace", async () => {
        const user = userEvent.setup();

        vi.mocked(login).mockResolvedValue({
            access_token: "test-access-token",
            token_type: "bearer",
        });

        vi.mocked(getMe).mockResolvedValue({
            id: "user-1",
            email: "jaiganesh@example.com",
            is_active: true,
            created_at: "2026-01-01T00:00:00Z",
        });

        vi.mocked(listConversations).mockResolvedValue([]);

        render(<App />);

        await user.type(
            screen.getByRole("textbox", { name: "Email address" }),
            "  jaiganesh@example.com  ",
        );

        await user.type(
            screen.getByLabelText("Password"),
            "test-password",
        );

        const emailInput = screen.getByRole("textbox", {
            name: "Email address",
        });
        const form = emailInput.closest("form");

        expect(form).toBeTruthy();

        await user.click(
            within(form as HTMLFormElement).getByRole("button", {
                name: "Sign in",
            }),
        );

        await waitFor(() => {
            expect(login).toHaveBeenCalledWith(
                "jaiganesh@example.com",
                "test-password",
            );
        });

        expect(getMe).toHaveBeenCalledWith("test-access-token");

        expect(sessionStorage.getItem("access_token")).toBe(
            "test-access-token",
        );

        expect(
            await screen.findByText("No conversations yet. Start a new chat to begin."),
        ).toBeTruthy();
    });

    it("registers an account and returns to sign-in mode", async () => {
        const user = userEvent.setup();

        vi.mocked(register).mockResolvedValue({
            id: "user-2",
            email: "newuser@example.com",
            is_active: true,
            created_at: "2026-01-01T00:00:00Z",
        });

        render(<App />);

        await user.click(screen.getByRole("button", { name: "Register" }));

        await user.type(
            screen.getByRole("textbox", { name: "Email address" }),
            "newuser@example.com",
        );

        await user.type(
            screen.getByLabelText("Password"),
            "a-secure-test-password",
        );

        await user.click(
            screen.getByRole("button", { name: "Create account" }),
        );

        await waitFor(() => {
            expect(register).toHaveBeenCalledWith(
                "newuser@example.com",
                "a-secure-test-password",
            );
        });

        expect(
            await screen.findByRole("status"),
        ).toHaveTextContent("Account created. Please sign in.");

        expect(
            screen.getByRole("heading", { name: "Welcome back" }),
        ).toBeTruthy();

        expect(sessionStorage.getItem("access_token")).toBeNull();
    });

    it("restores the authenticated session when a token exists", async () => {
        sessionStorage.setItem("access_token", "existing-access-token");

        vi.mocked(getMe).mockResolvedValue({
            id: "user-1",
            email: "jaiganesh@example.com",
            is_active: true,
            created_at: "2026-01-01T00:00:00Z",
        });

        vi.mocked(listConversations).mockResolvedValue([]);

        render(<App />);

        await waitFor(() => {
            expect(getMe).toHaveBeenCalledWith("existing-access-token");
        });

        expect(
            await screen.findByText(
                "No conversations yet. Start a new chat to begin.",
            ),
        ).toBeTruthy();

        expect(
            screen.getByText("jaiganesh@example.com"),
        ).toBeTruthy();

        expect(sessionStorage.getItem("access_token")).toBe(
            "existing-access-token",
        );
    });

    it("clears an invalid session token and shows the sign-in screen", async () => {
        sessionStorage.setItem("access_token", "invalid-access-token");

        vi.mocked(getMe).mockRejectedValue(new Error("Unauthorized"));

        render(<App />);

        await waitFor(() => {
            expect(getMe).toHaveBeenCalledWith("invalid-access-token");
        });

        expect(
            await screen.findByRole("heading", { name: "Welcome back" }),
        ).toBeTruthy();

        await waitFor(() => {
            expect(sessionStorage.getItem("access_token")).toBeNull();
        });

        expect(
            screen.getByRole("textbox", { name: "Email address" }),
        ).toBeTruthy();
    });

    it("logs out and clears the stored session token", async () => {
        const user = userEvent.setup();

        sessionStorage.setItem("access_token", "existing-access-token");

        vi.mocked(getMe).mockResolvedValue({
            id: "user-1",
            email: "jaiganesh@example.com",
            is_active: true,
            created_at: "2026-01-01T00:00:00Z",
        });

        vi.mocked(listConversations).mockResolvedValue([]);

        render(<App />);

        await user.click(
            await screen.findByRole("button", { name: "Log out" }),
        );

        expect(sessionStorage.getItem("access_token")).toBeNull();

        expect(
            screen.getByRole("heading", { name: "Welcome back" }),
        ).toBeTruthy();

        expect(
            screen.getByRole("textbox", { name: "Email address" }),
        ).toBeTruthy();
    });
    it("creates and selects a new conversation", async () => {
        const user = userEvent.setup();

        sessionStorage.setItem("access_token", "test-access-token");

        vi.mocked(getMe).mockResolvedValue({
            id: "user-1",
            email: "jaiganesh@example.com",
            is_active: true,
            created_at: "2026-01-01T00:00:00Z",
        });

        vi.mocked(listConversations).mockResolvedValue([]);

        vi.mocked(createConversation).mockResolvedValue({
            id: "conversation-1",
            title: "New conversation",
            created_at: "2026-01-01T00:00:00Z",
            updated_at: "2026-01-01T00:00:00Z",
        });

        vi.mocked(listMessages).mockResolvedValue([]);

        render(<App />);

        await user.click(
            await screen.findByRole("button", { name: "New Chat" }),
        );

        await waitFor(() => {
            expect(createConversation).toHaveBeenCalledWith(
                "test-access-token",
            );
        });

        expect(
            await screen.findByRole("button", {
                name: "New conversation",
            }),
        ).toHaveAttribute("aria-current", "page");

        expect(
            await screen.findByRole("textbox", { name: "Message" }),
        ).toBeTruthy();

        expect(listMessages).toHaveBeenCalledWith(
            "test-access-token",
            "conversation-1",
        );
    });
    it("sends a message and displays the user and assistant responses", async () => {
        const user = userEvent.setup();

        sessionStorage.setItem("access_token", "test-access-token");

        vi.mocked(getMe).mockResolvedValue({
            id: "user-1",
            email: "jaiganesh@example.com",
            is_active: true,
            created_at: "2026-01-01T00:00:00Z",
        });

        vi.mocked(listConversations).mockResolvedValue([
            {
                id: "conversation-1",
                title: "Test conversation",
                created_at: "2026-01-01T00:00:00Z",
                updated_at: "2026-01-01T00:00:00Z",
            },
        ]);

        vi.mocked(listMessages).mockResolvedValue([]);

        vi.mocked(sendMessage).mockResolvedValue({
            user_message: {
                id: "message-1",
                conversation_id: "conversation-1",
                role: "user",
                content: "Explain LangGraph",
                created_at: "2026-01-01T00:01:00Z",
            },
            assistant_message: {
                id: "message-2",
                conversation_id: "conversation-1",
                role: "assistant",
                content: "LangGraph helps build stateful agent workflows.",
                created_at: "2026-01-01T00:01:01Z",
            },
        });

        render(<App />);

        await user.click(
            await screen.findByRole("button", {
                name: "Test conversation",
            }),
        );

        const messageInput = await screen.findByRole("textbox", {
            name: "Message",
        });

        await user.type(messageInput, "Explain LangGraph");

        await user.click(screen.getByRole("button", { name: "Send message" }));

        await waitFor(() => {
            expect(sendMessage).toHaveBeenCalledWith(
                "test-access-token",
                "conversation-1",
                "Explain LangGraph",
            );
        });

        expect(await screen.findByText("LangGraph helps build stateful agent workflows.")).toBeTruthy();

        expect(screen.getByText("Explain LangGraph")).toBeTruthy();
    });

    it("restores the message and displays an error when sending fails", async () => {
        const user = userEvent.setup();

        sessionStorage.setItem("access_token", "test-access-token");

        vi.mocked(getMe).mockResolvedValue({
            id: "user-1",
            email: "jaiganesh@example.com",
            is_active: true,
            created_at: "2026-01-01T00:00:00Z",
        });

        vi.mocked(listConversations).mockResolvedValue([
            {
                id: "conversation-1",
                title: "Test conversation",
                created_at: "2026-01-01T00:00:00Z",
                updated_at: "2026-01-01T00:00:00Z",
            },
        ]);

        vi.mocked(listMessages).mockResolvedValue([]);

        vi.mocked(sendMessage).mockRejectedValue(
            new Error("Network unavailable"),
        );

        render(<App />);

        await user.click(
            await screen.findByRole("button", {
                name: "Test conversation",
            }),
        );

        const messageInput = await screen.findByRole("textbox", {
            name: "Message",
        });

        await user.type(messageInput, "Please explain state persistence");

        await user.click(
            screen.getByRole("button", { name: "Send message" }),
        );

        expect(
            await screen.findByRole("alert"),
        ).toHaveTextContent("Unable to send your message. Please try again.");

        await waitFor(() => {
            expect(messageInput).toHaveValue(
                "Please explain state persistence",
            );
        });

        expect(sendMessage).toHaveBeenCalledWith(
            "test-access-token",
            "conversation-1",
            "Please explain state persistence",
        );
    });

    it("displays an error when conversations fail to load", async () => {
        sessionStorage.setItem("access_token", "test-access-token");

        vi.mocked(getMe).mockResolvedValue({
            id: "user-1",
            email: "jaiganesh@example.com",
            is_active: true,
            created_at: "2026-01-01T00:00:00Z",
        });

        vi.mocked(listConversations).mockRejectedValue(
            new Error("Network unavailable"),
        );

        render(<App />);

        expect(
            await screen.findByRole("alert"),
        ).toHaveTextContent("Unable to load your conversations.");
    });
});

