# Curibot frontend

The React client for Curibot, a stateful conversational AI agent. It talks to
the FastAPI backend in [`../backend`](../backend).

## Features

- Sign in and registration, with session restore on refresh and automatic
  sign-out when a session expires
- Conversation sidebar with rename and delete; a slide-in drawer on small
  screens
- Assistant replies streamed over Server-Sent Events, revealed at a steady
  pace, and rendered as Markdown (tables, code, lists, safe links)
- Live backend connection status in the chat header
- Accessible by default: keyboard focus management, a native modal dialog for
  destructive actions, WCAG AA text contrast, and reduced-motion support

## Stack

React 19, TypeScript, Vite, plain CSS, `react-markdown` with `remark-gfm`, and
Vitest with Testing Library.

## Getting started

Requires Node.js 24 and a running backend (see the root `compose.yaml`).

```bash
npm install
npm run dev
```

The app runs at <http://localhost:5173>.

### Configuration

The API address comes from `VITE_API_BASE_URL`. Create
`.env.development` (Git-ignored) to override the default:

```bash
VITE_API_BASE_URL=http://localhost:8000/api/v1
```

## Scripts

| Command | Purpose |
| --- | --- |
| `npm run dev` | Start the dev server with hot reload |
| `npm run build` | Type-check and build for production into `dist/` |
| `npm run preview` | Serve the production build locally |
| `npm test -- --run` | Run the test suite once (`npm test` watches) |
| `npm run lint` | Lint with ESLint |
| `npm run typecheck` | Type-check without emitting |
| `npm run format` | Format with Prettier |

## Project layout

```text
src/
├── App.tsx                 # Workspace and auth screens, app state
├── App.css                 # Component styles
├── index.css               # Global styles and colour tokens
├── api/client.ts           # REST client and SSE stream parser
├── ConfirmDialog.tsx       # Native <dialog> confirmation
├── MarkdownMessage.tsx     # Safe Markdown rendering for replies
├── StreamingReply.tsx      # Paced reveal of a streaming reply
├── useConnectionStatus.ts  # Backend health polling
└── test/setup.ts           # Test environment shims
```
