# MeowPush Web SDK

This is a multi-package workspace. `packages/app-connect` publishes `@azurdream/meowpush-app-connect`; other SDK packages may be added independently.

- Do not create branches/worktrees or commit/push/publish without an explicit user request.
- Keep protocol code in the package core and optional DOM/UI code in its UI entry. Importing either entry must be safe during SSR.
- Use only the fixed official API and authorization origin. Never log or persist request IDs, poll secrets, push keys or raw responses. Do not include secrets in DOM attributes, errors or global events.
- Authorization is explicit on the official page. SDK cancellation stops waiting and never revokes an approved application.
- Use one source for ESM/IIFE builds. Keep TypeScript declarations and package exports aligned.
- Run typecheck, unit tests, build and browser tests relevant to the change. Generated screenshots/traces belong outside the repository.
