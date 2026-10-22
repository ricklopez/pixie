# Pixie v1 — the app on paper

Status: product specification for review, 2026-10-21. Owner: Rick Lopez.
This package specifies the intended application, not implemented capabilities. The [review decisions](v1-review-decisions.md) authorize only the bounded local G1 build slice. They do not authorize
provider provisioning, real-account changes, or deployment. The clickable demo remains a simulation.

## Reading order

Start with the [review decisions and prototype reference map](v1-review-decisions.md).

1. [Product specification](v1-product-spec.md): promise, scope, architecture, data, interfaces and behavior.
2. [CLI and Studio experience](v1-experience.md): screens, controls, states and Mermaid user flows.
3. [Environments and deployment](v1-environments.md): prerequisites, configuration, secrets and operations.
4. [First end-to-end use case](v1-lemonade-use-case.md): human login, persistent connection and policy API.
5. [Delivery and acceptance](v1-delivery.md): milestones, launch gates, unresolved decisions and evidence.

These documents are the detailed v1 product baseline. [The earlier plan](../docs/v1-plan.md) remains a concise
technical companion; this package supersedes its synthetic-invoice launch scenario. Existing experiment safety
requirements remain in force. The [clickable demo source](../sites/pixie-v1-demo/) establishes the CLI → Studio
experience; its invoice examples and simulated publication are references, not proof of Lemonade compatibility.

## Scope decisions

- Local authoring and tests → Developer Studio → one-button publication to user-owned Render infrastructure.
- Browserbase for persistent cloud authentication and bounded browser sessions; human login/MFA and handoff.
- Models, operation contracts, repositories, browser adapters; REST/OpenAPI and MCP share operations.
- Agent-assisted generation and reviewed repair; ordinary execution and authentication use no model calls.
- Lemonade is the first real portal acceptance case. Read operations are the initial target, pending validation.
- Full CRUD is required on the controlled Todo fixture. Lemonade quote CRUD is capability-gated: unsupported
  methods are absent, never simulated as working live endpoints. Policy purchase/cancellation is excluded from v1.
- Database connectors, GraphQL, autonomous repair promotion and multiplayer editing are next-phase scope.

No customer screenshots, personal identifiers, OTPs, cookies or live provider keys belong in this folder.
