import ReactMarkdown, { type Components } from "react-markdown";
import remarkGfm from "remark-gfm";

// Links in model output leave the app, so open them safely in a new tab.
const components: Components = {
  a: ({ href, children }) => (
    <a href={href} target="_blank" rel="noopener noreferrer">
      {children}
    </a>
  ),
};

interface MarkdownMessageProps {
  content: string;
}

// Raw HTML in the content is escaped, not rendered, by react-markdown.
function MarkdownMessage({ content }: MarkdownMessageProps) {
  return (
    <div className="message-text message-markdown">
      <ReactMarkdown remarkPlugins={[remarkGfm]} components={components}>
        {content}
      </ReactMarkdown>
    </div>
  );
}

export default MarkdownMessage;
