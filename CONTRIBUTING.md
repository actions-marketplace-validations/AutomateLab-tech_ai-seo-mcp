# Contributing

Thanks for considering a contribution.

## Ways to help

- File a bug. The more reproducible, the better.
- Suggest a new tool or a new check for an existing tool.
- Add a missing AI crawler to `src/lib/crawlers.json`.
- Improve scoring rubrics with citation correlation data.
- Port the audit logic to Python (PyPI distribution is on the 0.2 roadmap).

## Local setup

```bash
git clone https://github.com/AutomateLab-tech/ai-seo-mcp.git
cd ai-seo-mcp
npm install
npm run build
npm test
```

Node 20 or later is required.

For local development against a live MCP client, point the client at your built `dist/index.js`:

```json
{
  "mcpServers": {
    "ai-seo-dev": {
      "command": "node",
      "args": ["/absolute/path/to/ai-seo-mcp/dist/index.js"]
    }
  }
}
```

## Project layout

```
src/
  index.ts          MCP server entrypoint, tool registration
  types.ts          Shared types (Finding, etc.)
  lib/              Internal helpers: fetch, robots, schema, html, score, entities, llms-txt
  tools/            One file per tool
tests/
  smoke.test.ts     Network-dependent smoke tests
```

Each tool lives in its own file under `src/tools/`. A tool exports:

1. A zod input schema.
2. A handler function returning the result object.
3. A registration call inside `src/index.ts`.

The shared `Finding` type defined in `src/types.ts` is the canonical output shape for every audit tool. Use it.

## Coding rules

- TypeScript strict mode is on. Keep it on.
- No emojis in source files, comments, READMEs, or commit messages.
- No em-dashes anywhere. Use regular hyphens.
- Single quotes for strings unless template literals are needed.
- Two-space indentation.
- Functions over classes unless state is unavoidable.
- Network calls go through `src/lib/fetch.ts`. Never call `fetch` or `undici` directly from a tool file - the polite-fetch contract is enforced there.

## Tests

Run `npm test` before opening a PR. New tools must add at least one smoke test in `tests/smoke.test.ts`. Network-dependent tests should be tolerant of intermittent failures (use a small set of stable public targets).

## Pull requests

- Keep PRs focused. One tool or one fix per PR.
- Update `CHANGELOG.md` under an `## [Unreleased]` heading.
- Update `README.md` if you add a tool or change a public-facing behavior.
- Reference the issue you are closing.

## Versioning

We follow [semver](https://semver.org). Breaking changes to tool input/output shapes bump the major version. New tools or new fields are minor bumps. Bug fixes and rubric refinements are patches.

## License

By contributing, you agree your work is licensed under the [MIT License](./LICENSE).

## Code of conduct

Be civil. Disagree on substance, not people. Maintainers reserve the right to close issues or PRs that are off-topic, low-effort, or hostile.
