# ParityMark

Monorepo for the ParityMark project.

## Marking API

The marking service exposes HTTP endpoints for:

- saving draft marks for a response
- submitting marks (which locks the underlying response)
- fetching the current marks for a response for the calling marker

These endpoints are implemented in \`apps/api/src/server.js\` and backed by the marking module in \`apps/api/src/marking.js\`.

For full details (authentication, required permissions, error shapes and example flows), see:

- \`apps/api/README.md\` – section **"Marking HTTP endpoints"**
