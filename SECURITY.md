# Security Policy

## Supported Versions

Security fixes are made on the latest release only. VS Code updates
extensions automatically, so please make sure you're on the newest version
before reporting a problem.

| Version          | Supported |
| ---------------- | --------- |
| Latest release   | Yes       |
| Anything older   | No        |

## Reporting a Vulnerability

Please **don't** open a public issue, discussion or pull request for a
security problem.

Report it privately through GitHub instead:

1. Go to the [Security tab](https://github.com/arbs-io/github-copilot-llm-gateway/security) of this repository.
2. Click **Report a vulnerability**.
3. Fill in the form. Only the maintainers can see what you send.

It helps to include:

- The extension version, VS Code version and operating system
- The inference server you were using (vLLM, Ollama, LiteLLM, ...)
- What the problem is and what an attacker could do with it
- Steps to reproduce, or a proof of concept
- Any logs, with API keys and other secrets removed

## What to Expect

This is a project maintained in spare time, so timings are best effort:

- I'll acknowledge your report within a week.
- I'll let you know whether I can reproduce it and what the plan is.
- Once a fix is released, I'll publish a GitHub security advisory. You'll be
  credited in it unless you'd rather not be.

Please give me a reasonable amount of time to fix the problem before
disclosing it publicly.

## Scope

In scope are problems in this extension itself, for example:

- The API key or custom headers leaking out of VS Code's secret storage, into
  logs or to anywhere other than the configured server
- Requests going to a host other than the one you configured
- Model output or server responses causing the extension to do something it
  shouldn't, beyond what Copilot's own tool confirmations allow

Out of scope:

- Vulnerabilities in VS Code, GitHub Copilot or your inference server. Please
  report those to the relevant project.
- Anything that needs **Verbose Logging** to be turned on. That setting writes
  full request bodies to the output channel on purpose, and is documented as a
  debugging aid.
- What a model says or does when you give it tools. That's governed by your
  model, your server and Copilot's tool approval settings.
