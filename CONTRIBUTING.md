# Contributing

Thanks for your interest in improving GitHub Copilot LLM Gateway. Bug reports,
fixes, documentation and new ideas are all welcome.

By taking part in this project you agree to follow the
[Code of Conduct](CODE_OF_CONDUCT.md).

## Questions and Ideas

- **Questions and setup help:** start a thread in
  [Discussions](https://github.com/arbs-io/github-copilot-llm-gateway/discussions).
- **Bugs and feature requests:** open an
  [issue](https://github.com/arbs-io/github-copilot-llm-gateway/issues/new/choose).
  Please search the existing issues first.
- **Security problems:** please don't open an issue. Follow the
  [security policy](SECURITY.md) instead.

For anything bigger than a small fix, it's worth opening an issue before you
start so we can agree on the approach. That saves you writing code that ends
up going in a different direction.

## Development Setup

You'll need [Node.js](https://nodejs.org/) 22 or later and a recent version of
VS Code. The repository also includes a dev container
(`.devcontainer/devcontainer.json`) with everything installed.

```bash
git clone https://github.com/arbs-io/github-copilot-llm-gateway.git
cd github-copilot-llm-gateway
npm ci
```

To run the extension, open the folder in VS Code and press **F5**. This starts
the **Run Extension** launch configuration, which rebuilds on save and opens
an Extension Development Host window with the extension loaded. You'll need an
OpenAI-compatible server to talk to. A small model on
[Ollama](https://ollama.com/) or llama.cpp is enough for most changes.

Useful scripts:

| Command                 | What it does                                   |
| ----------------------- | ---------------------------------------------- |
| `npm run esbuild`       | Builds the extension into `out/`               |
| `npm run esbuild-watch` | Rebuilds on every change                       |
| `npm run lint`          | Runs ESLint over `src/`                        |
| `npm test`              | Compiles and runs the unit tests               |
| `npm run test-coverage` | Runs the unit tests with a coverage report     |
| `npm run test-compile`  | Type-checks the whole project with `tsc`       |
| `npm run package`       | Builds a `.vsix` you can install locally       |

Unit tests live next to the code in `__tests__` folders and use Node's
built-in test runner.

## Making a Change

1. Fork the repository and create a branch from `main`. Use a short
   descriptive name such as `fix/123-tool-call-parsing` or
   `feat/model-picker-detail`.
2. Make your change. Keep each pull request focused on one thing.
3. Add or update tests for any change in behaviour.
4. Update `README.md` if you've changed a setting, command or anything else
   users will notice.
5. Check that `npm run lint`, `npm test` and `npm run test-compile` all pass.
6. Open a pull request against `main` and fill in the template.

### Pull Request Titles

Pull requests are squash merged, and the title becomes the commit message and
the line in the release notes. Please write it in the
[Conventional Commits](https://www.conventionalcommits.org/) style:

```text
feat: show the upstream provider for aggregated model ids in the picker
fix: send pasted text attachments to the model
docs: document running multiple providers behind an aggregator
chore: upgrade dev dependencies
```

Use `feat` for new features, `fix` for bug fixes, `docs` for documentation,
`refactor` for code changes that don't change behaviour, `test` for tests
and `chore` for builds, dependencies and other housekeeping.

If the pull request fixes an issue, say so in the description, for example
`Fixes #123`. GitHub will then close the issue when the pull request is merged.

### Code Style

- TypeScript, formatted with the settings in the dev container: two spaces,
  double quotes and semicolons.
- ESLint must pass with no warnings.
- Follow the patterns in the surrounding code. Comments should explain why
  something is done, not restate what the code does.

### Changelog

There's no changelog to edit. `CHANGELOG.md` is generated from the GitHub
release notes when a release is published (see below), and those notes are
built from the titles of merged pull requests. A clear title is all that's
needed.

## Releasing

This section is for maintainers.

1. Open a pull request that bumps `version` in `package.json` (and
   `package-lock.json`) and merge it.
2. Create a GitHub release from `main`:
   - Tag it with the new version without a `v` prefix, for example `1.10.0`.
   - Click **Generate release notes**, then tidy them up if needed.
   - Publish the release.
3. Publishing the release runs the [Release workflow](.github/workflows/release.yml),
   which:
   - checks that the tag matches the version in `package.json`
   - generates `CHANGELOG.md` from all published releases, including this one
   - runs the tests
   - publishes the extension to the Visual Studio Marketplace

The changelog is packaged into the extension and shown on its Marketplace
page. It isn't committed to the repository. To preview it locally, run
`npm run changelog` (requires the [GitHub CLI](https://cli.github.com/)).

If the workflow fails, fix the cause and re-run the job. The release doesn't
need to be recreated. Pre-releases don't trigger a publish. To publish one
later, run the Release workflow by hand from the **Actions** tab and pick the
release tag under **Use workflow from**.

## License

By contributing, you agree that your contributions will be licensed under the
project's [MIT License](LICENSE).
