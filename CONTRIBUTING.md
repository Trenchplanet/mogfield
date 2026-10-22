# Contributing

Thanks for helping out. Issues and pull requests are welcome.

## Setup

```bash
cd app
npm install
cp .env.example .env   # add your COMFY_API_KEY if you want to run real jobs
npm run dev            # server on :8787, web on :5173
```

Without a key or a ComfyUI URL the app runs its ffmpeg preview engine, so most
of the UI works with no GPU and no account.

## Before you open a pull request

```bash
cd app
npm run typecheck
npm test
npm run build
```

For the node pack: `npm run test:nodes` from the repo root (needs Python with pytest).

## Guidelines

- Keep changes focused; one feature or fix per pull request.
- Match the existing code style: TypeScript strict, small functions, short comments
  that say why rather than what.
- Never commit `app/.env`, API keys, or anything under `app/data/` (your uploads and renders).
- Workflows in `workflows/` are API-format ComfyUI graphs bound by node **title**
  (`BL:video`, `BL:prompt`, ...). If you change a graph, re-export it in API format
  and keep the titles. See `workflows/README.md`.
- New model providers go in `app/server/providers/` (implement `types.ts`, list it in `index.ts`).

By contributing you agree that your contributions are licensed under the MIT License.
