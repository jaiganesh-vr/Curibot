import {
    cleanup,
    fireEvent,
    render,
    screen,
    waitFor,
    within,
} from "@testing-library/react";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import "@testing-library/jest-dom/vitest";
import { ApiError } from "./api/client";
import userEvent from "@testing-library/user-event";
import {
    checkHealth,
    createConversation,
    deleteConversation,
    getMe,
    listConversations,
    listMessages,
    login,
    register,
    renameConversation,
    streamMessage,
    type ChatTurn,
    type Conversation,
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
    // Tests must never reach a real backend for the health indicator.
    checkHealth: vi.fn(async () => "online"),
    createConversation: vi.fn(),
    deleteConversation: vi.fn(),
    getMe: vi.fn(),
    listConversations: vi.fn(),
    listMessages: vi.fn(),
    login: vi.fn(),
    register: vi.fn(),
    renameConversation: vi.fn(),
    streamMessage: vi.fn(),
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

        vi.mocked(getMe).mockRejectedValue(
            new ApiError("Unauthorized", 401),
        );

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


    it("preserves the session token when session verification fails with a server error", async () => {
        sessionStorage.setItem("access_token", "existing-access-token");

        vi.mocked(getMe).mockRejectedValue(
            new ApiError("Server error", 500),
        );

        render(<App />);

        await waitFor(() => {
            expect(getMe).toHaveBeenCalledWith("existing-access-token");
        });

        expect(
            await screen.findByText(
                "Unable to verify your session. Check your connection and try again.",
            ),
        ).toBeTruthy();

        expect(sessionStorage.getItem("access_token")).toBe(
            "existing-access-token",
        );
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
            await screen.findByRole("button", { name: "New chat" }),
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

        const savedTurn: ChatTurn = {
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
        };

        // Hold the stream open so the partial reply can be observed.
        let finishStream: () => void = () => {};

        vi.mocked(streamMessage).mockImplementation(
            async (_token, _conversationId, _content, onToken) => {
                onToken("LangGraph helps ");
                await new Promise<void>((resolve) => {
                    finishStream = resolve;
                });
                onToken("build stateful agent workflows.");
                return savedTurn;
            },
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

        await user.type(messageInput, "Explain LangGraph");

        await user.click(screen.getByRole("button", { name: "Send message" }));

        await waitFor(() => {
            expect(streamMessage).toHaveBeenCalledWith(
                "test-access-token",
                "conversation-1",
                "Explain LangGraph",
                expect.any(Function),
                expect.any(Function),
            );
        });

        // The user message and the partial reply show before the stream ends.
        expect(await screen.findByText("LangGraph helps")).toBeTruthy();
        expect(screen.getByText("Explain LangGraph")).toBeTruthy();
        expect(document.querySelector(".message-streaming")).toBeTruthy();

        finishStream();

        expect(
            await screen.findByText(
                "LangGraph helps build stateful agent workflows.",
            ),
        ).toBeTruthy();
        // The saved turn replaces the streaming one once it is fully revealed.
        await waitFor(() => {
            expect(document.querySelector(".message-streaming")).toBeNull();
        });
        expect(screen.getAllByText("Explain LangGraph")).toHaveLength(1);
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

        vi.mocked(streamMessage).mockRejectedValue(
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

        expect(streamMessage).toHaveBeenCalledWith(
            "test-access-token",
            "conversation-1",
            "Please explain state persistence",
            expect.any(Function),
            expect.any(Function),
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

describe("Conversation options menu", () => {
    const conversation: Conversation = {
        id: "conversation-1",
        title: "Test conversation",
        created_at: "2026-01-01T00:00:00Z",
        updated_at: "2026-01-01T00:00:00Z",
    };

    function renderWorkspace(conversations = [conversation]) {
        sessionStorage.setItem("access_token", "test-access-token");

        vi.mocked(getMe).mockResolvedValue({
            id: "user-1",
            email: "jaiganesh@example.com",
            is_active: true,
            created_at: "2026-01-01T00:00:00Z",
        });
        vi.mocked(listConversations).mockResolvedValue(conversations);
        vi.mocked(listMessages).mockResolvedValue([]);

        render(<App />);
    }

    async function openMenu(user: ReturnType<typeof userEvent.setup>) {
        await user.click(
            await screen.findByRole("button", {
                name: "Options for Test conversation",
            }),
        );
    }

    beforeEach(() => {
        sessionStorage.clear();
    });

    afterEach(() => {
        cleanup();
        vi.clearAllMocks();
    });

    it("opens the menu and closes it on Escape or an outside click", async () => {
        const user = userEvent.setup();

        renderWorkspace();

        await openMenu(user);

        expect(screen.getByRole("menu")).toBeTruthy();
        expect(
            screen.getByRole("button", {
                name: "Options for Test conversation",
            }),
        ).toHaveAttribute("aria-expanded", "true");

        await user.keyboard("{Escape}");
        expect(screen.queryByRole("menu")).toBeNull();

        await openMenu(user);
        await user.click(document.body);
        expect(screen.queryByRole("menu")).toBeNull();
    });

    it("renames a conversation when Enter is pressed", async () => {
        const user = userEvent.setup();

        vi.mocked(renameConversation).mockResolvedValue({
            ...conversation,
            title: "Trip ideas",
        });

        renderWorkspace();

        await openMenu(user);
        await user.click(screen.getByRole("menuitem", { name: "Rename" }));

        const titleInput = screen.getByRole("textbox", {
            name: "Conversation title",
        });

        expect(titleInput).toHaveValue("Test conversation");

        await user.clear(titleInput);
        await user.type(titleInput, "  Trip ideas  {Enter}");

        await waitFor(() => {
            expect(renameConversation).toHaveBeenCalledWith(
                "test-access-token",
                "conversation-1",
                "Trip ideas",
            );
        });

        expect(renameConversation).toHaveBeenCalledTimes(1);
        expect(
            await screen.findByRole("button", { name: "Trip ideas" }),
        ).toBeTruthy();
        expect(
            screen.queryByRole("textbox", { name: "Conversation title" }),
        ).toBeNull();
    });

    it("cancels a rename on Escape without calling the API", async () => {
        const user = userEvent.setup();

        renderWorkspace();

        await openMenu(user);
        await user.click(screen.getByRole("menuitem", { name: "Rename" }));

        const titleInput = screen.getByRole("textbox", {
            name: "Conversation title",
        });

        await user.clear(titleInput);
        await user.type(titleInput, "Discarded title{Escape}");

        expect(renameConversation).not.toHaveBeenCalled();
        expect(
            screen.getByRole("button", { name: "Test conversation" }),
        ).toBeTruthy();
    });

    it("restores the previous title and shows an error when renaming fails", async () => {
        const user = userEvent.setup();

        vi.mocked(renameConversation).mockRejectedValue(
            new Error("Network unavailable"),
        );

        renderWorkspace();

        await openMenu(user);
        await user.click(screen.getByRole("menuitem", { name: "Rename" }));

        const titleInput = screen.getByRole("textbox", {
            name: "Conversation title",
        });

        await user.clear(titleInput);
        await user.type(titleInput, "Trip ideas{Enter}");

        expect(
            await screen.findByRole("alert"),
        ).toHaveTextContent("Unable to rename the conversation.");
        expect(
            screen.getByRole("button", { name: "Test conversation" }),
        ).toBeTruthy();
    });

    // Selected directly: a closed dialog has no accessible name to query by.
    function confirmDialog(): HTMLDialogElement {
        const dialog = document.querySelector<HTMLDialogElement>(
            "dialog.confirm-dialog",
        );
        expect(dialog).toBeTruthy();
        return dialog as HTMLDialogElement;
    }

    it("deletes the selected conversation after confirming in the dialog", async () => {
        const user = userEvent.setup();

        vi.mocked(deleteConversation).mockResolvedValue(undefined);

        renderWorkspace();

        await user.click(
            await screen.findByRole("button", { name: "Test conversation" }),
        );
        await openMenu(user);
        await user.click(screen.getByRole("menuitem", { name: "Delete" }));

        const dialog = screen.getByRole("dialog", {
            name: "Delete conversation?",
        });
        expect(dialog).toHaveAttribute("open");
        expect(dialog).toHaveAccessibleDescription(
            "Test conversation and all of its messages will be permanently deleted.",
        );
        expect(
            within(dialog).getByRole("button", { name: "Cancel" }),
        ).toHaveFocus();
        expect(deleteConversation).not.toHaveBeenCalled();

        await user.click(within(dialog).getByRole("button", { name: "Delete" }));

        await waitFor(() => {
            expect(deleteConversation).toHaveBeenCalledWith(
                "test-access-token",
                "conversation-1",
            );
        });

        expect(
            await screen.findByRole("heading", { name: "Your AI workspace" }),
        ).toBeTruthy();
        expect(
            screen.queryByRole("button", { name: "Test conversation" }),
        ).toBeNull();
        expect(dialog).not.toHaveAttribute("open");
    });

    it("keeps the conversation when the dialog is cancelled", async () => {
        const user = userEvent.setup();

        renderWorkspace();

        await openMenu(user);
        await user.click(screen.getByRole("menuitem", { name: "Delete" }));
        await user.click(
            within(confirmDialog()).getByRole("button", { name: "Cancel" }),
        );

        expect(confirmDialog()).not.toHaveAttribute("open");
        expect(deleteConversation).not.toHaveBeenCalled();
        expect(
            screen.getByRole("button", { name: "Test conversation" }),
        ).toBeTruthy();
        expect(
            screen.getByRole("button", {
                name: "Options for Test conversation",
            }),
        ).toHaveFocus();
    });

    it("cancels on Escape and on a backdrop click", async () => {
        const user = userEvent.setup();

        renderWorkspace();

        // Browsers fire "cancel" on the dialog when Escape is pressed.
        await openMenu(user);
        await user.click(screen.getByRole("menuitem", { name: "Delete" }));
        fireEvent(confirmDialog(), new Event("cancel", { cancelable: true }));
        expect(confirmDialog()).not.toHaveAttribute("open");

        // A click on the backdrop targets the dialog element itself.
        await openMenu(user);
        await user.click(screen.getByRole("menuitem", { name: "Delete" }));
        await user.click(confirmDialog());
        expect(confirmDialog()).not.toHaveAttribute("open");

        expect(deleteConversation).not.toHaveBeenCalled();
    });

    it("describes an untitled conversation generically", async () => {
        const user = userEvent.setup();

        renderWorkspace([{ ...conversation, title: null }]);

        await user.click(
            await screen.findByRole("button", {
                name: "Options for New conversation",
            }),
        );
        await user.click(screen.getByRole("menuitem", { name: "Delete" }));

        expect(confirmDialog()).toHaveAccessibleDescription(
            "This conversation and all of its messages will be permanently deleted.",
        );
    });

    it("shows progress, then closes and reports a failed delete", async () => {
        const user = userEvent.setup();
        let rejectDelete: (error: Error) => void = () => {};

        vi.mocked(deleteConversation).mockReturnValue(
            new Promise((_resolve, reject) => {
                rejectDelete = reject;
            }),
        );

        renderWorkspace();

        await openMenu(user);
        await user.click(screen.getByRole("menuitem", { name: "Delete" }));
        await user.click(
            within(confirmDialog()).getByRole("button", { name: "Delete" }),
        );

        const busyButton = within(confirmDialog()).getByRole("button", {
            name: "Deleting…",
        });
        expect(busyButton).toBeDisabled();
        expect(
            within(confirmDialog()).getByRole("button", { name: "Cancel" }),
        ).toBeDisabled();

        rejectDelete(new Error("Network unavailable"));

        expect(await screen.findByRole("alert")).toHaveTextContent(
            "Unable to delete the conversation.",
        );
        expect(confirmDialog()).not.toHaveAttribute("open");
        expect(
            screen.getByRole("button", { name: "Test conversation" }),
        ).toBeTruthy();
    });

    it("titles an untitled conversation from the first message", async () => {
        const user = userEvent.setup();

        const savedTitleTurn: ChatTurn = {
            user_message: {
                id: "message-1",
                conversation_id: "conversation-1",
                role: "user",
                content: "Plan a   trip\nto Japan",
                created_at: "2026-01-01T00:01:00Z",
            },
            assistant_message: {
                id: "message-2",
                conversation_id: "conversation-1",
                role: "assistant",
                content: "Here is a plan.",
                created_at: "2026-01-01T00:01:01Z",
            },
        };

        vi.mocked(streamMessage).mockImplementation(
            async (_token, _conversationId, _content, onToken) => {
                onToken("Here is a plan.");
                return savedTitleTurn;
            },
        );

        renderWorkspace([{ ...conversation, title: null }]);

        await user.click(
            await screen.findByRole("button", { name: "New conversation" }),
        );

        const messageInput = await screen.findByRole("textbox", {
            name: "Message",
        });

        await user.type(
            messageInput,
            "Plan a   trip{Shift>}{Enter}{/Shift}to Japan",
        );
        await user.click(screen.getByRole("button", { name: "Send message" }));

        expect(
            await screen.findByRole("button", {
                name: "Plan a trip to Japan",
            }),
        ).toBeTruthy();
    });
});

describe("Assistant message formatting", () => {
    afterEach(() => {
        cleanup();
        vi.clearAllMocks();
        sessionStorage.clear();
    });

    it("renders assistant Markdown safely and keeps user text literal", async () => {
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
                title: "Formatting",
                created_at: "2026-01-01T00:00:00Z",
                updated_at: "2026-01-01T00:00:00Z",
            },
        ]);
        vi.mocked(listMessages).mockResolvedValue([
            {
                id: "message-1",
                conversation_id: "conversation-1",
                role: "user",
                content: "Use **stars** please",
                created_at: "2026-01-01T00:01:00Z",
            },
            {
                id: "message-2",
                conversation_id: "conversation-1",
                role: "assistant",
                content: [
                    "Here is **bold** text.",
                    "",
                    "- First item",
                    "- Second item",
                    "",
                    "Run `npm test` and see [the docs](https://example.com).",
                    "",
                    "<script>alert('x')</script>",
                ].join("\n"),
                created_at: "2026-01-01T00:01:01Z",
            },
        ]);

        render(<App />);

        await user.click(
            await screen.findByRole("button", { name: "Formatting" }),
        );

        expect(await screen.findByText("bold")).toContainHTML(
            "<strong>bold</strong>",
        );
        const markdown = document.querySelector(".message-markdown");
        expect(markdown).toBeTruthy();
        expect(
            within(markdown as HTMLElement)
                .getAllByRole("listitem")
                .map((item) => item.textContent),
        ).toEqual(["First item", "Second item"]);
        expect(screen.getByText("npm test").tagName).toBe("CODE");

        const link = screen.getByRole("link", { name: "the docs" });
        expect(link).toHaveAttribute("href", "https://example.com");
        expect(link).toHaveAttribute("target", "_blank");
        expect(link).toHaveAttribute("rel", "noopener noreferrer");

        expect(document.querySelector(".message-markdown script")).toBeNull();
        expect(screen.getByText("Use **stars** please")).toBeTruthy();
    });
});

describe("Streaming replies", () => {
    const first: Conversation = {
        id: "conversation-1",
        title: "First chat",
        created_at: "2026-01-01T00:00:00Z",
        updated_at: "2026-01-02T00:00:00Z",
    };
    const second: Conversation = {
        id: "conversation-2",
        title: "Second chat",
        created_at: "2026-01-01T00:00:00Z",
        updated_at: "2026-01-01T00:00:00Z",
    };

    const savedTurn: ChatTurn = {
        user_message: {
            id: "message-1",
            conversation_id: "conversation-1",
            role: "user",
            content: "Hello",
            created_at: "2026-01-03T00:00:00Z",
        },
        assistant_message: {
            id: "message-2",
            conversation_id: "conversation-1",
            role: "assistant",
            content: "Streamed reply",
            created_at: "2026-01-03T00:00:01Z",
        },
    };

    // A stream that stays open until the test releases or fails it.
    function holdStream(initialTokens: string[]) {
        const controls: {
            finish: () => void;
            fail: (error: Error) => void;
        } = {
            finish: () => {},
            fail: () => {},
        };

        vi.mocked(streamMessage).mockImplementation(
            async (_token, _conversationId, _content, onToken) => {
                initialTokens.forEach(onToken);
                await new Promise<void>((resolve, reject) => {
                    controls.finish = resolve;
                    controls.fail = reject;
                });
                return savedTurn;
            },
        );

        return controls;
    }

    async function openChatAndSend(
        user: ReturnType<typeof userEvent.setup>,
        content = "Hello",
    ) {
        sessionStorage.setItem("access_token", "test-access-token");
        vi.mocked(getMe).mockResolvedValue({
            id: "user-1",
            email: "jaiganesh@example.com",
            is_active: true,
            created_at: "2026-01-01T00:00:00Z",
        });
        vi.mocked(listConversations).mockResolvedValue([first, second]);
        vi.mocked(listMessages).mockResolvedValue([]);

        render(<App />);

        await user.click(
            await screen.findByRole("button", { name: "First chat" }),
        );
        await user.type(
            await screen.findByRole("textbox", { name: "Message" }),
            content,
        );
        await user.click(screen.getByRole("button", { name: "Send message" }));
    }

    afterEach(() => {
        cleanup();
        vi.clearAllMocks();
        sessionStorage.clear();
    });

    it("shows Thinking until the first token arrives", async () => {
        const user = userEvent.setup();
        const stream = holdStream([]);

        await openChatAndSend(user);

        expect(await screen.findByText("Thinking...")).toBeTruthy();
        expect(screen.getByText("Hello")).toBeTruthy();

        stream.finish();

        expect(await screen.findByText("Streamed reply")).toBeTruthy();
        expect(screen.queryByText("Thinking...")).toBeNull();
    });

    it("keeps a streaming reply out of another conversation", async () => {
        const user = userEvent.setup();
        const stream = holdStream(["Partial reply"]);

        await openChatAndSend(user);
        expect(await screen.findByText("Partial reply")).toBeTruthy();

        await user.click(screen.getByRole("button", { name: "Second chat" }));

        await waitFor(() => {
            expect(listMessages).toHaveBeenLastCalledWith(
                "test-access-token",
                "conversation-2",
            );
        });
        expect(screen.queryByText("Partial reply")).toBeNull();

        stream.finish();

        // Send re-enables (with a draft present) once the stream has ended.
        await user.type(
            screen.getByRole("textbox", { name: "Message" }),
            "Draft",
        );
        await waitFor(() => {
            expect(
                screen.getByRole("button", { name: "Send message" }),
            ).not.toBeDisabled();
        });
        expect(screen.queryByText("Streamed reply")).toBeNull();
        expect(screen.queryByText("Hello")).toBeNull();
    });

    it("discards the partial reply and restores the draft when the stream fails", async () => {
        const user = userEvent.setup();
        const stream = holdStream(["Half an ans"]);

        await openChatAndSend(user, "Explain streaming");
        expect(await screen.findByText("Half an ans")).toBeTruthy();

        stream.fail(new ApiError("The assistant could not generate a response.", 502));

        expect(await screen.findByRole("alert")).toHaveTextContent(
            "The assistant could not generate a response.",
        );
        expect(screen.queryByText("Half an ans")).toBeNull();
        expect(screen.getByRole("textbox", { name: "Message" })).toHaveValue(
            "Explain streaming",
        );
        expect(
            screen.getByRole("heading", {
                name: "What would you like to explore?",
            }),
        ).toBeTruthy();
    });

    it("keeps the composer focused and lets the user type ahead during a reply", async () => {
        const user = userEvent.setup();
        const stream = holdStream(["Thinking it over"]);

        await openChatAndSend(user);
        expect(await screen.findByText("Thinking it over")).toBeTruthy();

        const composer = screen.getByRole("textbox", { name: "Message" });
        expect(composer).not.toBeDisabled();
        expect(composer).toHaveFocus();

        await user.type(composer, "Next question{Enter}");

        expect(composer).toHaveValue("Next question");
        expect(streamMessage).toHaveBeenCalledTimes(1);
        expect(
            screen.getByRole("button", { name: "Send message" }),
        ).toBeDisabled();

        stream.finish();

        expect(await screen.findByText("Streamed reply")).toBeTruthy();
        expect(composer).toHaveValue("Next question");
        expect(composer).toHaveFocus();
        await waitFor(() => {
            expect(
                screen.getByRole("button", { name: "Send message" }),
            ).not.toBeDisabled();
        });
    });

    it("keeps a new draft instead of restoring a failed message", async () => {
        const user = userEvent.setup();
        const stream = holdStream([]);

        await openChatAndSend(user, "First message");
        await user.type(
            screen.getByRole("textbox", { name: "Message" }),
            "Newer draft",
        );

        stream.fail(new Error("Network unavailable"));

        expect(await screen.findByRole("alert")).toHaveTextContent(
            "Unable to send your message. Please try again.",
        );
        expect(screen.getByRole("textbox", { name: "Message" })).toHaveValue(
            "Newer draft",
        );
    });

    it("focuses the composer when a conversation is opened", async () => {
        const user = userEvent.setup();

        sessionStorage.setItem("access_token", "test-access-token");
        vi.mocked(getMe).mockResolvedValue({
            id: "user-1",
            email: "jaiganesh@example.com",
            is_active: true,
            created_at: "2026-01-01T00:00:00Z",
        });
        vi.mocked(listConversations).mockResolvedValue([first, second]);
        vi.mocked(listMessages).mockResolvedValue([]);

        render(<App />);

        await user.click(
            await screen.findByRole("button", { name: "Second chat" }),
        );

        expect(
            await screen.findByRole("textbox", { name: "Message" }),
        ).toHaveFocus();
    });

    it("disables Delete for the conversation that is still streaming", async () => {
        const user = userEvent.setup();
        const stream = holdStream(["Working on it"]);

        await openChatAndSend(user);
        expect(await screen.findByText("Working on it")).toBeTruthy();

        await user.click(
            screen.getByRole("button", { name: "Options for First chat" }),
        );
        expect(screen.getByRole("menuitem", { name: "Delete" })).toBeDisabled();

        await user.keyboard("{Escape}");
        await user.click(
            screen.getByRole("button", { name: "Options for Second chat" }),
        );
        expect(
            screen.getByRole("menuitem", { name: "Delete" }),
        ).not.toBeDisabled();

        stream.finish();
        expect(await screen.findByText("Streamed reply")).toBeTruthy();
    });
});

describe("Conversation rename on blur", () => {
    afterEach(() => {
        cleanup();
        vi.clearAllMocks();
        sessionStorage.clear();
    });

    it("saves the new title when the input loses focus", async () => {
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
                title: "Old title",
                created_at: "2026-01-01T00:00:00Z",
                updated_at: "2026-01-01T00:00:00Z",
            },
        ]);
        vi.mocked(renameConversation).mockResolvedValue({
            id: "conversation-1",
            title: "Blurred title",
            created_at: "2026-01-01T00:00:00Z",
            updated_at: "2026-01-01T00:00:00Z",
        });

        render(<App />);

        await user.click(
            await screen.findByRole("button", { name: "Options for Old title" }),
        );
        await user.click(screen.getByRole("menuitem", { name: "Rename" }));

        const titleInput = screen.getByRole("textbox", {
            name: "Conversation title",
        });
        await user.clear(titleInput);
        await user.type(titleInput, "Blurred title");
        await user.click(document.body);

        await waitFor(() => {
            expect(renameConversation).toHaveBeenCalledWith(
                "test-access-token",
                "conversation-1",
                "Blurred title",
            );
        });
        expect(renameConversation).toHaveBeenCalledTimes(1);
        expect(
            await screen.findByRole("button", { name: "Blurred title" }),
        ).toBeTruthy();
    });
});

describe("Mobile conversation drawer", () => {
    const conversations: Conversation[] = [
        {
            id: "conversation-1",
            title: "First chat",
            created_at: "2026-01-01T00:00:00Z",
            updated_at: "2026-01-02T00:00:00Z",
        },
        {
            id: "conversation-2",
            title: "Second chat",
            created_at: "2026-01-01T00:00:00Z",
            updated_at: "2026-01-01T00:00:00Z",
        },
    ];

    async function renderAndOpenDrawer(
        user: ReturnType<typeof userEvent.setup>,
    ) {
        sessionStorage.setItem("access_token", "test-access-token");
        vi.mocked(getMe).mockResolvedValue({
            id: "user-1",
            email: "jaiganesh@example.com",
            is_active: true,
            created_at: "2026-01-01T00:00:00Z",
        });
        vi.mocked(listConversations).mockResolvedValue(conversations);
        vi.mocked(listMessages).mockResolvedValue([]);

        render(<App />);

        const toggle = await screen.findByRole("button", {
            name: "Open conversations",
        });
        await user.click(toggle);

        return toggle;
    }

    function sidebar() {
        return screen.getByRole("complementary", { name: "Conversations" });
    }

    afterEach(() => {
        cleanup();
        vi.clearAllMocks();
        sessionStorage.clear();
    });

    it("opens the drawer and moves focus to its close button", async () => {
        const user = userEvent.setup();

        const toggle = await renderAndOpenDrawer(user);

        expect(toggle).toHaveAttribute("aria-expanded", "true");
        expect(toggle).toHaveAttribute("aria-controls", "sidebar");
        expect(sidebar()).toHaveClass("sidebar-open");
        expect(
            screen.getByRole("button", { name: "Close conversations" }),
        ).toHaveFocus();
    });

    it("closes after choosing a conversation and focuses the composer", async () => {
        const user = userEvent.setup();

        const toggle = await renderAndOpenDrawer(user);
        await user.click(screen.getByRole("button", { name: "Second chat" }));

        expect(sidebar()).not.toHaveClass("sidebar-open");
        expect(toggle).toHaveAttribute("aria-expanded", "false");
        expect(
            await screen.findByRole("textbox", { name: "Message" }),
        ).toHaveFocus();
    });

    it("closes on Escape and returns focus to the menu button", async () => {
        const user = userEvent.setup();

        const toggle = await renderAndOpenDrawer(user);
        await user.keyboard("{Escape}");

        expect(sidebar()).not.toHaveClass("sidebar-open");
        expect(toggle).toHaveFocus();
    });

    it("closes from the backdrop and the close button", async () => {
        const user = userEvent.setup();

        const toggle = await renderAndOpenDrawer(user);
        const backdrop = document.querySelector(".sidebar-backdrop");
        expect(backdrop).toBeTruthy();
        await user.click(backdrop as Element);
        expect(sidebar()).not.toHaveClass("sidebar-open");
        expect(document.querySelector(".sidebar-backdrop")).toBeNull();

        await user.click(toggle);
        await user.click(
            screen.getByRole("button", { name: "Close conversations" }),
        );
        expect(sidebar()).not.toHaveClass("sidebar-open");
        expect(toggle).toHaveFocus();
    });

    it("lets Escape close an open options menu before the drawer", async () => {
        const user = userEvent.setup();

        await renderAndOpenDrawer(user);
        await user.click(
            screen.getByRole("button", { name: "Options for First chat" }),
        );
        await user.keyboard("{Escape}");

        expect(screen.queryByRole("menu")).toBeNull();
        expect(sidebar()).toHaveClass("sidebar-open");
    });
});

describe("Session restore and expiry", () => {
    const activeUser = {
        id: "user-1",
        email: "jaiganesh@example.com",
        is_active: true,
        created_at: "2026-01-01T00:00:00Z",
    };
    const conversation: Conversation = {
        id: "conversation-1",
        title: "Test conversation",
        created_at: "2026-01-01T00:00:00Z",
        updated_at: "2026-01-01T00:00:00Z",
    };

    afterEach(() => {
        cleanup();
        vi.clearAllMocks();
        sessionStorage.clear();
    });

    function expectSignedOutWithNotice() {
        expect(sessionStorage.getItem("access_token")).toBeNull();
        expect(
            screen.getByRole("heading", { name: "Welcome back" }),
        ).toBeTruthy();
        expect(screen.getByRole("status")).toHaveTextContent(
            "Your session has expired. Please sign in again.",
        );
        expect(
            screen.getByRole("textbox", { name: "Email address" }),
        ).toHaveValue("jaiganesh@example.com");
    }

    it("shows a restoring screen instead of the login form while verifying", async () => {
        sessionStorage.setItem("access_token", "test-access-token");

        let resolveMe: (user: typeof activeUser) => void = () => {};
        vi.mocked(getMe).mockReturnValue(
            new Promise((resolve) => {
                resolveMe = resolve;
            }),
        );
        vi.mocked(listConversations).mockResolvedValue([]);

        render(<App />);

        expect(screen.getByRole("status")).toHaveTextContent(
            "Restoring your session…",
        );
        expect(screen.queryByRole("heading", { name: "Welcome back" })).toBeNull();

        resolveMe(activeUser);

        expect(
            await screen.findByText(
                "No conversations yet. Start a new chat to begin.",
            ),
        ).toBeTruthy();
    });

    it("shows the login form immediately when no token is stored", () => {
        render(<App />);

        expect(
            screen.getByRole("heading", { name: "Welcome back" }),
        ).toBeTruthy();
        expect(screen.queryByText("Restoring your session…")).toBeNull();
    });

    it("signs out with a notice when loading conversations returns 401", async () => {
        sessionStorage.setItem("access_token", "expired-token");
        vi.mocked(getMe).mockResolvedValue(activeUser);
        vi.mocked(listConversations).mockRejectedValue(
            new ApiError("Invalid or expired authentication credentials.", 401),
        );

        render(<App />);

        expect(
            await screen.findByRole("heading", { name: "Welcome back" }),
        ).toBeTruthy();
        expectSignedOutWithNotice();
    });

    it("signs out with a notice when sending a message returns 401", async () => {
        const user = userEvent.setup();

        sessionStorage.setItem("access_token", "test-access-token");
        vi.mocked(getMe).mockResolvedValue(activeUser);
        vi.mocked(listConversations).mockResolvedValue([conversation]);
        vi.mocked(listMessages).mockResolvedValue([]);
        vi.mocked(streamMessage).mockRejectedValue(
            new ApiError("Invalid or expired authentication credentials.", 401),
        );

        render(<App />);

        await user.click(
            await screen.findByRole("button", { name: "Test conversation" }),
        );
        await user.type(
            await screen.findByRole("textbox", { name: "Message" }),
            "Hello",
        );
        await user.click(screen.getByRole("button", { name: "Send message" }));

        expect(
            await screen.findByRole("heading", { name: "Welcome back" }),
        ).toBeTruthy();
        expectSignedOutWithNotice();
    });

    it("keeps the user signed in for non-auth errors", async () => {
        const user = userEvent.setup();

        sessionStorage.setItem("access_token", "test-access-token");
        vi.mocked(getMe).mockResolvedValue(activeUser);
        vi.mocked(listConversations).mockResolvedValue([]);
        vi.mocked(createConversation).mockRejectedValue(
            new ApiError("Server error", 500),
        );

        render(<App />);

        await user.click(
            await screen.findByRole("button", { name: "New chat" }),
        );

        expect(await screen.findByRole("alert")).toHaveTextContent(
            "Server error",
        );
        expect(sessionStorage.getItem("access_token")).toBe(
            "test-access-token",
        );
    });

    it("clears the email and notice on a normal logout", async () => {
        const user = userEvent.setup();

        sessionStorage.setItem("access_token", "test-access-token");
        vi.mocked(getMe).mockResolvedValue(activeUser);
        vi.mocked(listConversations).mockResolvedValue([]);

        render(<App />);

        await user.click(await screen.findByRole("button", { name: "Log out" }));

        expect(
            screen.getByRole("textbox", { name: "Email address" }),
        ).toHaveValue("");
        expect(screen.queryByRole("status")).toBeNull();
    });
});

describe("Connection status indicator", () => {
    function renderWorkspace() {
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

        render(<App />);
    }

    afterEach(() => {
        cleanup();
        vi.clearAllMocks();
        vi.mocked(checkHealth).mockImplementation(async () => "online");
        sessionStorage.clear();
    });

    it.each([
        ["online", "Connected"],
        ["degraded", "Database unavailable"],
        ["offline", "Offline"],
    ] as const)("shows %s as %s", async (status, label) => {
        vi.mocked(checkHealth).mockResolvedValue(status);

        renderWorkspace();

        expect(await screen.findByText(label)).toBeTruthy();
        expect(
            document.querySelector(`.connection-status.connection-${status}`),
        ).toBeTruthy();
    });

    it("does not check the backend from the login screen", () => {
        render(<App />);

        expect(checkHealth).not.toHaveBeenCalled();
    });

    it("rechecks the connection after a message fails to send", async () => {
        const user = userEvent.setup();

        renderWorkspace();
        expect(await screen.findByText("Connected")).toBeTruthy();

        vi.mocked(checkHealth).mockResolvedValue("offline");
        vi.mocked(streamMessage).mockRejectedValue(
            new TypeError("Failed to fetch"),
        );

        await user.click(
            screen.getByRole("button", { name: "Test conversation" }),
        );
        await user.type(
            await screen.findByRole("textbox", { name: "Message" }),
            "Hello",
        );
        await user.click(screen.getByRole("button", { name: "Send message" }));

        expect(await screen.findByText("Offline")).toBeTruthy();
    });

    it("switches to Offline when the browser loses its connection", async () => {
        renderWorkspace();
        expect(await screen.findByText("Connected")).toBeTruthy();

        window.dispatchEvent(new Event("offline"));

        expect(await screen.findByText("Offline")).toBeTruthy();
    });
});


describe("Theme switcher", () => {
    function renderWorkspace() {
        sessionStorage.setItem("access_token", "test-access-token");
        vi.mocked(getMe).mockResolvedValue({
            id: "user-1",
            email: "jaiganesh@example.com",
            is_active: true,
            created_at: "2026-01-01T00:00:00Z",
        });
        vi.mocked(listConversations).mockResolvedValue([]);

        render(<App />);
    }

    async function themeGroup() {
        return within(await screen.findByRole("group", { name: "Theme" }));
    }

    afterEach(() => {
        cleanup();
        vi.clearAllMocks();
        sessionStorage.clear();
        localStorage.clear();
        delete document.documentElement.dataset.theme;
    });

    it("follows the system theme by default", async () => {
        renderWorkspace();

        const group = await themeGroup();

        expect(group.getByRole("button", { name: "System" })).toHaveAttribute(
            "aria-pressed",
            "true",
        );
        expect(document.documentElement.dataset.theme).toBeUndefined();
    });

    it("applies and remembers an explicit choice", async () => {
        const user = userEvent.setup();

        renderWorkspace();
        const group = await themeGroup();

        await user.click(group.getByRole("button", { name: "Dark" }));

        expect(group.getByRole("button", { name: "Dark" })).toHaveAttribute(
            "aria-pressed",
            "true",
        );
        expect(group.getByRole("button", { name: "System" })).toHaveAttribute(
            "aria-pressed",
            "false",
        );
        expect(document.documentElement.dataset.theme).toBe("dark");
        expect(localStorage.getItem("curibot-theme")).toBe("dark");

        await user.click(group.getByRole("button", { name: "Light" }));

        expect(document.documentElement.dataset.theme).toBe("light");
        expect(localStorage.getItem("curibot-theme")).toBe("light");
    });

    it("returns to the system theme and forgets the saved choice", async () => {
        const user = userEvent.setup();

        localStorage.setItem("curibot-theme", "dark");
        renderWorkspace();
        const group = await themeGroup();

        expect(group.getByRole("button", { name: "Dark" })).toHaveAttribute(
            "aria-pressed",
            "true",
        );

        await user.click(group.getByRole("button", { name: "System" }));

        expect(document.documentElement.dataset.theme).toBeUndefined();
        expect(localStorage.getItem("curibot-theme")).toBeNull();
    });

    it("ignores an unrecognised saved value", async () => {
        localStorage.setItem("curibot-theme", "sepia");
        renderWorkspace();

        const group = await themeGroup();

        expect(group.getByRole("button", { name: "System" })).toHaveAttribute(
            "aria-pressed",
            "true",
        );
    });
});

describe("Web search activity", () => {
    afterEach(() => {
        cleanup();
        vi.clearAllMocks();
        sessionStorage.clear();
    });

    it("shows the search, drops pre-search text, then streams the answer", async () => {
        const user = userEvent.setup();
        const steps = {
            search: () => {},
            answer: () => {},
        };

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
                title: "Weather",
                created_at: "2026-01-01T00:00:00Z",
                updated_at: "2026-01-01T00:00:00Z",
            },
        ]);
        vi.mocked(listMessages).mockResolvedValue([]);
        vi.mocked(streamMessage).mockImplementation(
            async (_token, _conversationId, _content, onToken, onToolCall) => {
                onToken("Let me check that.");
                await new Promise<void>((resolve) => {
                    steps.search = resolve;
                });
                onToolCall?.({ name: "web_search", query: "Chennai weather" });
                await new Promise<void>((resolve) => {
                    steps.answer = resolve;
                });
                onToken("It is sunny in Chennai.");
                return {
                    user_message: {
                        id: "m1",
                        conversation_id: "conversation-1",
                        role: "user",
                        content: "Weather in Chennai?",
                        created_at: "2026-01-02T00:00:00Z",
                    },
                    assistant_message: {
                        id: "m2",
                        conversation_id: "conversation-1",
                        role: "assistant",
                        content: "It is sunny in Chennai.",
                        created_at: "2026-01-02T00:00:01Z",
                    },
                };
            },
        );

        render(<App />);

        await user.click(await screen.findByRole("button", { name: "Weather" }));
        await user.type(
            await screen.findByRole("textbox", { name: "Message" }),
            "Weather in Chennai?",
        );
        await user.click(screen.getByRole("button", { name: "Send message" }));

        expect(await screen.findByText("Let me check that.")).toBeTruthy();

        steps.search();

        expect(
            await screen.findByText("Searching the web for “Chennai weather”…"),
        ).toBeTruthy();
        expect(screen.queryByText("Let me check that.")).toBeNull();

        steps.answer();

        expect(await screen.findByText("It is sunny in Chennai.")).toBeTruthy();
        expect(
            screen.queryByText("Searching the web for “Chennai weather”…"),
        ).toBeNull();
    });
});
