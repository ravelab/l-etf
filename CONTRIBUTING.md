# Contributing

Thanks for your interest in improving this project. Issues and pull requests are welcome.

## Setup

See [README.md](./README.md#installation) for environment setup and the API keys required to run the app.

```bash
npm install
npm run setup:hooks   # once per clone — enables .githooks
```

## Development workflow

Day-to-day work happens on `dev`. `main` is production and only advances by a fast-forward of an already-tested `dev` tip (`npm run promote` / `npm run ship`).

1. Fork the repo (or clone) and branch off `dev`.
2. Make your changes. Keep PRs focused — one logical change per PR.
3. Open a PR against `dev`. Locally, `.githooks/pre-commit` runs lint / typecheck / knip and `.githooks/pre-push` runs the unit suite; CI re-runs the unit suite on every PR and every push to `dev`.
4. To ship what's on `dev` to production:
   ```bash
   npm run push:dev             # push + wait for preview UI CI
   npm run promote              # fast-forward main + wait for production smoke
   # or one shot:
   npm run ship -- "your message"
   ```

## Reporting issues

Please include:

- What you expected to happen
- What actually happened
- Steps to reproduce
- Your Node.js version and operating system

## Code style

- TypeScript strict mode; ESLint config in `eslint.config.mjs`.
- Prefer small, focused files; keep components and helpers single-purpose.
- Add unit tests for new logic in `unit-tests/`.
- Tag cheap, read-only Puppeteer specs with `export const tags = ["smoke"]` so they run against production after promote.

## License

By contributing, you agree your contributions will be licensed under the [MIT License](./LICENSE).
