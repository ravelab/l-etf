# Contributing

Thanks for your interest in improving this project. Issues and pull requests are welcome.

## Setup

See [README.md](./README.md#installation) for environment setup and the API keys required to run the app.

## Development workflow

1. Fork the repo and create a feature branch off `main`.
2. Make your changes. Keep PRs focused — one logical change per PR.
3. Before pushing, run:
   ```bash
   npm run lint
   npm run typecheck
   npm test
   ```
4. Open a PR against `main` with a clear description of what changed and why.

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

## License

By contributing, you agree your contributions will be licensed under the [MIT License](./LICENSE).
