import PlusIcon from "./PlusIcon";

interface WelcomeScreenProps {
  creating: boolean;
  onNewChat: () => void;
}

function WelcomeScreen({ creating, onNewChat }: WelcomeScreenProps) {
  return (
    <div className="welcome-content">
      <div className="welcome-icon" aria-hidden="true">
        ✳
      </div>

      <h2>Your AI workspace</h2>

      <p>
        Start a new conversation to ask a question and interact with your AI
        assistant. Your conversations are saved to your account.
      </p>

      <button
        className="new-chat-button welcome-new-chat"
        type="button"
        onClick={onNewChat}
        disabled={creating}
      >
        <PlusIcon />
        {creating ? "Creating…" : "Start a new chat"}
      </button>
    </div>
  );
}

export default WelcomeScreen;
